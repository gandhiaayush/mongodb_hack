// Google Calendar calls. Used only by the gateway (for the voice agent) and scripts/calendar-check.ts.
// The teacher never calls this file.
//
// Auth is OAuth2 with a refresh token (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN),
// not a service account, because a service account cannot invite attendees.

import "dotenv/config";
import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import type { BusinessHours } from "../mongo/types.js";
import { checkSlot, localToUtc, utcToLocal, type Busy } from "./time.js";

const ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;

export const missingCalendarEnv = () => ENV.filter((k) => !process.env[k]?.trim());

/** When given, times are checked against the workspace's clock and business hours before any API call. */
export interface SlotRules { timezone: string; hours: BusinessHours; now?: Date }

let client: calendar_v3.Calendar | null = null;
function api(): calendar_v3.Calendar {
  const missing = missingCalendarEnv();
  if (missing.length) throw new Error(`Google Calendar is not configured: set ${missing.join(", ")} in .env`);
  if (!client) {
    const oauth = new auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    client = calendar({ version: "v3", auth: oauth });
  }
  return client;
}

/** Google errors can echo request details; keep only the message. */
function fail(what: string, e: unknown): never {
  throw new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`);
}

function assertSlot(startISO: string, endISO: string, timezone: string, rules?: SlotRules) {
  if (!rules) return;
  const minutes = (localToUtc(endISO, timezone).getTime() - localToUtc(startISO, timezone).getTime()) / 60_000;
  const check = checkSlot(startISO, minutes, rules.timezone, rules.hours, rules.now ?? new Date());
  if (!check.ok) throw new Error(`time rejected: ${check.reason}`);
}

/**
 * Free/busy for one calendar between two local times ("YYYY-MM-DDTHH:MM" in `timezone`).
 * Busy periods come back as local times in the same zone.
 */
export async function checkAvailability(
  calendarId: string, startISO: string, endISO: string, timezone = "America/Los_Angeles", rules?: SlotRules,
): Promise<{ free: boolean; busy: Busy }> {
  assertSlot(startISO, endISO, timezone, rules);
  const cal = api();
  let res;
  try {
    res = await cal.freebusy.query({
      requestBody: {
        timeMin: localToUtc(startISO, timezone).toISOString(), timeMax: localToUtc(endISO, timezone).toISOString(),
        timeZone: timezone, items: [{ id: calendarId }],
      },
    });
  } catch (e) { fail("freebusy query failed", e); }
  // Keyed by the id that was asked for; if Google answers under another id (an alias), take the only entry.
  const all = res.data.calendars ?? {};
  const found = all[calendarId] ?? (Object.keys(all).length === 1 ? Object.values(all)[0] : undefined);
  if (!found) throw new Error(`freebusy query returned nothing for calendar ${calendarId}`);
  if (found.errors?.length) throw new Error(`calendar ${calendarId}: ${found.errors.map((x) => x.reason).join(", ")}`);
  const busy = (found.busy ?? []).flatMap((b) => b.start && b.end
    ? [{ start: utcToLocal(new Date(b.start), timezone), end: utcToLocal(new Date(b.end), timezone) }] : []);
  return { free: busy.length === 0, busy };
}

/** Creates an event. With `attendeeEmail`, the person is added as an attendee and Google emails the invite. */
export async function createEvent(input: {
  calendarId: string; startISO: string; endISO: string; summary: string;
  description?: string; attendeeEmail?: string; timezone?: string; rules?: SlotRules;
}): Promise<{ eventId: string; htmlLink: string }> {
  const timezone = input.timezone ?? "America/Los_Angeles";
  assertSlot(input.startISO, input.endISO, timezone, input.rules);
  const cal = api();
  let res;
  try {
    res = await cal.events.insert({
      calendarId: input.calendarId,
      sendUpdates: input.attendeeEmail ? "all" : "none",
      requestBody: {
        summary: input.summary,
        ...(input.description ? { description: input.description } : {}),
        start: { dateTime: `${input.startISO}:00`, timeZone: timezone },
        end: { dateTime: `${input.endISO}:00`, timeZone: timezone },
        ...(input.attendeeEmail ? { attendees: [{ email: input.attendeeEmail }] } : {}),
      },
    });
  } catch (e) { fail("event insert failed", e); }
  if (!res.data.id) throw new Error("event insert returned no event id");
  return { eventId: res.data.id, htmlLink: res.data.htmlLink ?? "" };
}
