// Decides who gets a push. Alerts go to every enrolled phone with a push
// token, except one that is watching the session over the WebSocket right
// now (the app only keeps the socket while it is on screen). The turn's Live
// Activity is started with the phone's push-to-start token, then driven by
// the activity's own token once the app has reported it.
import type { Store } from "./db.js";
import * as push from "./push.js";

export interface Notification {
  sessionId: string;
  title: string;
  body: string;
  requestId?: string;
}

export type ActivityEvent =
  | { sessionId: string; event: "start"; attributes: Record<string, unknown>; state: Record<string, unknown>; alert?: { title: string; body: string }; quiet?: boolean }
  | { sessionId: string; event: "update" | "end"; state: Record<string, unknown>; alert?: { title: string; body: string }; dismissAt?: Date; urgent?: boolean };

/** The content an orphaned activity is ended with; it is dismissed at once, so it never shows. */
const ORPHAN_STATE = { stage: "done", status: "stopped", tokens: 0, output: 0, startedAt: 0, lit: [], detail: "" };

export class Notifier {
  constructor(
    private readonly store: Store,
    /** Is this device subscribed to the session on an open socket? */
    private readonly watching: (deviceId: string, sessionId: string) => boolean,
    /** Swappable so tests never reach Apple. */
    private readonly transport: push.Transport = push.http2Transport,
  ) {}

  get enabled(): boolean {
    return push.pushConfigured();
  }

  async notify(n: Notification): Promise<void> {
    if (!this.enabled) return;
    for (const d of this.store.pushDevices()) {
      if (!d.push_token || this.watching(d.id, n.sessionId)) continue;
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
      const r = await push.updateLiveActivity(existing.token, push.environmentFrom(existing.environment), {
        event: a.event,
        state: a.state,
        ...(a.alert ? { alert: a.alert } : {}),
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
