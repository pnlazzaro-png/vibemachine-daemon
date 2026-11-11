// Pushes to the phone through APNs, token-based: one .p8 key from the Apple
// Developer account (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH; the team's
// key works for every app of the team). Two kinds:
//
//   alert         a permission prompt waiting, a turn that ended, a build
//                 that failed; tapping opens the session, and a permission
//                 push has Allow once / Deny buttons that answer it
//   liveactivity  the turn in flight on the Lock Screen and in the Dynamic
//                 Island: started by push (the phone's push-to-start token),
//                 updated and ended through the activity's own token
//
// Without a key of its own the daemon sends through the push relay at
// PUSH_RELAY (pushrelay.ts), which holds one: the payloads are the same,
// the relay adds the provider token and the topic.
//
// A push that fails is logged on the device and never fails the caller.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import { config } from "./config.js";

export type PushEnvironment = "sandbox" | "production";

export const HOSTS: Record<PushEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const BODY_MAX = 1000;

export const PUSH_CATEGORY = { session: "vm.session", permission: "vm.permission" } as const;

export interface AlertNote {
  title: string;
  body: string;
  sessionId: string;
  /** For a permission prompt: the request the buttons answer. */
  requestId?: string;
  /** Group by session in Notification Center. */
  thread?: string;
}

export interface LiveActivityStart {
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  /** Required by iOS to start an activity by push: a title and a body, or it drops the push silently. */
  alert?: { title: string; body: string };
  /** The alert without a sound. */
  quiet?: boolean;
}

export interface LiveActivityUpdate {
  event: "update" | "end";
  state: Record<string, unknown>;
  alert?: { title: string; body: string };
  /** For "end": when the Lock Screen should drop it. */
  dismissAt?: Date;
  /** A change the user should see now (a new stage or status): sent at high priority. */
  urgent?: boolean;
}

export type Transport = (req: { host: string; token: string; headers: Record<string, string>; payload: string }) => Promise<{ status: number; reason?: string | undefined }>;
export interface SendResult {
  ok: boolean;
  status: number;
  reason?: string | undefined;
  /** Apple says this token will never work again. */
  gone: boolean;
}

export function environmentFrom(v: unknown): PushEnvironment {
  return v === "production" ? "production" : "sandbox";
}

/** A device or activity token as the app sends it: hex. */
export function validToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{32,400}$/i.test(token);
}

let keyCache: { path: string; key: KeyObject } | null = null;
/** The .p8 key: APNS_KEY (its PEM text, as a hosted relay gets it from a secret), else the file at APNS_KEY_PATH. */
function signingKey(): KeyObject | null {
  const inline = process.env.APNS_KEY?.trim();
  const source = inline ? `inline:${inline.length}` : config.apns.keyPath;
  if (!source) return null;
  if (keyCache?.path === source) return keyCache.key;
  try {
    // A secret pasted on one line keeps its line breaks as \n.
    const pem = inline ? inline.replace(/\\n/g, "\n") : fs.readFileSync(source, "utf8");
    keyCache = { path: source, key: createPrivateKey(pem) };
    return keyCache.key;
  } catch {
    return null;
  }
}

export function apnsConfigured(): boolean {
  return Boolean(config.apns.keyId && config.apns.teamId && signingKey());
}

/** Pushes can go somewhere: a key of our own, or a relay that has one. */
export function pushConfigured(): boolean {
  return apnsConfigured() || Boolean(config.pushRelay);
}

/** The headers Apple wants for a push of this kind, signed with our key. */
export function relayHeaders(kind: "alert" | "liveactivity", priority: "5" | "10"): Record<string, string> {
  const topic = kind === "alert" ? config.apns.topic : `${config.apns.topic}.push-type.liveactivity`;
  return { authorization: `bearer ${providerToken()}`, "apns-topic": topic, "apns-push-type": kind, "apns-priority": priority };
}

