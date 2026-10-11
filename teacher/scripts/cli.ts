import { closeDb, cols, dbName } from "../src/services/mongo/client.js";
import {
  activeContext, answerOwnerQuestion, approveToolRequest, declineToolRequest, disableTool, enableTool, listToolRequests, printResult, rollback, scoreTrend, teach, watch,
} from "../src/services/teacher/index.js";
import { demoCalls, demoConfig } from "../fixtures/seed.js";

const [cmd, a, ...rest] = process.argv.slice(2);

async function seed() {
  // The demo wipes its collections, so it must never run in the database the bridge uses.
  if (!dbName().endsWith("_demo"))
    throw new Error(`refusing to seed "${dbName()}": demo data only goes in a database ending in _demo (use npm run seed / npm run demo)`);
  const c = await cols();
  await Promise.all([c.calls, c.configVersions, c.configState, c.grades, c.improvements, c.toolRequests].map((col) => col.deleteMany({})));
  await c.configVersions.createIndex({ version: 1 }, { unique: true }); // same index the bridge creates
  await c.configVersions.insertOne({ ...demoConfig });
  await c.configState.insertOne({ _id: "active", version: demoConfig.version });
  await c.calls.insertMany(demoCalls.map((d) => ({ ...d })));
  console.log(`seeded db "${dbName()}": ${demoConfig.companyName}, config v1, ${demoCalls.length} fake calls`);
}

try {
  if (cmd === "seed") await seed();
  else if (cmd === "teach") printResult(await teach(a!));
  else if (cmd === "demo") {
    await seed();
    for (const call of demoCalls) printResult(await teach(call.callSid));
    console.log("\n--- business context the receptionist gets after teaching ---\n" + await activeContext());
  } else if (cmd === "answer") {
    const cfg = await answerOwnerQuestion(a!, rest.join(" "));
    console.log(`answer added, active config is now ${cfg._id}`);
  } else if (cmd === "rollback") console.log(`rolled back to ${await rollback()}`);
  else if (cmd === "trend") console.table(await scoreTrend());
  else if (cmd === "context") console.log(await activeContext());
  else if (cmd === "tools") {
    console.table((await listToolRequests(a as never)).map((t) => ({
      name: t.name, status: t.status, asked_by_calls: t.request_count, effect: t.side_effect,
      params: t.parameters.map((p) => p.name).join(","), endpoint: t.endpoint ?? "",
    })));
  } else if (cmd === "tool-approve") console.log((await approveToolRequest(a!, rest.join(" "))).status);
  else if (cmd === "tool-decline") console.log((await declineToolRequest(a!, rest.join(" "))).status);
  else if (cmd === "tool-enable") console.log(`${a} ${(await enableTool(a!, rest[0]!)).status}: the next call can use it`);
  else if (cmd === "tool-disable") console.log((await disableTool(a!, rest.join(" "))).status);
  else if (cmd === "watch") await watch();
  else console.log("commands: seed | demo | teach <callSid> | answer <improvementId> <answer...> | rollback | trend | context | watch | tools [status] | tool-approve <name> | tool-decline <name> | tool-enable <name> <https-endpoint> | tool-disable <name>");
} finally {
  await closeDb();
}
