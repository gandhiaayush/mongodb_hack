import { fromConfig, renderContext, toCall, versionOf } from "../mongo/bridge.js";
import { cols, getActiveConfig, getConfig } from "../mongo/client.js";
import type { BridgeCall, ConfigVersionDoc, GradeDoc, ImprovementDoc, ToolRequestDoc } from "../mongo/types.js";
import { geminiJudge, teacherModel, type Judge } from "./judge.js";
import { buildPlan, LIMITS, regression } from "./plan.js";
import { TOOL_LIMITS, validateEndpoint } from "./tools.js";

export interface TeachResult {
  grade: GradeDoc;
  improvements: ImprovementDoc[];
  newConfig: ConfigVersionDoc | null;
  alreadyGraded: boolean;
  rolledBack: { from: string; to: string; reason: string } | null; // automatic rollback, if one fired
}

/**
 * Builds a new config version with the next free number and inserts it in the bridge's shape.
 * The manager can save a version from the dashboard at the same moment, so a taken number is retried.
 * Version numbers never repeat, even after a rollback leaves an older version active.
 */
async function insertVersion<T>(build: (version: number) => T, configOf: (built: T) => ConfigVersionDoc | null): Promise<T> {
  const c = await cols();
  for (let attempt = 0; ; attempt++) {
    const last = await c.configVersions.find().sort({ version: -1 }).limit(1).next();
    const built = build((last?.version ?? 0) + 1);
    const cfg = configOf(built);
    if (!cfg) return built;
    try {
      await c.configVersions.insertOne(fromConfig(cfg));
      return built;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000 || attempt >= 4) throw e;
    }
  }
}

/**
 * THE integration point: `teach(callSid)` once the bridge has saved the finished call.
 * Safe to call twice: a graded call is not graded again.
 */
export async function teach(callId: string, judge: Judge = geminiJudge): Promise<TeachResult> {
  const c = await cols();
  const rec = await c.calls.findOne({ callSid: callId });
  if (!rec) throw new Error(`call ${callId} not found`);
  if (rec.status !== "completed") throw new Error(`call ${callId} has not ended yet`);
  const call = toCall(rec);

  const existing = await c.grades.findOne({ _id: callId });
  if (existing) {
    const improvements = await c.improvements.find({ source_call_ids: callId }).toArray();
    return { grade: existing, improvements, newConfig: null, alreadyGraded: true, rolledBack: null };
  }

  // Changes are always built on the ACTIVE config, so two calls never overwrite each other's rules.
  const cfg = await getActiveConfig();
  const out = await judge(call, cfg);
  const now = new Date();
  const { grade } = buildPlan(out, call, cfg, teacherModel(), now);
  await c.grades.insertOne(grade);

  // If the active version has regressed, go back to its parent first and build this call's
  // changes on the parent instead, so the rolled-back rules are not carried forward.
  const rolledBack = call.config_version_id === cfg._id ? await autoRollback(cfg) : null;
  const base = rolledBack?.parent ?? cfg;

  const plan = await insertVersion(
    (version) => buildPlan(out, call, base, teacherModel(), now, version), (p) => p.nextConfig);
  if (plan.improvements.length) await c.improvements.insertMany(plan.improvements);
  if (plan.nextConfig) await setActive(plan.nextConfig.version);
  for (const r of plan.toolRequests) await recordToolRequest(r);
  return {
    grade, improvements: plan.improvements, newConfig: plan.nextConfig, alreadyGraded: false,
    rolledBack: rolledBack && { from: rolledBack.from, to: rolledBack.to, reason: rolledBack.reason },
  };
}

async function setActive(version: number) {
  await (await cols()).configState.updateOne({ _id: "active" }, { $set: { version } }, { upsert: true });
}

/**
 * Rolls back a teacher-made version whose last calls score below its parent's average.
 * Versions saved by the manager are never rolled back automatically.
 */
