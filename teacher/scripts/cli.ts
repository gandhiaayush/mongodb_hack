import { closeDb, cols, dbName } from "../src/services/mongo/client.js";
import { activeContext, answerOwnerQuestion, listToolProposals, printResult, rollback, scoreTrend, teach, watch } from "../src/services/teacher/index.js";
import { demoCalls, demoConfig } from "../fixtures/seed.js";

const [cmd, a, ...rest] = process.argv.slice(2);

async function seed() {
  // The demo wipes its collections, so it must never run in the database the bridge uses.
  if (!dbName().endsWith("_demo"))
    throw new Error(`refusing to seed "${dbName()}": demo data only goes in a database ending in _demo (use npm run seed / npm run demo)`);
  const c = await cols();
  await Promise.all([c.calls, c.configVersions, c.configState, c.grades, c.improvements, c.toolProposals].map((col) => col.deleteMany({})));
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
  else if (cmd === "tools") {
    const rows = await listToolProposals();
    if (!rows.length) console.log("no tool proposals yet");
    for (const t of rows) console.log(`${t.name}  [${t.status}${t.enabledBy ? ` by ${t.enabledBy}` : ""}]  requests ${t.requestCount}  ${t.write ? "write" : "read"}\n    why: ${t.why}`);
  } else if (cmd === "context") console.log(await activeContext());
  else if (cmd === "watch") await watch();
  else console.log("commands: seed | demo | teach <callSid> | answer <improvementId> <answer...> | rollback | trend | tools | context | watch");
} finally {
  await closeDb();
}
