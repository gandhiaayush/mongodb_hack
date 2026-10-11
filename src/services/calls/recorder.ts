import type { CallRecord, DataStore } from "../data/store";

const SAVE_INTERVAL_MS = 2000;

// Active calls are kept in memory so the dashboard can see live transcripts
const activeCalls = new Map<string, CallRecord>();

export function getActiveCalls(): CallRecord[] {
  return [...activeCalls.values()].map((c) => structuredClone(c));
}

export class CallRecorder {
  private record: CallRecord;
  private lastSave = 0;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private lastRole: "caller" | "agent" | null = null;

  constructor(private store: DataStore, callSid: string, from?: string) {
    this.record = {
      callSid,
      ...(from ? { from } : {}),
      startedAt: new Date().toISOString(),
      transcript: [],
      toolCalls: [],
      status: "active",
    };
    activeCalls.set(callSid, this.record);
  }

  setConfigVersion(version: number): void {
    if (this.ended) return;
    this.record.configVersion = version;
    this.scheduleSave();
  }

  async start(): Promise<void> {
    await this.flush();
  }

  addTranscript(role: "caller" | "agent", text: string): void {
    if (this.ended || !text) return;
    const last = this.record.transcript[this.record.transcript.length - 1];
    if (last && this.lastRole === role) {
      last.text += text;
    } else {
      this.record.transcript.push({ role, text, ts: new Date().toISOString() });
    }
    this.lastRole = role;
    this.scheduleSave();
  }

  addToolCall(name: string, args: Record<string, unknown>, result: unknown): void {
    if (this.ended) return;
    this.record.toolCalls.push({ name, args, result, ts: new Date().toISOString() });
    this.scheduleSave();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const endedAt = new Date();
    this.record.endedAt = endedAt.toISOString();
    this.record.durationSec = Math.round((endedAt.getTime() - Date.parse(this.record.startedAt)) / 1000);
    this.record.status = "completed";
    activeCalls.delete(this.record.callSid);
    await this.flush();
  }

  private scheduleSave(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastSave + SAVE_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.ended) void this.flush();
    }, wait);
  }

  // Saves are chained so they land in order: a periodic save still in flight when the call ends can
  // no longer overwrite the final "completed" save (which left calls stuck as "active" and never graded)
  private queue: Promise<void> = Promise.resolve();

  private flush(): Promise<void> {
    this.lastSave = Date.now();
    const snapshot = structuredClone(this.record);
    this.queue = this.queue
      .then(() => this.store.saveCall(snapshot))
      .catch((err) => {
        console.error(`[${this.record.callSid}] Failed to save call:`, err);
      });
    return this.queue;
  }
}
