// Simulated learning journey for a dry cleaner. No database, no model, no keys.
//
// A scripted "agent" has known weaknesses and a scripted "judge" reports them, but every decision about
// what changes goes through the REAL guardrail layer (plan.ts), tool validation (tools.ts) and the real
// regression test (regression()). So the rejections, caps, rollbacks and version numbers are what the
// production teacher would do with the same judge output. Only the callers and the judge are fake.
//
//   npm run simulate     -> demo/journey.json and docs/teacher-journey.html
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JudgeOutput } from "../src/services/teacher/judge.js";
import { buildPlan, regression as prodRegression } from "../src/services/teacher/plan.js";
import type { CallDoc, ConfigVersionDoc, ImprovementDoc, Outcome, ToolRequestDoc } from "../src/services/mongo/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- deterministic randomness -------------------------------------------------------------------
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (n: number, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, n));
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---- what the agent is bad at -------------------------------------------------------------------
type Fix = "rule" | "owner_answer" | "tool";
interface Mode {
  key: string;
  label: string;
  weight: number;
  baseFail: number; // chance the agent fails this kind of call before it is fixed
  fixedFail: number; // chance after the fix
  fix: Fix;
  dims: Partial<Record<"accuracy" | "tool_use" | "task_completion" | "tone" | "brevity", number>>; // score drop on failure
  frustration: number; // extra frustration on failure
  outcomeOnFail: Outcome;
  caller: string; // what the caller says
  good: string; // what a good agent says
  bad: string; // what the failing agent says (also the quote the judge cites)
  issue: { type: string; explanation: string };
  tools?: { name: string; args: Record<string, unknown>; result: Record<string, unknown> }[];
  // the one improvement the judge proposes when it sees this failure
  proposal: Record<string, unknown>;
}

