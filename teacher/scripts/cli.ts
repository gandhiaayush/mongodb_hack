import { closeDb, cols, dbName, getWorkspace } from "../src/services/mongo/client.js";
import { PERMISSIONS, TOOL_NAMES, type Permission, type ToolName } from "../src/services/mongo/types.js";
import { approveAppointment, rejectAppointment, runTool } from "../src/services/integrations/gateway.js";
import { nextOpenDayAt } from "../src/services/integrations/time.js";
import { activeContext, answerOwnerQuestion, listToolProposals, printResult, rollback, scoreTrend, setToolPermission, teach, watch } from "../src/services/teacher/index.js";
import { call, demoCalls, demoConfig, demoWorkspace } from "../fixtures/seed.js";

const [cmd, a, ...rest] = process.argv.slice(2);

async function seed() {
  // The demo wipes its collections, so it must never run in the database the bridge uses.
  if (!dbName().endsWith("_demo"))
    throw new Error(`refusing to seed "${dbName()}": demo data only goes in a database ending in _demo (use npm run seed / npm run demo)`);
  const c = await cols();
  await Promise.all([c.calls, c.configVersions, c.configState, c.grades, c.improvements, c.toolProposals, c.workspaces, c.appointments]
    .map((col) => col.deleteMany({})));
  await c.configVersions.createIndex({ version: 1 }, { unique: true }); // same index the bridge creates
  await c.configVersions.insertOne({ ...demoConfig });
  await c.configState.insertOne({ _id: "active", version: demoConfig.version });
  await c.workspaces.insertOne({ ...demoWorkspace });
  await c.calls.insertMany(demoCalls.map((d) => ({ ...d })));
  console.log(`seeded db "${dbName()}": ${demoConfig.companyName}, config v1, ${demoCalls.length} fake calls`);
}

async function printAppointments() {
  const rows = await (await cols()).appointments.find().sort({ created_at: 1 }).toArray();
  console.table(rows.map((r) => ({
    id: r._id, staff: r.staff_id, customer: r.customer_name, service: r.service, start: r.start,
    status: r.status, event: r.event_link ?? "", error: r.error ?? "",
  })));
}

/**
 * A fourth demo call that books an appointment. The transcript is scripted, but the tool result is
 * whatever the real gateway returns for it, and the approval goes to the real Google Calendar API.
 */
async function bookingDemo() {
  const ws = demoWorkspace;
  const start = nextOpenDayAt("14:00", ws.timezone, ws.business_hours, new Date());
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    .format(new Date(start + ":00Z"));
  const callSid = "fake_call_booking";
  const trace = await runTool(callSid, "book_appointment", {
    staff: "Maya", start, duration_minutes: 60, service: "Women's cut",
    customer_name: "Priya", customer_phone: "415-555-0134", caller_confirmed: true,
  });
  await (await cols()).calls.insertOne(call(callSid, [
    ["caller", `Hi, can I book a women's cut with Maya on ${day} at 2 PM?`],
    ["agent", `Sure. Just to confirm, a women's cut with Maya on ${day} at 2 PM?`],
    ["caller", "Yes, that's right. It's Priya, 415-555-0134."],
    ["agent", "Thanks, Priya. I've sent that to the owner to confirm, and you'll hear back shortly."],
    ["caller", "Great, thank you."],
  ], [{ name: trace.name, args: trace.args as Record<string, unknown>, result: trace.result }]));
  console.log(`\n--- booking call: gateway returned ---\n${JSON.stringify(trace.result)}`);
  printResult(await teach(callSid));
  await printAppointments();
  const id = (trace.result as { appointment_id?: string }).appointment_id;
  if (!id) return console.log("no appointment was queued, nothing to approve");
  console.log(`\n--- owner approves ${id} (calls Google Calendar) ---\n${JSON.stringify(await approveAppointment(id))}`);
  await printAppointments();
}

try {
  if (cmd === "seed") await seed();
  else if (cmd === "teach") printResult(await teach(a!));
  else if (cmd === "demo") {
    await seed();
    for (const call of demoCalls) printResult(await teach(call.callSid));
    await bookingDemo();
    console.log("\n--- business context the receptionist gets after teaching ---\n" + await activeContext());
  } else if (cmd === "answer") {
    const cfg = await answerOwnerQuestion(a!, rest.join(" "));
    console.log(`answer added, active config is now ${cfg._id}`);
  } else if (cmd === "rollback") console.log(`rolled back to ${await rollback()}`);
  else if (cmd === "trend") console.table(await scoreTrend());
  else if (cmd === "tools") {
    const rows = await listToolProposals();
    if (!rows.length) console.log("no tool proposals yet");
    for (const t of rows) console.log(`${t.name}  [${t.status}${t.enabledBy ? ` by ${t.enabledBy}` : ""}]  requests ${t.requestCount}  ${t.write ? "write" : "read"}\n    why: ${t.why}`);
  } else if (cmd === "context") console.log(await activeContext());
  else if (cmd === "watch") await watch();
  else if (cmd === "appointments") await printAppointments();
  else if (cmd === "approve") console.log(JSON.stringify(await approveAppointment(a!)));
  else if (cmd === "reject") console.log(JSON.stringify(await rejectAppointment(a!)));
  else if (cmd === "permission") {
    const tool = TOOL_NAMES.find((t) => t === a), permission = PERMISSIONS.find((p) => p === rest[0]);
    if (!tool || !permission) throw new Error(`usage: permission <${TOOL_NAMES.join("|")}> <${PERMISSIONS.join("|")}>`);
    const cfg = await setToolPermission(tool as ToolName, permission as Permission);
    console.log(`${tool} is ${permission}, active config is ${cfg._id}`);
  } else if (cmd === "calendar-setup") {
    // Adds a staff member (and the default hours and time zone if this is the first one).
    if (!a || !rest[0]) throw new Error("usage: calendar-setup <staff name> <google calendar id>");
    const ws = (await getWorkspace()) ?? { ...demoWorkspace, staff: [] };
    const id = a.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const staff = [...ws.staff.filter((s) => s.id !== id), { id, name: a, calendar_id: rest[0] }];
    await (await cols()).workspaces.replaceOne({ _id: "default" }, { ...ws, staff }, { upsert: true });
    console.log(`staff: ${staff.map((s) => s.name).join(", ")} | time zone ${ws.timezone} | edit business_hours in the workspaces collection if needed`);
  } else console.log("commands: seed | demo | teach <callSid> | answer <improvementId> <answer...> | rollback | trend | tools | context | watch\n" +
    "          appointments | approve <id> | reject <id> | permission <tool> <level> | calendar-setup <staff name> <calendar id>");
} finally {
  await closeDb();
}