async function autoRollback(cfg: ConfigVersionDoc) {
  if (cfg.created_by !== "teacher" || !cfg.parent_id) return null;
  const c = await cols();
  const overalls = async (configId: string) =>
    (await c.grades.find({ config_version_id: configId }).sort({ created_at: 1 }).toArray()).map((g) => g.overall);
  const r = regression(await overalls(cfg._id), await overalls(cfg.parent_id));
  if (!r) return null;
  const parent = await getConfig(versionOf(cfg.parent_id));
  if (!parent) return null;
  const reason = `auto: last ${LIMITS.rollbackWindow} calls on v${cfg.version} averaged ${r.avg.toFixed(2)}, ` +
    `below the v${parent.version} average of ${r.parentAvg.toFixed(2)}`;
  if (!(await rollbackFrom(cfg, reason))) return null;
  return { from: cfg._id, to: parent._id, reason, parent };
}

/** Moves the pointer from `cfg` to its parent, only if `cfg` is still active. Records the reason. */
async function rollbackFrom(cfg: ConfigVersionDoc, reason: string): Promise<boolean> {
  const c = await cols();
  const res = await c.configState.updateOne(
    { _id: "active", version: cfg.version }, { $set: { version: versionOf(cfg.parent_id!) } });
  if (!res.modifiedCount) return false;
  await c.improvements.updateMany({ applied_in_config_id: cfg._id },
    { $set: { status: "rolled_back", rolled_back_reason: reason } });
  return true;
}

/** Owner answers a "context" question. Only this path can add to the company text. */
export async function answerOwnerQuestion(improvementId: string, answer: string) {
  const c = await cols();
  const imp = await c.improvements.findOne({ _id: improvementId });
  if (!imp || imp.type !== "context" || imp.status !== "proposed")
    throw new Error(`${improvementId} is not an open owner question`);
  const cfg = await getActiveConfig();
  const question = imp.payload.question ?? "";
  const next = await insertVersion<ConfigVersionDoc>((version) => ({
    ...cfg, _id: `v${version}`, version,
    context: `${cfg.context}\n${question} ${answer.trim()}`.trim(),
    parent_id: cfg._id, created_by: "manager", source_call_id: imp.source_call_ids[0] ?? null,
    note: `Owner answered: ${question}`.slice(0, 300), created_at: new Date(),
  }), (n) => n);
  await setActive(next.version);
  await c.improvements.updateOne({ _id: improvementId },
    { $set: { status: "applied", "payload.answer": answer, applied_in_config_id: next._id } });
  return next;
}

/** One pointer change back to the parent version. History is kept. */
export async function rollback() {
  const cfg = await getActiveConfig();
  if (!cfg.parent_id)
    throw new Error(`${cfg._id} has no recorded parent (it was not made by the teacher); activate another version from the dashboard`);
  await rollbackFrom(cfg, "manual rollback");
  return cfg.parent_id;
}

/** For the dashboard timeline: one point per call, oldest first. */
export async function scoreTrend() {
  const c = await cols();
  const grades = await c.grades.find().sort({ created_at: 1 }).toArray();
  return grades.map((g) => ({
    call_id: g.call_id, config_version_id: g.config_version_id, outcome: g.outcome,
    overall: g.overall, frustration: g.frustration, at: g.created_at,
  }));
}

/**
 * Runs next to the bridge: teaches every finished call that has no grade yet.
 * Needs no change on the bridge side. A call that fails 3 times is skipped until restart.
 */