const MODES: Mode[] = [
  {
    key: "invented_price", label: "Invents prices", weight: 12, baseFail: 0.78, fixedFail: 0.1, fix: "rule",
    dims: { accuracy: -6, task_completion: -2 }, frustration: 1, outcomeOnFail: "answered",
    caller: "How much to clean a tuxedo?", good: "I don't have a price for tuxedos on file. I can take a message and have staff call you back.",
    bad: "A tuxedo is usually about forty dollars.",
    issue: { type: "invented_fact", explanation: "No tuxedo price exists in the business information or any tool result." },
    proposal: { type: "prompt", op: "add", rule_kind: "guardrail", reason: "The agent made up a price.",
      text: "If a caller asks for a price that is not in your business information or a tool result, say you don't have it on file and offer to take a message. Never estimate." },
  },
  {
    key: "hours_guess", label: "Guesses hours", weight: 14, baseFail: 0.55, fixedFail: 0.06, fix: "rule",
    dims: { accuracy: -5, tool_use: -4 }, frustration: 2, outcomeOnFail: "answered",
    caller: "Are you open this Sunday?", good: "We're closed on Sundays. We open again Monday at eight.",
    bad: "We might be open Sunday morning, I'm not sure.",
    issue: { type: "invented_fact", explanation: "The agent guessed instead of using the hours tool; the shop is closed Sunday." },
    proposal: { type: "prompt", op: "add", rule_kind: "behavior", reason: "Hours questions were guessed.",
      text: "For any question about whether the shop is open, or when it opens or closes, call get_hours and answer from the result." },
  },
  {
    key: "repeat_order", label: "Asks callers to repeat order numbers", weight: 20, baseFail: 0.5, fixedFail: 0.08, fix: "rule",
    dims: { tool_use: -6, brevity: -4, tone: -2 }, frustration: 4, outcomeOnFail: "failed",
    caller: "It's order 1038, can you check it?", good: "Hold on, let me check. Order 1038 is ready for pickup.",
    bad: "Could you say that number again, please?",
    issue: { type: "tool_error", explanation: "The caller had already given a clear order number; the tool was never called." },
    tools: [{ name: "get_order", args: { orderId: "ORD-1038" }, result: { found: true } }],
    proposal: { type: "prompt", op: "add", rule_kind: "behavior", reason: "Caller gave the number and the agent made them repeat it.",
      text: "When the caller gives an order number, call get_order with it right away. Only ask them to repeat it if the tool says it was not found." },
  },
  {
    key: "human_request", label: "Ignores requests for a person", weight: 8, baseFail: 0.7, fixedFail: 0.1, fix: "rule",
    dims: { task_completion: -6, tone: -3 }, frustration: 6, outcomeOnFail: "failed",
    caller: "I just want to talk to a real person.", good: "Of course. What's your name and the best number to reach you?",
    bad: "I can help with that. What would you like to know?",
    issue: { type: "missed_question", explanation: "The caller asked for a person and the agent kept going." },
    proposal: { type: "prompt", op: "add", rule_kind: "guardrail", reason: "The caller asked for a human twice.",
      text: "The moment a caller asks for a person, stop and take a message: collect their name and callback number, one question at a time." },
  },
  {
    key: "stain_promise", label: "Promises stain removal", weight: 9, baseFail: 0.6, fixedFail: 0.1, fix: "rule",
    dims: { accuracy: -5 }, frustration: 0, outcomeOnFail: "answered",
    caller: "Will you get this red wine stain out of my silk shirt?", good: "We'll treat it carefully, but we can't guarantee every stain comes out.",
    bad: "Yes, we'll definitely get that stain out.",
    issue: { type: "invented_fact", explanation: "The business information says stain removal is never guaranteed." },
    proposal: { type: "prompt", op: "add", rule_kind: "guardrail", reason: "The agent promised a result the shop does not guarantee.",
      text: "Never promise that a stain or damage will be removed or fixed. Say staff will treat it and results are not guaranteed." },
  },
  {
    key: "chatty", label: "Talks too much", weight: 12, baseFail: 0.5, fixedFail: 0.1, fix: "rule",
    dims: { brevity: -6, tone: -1 }, frustration: 2, outcomeOnFail: "answered",
    caller: "Do you do alterations?", good: "Yes, we do. Want me to take your details?",
    bad: "Great question! We offer a wide range of services including dry cleaning, laundry, pressing, alterations, repairs, and much more, and we'd love to help.",
    issue: { type: "verbosity", explanation: "A one-line answer was wrapped in a long sales pitch." },
    proposal: { type: "prompt", op: "add", rule_kind: "behavior", reason: "Answers ran long for a phone call.",
      text: "Answer in one short sentence, then stop and let the caller speak. Do not list services unless asked." },
  },
  {
    key: "unknown_policy", label: "Doesn't know a policy", weight: 8, baseFail: 0.85, fixedFail: 0.05, fix: "owner_answer",
    dims: { accuracy: -6, task_completion: -3 }, frustration: 2, outcomeOnFail: "answered",
    caller: "Can I drop off a wedding dress without an appointment?", good: "Yes, walk-ins are welcome for wedding dresses, up to three days before the event.",
    bad: "I think so, but you might want to call ahead.",
    issue: { type: "missed_question", explanation: "The agent had no answer and hedged. The owner has not said what the policy is." },
    proposal: { type: "context", reason: "Two callers asked and the agent had nothing to say.",
      question: "Do you accept wedding dress drop-offs without an appointment?" },
  },
  {
    key: "reschedule", label: "Can't reschedule a pickup", weight: 10, baseFail: 1.0, fixedFail: 0.05, fix: "tool",
    dims: { task_completion: -4 }, frustration: 3, outcomeOnFail: "message_taken",
    caller: "Can you move my pickup to Friday afternoon?", good: "Done. Your pickup is now Friday afternoon.",
    bad: "I can't change bookings, but I'll take a message for staff.",
    issue: { type: "missed_question", explanation: "No tool exists to move a pickup, so the caller had to wait for a callback." },
    tools: [{ name: "take_message", args: { name: "Caller", phone: "+14155550101", message: "Move pickup to Friday afternoon." }, result: { saved: true } }],
    proposal: { type: "tool", reason: "Callers keep asking to move a pickup and no tool can.",
      tool: { name: "reschedule_pickup", description: "Move an existing pickup or delivery to a new date and window.", side_effect: "write",
        parameters: [{ name: "orderId", type: "string", description: "Order number", required: true }, { name: "newDate", type: "string", description: "YYYY-MM-DD", required: true }, { name: "window", type: "string", description: "morning, afternoon or evening", required: true }] } },
  },
  {
    key: "routine", label: "Routine call", weight: 20, baseFail: 0.04, fixedFail: 0.04, fix: "rule",
    dims: { tone: -2 }, frustration: 0, outcomeOnFail: "answered",
    caller: "What's the status of my suit?", good: "Your suit is in pressing and will be ready tomorrow.",
    bad: "Um, one second, I think it is in pressing maybe.",
    issue: { type: "tone", explanation: "Hesitant delivery for a simple status question." },
    tools: [{ name: "get_order", args: { orderId: "ORD-1041" }, result: { found: true } }],
    proposal: { type: "prompt", op: "add", rule_kind: "behavior", reason: "Hedging on easy questions.", text: "Sound confident and calm when a tool has returned the answer." },
  },
];

