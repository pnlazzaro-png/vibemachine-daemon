// HTTP + WebSocket on 127.0.0.1:3005. Tailscale Serve fronts it with TLS.
//
//   GET  /health                           (no auth) liveness
//   POST /pair                             (no auth) {code, device_id, name, public_key}
//   GET  /sessions
//   GET  /sessions/:id                     session + pending permission prompts
//   GET  /sessions/:id/events?since=&limit=
//   POST /sessions                         {cwd, prompt, title?, model?, effort?, permission_mode?, attachments?}
//   POST /sessions/:id/prompt              {prompt, attachments?: [{name, media_type, data (base64)}]}
//   POST /sessions/:id/settings            {model?, effort?, permission_mode?} (null resets model/effort) → {session}
//   POST /sessions/:id/permission          {request_id, behavior, message?, updated_permissions?}
//   POST /sessions/:id/interrupt
//   POST /sessions/:id/stop
//   POST /sessions/:id/archive             {archived?: boolean (default true)} out of the list, or back → {session}
//   POST /sessions/:id/pipeline            {stage, status, title, detail?, log?}
//   POST /sessions/:id/preview             screenshot the project's app now
//   GET  /captures/:id                     a screenshot (image/png)
//   GET  /captures/:id/clip                the screen from launch to that shot (video/mp4), when it changed
//   GET  /attachments/:id                  a file the phone sent with a prompt
//   GET  /attachments/:id/poster           a video's first frame (image/jpeg), made when first asked for
//   GET  /projects                         repos a session can start in
//   GET  /stats?since=&until=&bucket=day|month&project=   the usage ledger for a span (stats.ts)
//   POST /diagnostics                      a MetricKit payload from the phone (crashes, hangs), kept under DATA_DIR/diagnostics
//   POST /devices/me/push                 {token, environment} APNs device token (or token: null)
//   POST /devices/me/activity              {kind: "start"|"update", token, environment, session_id?} ActivityKit tokens
//   GET  /install/:token/...               (no auth) an ad hoc build for the phone: ios/scripts/adhoc.sh
//   GET  /ws                               WebSocket, same signed headers
//   (any other route)                      404 {error, unknown_route: true, version, api, min_app_api}: this daemon doesn't have it
//
// WebSocket, client → server: {"type":"subscribe","session_id","since"} | {"type":"unsubscribe","session_id"}
// server → client: {"type":"hello","version","api","min_app_api","sessions"} | {"type":"session","session"} | {"type":"event","session_id","seq","ts","event"}
//   | {"type":"meter","utilization","resets_at"} (the account's newest five-hour reading, from any session)
//                  | {"type":"backlog_done","session_id","seq"} | {"type":"stats_changed"} | {"type":"error","message"}
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_VIDEO_BYTES, parseAttachments } from "./attachments.js";
import { isVideo, poster } from "./video.js";
import { authenticate, preauthenticate } from "./auth.js";
import { EFFORT_LEVELS, RefusedError, UnavailableError } from "./claude.js";
import { config, packageVersion } from "./config.js";
import type { EventRow, Store } from "./db.js";
import { saveDiagnostic } from "./diagnostics.js";
import { Notifier } from "./notifier.js";
import { STAGES, STAGE_STATUSES, type PipelineLine, type Stage, type StageStatus } from "./pipeline.js";
import { clipPath, servedCopy } from "./preview.js";
import { listProjects } from "./projects.js";
import { ensureTls, lanAddress, PairingGuard } from "./lan.js";
import { apnsConfigured, environmentFrom, validToken } from "./push.js";
import { PERMISSION_MODES, type SessionManager, BadRequestError } from "./sessions.js";
import { statsReport } from "./stats.js";
import { planUsage } from "./planusage.js";
import { trimForRelay } from "./trim.js";
import type { UsageLedger } from "./usage.js";

const VERSION = packageVersion;
/** The protocol the app and the daemon speak. Bump it when a change would break the other side;
 *  MIN_APP_API is the oldest app this daemon still serves (the app checks both, Core/Compatibility.swift). */
