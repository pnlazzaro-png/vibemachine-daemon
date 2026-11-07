// Device-key auth. The phone holds a P-256 key (Secure Enclave when it has
// one) that the daemon enrolled once with a pairing code. Every request and
// the WebSocket upgrade carry:
//
//   X-VM-Device:    <device id>
//   X-VM-Timestamp: <unix seconds>
//   X-VM-Signature: base64(ECDSA-P256-SHA256, raw r||s) over
//                   "<METHOD>\n<path?query>\n<timestamp>\n<sha256 hex of body>"
//
// Tailscale keeps strangers off the port; this keeps a stranger on the tailnet
// (or a leaked URL) from driving Claude Code on the Mac.
import { createHash, createPublicKey, randomInt, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import type { Store } from "./db.js";

// DER prefix for an uncompressed P-256 public key in SubjectPublicKeyInfo form.
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

export function publicKeyFromX963(base64: string): KeyObject {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("public key must be 65 bytes, X9.63 uncompressed");
  return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function signingString(method: string, pathWithQuery: string, timestamp: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`;
}

export interface AuthResult {
  ok: boolean;
  deviceId?: string;
  reason?: string;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** The headers' half of authentication: an enrolled device with a fresh timestamp. Checked before the body is read, so a stranger can't make the daemon hold one. */
export function preauthenticate(store: Store, req: IncomingMessage): AuthResult {
  const deviceId = header(req, "x-vm-device");
  const timestamp = header(req, "x-vm-timestamp");
  const signature = header(req, "x-vm-signature");
  if (!deviceId || !timestamp || !signature) return { ok: false, reason: "missing auth headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > config.authSkewSeconds) return { ok: false, reason: "timestamp out of range" };
  if (!store.getDevice(deviceId)) return { ok: false, reason: "unknown device" };
  return { ok: true, deviceId };
}

export function authenticate(store: Store, req: IncomingMessage, body: Buffer): AuthResult {
  const pre = preauthenticate(store, req);
  if (!pre.ok) return pre;
  const deviceId = pre.deviceId!;
  const timestamp = header(req, "x-vm-timestamp")!;
  const signature = header(req, "x-vm-signature")!;
  const device = store.getDevice(deviceId)!;
  let key: KeyObject;
  try {
    key = publicKeyFromX963(device.public_key);
  } catch {
    return { ok: false, reason: "bad stored key" };
  }
  const message = signingString(req.method ?? "GET", req.url ?? "/", timestamp, sha256Hex(body));
  let valid = false;
  try {
    valid = cryptoVerify("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  store.touchDevice(deviceId);
  return { ok: true, deviceId };
}

export function newPairingCode(): string {
  // Six digits, typed on the phone; from the CSPRNG, since a guessable code is the whole wall on an open Wi-Fi.
  return String(randomInt(100000, 1000000));
}
