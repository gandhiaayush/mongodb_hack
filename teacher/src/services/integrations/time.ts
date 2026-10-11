// Pure time helpers for the calendar integration. No database, no network.
// The voice agent and the appointments collection use local wall-clock times ("YYYY-MM-DDTHH:MM")
// in the workspace time zone; Google gets UTC instants.

import type { BusinessHours, Weekday } from "../mongo/types.js";

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const DAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock time in `tz` for an instant, as "YYYY-MM-DDTHH:MM". */
export function utcToLocal(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The instant at which the clocks in `tz` show the given local time. */
export function localToUtc(local: string, tz: string): Date {
  const m = LOCAL.exec(local);
  if (!m) throw new Error(`not a local time: ${local}`);
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  const offsetAt = (t: number) => localToWall(utcToLocal(new Date(t), tz)) - t;
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc); // second pass settles times next to a daylight-saving change
  return new Date(utc);
}
const localToWall = (local: string) => {
  const m = LOCAL.exec(local)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
};

/** Accepts a local time, or an ISO time with an offset or Z, and returns the local time in `tz`. */
export function toLocal(input: string, tz: string): string | null {
  const m = LOCAL.exec(input.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : utcToLocal(new Date(t), tz);
}

export function weekdayOf(local: string): Weekday {
  return DAYS[new Date(localToWall(local.slice(0, 10) + "T00:00")).getUTCDay()]!;
}

export function addMinutes(local: string, minutes: number): string {
  const d = new Date(localToWall(local) + minutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export type Slot = { start: string; end: string; open: string; close: string }; // all local
export type SlotCheck =
  | ({ ok: true } & Slot)
  | { ok: false; reason: "bad_time" | "in_the_past" | "outside_business_hours"; hours?: [string, string] | null };

/** A slot must parse, be in the future, and sit inside that day's business hours. */
export function checkSlot(startInput: string, minutes: number, tz: string, hours: BusinessHours, now: Date): SlotCheck {
  const start = toLocal(startInput, tz);
  if (!start || !(minutes > 0)) return { ok: false, reason: "bad_time" };
  const end = addMinutes(start, minutes);
  if (localToUtc(start, tz).getTime() <= now.getTime()) return { ok: false, reason: "in_the_past" };
  const day = hours[weekdayOf(start)];
  if (!day) return { ok: false, reason: "outside_business_hours", hours: null };
  const open = `${start.slice(0, 10)}T${day[0]}`, close = `${start.slice(0, 10)}T${day[1]}`;
  if (start < open || end > close) return { ok: false, reason: "outside_business_hours", hours: day };
  return { ok: true, start, end, open, close };
}

export type Busy = { start: string; end: string }[]; // local times

export const overlaps = (busy: Busy, start: string, end: string) => busy.some((b) => b.start < end && b.end > start);

/** The next `count` free start times that day, on a 30-minute grid, at or after `from`. */
export function freeSlots(busy: Busy, slot: Slot, minutes: number, from: string, count = 3): string[] {
  const out: string[] = [];
  let t = slot.open;
  while (out.length < count && addMinutes(t, minutes) <= slot.close) {
    if (t >= from && !overlaps(busy, t, addMinutes(t, minutes))) out.push(t);
    t = addMinutes(t, 30);
  }
  return out;
}

/** First business day strictly after `now`, at the given local hour. Used by the demo and the check script. */
export function nextOpenDayAt(hhmm: string, tz: string, hours: BusinessHours, now: Date): string {
  let day = utcToLocal(now, tz).slice(0, 10) + "T00:00";
  for (let i = 0; i < 14; i++) {
    day = addMinutes(day, 24 * 60);
    if (hours[weekdayOf(day)]) return `${day.slice(0, 10)}T${hhmm}`;
  }
  throw new Error("business_hours has no open day");
}
