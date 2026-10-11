// The single entry point the voice bridge calls for calendar tools.
//   const call = await runTool(callSid, name, args);   // never throws
//   recorder.addToolCall(call.name, call.args, call.result);  -> the teacher sees it in the tool trace
//   send call.result back to Gemini as the function response
// The permission for each tool comes from the ACTIVE config version, which only the teacher and the owner change.

import { Type, type FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { cols, getActiveConfig, getWorkspace } from "../mongo/client.js";
import type { AppointmentDoc, ToolCall, ToolName, WorkspaceDoc } from "../mongo/types.js";
import * as google from "./calendar.js";
import { checkSlot, freeSlots, overlaps, type Busy, type Slot } from "./time.js";

/** The two calendar calls the gateway needs. Replaced by a fake in offline tests. */
export interface CalendarApi {
  checkAvailability: typeof google.checkAvailability;
  createEvent: typeof google.createEvent;
}
export interface GatewayDeps { calendar: CalendarApi; now: () => Date }
const REAL: GatewayDeps = { calendar: google, now: () => new Date() };

const time = { staff: z.string().trim().min(1), start: z.string().trim().min(1), duration_minutes: z.coerce.number().int().min(15).max(240).default(60) };
const ARGS = {
  check_availability: z.object(time),
  book_appointment: z.object({
    ...time,
    service: z.string().trim().min(1).max(120),
    customer_name: z.string().trim().min(1).max(120),
    customer_phone: z.string().trim().min(5).max(40),
    customer_email: z.string().trim().email().optional(),
    caller_confirmed: z.boolean(),
  }),
};

type Result = Record<string, unknown> & { ok: boolean };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runTool(callId: string, tool: string, args: unknown, deps: GatewayDeps = REAL): Promise<ToolCall> {
  try {
    const result = await run(callId, tool, args, deps);
    return { name: tool, args, result, ...(typeof result.error === "string" ? { error: result.error } : {}) };
  } catch (e) {
    const error = errorText(e);
    return { name: tool, args, result: { ok: false, error }, error };
  }
}

async function run(callId: string, tool: string, rawArgs: unknown, deps: GatewayDeps): Promise<Result> {
  if (tool !== "check_availability" && tool !== "book_appointment") return { ok: false, reason: "unknown_tool" };
  const parsed = ARGS[tool].safeParse(rawArgs);
  if (!parsed.success)
    return { ok: false, reason: "invalid_args", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const args = parsed.data;

  const cfg = await getActiveConfig();
  const permission = cfg.tools[tool];
  if (permission === "disabled") return { ok: false, reason: "tool_disabled" };

  const ws = await getWorkspace();
  if (!ws?.staff.length) return { ok: false, reason: "calendar_not_set_up" };
  const staff = findStaff(ws, args.staff);
  if (!staff) return { ok: false, reason: "unknown_staff", staff: ws.staff.map((s) => s.name) };
  const slot = checkSlot(args.start, args.duration_minutes, ws.timezone, ws.business_hours, deps.now());
  if (!slot.ok) return { ...slot };

  if (tool === "check_availability") {
    // Availability has nothing for an owner to approve, so only "auto" runs it.
    if (permission !== "auto") return { ok: false, reason: "requires_approval" };
    const busy = await dayBusy(ws, staff.calendar_id, slot, deps);
    const free = !overlaps(busy, slot.start, slot.end);
    return {
      ok: true, staff: staff.name, start: slot.start, end: slot.end, free,
      busy: busy.filter((b) => b.start < slot.end && b.end > slot.start),
      ...(free ? {} : { next_free: freeSlots(busy, slot, args.duration_minutes, slot.start) }),
    };
  }

  const book = args as z.infer<typeof ARGS.book_appointment>;
  // Nothing is booked or queued unless the agent states that the caller confirmed the date and time.
  // The teacher checks that claim against the transcript afterwards.
  if (!book.caller_confirmed) return { ok: false, reason: "not_confirmed" };

  const c = await cols();
  const appointment: AppointmentDoc = {
    _id: `${callId}_apt${(await c.appointments.countDocuments({ call_id: callId })) + 1}`,
    call_id: callId, staff_id: staff.id, customer_name: book.customer_name, customer_phone: book.customer_phone,
    ...(book.customer_email ? { customer_email: book.customer_email } : {}),
    service: book.service, start: slot.start, end: slot.end, status: "awaiting_approval",
    config_version_id: cfg._id, created_at: deps.now(),
  };

  if (permission === "requires_approval") {
    await c.appointments.insertOne(appointment);
    return { ok: true, queued: true, appointment_id: appointment._id, staff: staff.name, start: slot.start, end: slot.end };
  }
  return createBooking(ws, appointment, slot, deps, (doc) => c.appointments.insertOne(doc));
}

function findStaff(ws: WorkspaceDoc, name: string) {
  const q = name.trim().toLowerCase();
  return ws.staff.find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q)
    ?? ws.staff.find((s) => s.name.toLowerCase().split(" ")[0] === q);
}

/** Busy periods for the whole business day, so alternatives can be offered from one query. */
function dayBusy(ws: WorkspaceDoc, calendarId: string, slot: Slot, deps: GatewayDeps): Promise<Busy> {
  return deps.calendar.checkAvailability(calendarId, slot.open, slot.close, ws.timezone).then((r) => r.busy);
}

/**
 * Checks the slot again, creates the event, and saves the appointment with its final status.
 * An API failure is saved as status "failed" with the error. Nothing is ever reported as booked without an event id.
 */
async function createBooking(
  ws: WorkspaceDoc, appointment: AppointmentDoc, slot: Slot, deps: GatewayDeps, save: (doc: AppointmentDoc) => Promise<unknown>,
): Promise<Result> {
  const staff = ws.staff.find((s) => s.id === appointment.staff_id);
  if (!staff) return { ok: false, reason: "unknown_staff" };
  const minutes = (Date.parse(appointment.end + ":00Z") - Date.parse(appointment.start + ":00Z")) / 60_000;
  try {
    const busy = await dayBusy(ws, staff.calendar_id, slot, deps);
    if (overlaps(busy, slot.start, slot.end))
      return { ok: false, reason: "slot_taken", next_free: freeSlots(busy, slot, minutes, slot.start) };
    const event = await deps.calendar.createEvent({
      calendarId: staff.calendar_id, startISO: slot.start, endISO: slot.end, timezone: ws.timezone,
      summary: `${appointment.service}: ${appointment.customer_name}`,
      description: `Booked by the phone receptionist.\nPhone: ${appointment.customer_phone}\nCall: ${appointment.call_id}`,
      ...(appointment.customer_email ? { attendeeEmail: appointment.customer_email } : {}),
      rules: { timezone: ws.timezone, hours: ws.business_hours, now: deps.now() },
    });
    await save({ ...appointment, status: "booked", event_id: event.eventId, event_link: event.htmlLink });
    return {
      ok: true, booked: true, appointment_id: appointment._id, staff: staff.name,
      start: slot.start, end: slot.end, event_link: event.htmlLink,
    };
  } catch (e) {
    const error = errorText(e);
    await save({ ...appointment, status: "failed", error });
    return { ok: false, error, appointment_id: appointment._id };
  }
}

/** Owner approves a queued appointment. The slot is checked again before the event is created. */
export async function approveAppointment(id: string, deps: GatewayDeps = REAL): Promise<Result> {
  try {
    const c = await cols();
    const appointment = await c.appointments.findOne({ _id: id });
    if (!appointment || appointment.status !== "awaiting_approval") return { ok: false, reason: "not_awaiting_approval" };
    const save = (doc: AppointmentDoc) => c.appointments.replaceOne({ _id: id }, doc);
    const ws = await getWorkspace();
    if (!ws) return { ok: false, reason: "calendar_not_set_up" };
    const minutes = (Date.parse(appointment.end + ":00Z") - Date.parse(appointment.start + ":00Z")) / 60_000;
    const slot = checkSlot(appointment.start, minutes, ws.timezone, ws.business_hours, deps.now());
    if (!slot.ok) {
      await save({ ...appointment, status: "failed", error: slot.reason });
      return { ...slot };
    }
    const result = await createBooking(ws, appointment, slot, deps, save);
    if (result.reason === "slot_taken") await save({ ...appointment, status: "failed", error: "slot_taken" });
    return result;
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function rejectAppointment(id: string): Promise<Result> {
  try {
    const res = await (await cols()).appointments.updateOne(
      { _id: id, status: "awaiting_approval" }, { $set: { status: "rejected" } });
    return res.modifiedCount ? { ok: true, appointment_id: id } : { ok: false, reason: "not_awaiting_approval" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Gemini function declarations for the bridge to register. Staff names go in the description so the agent knows them. */
export function toolDeclarations(ws: Pick<WorkspaceDoc, "staff" | "timezone">): FunctionDeclaration[] {
  const staff = ws.staff.map((s) => s.name).join(", ") || "(none set up)";
  const when = {
    staff: { type: Type.STRING, description: `Staff member's name. One of: ${staff}` },
    start: { type: Type.STRING, description: `Local start time as YYYY-MM-DDTHH:MM (24-hour, ${ws.timezone})` },
    duration_minutes: { type: Type.INTEGER, description: "Length in minutes. Default 60." },
  };
  return [
    {
      name: "check_availability" satisfies ToolName,
      description: "Check whether a staff member is free at a time. If not, the result lists the next free times that day.",
      parameters: { type: Type.OBJECT, properties: when, required: ["staff", "start"] },
    },
    {
      name: "book_appointment" satisfies ToolName,
      description:
        "Book an appointment. First repeat the staff member, date and time back to the caller and wait for a clear yes; " +
        "only then call this with caller_confirmed true. If the result has queued: true, tell the caller the owner will confirm the booking. " +
        "If it has reason slot_taken, offer the times in next_free.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          ...when,
          service: { type: Type.STRING, description: "What the appointment is for" },
          customer_name: { type: Type.STRING, description: "Caller's name" },
          customer_phone: { type: Type.STRING, description: "Callback phone number" },
          customer_email: { type: Type.STRING, description: "Email for the calendar invite, only if the caller gives one" },
          caller_confirmed: { type: Type.BOOLEAN, description: "True only after the caller said yes to this exact date and time" },
        },
        required: ["staff", "start", "service", "customer_name", "customer_phone", "caller_confirmed"],
      },
    },
  ];
}