// One more rule the teacher gets wrong on purpose, to show automatic rollback.
const BAD_RULE = {
  type: "prompt", op: "add", rule_kind: "behavior", reason: "The agent never learned the caller's name before answering.",
  text: "Before answering any question, ask the caller for their name and phone number.",
};
const BAD_RULE_CALL = 41; // the judge proposes it on this call (a routine call)
const BAD_RULE_PENALTY = { overall: 2.6, frustration: 3.2 };

// owner actions, by call number
const OWNER_ANSWER_AT = 33;
const OWNER_ANSWER = "Yes. Walk-ins are fine for wedding dresses, but bring it in at least three days before the event.";
const TOOL_APPROVE_AT = 52;
const TOOL_ENABLE_AT = 58;

// ---- simulation -----------------------------------------------------------------------------------
const TOTAL = 90;
const start = Date.UTC(2026, 9, 12, 15, 0, 0);
const avgOf = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

/** Rollback tests. "prod" is the real function. "strict" is a proposal: more calls and a margin. */
type Guard = "prod" | "strict";
function strictRegression(version: number[], parent: number[]) {
  if (version.length < 5 || parent.length < 5) return null;
  const avg = avgOf(version.slice(-5)), parentAvg = avgOf(parent);
  return avg < parentAvg - 0.8 ? { avg, parentAvg } : null;
}

