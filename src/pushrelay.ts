// The push relay: lets a daemon without an APNs key (anyone's but the developer's)
// reach its phone. It holds the team's .p8 key, takes a ready payload and
// a device token from a daemon, adds the provider token and the app's topic
// itself, and forwards to Apple over HTTP/2. It keeps nothing.
//
//   POST /v1/push   {environment, type: "alert"|"liveactivity", priority: 5|10, token, payload}
//                   → {ok, status, reason?}  (Apple's answer, passed back)
//   GET  /health
//
// What it guards: the topic is always this app's (a caller can't push for
// another bundle), payloads must be APNs JSON with an `aps` object and fit
// Apple's 4 KB, tokens must be hex, and each caller, each token and the
// relay as a whole has a rate limit (a caller on IPv6 is its /64: one
// customer holds a whole one). A token is the only key to a phone, and only
// the phone and the daemon it paired with know it, which is what lets the
// relay be open. Pushes share one connection to Apple (push.ts).
//
// Run with `npm run relay` (RELAY_PORT, default 3009; RELAY_HOST, default
// 127.0.0.1, 0.0.0.0 in a container); it reads the same APNS_* settings as
// the daemon. Paths may carry a prefix (Tailscale Funnel's --set-path), so
// routes match on their tail. The caller's address for the rate limit comes
// from the socket, or from the one header a trusted proxy in front sets
// (RELAY_CLIENT_HEADER, e.g. fly-client-ip on Fly.io), never from
// X-Forwarded-For, which any caller can write.
import http from "node:http";
import { config } from "./config.js";
import { apnsConfigured, environmentFrom, http2Transport, relayHeaders, HOSTS, type PushEnvironment, type Transport } from "./push.js";

export const PAYLOAD_MAX = 4096;

export interface RelayRequest {
  environment: PushEnvironment;
  type: "alert" | "liveactivity";
  priority: "5" | "10";
  token: string;
  payload: string;
}

/** The request body checked and normalised, or why not. */
export function parseRelayRequest(body: unknown): RelayRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.type !== "alert" && b.type !== "liveactivity") return { error: "type must be alert or liveactivity" };
  if (typeof b.token !== "string" || !/^[0-9a-f]{32,400}$/i.test(b.token)) return { error: "token must be hex" };
  const priority = String(b.priority ?? "10");
  if (priority !== "5" && priority !== "10") return { error: "priority must be 5 or 10" };
  const payload = typeof b.payload === "string" ? b.payload : JSON.stringify(b.payload ?? null);
  if (Buffer.byteLength(payload) > PAYLOAD_MAX) return { error: `payload over ${PAYLOAD_MAX} bytes` };
  try {
    const parsed = JSON.parse(payload) as { aps?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.aps || typeof parsed.aps !== "object") return { error: "payload must have an aps object" };
  } catch {
    return { error: "payload must be JSON" };
  }
  return { environment: environmentFrom(b.environment), type: b.type, priority, token: b.token.toLowerCase(), payload };
}

/**
 * A sliding count per key: at most `limit` in any `windowMs`. Keys gone quiet are dropped once a
 * window, and the map never holds more than `maxKeys`: past that a key not seen before is refused
 * (a flood of new addresses can't grow it, and the callers already known carry on).
 */
export class RateLimit {
  private hits = new Map<string, number[]>();
  private swept = 0;
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 50_000) {}

  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now = Date.now()): boolean {
    if (now - this.swept >= this.windowMs) {
      this.swept = now;
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    const known = this.hits.get(key);
    if (!known && this.hits.size >= this.maxKeys) return false;
    const recent = (known ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/**
 * What a caller's address counts as for the rate limit: an IPv4 address itself (also when it
 * arrives mapped into IPv6), an IPv6 address's /64, since one customer is handed the whole of one
 * and could otherwise be 2^64 callers.
 */
export function callerKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(":")) return a || "?";
  const [head = "", tail] = a.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(8 - front.length - back.length, 0)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export interface RelayOptions {
  /** The header a trusted proxy sets with the caller's address (lower-case), e.g. `fly-client-ip`; none: the socket's address. */
  clientHeader?: string;
  transport?: Transport;
  /** Per caller (address, or its /64) and per device token, each a minute's worth. */
  perCaller?: number;
  perToken?: number;
  /** Every caller together, a minute's worth: what the relay will ever ask of Apple. */
  overall?: number;
}

export function createRelay(opts: RelayOptions = {}): http.Server {
  const transport = opts.transport ?? http2Transport;
  const callers = new RateLimit(opts.perCaller ?? 120, 60_000);
  const tokens = new RateLimit(opts.perToken ?? 30, 60_000);
  const overall = new RateLimit(opts.overall ?? 3000, 60_000);
  const clientHeader = (opts.clientHeader ?? process.env.RELAY_CLIENT_HEADER ?? "").trim().toLowerCase() || null;
  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname.endsWith("/health")) return reply(res, 200, { ok: true, apns: apnsConfigured() });
    if (req.method !== "POST" || !url.pathname.endsWith("/v1/push")) return reply(res, 404, { error: "not found" });
    // Behind a proxy the socket is the proxy's; only a header the proxy itself sets names the caller.
    const forwarded = clientHeader ? String(req.headers[clientHeader] ?? "").split(",")[0]!.trim() : "";
    const caller = callerKey(forwarded || req.socket.remoteAddress || "?");
    if (!callers.allow(caller)) return reply(res, 429, { error: "slow down" });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > PAYLOAD_MAX * 3) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(res, 400, { error: "body must be JSON" });
      }
      const r = parseRelayRequest(body);
      if ("error" in r) return reply(res, 400, r);
      if (!tokens.allow(r.token)) return reply(res, 429, { error: "slow down" });
      if (!overall.allow("all")) return reply(res, 429, { error: "the relay is busy; try again in a minute" });
      if (!apnsConfigured()) return reply(res, 503, { error: "the relay has no APNs key" });
      let headers: Record<string, string>;
      try {
        headers = relayHeaders(r.type, r.priority);
      } catch (err) {
        return reply(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      const sent = await transport({ host: HOSTS[r.environment], token: r.token, headers, payload: r.payload }).catch((err: unknown) => ({ status: 0, reason: err instanceof Error ? err.message : String(err) }));
      reply(res, 200, { ok: sent.status === 200, status: sent.status, ...(sent.reason ? { reason: sent.reason } : {}) });
    });
  });
}

// `npm run relay`
if (/pushrelay\.[tj]s$/.test(process.argv[1] ?? "")) {
  const port = Number(process.env.RELAY_PORT ?? 3009);
  const host = process.env.RELAY_HOST?.trim() || "127.0.0.1";
  if (!apnsConfigured()) console.warn("relay: no APNs key; set APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_PATH");
  createRelay().listen(port, host, () => console.log(`Vibe Machine push relay on http://${host}:${port} (topic ${config.apns.topic})`));
}