export async function watch(intervalMs = 3000, judge: Judge = geminiJudge) {
  const c = await cols();
  const failures = new Map<string, number>();
  console.log("teacher watching for finished calls...");
  for (;;) {
    const [next] = await c.calls.aggregate<BridgeCall>([
      { $match: { status: "completed", "transcript.0": { $exists: true }, callSid: { $nin: [...failures].filter(([, n]) => n >= 3).map(([id]) => id) } } },
      { $lookup: { from: "grades", localField: "callSid", foreignField: "_id", as: "grade" } },
      { $match: { grade: { $size: 0 } } },
      { $sort: { startedAt: 1 } }, { $limit: 1 },
    ]).toArray();
    if (!next) { await sleep(intervalMs); continue; }
    try { printResult(await teach(next.callSid, judge)); }
    catch (e) {
      console.error(`teach(${next.callSid}) failed:`, e);
      failures.set(next.callSid, (failures.get(next.callSid) ?? 0) + 1);
      await sleep(intervalMs);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function printResult(r: TeachResult) {
  const g = r.grade;
  console.log(`\n=== ${g.call_id} (${g.outcome}) overall ${g.overall}/10, frustration ${g.frustration}/10 ===`);
  console.log(Object.entries(g.scores).map(([k, v]) => `${k} ${v}`).join(" | "));
  console.log(g.rationale);
  if (r.rolledBack) console.log(`  ROLLED BACK ${r.rolledBack.from} -> ${r.rolledBack.to} (${r.rolledBack.reason})`);
  for (const i of g.issues) console.log(`  issue [turn ${i.turn}] ${i.type}: "${i.quote}"`);
  for (const m of r.improvements) {
    const what = m.payload.question ?? `${m.payload.op ?? ""} ${m.payload.rule_id ?? ""} ${m.payload.text ?? ""}`;
    console.log(`  ${m.status.toUpperCase()} ${m.type}: ${what.trim()}${m.rejected_reason ? ` (${m.rejected_reason})` : ""}`);
  }
  if (r.newConfig) console.log(`  -> new active config: ${r.newConfig._id} (${r.newConfig.rules.length} rules)`);
}

/** What the bridge will put under "ABOUT THE BUSINESS" in the receptionist's system prompt. */
export async function activeContext(): Promise<string> {
  const cfg = await getActiveConfig();
  return `COMPANY: ${cfg.company_name} (config ${cfg._id})\n\n${renderContext(cfg)}`;
}

// ---- Tool requests ------------------------------------------------------------------------------

/**
 * Adds a teacher request, or counts another call asking for the same tool. An existing request keeps
 * its status and owner-set fields: a declined tool is not reopened by the teacher asking again.
 */
async function recordToolRequest(r: ToolRequestDoc) {
  const c = await cols();
  const { _id, ...fields } = r;
  const res = await c.toolRequests.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
  if (res.upsertedCount) return;
  await c.toolRequests.updateOne({ _id: r._id, source_call_ids: { $ne: r.source_call_ids[0] } }, {
    $inc: { request_count: 1 }, $push: { source_call_ids: r.source_call_ids[0]! }, $set: { updated_at: new Date() },
  });
}

/** Requests sorted by how many calls asked for them: the owner's build list. */
export async function listToolRequests(status?: ToolRequestDoc["status"]) {
  const c = await cols();
  return c.toolRequests.find(status ? { status } : {}).sort({ request_count: -1, created_at: 1 }).toArray();
}

async function openRequest(name: string, from: ToolRequestDoc["status"][], to: ToolRequestDoc["status"], set: Partial<ToolRequestDoc> = {}) {
  const c = await cols();
  const res = await c.toolRequests.findOneAndUpdate(
    { _id: name, status: { $in: from } }, { $set: { ...set, status: to, updated_at: new Date() } }, { returnDocument: "after" });
  if (!res) throw new Error(`tool request "${name}" not found or not in status ${from.join("/")}`);
  return res;
}

/** Owner agrees the tool is worth building. Nothing is exposed to the receptionist yet. */
export const approveToolRequest = (name: string, note?: string) =>
  openRequest(name, ["requested"], "approved", note ? { decided_note: note } : {});

export const declineToolRequest = (name: string, note?: string) =>
  openRequest(name, ["requested", "approved"], "declined", note ? { decided_note: note } : {});

/**
 * Owner has built the tool and gives its endpoint. From the next call the bridge exposes it to the
 * receptionist. Only this function (a person's action) can enable a tool; the teacher cannot.
 */
export async function enableTool(name: string, endpoint: string) {
  const bad = validateEndpoint(endpoint);
  if (bad) throw new Error(bad);
  const c = await cols();
  if ((await c.toolRequests.countDocuments({ status: "enabled", _id: { $ne: name } })) >= TOOL_LIMITS.maxEnabled)
    throw new Error(`already ${TOOL_LIMITS.maxEnabled} custom tools enabled; disable one first`);
  return openRequest(name, ["approved", "disabled"], "enabled", { endpoint, enabled_at: new Date() });
}

export const disableTool = (name: string, note?: string) =>
  openRequest(name, ["enabled"], "disabled", note ? { decided_note: note } : {});