/** Sends through the relay: the same payload and token, the relay signs. Shaped like Apple's answer. */
export function relaySend(relay: string, req: { environment: PushEnvironment; type: "alert" | "liveactivity"; priority: "5" | "10"; token: string; payload: string }): Promise<{ status: number; reason?: string | undefined }> {
  const url = relay.replace(/\/+$/, "") + "/v1/push";
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(20_000) })
    .then(async (res) => {
      const j = (await res.json().catch(() => ({}))) as { status?: number; reason?: string; error?: string };
      if (!res.ok) return { status: 0, reason: `relay ${res.status}${j.error ? `: ${j.error}` : ""}` };
      return { status: j.status ?? 0, reason: j.reason };
    })
    .catch((err: unknown) => ({ status: 0, reason: `relay: ${err instanceof Error ? err.message : String(err)}` }));
}

// Provider token (JWT, ES256); Apple wants it reused for 20–60 minutes.
let jwtCache: { jwt: string; at: number } | null = null;
export function providerToken(now = Date.now(), key = signingKey()): string {
  const { keyId, teamId } = config.apns;
  if (!key || !keyId || !teamId) throw new Error("APNs is not configured");
  if (jwtCache && now - jwtCache.at < 40 * 60_000) return jwtCache.jwt;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  jwtCache = { jwt: `${unsigned}.${signature}`, at: now };
  return jwtCache.jwt;
}

// Payloads

export function alertPayload(note: AlertNote): string {
  const body = note.body.length > BODY_MAX ? `${note.body.slice(0, BODY_MAX - 1)}…` : note.body;
  return JSON.stringify({
    aps: {
      alert: { title: note.title, body },
      sound: "default",
      category: note.requestId ? PUSH_CATEGORY.permission : PUSH_CATEGORY.session,
      "thread-id": note.thread ?? note.sessionId,
      "interruption-level": note.requestId ? "time-sensitive" : "active",
    },
    session_id: note.sessionId,
    ...(note.requestId ? { request_id: note.requestId } : {}),
  });
}

/** The attributes type name the widget declares (TurnActivityAttributes in Core/TurnActivity.swift). */
export const ACTIVITY_ATTRIBUTES_TYPE = "TurnActivityAttributes";

export function activityStartPayload(start: LiveActivityStart, now = Date.now()): string {
  return JSON.stringify({
    aps: {
      timestamp: Math.floor(now / 1000),
      event: "start",
      "content-state": start.state,
      "attributes-type": ACTIVITY_ATTRIBUTES_TYPE,
      attributes: start.attributes,
      ...(start.alert ? { alert: { title: start.alert.title, body: start.alert.body }, ...(start.quiet ? {} : { sound: "default" }) } : {}),
    },
  });
}

export function activityUpdatePayload(update: LiveActivityUpdate, now = Date.now()): string {
  return JSON.stringify({
    aps: {
      timestamp: Math.floor(now / 1000),
      event: update.event,
      "content-state": update.state,
      ...(update.alert ? { alert: { title: update.alert.title, body: update.alert.body }, sound: "default" } : {}),
      ...(update.event === "end" && update.dismissAt ? { "dismissal-date": Math.floor(update.dismissAt.getTime() / 1000) } : {}),
    },
  });
}

// Transport

export interface ApnsTransportOptions {
  /** A connection with nothing in flight for this long is closed; the next push opens another. */
  idleMs?: number;
  /** How long one push may take before it counts as lost. */
  timeoutMs?: number;
}

/**
 * Pushes to Apple over one HTTP/2 connection per host, kept open between pushes as Apple asks
 * (it reads a connection per push as an attack) and closed after a quiet spell. A connection that
 * Apple has closed, or that died while it sat, is dropped and the push tried once more on a new one.
 * An open connection holds the process up only while a push is in flight.
 */
