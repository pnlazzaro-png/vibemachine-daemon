// Reaching the daemon on the same Wi-Fi, without Tailscale. With LAN=1 a
// second listener serves the same routes over HTTPS on LAN_PORT (3006) on
// every interface, under a self-signed certificate made once and kept in
// DATA_DIR/tls. The phone learns the certificate's SHA-256 fingerprint from
// the pairing QR code and pins it, so the link is encrypted and only this
// Mac's certificate is accepted; the Mac is found by its Bonjour name
// (<LocalHostName>.local), which follows it from address to address.
//
// The pairing link the QR code carries:
//   vibemachine://pair?s=<server URL>&c=<6-digit code>[&fp=<sha256 hex>]
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

export interface Tls {
  key: Buffer;
  cert: Buffer;
  /** SHA-256 of the certificate (DER), lowercase hex without colons: what the phone pins. */
  fingerprint: string;
}

/** The Mac's Bonjour name, e.g. "Sams-MacBook.local". */
export function localHostName(): string {
  try {
    const name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
    if (name) return `${name}.local`;
  } catch {
    /* not macOS, or scutil missing */
  }
  const host = os.hostname();
  return host.endsWith(".local") ? host : `${host}.local`;
}

export function fingerprintOf(certPem: Buffer | string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();
}

/** The certificate, made on first use (P-256, ten years, named for the Bonjour host). */
export function ensureTls(dir = path.join(config.dataDir, "tls"), host = localHostName()): Tls {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("/usr/bin/openssl", [
      // A named curve: macOS's LibreSSL otherwise writes the curve out in full, which Apple's TLS refuses ("decode error").
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-days", "3650",
      "-subj", "/CN=Vibe Machine", "-addext", `subjectAltName=DNS:${host},DNS:localhost`,
      "-keyout", keyFile, "-out", certFile,
    ], { stdio: "ignore" });
    fs.chmodSync(keyFile, 0o600);
  }
  const cert = fs.readFileSync(certFile);
  return { key: fs.readFileSync(keyFile), cert, fingerprint: fingerprintOf(cert) };
}

/** The address the phone uses on the Wi-Fi. */
export function lanAddress(host = localHostName()): string {
  return `https://${host}:${config.lanPort}`;
}

export function pairingLink(server: string, code: string, fingerprint?: string): string {
  const q = new URLSearchParams({ s: server, c: code });
  if (fingerprint) q.set("fp", fingerprint);
  return `vibemachine://pair?${q.toString()}`;
}

/** The link as a QR code in the terminal, small enough for an 80-column window. */
export async function printQr(link: string): Promise<void> {
  const mod = (await import("qrcode-terminal")) as unknown as { default?: QrTerminal } & QrTerminal;
  const qr = mod.default ?? mod;
  await new Promise<void>((resolve) => qr.generate(link, { small: true }, (code: string) => {
    console.log(code);
    resolve();
  }));
}

interface QrTerminal {
  generate(text: string, opts: { small: boolean }, cb: (code: string) => void): void;
}

/**
 * Wrong pairing codes: a handful per client per window, then nothing from that client until it
 * passes (a 6-digit code on an open Wi-Fi); and a wider limit over everyone, so a flood from many
 * addresses can't try them all. Clients are addresses; `*` is everyone.
 */
export class PairingGuard {
  private failures = new Map<string, number[]>();
  constructor(private readonly limit = 10, private readonly windowMs = 10 * 60_000, private readonly everyoneLimit = limit * 5) {}

  private recent(client: string, now: number): number[] {
    const kept = (this.failures.get(client) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.failures.delete(client);
    else this.failures.set(client, kept);
    return kept;
  }

  blocked(client = "*", now = Date.now()): boolean {
    if (this.recent("*", now).length >= this.everyoneLimit) return true;
    return client !== "*" && this.recent(client, now).length >= this.limit;
  }

  failed(client = "*", now = Date.now()): void {
    for (const key of client === "*" ? ["*"] : ["*", client]) this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }
}
