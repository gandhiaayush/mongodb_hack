// Shop-domain types and pure logic (hours, turnaround, quotes). No database access here,
// so the in-memory and MongoDB stores share exactly the same rules.

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const DAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface DayHours {
  day: Weekday;
  closed?: boolean;
  open?: string; // "08:00"
  close?: string; // "18:00"
}

/** `store_hours` collection, one document `_id: "main"`. Owner-maintained. */
export interface StoreHours {
  _id?: "main";
  timezone: string; // IANA, e.g. America/Los_Angeles
  address: string;
  phone: string;
  weekly: DayHours[];
  exceptions: { date: string; closed?: boolean; open?: string; close?: string; reason?: string }[];
  /** Bookings allowed per window (pickups and deliveries together). Defaults to DEFAULT_CAPACITY. */
  slotCapacity?: Partial<Record<AppointmentWindow, number>>;
}

export interface HoursForDate {
  date: string;
  weekday: Weekday;
  isOpen: boolean;
  opens?: string;
  closes?: string;
  reason?: string;
}

/** `customers` collection, keyed by normalized phone. */
export interface Customer {
  phone: string;
  name: string;
  email?: string;
  preferences: { starch?: "none" | "light" | "medium" | "heavy"; hangers?: boolean; notes?: string };
  orderCount: number;
  lastOrderId?: string;
  createdAt: string;
}

export interface OrderItem {
  item: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  notes?: string;
}

export interface StageEvent {
  stage: string;
  at: string;
}

export type AppointmentType = "pickup" | "delivery";
export type AppointmentWindow = "morning" | "afternoon" | "evening";

/** `appointments` collection: customer pickups and home deliveries. */
export interface Appointment {
  appointmentId: string;
  type: AppointmentType;
  orderId: string;
  phone: string;
  date: string;
  window: AppointmentWindow;
  address?: string;
  status: "scheduled" | "completed" | "cancelled";
  createdAt: string;
  updatedAt?: string;
  // Calendar sync. Atlas is the source of truth; the calendar copy is best effort.
  externalEventId?: string;
  calendarSync?: "synced" | "failed" | "off";
}

export const WINDOWS: AppointmentWindow[] = ["morning", "afternoon", "evening"];

export function localToday(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function localTime(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function hoursFor(h: StoreHours, date: string): HoursForDate {
  const weekday = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  const ex = h.exceptions.find((e) => e.date === date);
  if (ex) {
    const open = !ex.closed && !!ex.open && !!ex.close;
    return { date, weekday, isOpen: open, ...(open ? { opens: ex.open, closes: ex.close } : {}), ...(ex.reason ? { reason: ex.reason } : {}) };
  }
  const w = h.weekly.find((d) => d.day === weekday);
  const open = !!w && !w.closed && !!w.open && !!w.close;
  return { date, weekday, isOpen: open, ...(open ? { opens: w!.open, closes: w!.close } : {}) };
}

export function nextOpenDate(h: StoreHours, from: string, includeFrom = false): string {
  let d = includeFrom ? from : addDays(from, 1);
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) if (hoursFor(h, d).isOpen) return d;
  return d;
}

/** The date a drop-off made today is ready: `days` open days later. */
export function readyBy(h: StoreHours, today: string, days: number): string {
  let d = today;
  for (let n = 0; n < days; n++) d = nextOpenDate(h, d);
  return d;
}

// ---- Pickup slots -----------------------------------------------------------------------------

export const DEFAULT_CAPACITY = 4;

/** Nominal window times. A window is only offered if it overlaps the store's open hours that day. */
export const WINDOW_TIMES: Record<AppointmentWindow, [string, string]> = {
  morning: ["08:00", "12:00"],
  afternoon: ["12:00", "16:00"],
  evening: ["16:00", "20:00"],
};

export interface SlotInfo {
  window: AppointmentWindow;
  start: string; // clipped to opening hours
  end: string;
  capacity: number;
  booked: number;
  available: number;
}

export function capacityFor(h: StoreHours, w: AppointmentWindow): number {
  return h.slotCapacity?.[w] ?? DEFAULT_CAPACITY;
}

/** The window as actually served on a day: clipped to opening hours, or null if the store is closed then. */
export function windowRange(h: StoreHours, date: string, w: AppointmentWindow): [string, string] | null {
  const day = hoursFor(h, date);
  if (!day.isOpen) return null;
  const [ws, we] = WINDOW_TIMES[w];
  const start = ws > day.opens! ? ws : day.opens!;
  const end = we < day.closes! ? we : day.closes!;
  return start < end ? [start, end] : null;
}

/** Slots for one date given how many bookings each window already has. */
export function slotsFor(h: StoreHours, date: string, booked: Partial<Record<AppointmentWindow, number>>): SlotInfo[] {
  const out: SlotInfo[] = [];
  for (const w of WINDOWS) {
    const r = windowRange(h, date, w);
    if (!r) continue;
    const capacity = capacityFor(h, w);
    const b = booked[w] ?? 0;
    out.push({ window: w, start: r[0], end: r[1], capacity, booked: b, available: Math.max(capacity - b, 0) });
  }
  return out;
}
