// Google Calendar via the REST API with a service account (no extra dependency).
// Setup: create a service account, share the target calendar with its email ("Make changes to events"),
// then set GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_JSON (the key file contents, as one line).
import { createSign } from "crypto";
import type { CalendarProvider, EventContext } from "./provider";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3/calendars";
const TIMEOUT_MS = 6000;

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function createGoogleCalendar(): CalendarProvider | null {
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!calendarId || !raw) return null;
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) throw new Error("missing client_email or private_key");
  } catch (err) {
    console.error("[calendar] GOOGLE_SERVICE_ACCOUNT_JSON is invalid, calendar sync is off:", err instanceof Error ? err.message : err);
    return null;
  }

  let token: { value: string; expires: number } | null = null;
  async function accessToken(): Promise<string> {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const claim = b64(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${claim}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64(sig)}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
    return token.value;
  }

  const body = (c: EventContext) => ({
    summary: c.summary,
    description: c.description,
    start: { dateTime: c.start, timeZone: c.timezone },
    end: { dateTime: c.end, timeZone: c.timezone },
  });

  async function call(method: string, path: string, payload?: unknown): Promise<Response> {
    const res = await fetch(`${API}/${encodeURIComponent(calendarId!)}/events${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok && !(method === "DELETE" && (res.status === 404 || res.status === 410))) throw new Error(`Google Calendar ${method} failed: HTTP ${res.status}`);
    return res;
  }

  console.log(`[calendar] Google Calendar sync on (${calendarId})`);
  return {
    name: "google",
    async createEvent(_appt, ctx) {
      return ((await (await call("POST", "", body(ctx))).json()) as { id: string }).id;
    },
    async updateEvent(eventId, _appt, ctx) {
      await call("PATCH", `/${encodeURIComponent(eventId)}`, body(ctx));
    },
    async deleteEvent(eventId) {
      await call("DELETE", `/${encodeURIComponent(eventId)}`);
    },
  };
}
