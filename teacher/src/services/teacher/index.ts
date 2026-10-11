import { fromConfig, renderContext, toCall, versionOf } from "../mongo/bridge.js";
import { cols, getActiveConfig, getConfig } from "../mongo/client.js";
import { TOOL_NAMES } from "../mongo/types.js";
import type { BridgeCall, ConfigVersionDoc, GradeDoc, ImprovementDoc, Permission, ToolName, ToolProposal, ToolProposalDoc } from "../mongo/types.js";
import { geminiJudge, teacherModel, type Judge } from "./judge.js";
import {
  buildPlan, decideToolStatus, describeRecipe, LIMITS, mergeToolProposal, NO_STATS, ownerAnswerLine, regression, verifyToolRecipe,
  type ToolDecision, type ToolStats,
} from "./plan.js";

export interface TeachResult {
  grade: GradeDoc;
  improvements: ImprovementDoc[];
  newConfig: ConfigVersionDoc | null;
  alreadyGraded: boolean;
  rolledBack: { from: string; to: string; reason: string } | null; // automatic rollback, if one fired
  // Accepted tool proposal (as stored) and what happened to it. null when the call showed no capability gap or it was rejected.
  toolProposal: { proposal: ToolProposal; action: ToolDecision["action"]; status: ToolProposal["status"]; promoted: boolean; threshold: number } | null;
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
    return { grade: existing, improvements, newConfig: null, alreadyGraded: true, rolledBack: null, toolProposal: null };
  }

  // Changes are always built on the ACTIVE config, so two calls never overwrite each other's rules.
  const cfg = await getActiveConfig();
  const out = await judge(call, cfg);
  const now = new Date();
  // Owner questions already open or answered (a repeat is rejected), and the async self-check of a proposed recipe.
  const existingQuestions = (await c.improvements.find({ type: "context", status: { $in: ["proposed", "applied"] } }).toArray())
    .map((i) => i.payload.question ?? "").filter(Boolean);
  const recipeCheck = out.tool_proposal ? await verifyToolRecipe(out.tool_proposal) : undefined;
  const extra = { existingQuestions, recipeCheck };
  const { grade } = buildPlan(out, call, cfg, teacherModel(), now, undefined, extra);
  await c.grades.insertOne(grade);

  // If the active version has regressed, go back to its parent first and build this call's
  // changes on the parent instead, so the rolled-back rules are not carried forward.
  const rolledBack = call.config_version_id === cfg._id ? await autoRollback(cfg) : null;
  const base = rolledBack?.parent ?? cfg;

  const stats = await toolStats(grade._id);
  const plan = await insertVersion(
    (version) => buildPlan(out, call, base, teacherModel(), now, version, { ...extra, toolStats: stats }), (p) => p.nextConfig);
  const toolProposal = plan.toolProposal ? await saveToolProposal(plan.toolProposal, grade.overall, plan.improvements) : null;
  if (plan.improvements.length) await c.improvements.insertMany(plan.improvements);
  if (plan.nextConfig) await setActive(plan.nextConfig.version);
  return {
    grade, improvements: plan.improvements, newConfig: plan.nextConfig, alreadyGraded: false, toolProposal,
    rolledBack: rolledBack && { from: rolledBack.from, to: rolledBack.to, reason: rolledBack.reason },
  };
}

/**
 * Per calendar tool: earlier graded calls that used it without an error and scored tool_use >= 8,
 * counted since that tool's permission last changed, so a demotion resets the record.
 */
async function toolStats(exceptCallId: string): Promise<ToolStats> {
  const c = await cols();
  const stats = { ...NO_STATS };
  for (const tool of TOOL_NAMES) {
    const last = await c.improvements.find({ "payload.tool": tool, status: "applied" }).sort({ created_at: -1 }).limit(1).next();
    stats[tool] = await c.grades.countDocuments({
      _id: { $ne: exceptCallId }, tools_used: tool, tools_failed: { $ne: tool },
      "scores.tool_use": { $gte: LIMITS.cleanToolUseScore }, ...(last ? { created_at: { $gt: last.created_at } } : {}),
    });
  }
  return stats;
}

/** Owner sets a tool permission directly. This is the only way up from "disabled", and it skips the clean-call rule. */
export async function setToolPermission(tool: ToolName, permission: Permission) {
  const cfg = await getActiveConfig();
  if (cfg.tools[tool] === permission) return cfg;
  const next = await insertVersion<ConfigVersionDoc>((version) => ({
    ...cfg, _id: `v${version}`, version, tools: { ...cfg.tools, [tool]: permission },
    parent_id: cfg._id, created_by: "manager", source_call_id: null,
    note: `Owner set ${tool} to ${permission}`, created_at: new Date(),
  }), (n) => n);
  await setActive(next.version);
  return next;
}

/**
 * Writes an accepted tool proposal to `tool_proposals` and records the outcome on its `improvements` document
 * (mutated in place before it is inserted). The owner's decision wins: "disabled" and "declined" are never touched.
 */