export const API = 1;
export const MIN_APP_API = 1;
/** The `/sessions/:id/<action>` routes; any other action is a route this daemon doesn't know. */
const SESSION_ACTIONS = new Set(["events", "prompt", "settings", "permission", "interrupt", "stop", "preview", "pipeline", "archive"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** What this daemon says about itself: /health, the WebSocket hello, an unknown route. */
const versionFields = () => ({ version: VERSION, api: API, min_app_api: MIN_APP_API });

/**
 * A route this daemon doesn't have (audit 4.5). Not the same as a 404 for a missing thing (a
 * session, a capture): `unknown_route` and `api` let an app newer than the daemon say "update the
 * daemon" instead of "not found".
 */
function unknownRoute(method: string, pathname: string): HttpError {
  return new HttpError(404, `this daemon (api ${API}, version ${VERSION}) has no ${method} ${pathname}; it may be older than the app`, {
    unknown_route: true,
    ...versionFields(),
  });
}

type Json = Record<string, unknown>;

/** The five-hour reading as the phone's gauge takes it: utilization 0…1, the reset in unix seconds. */
function meterMessage(meter: { utilization: number; resetsAt?: number }): string {
  return JSON.stringify({ type: "meter", utilization: meter.utilization, resets_at: meter.resetsAt ?? null });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

/** A prompt may carry attachments, base64: room for a video and a couple of others, or four others, with the JSON around them. */
const MAX_BODY_BYTES = Math.max(
  Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) * 2,
  Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) * Math.min(MAX_ATTACHMENTS, 4),
);

/** All an unauthenticated request may say: a pairing code, a device id and a public key. */
const MAX_PAIR_BODY_BYTES = 4096;

function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new HttpError(413, "body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(body: Buffer): Json {
  if (body.length === 0) return {};
  try {
    const v: unknown = JSON.parse(body.toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "body must be a JSON object");
}

function requireString(body: Json, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${key} is required`);
  return v;
}
function optionalString(body: Json, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}
/** A setting the phone may change: a string sets it, null resets it, absent leaves it. */
function settable(body: Json, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string or null`);
  return v.trim();
}
function effortOrThrow(value: string | null | undefined): string | null | undefined {
  if (value && !(EFFORT_LEVELS as readonly string[]).includes(value)) throw new HttpError(400, `effort must be one of ${EFFORT_LEVELS.join(", ")}`);
  return value;
}
function attachmentsOrThrow(body: Json) {
  try {
    return parseAttachments(body.attachments);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "bad attachments");
  }
}

/** Lines that only mean something while they stream; a replay skips them. */
function isLiveOnly(row: EventRow): boolean {
  return row.type === "stream_event" || (row.type === "system" && row.subtype === "thinking_tokens");
}

function publicEvent(row: EventRow): Json {
  return { type: "event", session_id: row.session_id, seq: row.seq, ts: row.ts, event: trimForRelay(JSON.parse(row.json)) };
}

/** Requests that came in on the Wi-Fi listener rather than loopback (and so Tailscale Serve). */
const viaLan = new WeakSet<http.IncomingMessage>();

