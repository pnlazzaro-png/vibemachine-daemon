// Crash and hang reports from the phone: MetricKit payloads, kept one file
// each under DATA_DIR/diagnostics (named by a hash of the payload, so the
// copies the phone sends again at each launch are kept once). Symbolicate a
// crash's frames against the archive's dSYM with `atos -arch arm64 -o
// <dSYM>/Contents/Resources/DWARF/VibeMachine -l <loadAddress> <address>`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const diagnosticsDir = path.join(config.dataDir, "diagnostics");

type Json = Record<string, unknown>;

/** One line about a payload: what crashed, on which build. */
export function summarize(payload: Json): string {
  const parts: string[] = [];
  for (const crash of (payload.crashDiagnostics as Json[] | undefined) ?? []) {
    const meta = (crash.diagnosticMetaData ?? {}) as Json;
    const what = [meta.exceptionType !== undefined ? `exception ${String(meta.exceptionType)}` : null, meta.signal !== undefined ? `signal ${String(meta.signal)}` : null, typeof meta.terminationReason === "string" ? meta.terminationReason : null]
      .filter(Boolean)
      .join(", ");
    parts.push(`crash (${what || "no reason given"}) in build ${String(meta.bundleIdentifier ?? "?")} ${String(meta.appBuildVersion ?? "?")}`);
  }
  for (const key of ["hangDiagnostics", "cpuExceptionDiagnostics", "diskWriteExceptionDiagnostics", "appLaunchDiagnostics"]) {
    const n = ((payload[key] as unknown[] | undefined) ?? []).length;
    if (n > 0) parts.push(`${n} ${key.replace("Diagnostics", "")}`);
  }
  return parts.join("; ") || "no diagnostics";
}

/** Keeps a payload; null when this exact one was kept before. */
export function saveDiagnostic(payload: Json, deviceId: string, dir = diagnosticsDir): { file: string; summary: string } | null {
  const text = JSON.stringify(payload);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).some((f) => f.endsWith(`-${hash}.json`))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${hash}.json`);
  fs.writeFileSync(file, JSON.stringify({ device_id: deviceId, received_at: new Date().toISOString(), payload }, null, 2));
  return { file, summary: summarize(payload) };
}
