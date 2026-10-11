// Live check of the Google Calendar connection. Reads free/busy for the next 3 hours,
// then creates a real test event one hour from now and prints its link.
//   npm run calendar:check [calendarId]     (default: GOOGLE_CALENDAR_ID, else "primary")
import "dotenv/config";
import { checkAvailability, createEvent, missingCalendarEnv } from "../src/services/integrations/calendar.js";
import { addMinutes, utcToLocal } from "../src/services/integrations/time.js";

const missing = missingCalendarEnv();
if (missing.length) {
  console.error(`Google Calendar is not configured. Missing in .env: ${missing.join(", ")}\n` +
    "In Google Cloud Console: enable the Calendar API and create an OAuth client of type Web application with the\n" +
    "redirect URI https://developers.google.com/oauthplayground. Then use the OAuth Playground with your own\n" +
    "credentials to get a refresh token for the scope https://www.googleapis.com/auth/calendar.");
  process.exit(1);
}

const calendarId = process.argv[2] ?? process.env.GOOGLE_CALENDAR_ID?.trim() ?? "primary";
const tz = process.env.CALENDAR_TIMEZONE?.trim() || "America/Los_Angeles";
const now = utcToLocal(new Date(), tz);

try {
  // No business-hours rules here: this is a connection test and must work at any time of day.
  const { free, busy } = await checkAvailability(calendarId, now, addMinutes(now, 180), tz);
  console.log(`calendar ${calendarId}, ${now} to ${addMinutes(now, 180)} (${tz}): ${free ? "free" : "busy"}`);
  for (const b of busy) console.log(`  busy ${b.start} to ${b.end}`);
  const start = addMinutes(now, 60);
  const event = await createEvent({
    calendarId, startISO: start, endISO: addMinutes(start, 30), timezone: tz,
    summary: "Snoopy teacher: calendar test", description: "Created by npm run calendar:check. Safe to delete.",
  });
  console.log(`created test event at ${start}: ${event.htmlLink}`);
} catch (e) {
  console.error(`calendar check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