function simulate(guard: Guard) {
  let cfg: ConfigVersionDoc = {
    _id: "v1", version: 1, company_name: "CJ's Cleaning", greeting: "Thanks for calling CJ's Cleaning, how can I help?",
    context: [
      "CJ's Cleaning is a friendly neighborhood dry cleaner.",
      "Hours: Monday to Friday 8am to 6pm, Saturday 9am to 3pm, closed Sunday.",
      "Stain removal is never guaranteed.",
      "Tone: warm and brief.",
    ].join("\n"),
    rules: [{ id: "r1", kind: "guardrail", locked: true, text: "Never share another customer's personal details." }],
    parent_id: null, created_by: "system", source_call_id: null, note: "Initial setup", created_at: new Date(start - 864e5),
  };
  const versions: ConfigVersionDoc[] = [cfg];
  const improvements: ImprovementDoc[] = [];
  const toolRequests = new Map<string, ToolRequestDoc>();
  const gradesByVersion = new Map<string, number[]>();
  const events: { call: number; kind: string; text: string; version?: string }[] = [];
  const calls: Record<string, unknown>[] = [];
  let toolState: "none" | "requested" | "approved" | "enabled" = "none";
  const nextVersionNumber = () => Math.max(...versions.map((v) => v.version)) + 1;
  const hasRule = (text: unknown) => cfg.rules.some((r) => r.text === text);
  const fixedNow = (m: Mode) =>
    m.fix === "rule" ? hasRule(m.proposal.text) : m.fix === "owner_answer" ? cfg.context.includes(OWNER_ANSWER) : toolState === "enabled";
  const alreadyAsked = (m: Mode) =>
    m.fix === "owner_answer" ? improvements.some((i) => i.type === "context" && i.status !== "rejected" && i.payload.question === m.proposal.question) : false;

  for (let n = 1; n <= TOTAL; n++) {
    const r = rng(7919 * n + 13); // per-call randomness: both guards see the same callers
    const jitter = (c: number, sp: number) => c + (r() - 0.5) * 2 * sp;
    const now = new Date(start + Math.floor((n - 1) * (21 * 864e5 / TOTAL)) + Math.floor(r() * 3e6));
    const callVersion = cfg;

    // owner actions happen between calls
    if (n === OWNER_ANSWER_AT) {
      const imp = improvements.find((i) => i.type === "context" && i.status === "proposed");
      if (imp) {
        const v: ConfigVersionDoc = {
          ...cfg, _id: `v${nextVersionNumber()}`, version: nextVersionNumber(),
          context: `${cfg.context}\n${imp.payload.question} ${OWNER_ANSWER}`,
          parent_id: cfg._id, created_by: "manager", source_call_id: imp.source_call_ids[0] ?? null,
          note: `Owner answered: ${imp.payload.question}`, created_at: now,
        };
        versions.push(v); cfg = v;
        imp.status = "applied"; imp.payload.answer = OWNER_ANSWER; imp.applied_in_config_id = v._id;
        events.push({ call: n, kind: "owner_answer", text: "Owner answered the wedding dress question", version: v._id });
      }
    }
    if (n === TOOL_APPROVE_AT && toolState === "requested") {
      toolState = "approved"; toolRequests.get("reschedule_pickup")!.status = "approved";
      events.push({ call: n, kind: "tool_approved", text: "Owner approved reschedule_pickup as worth building" });
    }
    if (n === TOOL_ENABLE_AT && toolState === "approved") {
      toolState = "enabled"; const t = toolRequests.get("reschedule_pickup")!;
      t.status = "enabled"; t.endpoint = "https://crm.cjscleaning.example/tools/reschedule_pickup";
      events.push({ call: n, kind: "tool_enabled", text: "Owner built the endpoint and turned reschedule_pickup on" });
    }

    // the caller and the agent's behaviour
    let x = r() * MODES.reduce((sum, m) => sum + m.weight, 0);
    let mode = MODES[MODES.length - 1]!;
    for (const m of MODES) { x -= m.weight; if (x <= 0) { mode = m; break; } }
    const failed = r() < (fixedNow(mode) ? mode.fixedFail : mode.baseFail);

    const badRuleActive = hasRule(BAD_RULE.text);
    const base = { accuracy: 9, tool_use: 9, task_completion: 9, tone: 9, brevity: 8.6 };
    const scores: Record<string, number> = {};
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      scores[k] = clamp(r1(jitter(base[k], 0.5) + (failed ? (mode.dims[k] ?? -1.2) * 1.4 - 1.2 : 0)));
      if (badRuleActive) scores[k] = clamp(r1(scores[k]! - BAD_RULE_PENALTY.overall * (k === "brevity" || k === "tone" ? 1.3 : 0.9)));
    }
    const frustration = clamp(r1(jitter(0.8, 0.6) + (failed ? mode.frustration : 0) + (badRuleActive ? BAD_RULE_PENALTY.frustration : 0)));

    const agentLine = failed ? mode.bad : mode.good;
    const transcript: { turn: number; role: "caller" | "agent"; text: string }[] = [
      { turn: 1, role: "agent", text: cfg.greeting },
      { turn: 2, role: "caller", text: mode.caller },
    ];
    if (badRuleActive) {
      transcript.push({ turn: 3, role: "agent", text: "Before I answer, may I have your name and phone number?" }, { turn: 4, role: "caller", text: "Why do you need that? I just have a quick question." });
    }
    transcript.push({ turn: transcript.length + 1, role: "agent", text: agentLine });
    const badTurn = transcript.length;
    const toolTrace = failed ? (mode.key === "reschedule" ? mode.tools ?? [] : []) : mode.tools ?? [];
    const outcome: Outcome = failed ? mode.outcomeOnFail : "answered";
    const call: CallDoc = {
      _id: `CA${1000 + n}`, config_version_id: callVersion._id, transcript, tool_trace: toolTrace, outcome,
      duration_sec: 25 + Math.floor(r() * 60), created_at: now,
    };

    // the scripted judge proposes a fix the first time it sees a failure that has no fix yet
    const proposals: Record<string, unknown>[] = [];
    if (failed && !fixedNow(mode) && !alreadyAsked(mode) && mode.fix !== "tool") proposals.push({ ...mode.proposal, evidence_turns: [badTurn] });
    if (failed && mode.fix === "tool" && toolState !== "enabled") proposals.push({ ...mode.proposal, evidence_turns: [badTurn] });
    if (n === BAD_RULE_CALL && !badRuleActive) proposals.push({ ...BAD_RULE, evidence_turns: [2] });
    if (n === 18) proposals.push({ type: "prompt", op: "add", rule_kind: "behavior", reason: "Callers want rush prices.", evidence_turns: [2], text: "Tell callers that rush service costs $15 extra." });

    const judged = JudgeOutput.parse({
      scores, frustration, rationale: failed ? mode.issue.explanation : "Handled correctly and briefly.",
      issues: failed ? [{ type: mode.issue.type, turn: badTurn, quote: agentLine, explanation: mode.issue.explanation }] : [],
      improvements: proposals,
    });

    // grade, then the automatic rollback test, then apply what is left (real guardrails throughout)
    const plan = buildPlan(judged, call, cfg, "simulated-judge", now, nextVersionNumber());
    gradesByVersion.set(callVersion._id, [...(gradesByVersion.get(callVersion._id) ?? []), plan.grade.overall]);

    let rolledBack: { from: string; to: string } | null = null;
    let base2 = cfg;
    if (callVersion._id === cfg._id && cfg.created_by === "teacher" && cfg.parent_id) {
      const parent = versions.find((v) => v._id === cfg.parent_id)!;
      const test = guard === "prod" ? prodRegression : strictRegression;
      const hit = test(gradesByVersion.get(cfg._id) ?? [], gradesByVersion.get(parent._id) ?? []);
      if (hit) {
        for (const i of improvements) if (i.applied_in_config_id === cfg._id) { i.status = "rolled_back"; i.rolled_back_reason = `auto: ${cfg._id} averaged ${hit.avg.toFixed(2)}, below ${parent._id}'s ${hit.parentAvg.toFixed(2)}`; }
        const lost = cfg.rules.filter((rl) => !parent.rules.some((p) => p.id === rl.id && p.text === rl.text)).map((rl) => rl.text);
        rolledBack = { from: cfg._id, to: parent._id };
        base2 = cfg = parent;
        events.push({ call: n, kind: lost.includes(BAD_RULE.text) ? "rollback" : "false_rollback", text: lost.includes(BAD_RULE.text) ? `Automatic rollback ${rolledBack.from} to ${rolledBack.to}: the new rule made calls worse` : `Rolled back ${rolledBack.from} to ${rolledBack.to}, removing a rule that was working: ${lost[0] ?? ""}`, version: rolledBack.to });
      }
    }
    const finalPlan = base2 === callVersion && !rolledBack ? plan : buildPlan(judged, call, base2, "simulated-judge", now, nextVersionNumber());

    for (const imp of finalPlan.improvements) improvements.push(imp);
    for (const t of finalPlan.toolRequests) {
      const have = toolRequests.get(t._id);
      if (!have) { toolRequests.set(t._id, t); toolState = "requested"; events.push({ call: n, kind: "tool_requested", text: `Teacher requested a new tool: ${t.name}()` }); }
      else if (!have.source_call_ids.includes(call._id)) { have.request_count++; have.source_call_ids.push(call._id); }
    }
    if (finalPlan.nextConfig) {
      versions.push(finalPlan.nextConfig); cfg = finalPlan.nextConfig;
      for (const imp of finalPlan.improvements.filter((i) => i.status === "applied")) {
        events.push({ call: n, kind: imp.payload.text === BAD_RULE.text ? "bad_rule" : "rule_added", text: `New rule ${imp.payload.rule_id}: ${imp.payload.text}`, version: finalPlan.nextConfig._id });
      }
    }
    for (const imp of finalPlan.improvements) {
      if (imp.status === "rejected") events.push({ call: n, kind: "rejected", text: `Blocked by guardrail: ${imp.payload.text ?? ""} (${imp.rejected_reason})` });
      if (imp.type === "context" && imp.status === "proposed") events.push({ call: n, kind: "owner_question", text: `Teacher asked the owner: ${imp.payload.question}` });
    }

    calls.push({
      n, id: call._id, at: now.toISOString(), mode: mode.key, modeLabel: mode.label, failed, outcome,
      overall: plan.grade.overall, frustration: plan.grade.frustration, scores: plan.grade.scores,
      version: callVersion._id, rationale: plan.grade.rationale, issues: plan.grade.issues, transcript,
      improvements: finalPlan.improvements.map((i) => ({ type: i.type, status: i.status, text: i.payload.text ?? i.payload.question ?? i.payload.tool?.name, reason: i.rejected_reason })),
      rolledBack,
    });
  }

  return {
    guard, company: cfg.company_name, calls, events,
    versions: versions.map((v) => ({ id: v._id, parent: v.parent_id, by: v.created_by, note: v.note, rules: v.rules.map((rl) => ({ id: rl.id, kind: rl.kind, locked: !!rl.locked, text: rl.text })), context: v.context, at: v.created_at })),
    activeVersion: cfg._id,
    improvements: improvements.map((i) => ({ id: i._id, type: i.type, status: i.status, payload: i.payload, evidence: i.evidence_turns, version: i.applied_in_config_id, rejected: i.rejected_reason, rolledBack: i.rolled_back_reason })),
    toolRequests: [...toolRequests.values()].map((t) => ({ name: t.name, status: t.status, count: t.request_count, description: t.description, endpoint: t.endpoint })),
  };
}

