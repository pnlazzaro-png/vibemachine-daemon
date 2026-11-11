// Decides who gets a push. Alerts go to every enrolled phone with a push
// token, except one that is watching the session over the WebSocket right
// now (the app only keeps the socket while it is on screen; the server
// checks that the phone still answers before it says so). The turn's Live
// Activity is started with the phone's push-to-start token, then driven by
// the activity's own token once the app has reported it.
import type { Store } from "./db.js";
import * as push from "./push.js";

/**
 * What a push is about. Each phone picks which it gets (Settings, Notifications; kept on the daemon,
 * `devices.push_kinds`). Pete, 2026-11-11: too many came (every build that failed); what matters is
 * a question waiting, a session that stopped (the usage limit, a failure), an upload that landed and
 * a turn that finished. A turn he interrupts himself, or an upload stopped for a newer prompt,
 * isn't news to anyone and is never pushed.
 */
export type PushKind = "permission" | "turn_done" | "stopped" | "shipped" | "build_failed";

export const PUSH_KINDS: readonly PushKind[] = ["permission", "turn_done", "stopped", "shipped", "build_failed"];

/** What a phone gets until it says otherwise. */
export const PUSH_DEFAULTS: Readonly<Record<PushKind, boolean>> = {
  permission: true,
  turn_done: true,
  stopped: true,
  shipped: true,
  build_failed: false,
};

/** A phone's choices: its own where it has said, the defaults elsewhere. Anything unreadable is the defaults. */
export function pushKinds(stored: string | null | undefined): Record<PushKind, boolean> {
  const kinds = { ...PUSH_DEFAULTS };
  if (!stored) return kinds;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    for (const kind of PUSH_KINDS) if (typeof parsed[kind] === "boolean") kinds[kind] = parsed[kind];
  } catch {
    // Left as the defaults.
  }
  return kinds;
}

export interface Notification {
  sessionId: string;
  kind: PushKind;
  title: string;
  body: string;
  requestId?: string;
}

export type ActivityEvent =
  | { sessionId: string; event: "start"; attributes: Record<string, unknown>; state: Record<string, unknown>; alert?: { title: string; body: string }; quiet?: boolean }
  | { sessionId: string; event: "update" | "end"; state: Record<string, unknown>; alert?: { title: string; body: string }; alertKind?: PushKind; dismissAt?: Date; urgent?: boolean };

/** The content an orphaned activity is ended with; it is dismissed at once, so it never shows. */
const ORPHAN_STATE = { stage: "done", status: "stopped", tokens: 0, output: 0, startedAt: 0, lit: [], detail: "" };

export class Notifier {
  constructor(
    private readonly store: Store,
    /** Is this device subscribed to the session on a socket it still answers on? */
    private readonly watching: (deviceId: string, sessionId: string) => boolean | Promise<boolean>,
    /** Swappable so tests never reach Apple. */
    private readonly transport: push.Transport = push.http2Transport,
  ) {}

  get enabled(): boolean {
    return push.pushConfigured();
  }

  async notify(n: Notification): Promise<void> {
    if (!this.enabled) return;
    for (const d of this.store.pushDevices()) {
      if (!d.push_token || !pushKinds(d.push_kinds)[n.kind] || (await this.watching(d.id, n.sessionId))) continue;
      const r = await push.sendAlert(d.push_token, push.environmentFrom(d.push_environment), { title: n.title, body: n.body, sessionId: n.sessionId, ...(n.requestId ? { requestId: n.requestId } : {}) }, this.transport);
      this.record(d.id, d.name, "alert", r, () => this.store.setPushToken(d.id, null, null));
    }
  }

  async activity(a: ActivityEvent): Promise<void> {
    if (!this.enabled) return;
    const tokens = new Map(this.store.activityTokens(a.sessionId).map((t) => [t.device_id, t]));
    for (const d of this.store.pushDevices()) {
      const existing = tokens.get(d.id);
      if (a.event === "start") {
        if (existing) {
          // Already on the Lock Screen (an end that never landed): move it along instead.
          const r = await push.updateLiveActivity(existing.token, push.environmentFrom(existing.environment), { event: "update", state: a.state, ...(a.alert ? { alert: a.alert } : {}) }, this.transport);
          this.record(d.id, d.name, "activity", r, () => this.store.clearActivityToken(d.id, a.sessionId));
        } else if (d.activity_start_token) {
          const r = await push.startLiveActivity(d.activity_start_token, push.environmentFrom(d.push_environment), { attributes: a.attributes, state: a.state, ...(a.alert ? { alert: a.alert } : {}), ...(a.quiet ? { quiet: true } : {}) }, this.transport);
          this.record(d.id, d.name, "activity start", r, () => this.store.setActivityStartToken(d.id, null));
        }
        continue;
      }
      if (!existing) continue;
      // The card moves along whatever the phone picked; only its sound and banner are a push of a kind.
      const alert = a.alert && (!a.alertKind || pushKinds(d.push_kinds)[a.alertKind]) ? a.alert : undefined;
      const r = await push.updateLiveActivity(existing.token, push.environmentFrom(existing.environment), {
        event: a.event,
        state: a.state,
        ...(alert ? { alert } : {}),
        ...(a.dismissAt ? { dismissAt: a.dismissAt } : {}),
        ...(a.urgent ? { urgent: true } : {}),
      }, this.transport);
      this.record(d.id, d.name, "activity", r, () => this.store.clearActivityToken(d.id, a.sessionId));
      if (a.event === "end" && r.ok) this.store.clearActivityToken(d.id, a.sessionId);
    }
  }

  /**
   * At startup: every activity still on a Lock Screen belongs to a turn the last daemon was in when
   * it stopped. Nothing will move it along now; it is ended and dismissed at once.
   */
  async endOrphans(): Promise<void> {
    if (!this.enabled) return;
    const names = new Map(this.store.pushDevices().map((d) => [d.id, d.name]));
    for (const t of this.store.allActivityTokens()) {
      const r = await push.updateLiveActivity(t.token, push.environmentFrom(t.environment), { event: "end", state: ORPHAN_STATE, dismissAt: new Date() }, this.transport);
      if (!r.ok) this.record(t.device_id, names.get(t.device_id) ?? t.device_id, "activity end", r, () => {});
      this.store.clearActivityToken(t.device_id, t.session_id);
    }
  }

  private record(deviceId: string, name: string, what: string, r: push.SendResult, forget: () => void): void {
    if (r.ok) {
      this.store.setPushError(deviceId, null);
      return;
    }
    const error = `${what}: ${r.status || "no answer"}${r.reason ? ` ${r.reason}` : ""}`;
    console.warn(`[push] ${name}: ${error}${r.gone ? " (token dropped)" : ""}`);
    this.store.setPushError(deviceId, error);
    if (r.gone) forget();
  }
}