export function startServer(store: Store, sessions: SessionManager, ledger?: UsageLedger): http.Server {
  // Who is watching what, so a phone with the session on screen isn't also pushed.
  const subscriptions = new Map<WebSocket, { deviceId: string; sessions: Set<string> }>();
  const watching = (deviceId: string, sessionId: string): boolean => {
    for (const [ws, sub] of subscriptions) if (sub.deviceId === deviceId && sub.sessions.has(sessionId) && ws.readyState === WebSocket.OPEN) return true;
    return false;
  };
  const notifier = new Notifier(store, watching);
  const pairing = new PairingGuard();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, ...err.extra });
      else if (err instanceof RefusedError) sendJson(res, 409, { error: err.message });
      else if (err instanceof BadRequestError) sendJson(res, 400, { error: err.message });
      else if (err instanceof UnavailableError) sendJson(res, 503, { error: err.message });
      else {
        // The detail stays in the log; a client (on the Wi-Fi, anyone) gets no file paths or stack from it.
        console.error("request failed:", err);
        sendJson(res, 500, { error: "internal error" });
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, name: "Vibe Machine", ...versionFields() });

    // An ad hoc build the phone installs from Safari (itms-services). Unsigned, since Safari and
    // the installer can't sign; the token in the path is the secret, and the tailnet the fence.
    const install = /^\/install\/([A-Za-z0-9_-]{16,})\/?([A-Za-z0-9._-]*)$/.exec(url.pathname);
    // Unsigned by design (Safari can't sign), so it is served only where the tailnet is the fence: never on the Wi-Fi.
    if (install && method === "GET" && viaLan.has(req)) throw new HttpError(404, "not found");
    if (install && method === "GET") {
      const dir = path.join(config.dataDir, "install", install[1]!);
      const name = install[2] || "index.html";
      const file = path.join(dir, name);
      if (!file.startsWith(dir) || !fs.existsSync(file)) throw new HttpError(404, "no such build");
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".plist": "application/xml", ".ipa": "application/octet-stream", ".png": "image/png" };
      res.writeHead(200, { "content-type": types[path.extname(name)] ?? "application/octet-stream", "content-length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (method === "POST" && url.pathname === "/pair") {
      // JSON only: a web page can't send that cross-origin without a preflight, which nothing here answers.
      if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpError(415, "send JSON");
      const client = req.socket.remoteAddress ?? "*";
      if (pairing.blocked(client)) throw new HttpError(429, "too many wrong codes; wait ten minutes and run `vibemachine pair` again");
      const json = parseJson(await readBody(req, MAX_PAIR_BODY_BYTES));
      const code = requireString(json, "code");
      if (!store.redeemPairingCode(code)) {
        pairing.failed(client);
        throw new HttpError(403, "pairing code is wrong or expired");
      }
      const device = store.insertDevice({ id: requireString(json, "device_id"), name: requireString(json, "name"), public_key: requireString(json, "public_key") });
      console.log(`paired device ${device.name} (${device.id})`);
      return sendJson(res, 200, { ok: true, device_id: device.id });
    }

    // Everything else is signed. The headers name the device: check them before holding a body
    // for it, so an unknown caller can't make the daemon buffer a prompt's worth of attachments.
    const pre = preauthenticate(store, req);
    if (!pre.ok) throw new HttpError(401, pre.reason ?? "unauthorized");
    const body = await readBody(req);
    const auth = authenticate(store, req, body);
    if (!auth.ok) throw new HttpError(401, auth.reason ?? "unauthorized");

    if (url.pathname === "/sessions" && method === "GET") return sendJson(res, 200, { sessions: sessions.list() });
    if (url.pathname === "/projects" && method === "GET") return sendJson(res, 200, { projects: await listProjects() });
    if (url.pathname === "/stats" && method === "GET") {
      const instant = (key: string): string | null => {
        const v = url.searchParams.get(key);
        if (!v) return null;
        if (Number.isNaN(Date.parse(v))) throw new HttpError(400, `${key} must be an ISO-8601 instant`);
        return new Date(v).toISOString();
      };
      return sendJson(res, 200, statsReport(store, {
        since: instant("since"),
        until: instant("until"),
        bucket: url.searchParams.get("bucket") === "month" ? "month" : "day",
        cwd: url.searchParams.get("project") || null,
      }, Date.now(), await planUsage()));
    }

    if (url.pathname === "/diagnostics" && method === "POST") {
      const saved = saveDiagnostic(parseJson(body), auth.deviceId!);
      if (saved) console.log(`diagnostic from ${auth.deviceId}: ${saved.summary} (${saved.file})`);
      return sendJson(res, 200, { ok: true, new: saved !== null });
    }
    // The phone forgets this Mac: its key is revoked here too, so a lost or reset phone can't come back.
    if (url.pathname === "/devices/me" && method === "DELETE") {
      store.removeDevice(auth.deviceId!);
      console.log(`device ${auth.deviceId} unpaired itself`);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/devices/me/push" && method === "POST") {
      const json = parseJson(body);
      if (json.token === null) {
        store.setPushToken(auth.deviceId!, null, null);
        return sendJson(res, 200, { ok: true });
      }
      if (!validToken(json.token)) throw new HttpError(400, "token must be hex");
      store.setPushToken(auth.deviceId!, json.token.toLowerCase(), environmentFrom(json.environment));
      return sendJson(res, 200, { ok: true, push: notifier.enabled });
    }
    if (url.pathname === "/devices/me/activity" && method === "POST") {
      const json = parseJson(body);
      if (!validToken(json.token)) throw new HttpError(400, "token must be hex");
      if (json.kind === "start") store.setActivityStartToken(auth.deviceId!, json.token.toLowerCase());
      else {
        const sessionId = requireString(json, "session_id");
        if (!sessions.get(sessionId)) throw new HttpError(404, "no such session");
        store.setActivityToken(auth.deviceId!, sessionId, json.token.toLowerCase(), environmentFrom(json.environment));
        sessions.activityTokenArrived(sessionId);
      }
      return sendJson(res, 200, { ok: true });
    }

    const clip = /^\/captures\/([0-9a-fA-F-]{36})\/clip$/.exec(url.pathname);
    if (clip && method === "GET") {
      const row = store.getCapture(clip[1]!);
      const file = row ? clipPath(row.path) : "";
      if (!row || !fs.existsSync(file)) throw new HttpError(404, "no clip for that capture");
      res.writeHead(200, { "content-type": "video/mp4", "content-length": fs.statSync(file).size, "cache-control": "private, max-age=31536000, immutable" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    const capture = /^\/captures\/([0-9a-fA-F-]{36})(?:\.png)?$/.exec(url.pathname);
    if (capture && method === "GET") {
      const row = store.getCapture(capture[1]!);
      if (!row || !fs.existsSync(row.path)) throw new HttpError(404, "no such capture");
      // The phone's small JPEG (made on the first ask for a capture shot before it existed); the PNG if that fails.
      let file = row.path;
      let type = "image/png";
      try {
        file = await servedCopy(row.path);
        type = "image/jpeg";
      } catch (err) {
        console.error(`captures: no JPEG for ${capture[1]}:`, err);
      }
      const stat = fs.statSync(file);
      res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "private, max-age=31536000, immutable" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    const attachmentFile = /^\/attachments\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (attachmentFile && method === "GET") {
      const row = store.getAttachment(attachmentFile[1]!);
      if (!row || !fs.existsSync(row.path)) throw new HttpError(404, "no such attachment");
      res.writeHead(200, {
        "content-type": row.media_type,
        "content-length": fs.statSync(row.path).size,
        "content-disposition": `inline; filename="${row.name.replace(/["\\\r\n]/g, "_")}"`,
        "cache-control": "private, max-age=31536000, immutable",
      });
      fs.createReadStream(row.path).pipe(res);
      return;
    }

    const attachmentPoster = /^\/attachments\/([0-9a-fA-F-]{36})\/poster$/.exec(url.pathname);
    if (attachmentPoster && method === "GET") {
      const row = store.getAttachment(attachmentPoster[1]!);
      if (!row || !isVideo(row.media_type) || !fs.existsSync(row.path)) throw new HttpError(404, "no such video");
      const file = await poster(row.path);
      if (!file) throw new HttpError(404, "no poster for this video");
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": fs.statSync(file).size, "cache-control": "private, max-age=31536000, immutable" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname === "/sessions" && method === "POST") {
      const json = parseJson(body);
      // The mode and the model go to the CLI's argv: only known modes, and nothing that reads as a flag.
      const mode = optionalString(json, "permission_mode");
      if (mode && !(PERMISSION_MODES as readonly string[]).includes(mode)) throw new HttpError(400, `permission_mode must be one of ${PERMISSION_MODES.join(", ")}`);
      const model = optionalString(json, "model");
      if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model)) throw new HttpError(400, "model must be a model name or alias");
      const attachments = attachmentsOrThrow(json);
      const prompt = attachments.length > 0 ? (optionalString(json, "prompt") ?? "") : requireString(json, "prompt");
      const effort = effortOrThrow(optionalString(json, "effort"));
      const row = await sessions.create({
        cwd: requireString(json, "cwd"),
        prompt,
        ...(optionalString(json, "title") ? { title: optionalString(json, "title")! } : {}),
        ...(optionalString(json, "model") ? { model: optionalString(json, "model")! } : {}),
        ...(effort ? { effort } : {}),
        ...(optionalString(json, "permission_mode") ? { permissionMode: optionalString(json, "permission_mode")! } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return sendJson(res, 201, { session: row });
    }

    const m = /^\/sessions\/([0-9a-fA-F-]{36})(?:\/([a-z_]+))?$/.exec(url.pathname);
    if (m) {
      const id = m[1]!;
      const action = m[2];
      if (action && !SESSION_ACTIONS.has(action)) throw unknownRoute(method, url.pathname);
      const row = sessions.get(id);
      if (!row) throw new HttpError(404, "no such session");

      if (!action && method === "GET") return sendJson(res, 200, { session: row, pending: sessions.pendingPermissions(id) });

      if (action === "events" && method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 2000) || 2000, 5000);
        return sendJson(res, 200, { events: sessions.events(id, since, limit).map(publicEvent) });
      }

      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const json = parseJson(body);

      if (action === "prompt") {
        const attachments = attachmentsOrThrow(json);
        const prompt = attachments.length > 0 ? (optionalString(json, "prompt") ?? "") : requireString(json, "prompt");
        await sessions.prompt(id, prompt, attachments);
        return sendJson(res, 202, { ok: true });
      }
      if (action === "settings") {
        const model = settable(json, "model");
        const effort = effortOrThrow(settable(json, "effort"));
        const permissionMode = optionalString(json, "permission_mode");
        if (permissionMode && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) throw new HttpError(400, `permission_mode must be one of ${PERMISSION_MODES.join(", ")}`);
        if (model === undefined && effort === undefined && !permissionMode) throw new HttpError(400, "nothing to change: give model, effort or permission_mode");
        return sendJson(res, 200, {
          session: await sessions.setOptions(id, {
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          }),
        });
      }
      if (action === "permission") {
        const requestId = requireString(json, "request_id");
        const behavior = requireString(json, "behavior");
        let ok: boolean;
        if (behavior === "allow") {
          const updated = Array.isArray(json.updated_permissions) ? json.updated_permissions : undefined;
          ok = sessions.answer(id, requestId, { behavior: "allow", ...(updated ? { updatedPermissions: updated } : {}) });
        } else if (behavior === "deny") {
          ok = sessions.answer(id, requestId, { behavior: "deny", message: optionalString(json, "message") ?? "Declined on the phone." });
        } else throw new HttpError(400, "behavior must be allow or deny");
        if (!ok) throw new HttpError(409, "no such pending permission request");
        return sendJson(res, 200, { ok: true });
      }
      if (action === "interrupt") {
        if (!(await sessions.interrupt(id))) throw new HttpError(409, "session is not running");
        return sendJson(res, 200, { ok: true });
      }
      if (action === "archive") {
        if ("archived" in json && typeof json.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
        return sendJson(res, 200, { session: sessions.archive(id, json.archived !== false) });
      }
      if (action === "stop") {
        return sendJson(res, 200, { ok: sessions.stop(id) });
      }
      if (action === "preview") {
        sessions.capturePreview(id).catch((err: unknown) => console.error(`[${id.slice(0, 8)}] preview failed:`, err));
        return sendJson(res, 202, { ok: true });
      }
      if (action === "pipeline") {
        const stage = requireString(json, "stage") as Stage;
        const status = requireString(json, "status") as StageStatus;
        if (!STAGES.includes(stage)) throw new HttpError(400, `stage must be one of ${STAGES.join(", ")}`);
        if (!STAGE_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STAGE_STATUSES.join(", ")}`);
        const line: PipelineLine = {
          type: "pipeline",
          stage,
          status,
          title: requireString(json, "title"),
          ...(optionalString(json, "detail") ? { detail: optionalString(json, "detail")! } : {}),
          ...(optionalString(json, "log") ? { log: optionalString(json, "log")! } : {}),
          ...(optionalString(json, "ref") ? { ref: optionalString(json, "ref")! } : {}),
          ts: new Date().toISOString(),
        };
        return sendJson(res, 201, publicEvent(sessions.addPipeline(id, line)));
      }
    }
    throw unknownRoute(method, url.pathname);
  }

  // WebSocket feed
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const auth = authenticate(store, req, Buffer.alloc(0));
    if (!auth.ok) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, auth.deviceId));
  });

  wss.on("connection", (ws: WebSocket, deviceId: string) => {
    subscriptions.set(ws, { deviceId, sessions: new Set() });
    ws.send(JSON.stringify({ type: "hello", ...versionFields(), sessions: sessions.list() }));
    ws.on("message", (data) => {
      let msg: Json;
      try {
        msg = JSON.parse(data.toString()) as Json;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "messages must be JSON" }));
        return;
      }
      const sessionId = typeof msg.session_id === "string" ? msg.session_id : null;
      if (msg.type === "subscribe" && sessionId) {
        if (!sessions.get(sessionId)) {
          ws.send(JSON.stringify({ type: "error", message: "no such session" }));
          return;
        }
        subscriptions.get(ws)?.sessions.add(sessionId);
        const since = Number(msg.since ?? 0) || 0;
        let last = since;
        // Backlog in pages, then live. Streaming deltas and thinking counters are left out:
        // the complete `assistant` lines carry everything they built, and a session's
        // history is nine parts deltas, which the phone would otherwise replay one by one.
        for (;;) {
          const page = sessions.events(sessionId, last, 1000);
          for (const row of page) if (!isLiveOnly(row)) ws.send(JSON.stringify(publicEvent(row)));
          if (page.length < 1000) break;
          last = page[page.length - 1]!.seq;
        }
        const pending = sessions.pendingPermissions(sessionId);
        ws.send(JSON.stringify({ type: "backlog_done", session_id: sessionId, seq: sessions.get(sessionId)?.last_seq ?? 0, pending }));
        // The gauge's reading for the account, after the backlog: the session's own history may only
        // hold a reading from a window that has since reset, which would put the needle at zero.
        const meter = sessions.latestMeter();
        if (meter) ws.send(meterMessage(meter));
      } else if (msg.type === "unsubscribe" && sessionId) {
        subscriptions.get(ws)?.sessions.delete(sessionId);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
    ws.on("close", () => subscriptions.delete(ws));
  });

  sessions.on("event", (row) => {
    const payload = JSON.stringify(publicEvent(row));
    for (const [ws, sub] of subscriptions) if (sub.sessions.has(row.session_id) && ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  sessions.on("meter", (meter) => {
    const payload = meterMessage(meter);
    for (const ws of subscriptions.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  sessions.on("session", (row) => {
    const payload = JSON.stringify({ type: "session", session: row });
    for (const ws of subscriptions.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  // The ledger read new lines: a phone with the stats page open fetches it again. While any session
  // streams the ledger changes every second or two, so the phone hears at most once per interval.
  const STATS_NOTICE_MS = 10_000;
  let lastNotice = 0;
  let noticeTimer: NodeJS.Timeout | null = null;
  const noticeStats = () => {
    noticeTimer = null;
    lastNotice = Date.now();
    const payload = JSON.stringify({ type: "stats_changed" });
    for (const ws of subscriptions.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };
  ledger?.on("changed", () => {
    if (noticeTimer) return;
    const wait = Math.max(lastNotice + STATS_NOTICE_MS - Date.now(), 0);
    noticeTimer = setTimeout(noticeStats, wait);
    noticeTimer.unref();
  });
  sessions.on("notify", (n) => void notifier.notify(n).catch((err: unknown) => console.error("push failed:", err)));
  sessions.on("activity", (a) => void notifier.activity(a).catch((err: unknown) => console.error("live activity push failed:", err)));
  // Activities a stopped daemon left on a Lock Screen: their turns are over.
  void notifier.endOrphans().catch((err: unknown) => console.error("ending stale live activities failed:", err));
  if (apnsConfigured()) console.log("push: APNs configured");
  else if (config.pushRelay) console.log(`push: through the relay at ${config.pushRelay}`);
  else console.log("push: off (set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH)");

  // Keep idle sockets alive through Tailscale Serve.
  const heartbeat = setInterval(() => {
    for (const ws of subscriptions.keys()) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);
  heartbeat.unref();

  // A port already taken (another daemon, a dev server) is said once and retried, instead of
  // an uncaught error that launchd would restart every ten seconds.
  const RETRY_LISTEN_MS = 15_000;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.error(`port ${config.port} is in use (another daemon, or something else on it): set PORT in .env, or stop it; trying again in ${RETRY_LISTEN_MS / 1000} s`);
    else console.error("listen failed:", err.message);
    setTimeout(() => server.listen(config.port, config.host), RETRY_LISTEN_MS);
  });
  server.listen(config.port, config.host, () => {
    console.log(`Vibe Machine daemon ${VERSION} on http://${config.host}:${config.port} (data: ${config.dataDir})`);
  });
  // The same routes on the Wi-Fi, over HTTPS with the pinned certificate.
  if (config.lan) {
    try {
      const tls = ensureTls();
      const lan = https.createServer({ key: tls.key, cert: tls.cert });
      lan.on("request", (req, res) => {
        viaLan.add(req);
        server.emit("request", req, res);
      });
      lan.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
      lan.on("error", (err: NodeJS.ErrnoException) => {
        console.error(`lan: port ${config.lanPort} ${err.code === "EADDRINUSE" ? "is in use (set LAN_PORT in .env)" : `failed: ${err.message}`}; trying again in ${RETRY_LISTEN_MS / 1000} s`);
        setTimeout(() => lan.listen(config.lanPort, "::"), RETRY_LISTEN_MS);
      });
      lan.listen(config.lanPort, "::", () => console.log(`on the Wi-Fi at ${lanAddress()} (certificate ${tls.fingerprint.slice(0, 16)}…)`));
      server.on("close", () => lan.close());
    } catch (err) {
      console.error("lan: couldn't start the Wi-Fi listener:", err);
    }
  }
  return server;
}