// ---- output ------------------------------------------------------------------------------------------
const runs = { prod: simulate("prod"), strict: simulate("strict") };
const journey = {
  label: "SIMULATED: callers and judge are scripted. Guardrails, tool validation and the production rollback test are the real code.",
  modes: MODES.map((m) => ({ key: m.key, label: m.label, fix: m.fix, fixText: String(m.proposal.text ?? m.proposal.question ?? (m.proposal.tool as { name: string }).name) })),
  owner: { answerAt: OWNER_ANSWER_AT, answer: OWNER_ANSWER, approveAt: TOOL_APPROVE_AT, enableAt: TOOL_ENABLE_AT, badRuleAt: BAD_RULE_CALL },
  runs,
};
const out = resolve(here, "../demo");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "journey.json"), JSON.stringify(journey, null, 1));

const failRate = (xs: Record<string, unknown>[]) => xs.filter((c) => c.failed).length / Math.max(xs.length, 1);
const avg = (xs: Record<string, unknown>[], k: string) => r1(xs.reduce((sum, c) => sum + (c[k] as number), 0) / xs.length);
for (const [name, run] of Object.entries(runs)) {
  const f = run.calls.slice(0, 20), l = run.calls.slice(-20);
  const kinds = (k: string) => run.events.filter((e) => e.kind === k).length;
  console.log(`\n[${name}] versions ${run.versions.length}, rules ${run.versions.find((v) => v.id === run.activeVersion)!.rules.length}, good rollbacks ${kinds("rollback")}, false rollbacks ${kinds("false_rollback")}, blocked ${kinds("rejected")}`);
  console.log(`  first 20 calls: score ${avg(f, "overall")}, frustration ${avg(f, "frustration")}, failed ${Math.round(failRate(f) * 100)}%`);
  console.log(`  last 20 calls:  score ${avg(l, "overall")}, frustration ${avg(l, "frustration")}, failed ${Math.round(failRate(l) * 100)}%`);
}
for (const e of runs.prod.events) console.log(`  prod #${e.call} ${e.kind}: ${e.text.slice(0, 100)}`);

try {
  const html = readFileSync(resolve(here, "../demo/journey.template.html"), "utf8").replace("/*JOURNEY_DATA*/null", JSON.stringify(journey));
  writeFileSync(resolve(here, "../../docs/teacher-journey.html"), html);
  console.log("wrote docs/teacher-journey.html");
} catch {
  console.log("no template yet, wrote demo/journey.json only");
}
