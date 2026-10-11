import type { Appointment } from "../data/shop";
import { windowRange, type StoreHours } from "../data/shop";
import { createGoogleCalendar } from "./googleCalendar";

/**
 * A calendar the owner already uses. Atlas stays the source of truth for availability;
 * the calendar gets a copy of each booking so the owner sees pickups where they already look.
 * A provider failure never fails a booking (the caller is on the phone).
 */
export interface CalendarProvider {
  name: string;
  createEvent(appt: Appointment, ctx: EventContext): Promise<string>; // returns the external event id
  updateEvent(eventId: string, appt: Appointment, ctx: EventContext): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface EventContext {
  summary: string;
  description: string;
  start: string; // local ISO without offset, e.g. 2026-10-14T12:00:00
  end: string;
  timezone: string;
}

export function eventContext(appt: Appointment, hours: StoreHours, customerName: string): EventContext {
  const range = windowRange(hours, appt.date, appt.window) ?? ["09:00", "10:00"];
  const label = appt.type === "delivery" ? "Delivery" : "Pickup";
  return {
    summary: `${label}: ${customerName} (${appt.orderId})`,
    description: [`${label} for ${appt.orderId}`, `Phone: ${appt.phone}`, appt.address ? `Address: ${appt.address}` : "", `Booked by the phone assistant (${appt.appointmentId}).`].filter(Boolean).join("\n"),
    start: `${appt.date}T${range[0]}:00`,
    end: `${appt.date}T${range[1]}:00`,
    timezone: hours.timezone,
  };
}

let cached: CalendarProvider | null | undefined;
export function getCalendar(): CalendarProvider | null {
  if (cached !== undefined) return cached;
  cached = createGoogleCalendar();
  return cached;
}

/** For tests and alternative providers. */
export function setCalendar(p: CalendarProvider | null): void {
  cached = p;
}