export function apnsTransport(opts: ApnsTransportOptions = {}): Transport & { close(): void } {
  const idleMs = opts.idleMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  interface Conn {
    session: http2.ClientHttp2Session;
    inFlight: number;
    idle: NodeJS.Timeout | null;
  }
  const conns = new Map<string, Conn>();
  const usable = (c: Conn | undefined): c is Conn => !!c && !c.session.closed && !c.session.destroyed;
  const drop = (host: string, conn: Conn) => {
    if (conns.get(host) === conn) conns.delete(host);
    if (conn.idle) clearTimeout(conn.idle);
    conn.idle = null;
  };
  const connect = (host: string): Conn => {
    const session = http2.connect(host);
    const conn: Conn = { session, inFlight: 0, idle: null };
    // Each of these means no new push should go on it; pushes in flight settle through their own streams.
    session.on("error", () => drop(host, conn));
    session.on("goaway", () => drop(host, conn));
    session.on("close", () => drop(host, conn));
    conns.set(host, conn);
    return conn;
  };
  const rest = (host: string, conn: Conn) => {
    conn.inFlight -= 1;
    if (conn.inFlight > 0 || conn.session.destroyed) return;
    conn.session.unref();
    if (conns.get(host) !== conn) return void conn.session.close();
    conn.idle = setTimeout(() => {
      drop(host, conn);
      conn.session.close();
    }, idleMs);
    conn.idle.unref();
  };
  const attempt = (conn: Conn, { host, token, headers, payload }: Parameters<Transport>[0]): Promise<{ status: number; reason?: string | undefined }> =>
    new Promise((resolve) => {
      if (conn.idle) clearTimeout(conn.idle);
      conn.idle = null;
      conn.inFlight += 1;
      conn.session.ref();
      let settled = false;
      const done = (r: { status: number; reason?: string | undefined }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rest(host, conn);
        resolve(r);
      };
      // No answer in time: the connection is probably dead, so nothing else should wait on it.
      const timer = setTimeout(() => {
        drop(host, conn);
        conn.session.destroy();
        done({ status: 0, reason: "timeout" });
      }, timeoutMs);
      let req: http2.ClientHttp2Stream;
      try {
        req = conn.session.request({ ":method": "POST", ":path": `/3/device/${token}`, "content-type": "application/json", ...headers });
      } catch (err) {
        drop(host, conn);
        return done({ status: 0, reason: err instanceof Error ? err.message : String(err) });
      }
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      req.on("data", (chunk: string) => (data += chunk));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = data.slice(0, 120) || undefined;
        }
        done({ status, reason });
      });
      req.on("error", (err) => done({ status: 0, reason: err.message }));
      req.on("close", () => done({ status: 0, reason: "connection closed" }));
      req.end(payload);
    });
  const transport = async (req: Parameters<Transport>[0]) => {
    const kept = conns.get(req.host);
    const reused = usable(kept);
    const first = await attempt(reused ? kept : connect(req.host), req);
    // Apple never answered on a connection that had been sitting: once more, on a fresh one.
    if (first.status !== 0 || !reused) return first;
    const now = conns.get(req.host);
    return attempt(usable(now) && now !== kept ? now : connect(req.host), req);
  };
  return Object.assign(transport, {
    close() {
      for (const [host, conn] of [...conns]) {
        drop(host, conn);
        conn.session.close();
      }
    },
  });
}

export const http2Transport = apnsTransport();

const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

async function send(kind: "alert" | "liveactivity", token: string, environment: PushEnvironment, payload: string, priority: "5" | "10", transport: Transport): Promise<SendResult> {
  let r: { status: number; reason?: string | undefined };
  if (apnsConfigured()) {
    let headers: Record<string, string>;
    try {
      headers = relayHeaders(kind, priority);
    } catch (err) {
      return { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err), gone: false };
    }
    r = await transport({ host: HOSTS[environment], token, headers, payload }).catch((err: unknown) => ({ status: 0, reason: err instanceof Error ? err.message : String(err) }));
  } else if (config.pushRelay) {
    r = await relaySend(config.pushRelay, { environment, type: kind, priority, token, payload });
  } else {
    return { ok: false, status: 0, reason: "APNs is not configured", gone: false };
  }
  return { ok: r.status === 200, status: r.status, reason: r.reason, gone: r.status === 410 || (r.reason !== undefined && GONE.has(r.reason)) };
}

export function sendAlert(token: string, environment: PushEnvironment, note: AlertNote, transport: Transport = http2Transport): Promise<SendResult> {
  return send("alert", token, environment, alertPayload(note), "10", transport);
}

export function startLiveActivity(startToken: string, environment: PushEnvironment, start: LiveActivityStart, transport: Transport = http2Transport): Promise<SendResult> {
  return send("liveactivity", startToken, environment, activityStartPayload(start), "10", transport);
}

export function updateLiveActivity(token: string, environment: PushEnvironment, update: LiveActivityUpdate, transport: Transport = http2Transport): Promise<SendResult> {
  return send("liveactivity", token, environment, activityUpdatePayload(update), update.alert || update.urgent || update.event === "end" ? "10" : "5", transport);
}