async function saveToolProposal(incoming: ToolProposal, overall: number, improvements: ImprovementDoc[]): Promise<TeachResult["toolProposal"]> {
  const c = await cols();
  const imp = improvements.find((i) => i.type === "tool" && i.payload.tool_name === incoming.name && i.status === "proposed");
  const now = new Date();
  let existing = await c.toolProposals.findOne({ _id: incoming.name });
  let d = decideToolStatus(overall, existing?.status ?? null, process.env);
  if (d.action === "create") {
    const doc: ToolProposalDoc = { ...incoming, _id: incoming.name, status: d.status };
    if (d.promote) { doc.enabledAt = now.toISOString(); doc.enabledBy = "teacher"; }
    try { await c.toolProposals.insertOne(doc); existing = doc; }
    catch (e) { // another call created it at the same moment: treat as a repeat request
      if ((e as { code?: number }).code !== 11000) throw e;
      existing = await c.toolProposals.findOne({ _id: incoming.name });
      d = decideToolStatus(overall, existing?.status ?? null, process.env);
    }
  }
  if (d.action !== "create" && existing) {
    if (d.action === "bump") {
      const m = mergeToolProposal(existing, incoming, now);
      const set: Partial<ToolProposalDoc> = { requestCount: m.requestCount, sourceCallSids: m.sourceCallSids, evidence: m.evidence, updatedAt: m.updatedAt };
      if (d.promote) { set.status = "enabled"; set.enabledAt = now.toISOString(); set.enabledBy = "teacher"; }
      await c.toolProposals.updateOne({ _id: incoming.name, status: existing.status }, { $set: set });
    }
  }
  if (imp) {
    if (d.action === "skip") {
      imp.status = "rejected";
      imp.rejected_reason = `tool proposal: the owner already ${existing?.status ?? "declined"} ${incoming.name}; not reopened`;
    } else if (d.status === "enabled" && (d.promote || d.action === "bump")) {
      imp.reason = d.promote
        ? `${imp.reason} (Tool auto-enabled by the teacher because the call scored ${overall} (< ${d.threshold}).)`
        : `${imp.reason} (Repeat request for the already enabled tool ${incoming.name}.)`;
    } else {
      imp.reason = `${imp.reason} (Waiting for the owner to enable it; the call scored ${overall}, threshold ${d.threshold}.)`;
    }
  }
  return d.action === "skip" ? null : { proposal: incoming, action: d.action, status: d.status, promoted: d.promote, threshold: d.threshold };
}

/** For `npm run tools`: every proposal, most requested first. */
export async function listToolProposals() {
  return (await cols()).toolProposals.find().sort({ requestCount: -1, updatedAt: -1 }).toArray();
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
    context: `${cfg.context}\n${ownerAnswerLine(question, answer)}`.trim(),
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
    const what = m.type === "tool" && m.payload.tool_name ? `${m.payload.tool_name}: ${m.payload.text}`
      : m.payload.question
        ?? (m.payload.tool ? `${m.payload.tool}: ${m.payload.from_permission} -> ${m.payload.permission}`
          : `${m.payload.op ?? ""} ${m.payload.rule_id ?? ""} ${m.payload.text ?? ""}`);
    const why = m.rejected_reason ?? m.held_reason;
    console.log(`  ${m.status.toUpperCase()} ${m.type}: ${what.trim()}${why ? ` (${why})` : ""}`);
  }
  if (r.toolProposal) {
    const t = r.toolProposal, p = t.proposal;
    const head = t.status === "enabled"
      ? (t.promoted ? `TOOL CREATED (auto-enabled, grade ${g.overall} < ${t.threshold})` : "TOOL REQUESTED AGAIN (already enabled)")
      : `TOOL PROPOSED (waiting for owner, grade ${g.overall})`;
    console.log(`  ${head}: ${p.name} [${p.write ? "write" : "read"}] ${p.description}`);
    console.log(`    recipe: ${p.recipe ? `yes, verified: ${p.recipeVerified ? "yes" : "no"}` : "no (plain save/look-up tool)"}`);
    if (p.recipe) for (const line of describeRecipe(p.recipe)) console.log(`      - ${line}`);
    console.log(`    params: ${p.params.map((q) => `${q.name}:${q.type}${q.required ? "*" : ""}`).join(", ") || "(none)"}`);
    for (const d of p.mockup.sampleDialogue) console.log(`    ${d.role.padEnd(6)} ${d.text}`);
    console.log(`    example args ${JSON.stringify(p.mockup.exampleArgs)} -> ${JSON.stringify(p.mockup.exampleResult)}`);
  }
  if (r.newConfig) console.log(`  -> new active config: ${r.newConfig._id} (${r.newConfig.rules.length} rules)`);
}

/** What the bridge will put under "ABOUT THE BUSINESS" in the receptionist's system prompt. */
export async function activeContext(): Promise<string> {
  const cfg = await getActiveConfig();
  return `COMPANY: ${cfg.company_name} (config ${cfg._id})\n\n${renderContext(cfg)}`;
}
