// Pure logic, no database and no model. This is the guardrail layer between
// what the teacher proposes and what is allowed to reach the receptionist.

import { configId } from "../mongo/bridge.js";
import type {
  CallDoc, ConfigVersionDoc, GradeDoc, ImprovementDoc, Issue, Rule, Scores, ToolProposal,
} from "../mongo/types.js";
import type { JudgeOutput } from "./judge.js";
import { CALLABLE_TOOLS, runRecipe, validateRecipe, WRITE_CALLS, type CallableTool, type Expr, type Recipe, type RecipeIO } from "./recipe.js";

export const LIMITS = {
  maxPromptChangesPerCall: 3, maxRules: 20, maxRuleLength: 300, rollbackWindow: 2,
  maxOwnerQuestionsPerCall: 2, maxQuestionLength: 160, questionSimilarity: 0.8,
};

const WEIGHTS: Record<keyof Scores, number> = {
  accuracy: 0.35, task_completion: 0.25, tool_use: 0.15, tone: 0.15, brevity: 0.1,
};

export function overallScore(s: Scores): number {
  const sum = (Object.keys(WEIGHTS) as (keyof Scores)[]).reduce((a, k) => a + s[k] * WEIGHTS[k], 0);
  return Math.round(sum * 10) / 10;
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

/**
 * Automatic rollback test. Both lists are `overall` scores, oldest first. A version has regressed
 * when its last `rollbackWindow` graded calls average lower than its parent's average.
 */
export function regression(versionOveralls: number[], parentOveralls: number[]): { avg: number; parentAvg: number } | null {
  if (versionOveralls.length < LIMITS.rollbackWindow || !parentOveralls.length) return null;
  const avg = mean(versionOveralls.slice(-LIMITS.rollbackWindow)), parentAvg = mean(parentOveralls);
  return avg < parentAvg ? { avg, parentAvg } : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function similar(a: string, b: string): boolean {
  const A = new Set(norm(a).split(" ")), B = new Set(norm(b).split(" "));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (A.size + B.size - inter) >= 0.75;
}

/** Owner questions: same text after normalisation, or word-set overlap (Jaccard) above 0.8. */
export function similarQuestion(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const A = new Set(x.split(" ")), B = new Set(y.split(" "));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (A.size + B.size - inter) > LIMITS.questionSimilarity;
}

/** The line appended to the company text when the owner answers a question. */
export function ownerAnswerLine(question: string, answer: string): string {
  return `Owner answer: ${question.trim()} ${answer.trim()}`;
}

/** A rule may not smuggle in a business fact: any number it contains must already exist in the config. */
function inventedNumbers(text: string, cfg: ConfigVersionDoc): string[] {
  const known = [cfg.company_name, cfg.greeting, cfg.context, ...cfg.rules.map((r) => r.text)].join(" ");
  return (text.match(/\d+(?:[.:]\d+)?/g) ?? []).filter((n) => !known.includes(n));
}

export interface Plan {
  toolProposal: ToolProposal | null; // validated proposal (status "proposed"); null if none or rejected
  grade: GradeDoc;
  improvements: ImprovementDoc[]; // every proposal, with final status
  nextConfig: ConfigVersionDoc | null; // null when nothing was applied
}

export interface PlanExtra {
  existingQuestions?: string[]; // owner questions already open or answered; a repeat is rejected
  recipeCheck?: RecipeCheck; // result of the async self-check (verifyToolRecipe) of the proposal's recipe
}

export function buildPlan(
  out: JudgeOutput, call: CallDoc, cfg: ConfigVersionDoc, model: string, now = new Date(),
  nextVersion = cfg.version + 1, // higher after a rollback, when cfg is not the newest version
  extra: PlanExtra = {},
): Plan {
  const turns = new Map(call.transcript.map((t) => [t.turn, t]));

  // Issues need a real quote from the transcript, otherwise they are dropped.
  const issues: Issue[] = out.issues.filter((i) => {
    const q = norm(i.quote);
    return q.length > 0 && call.transcript.some((t) => norm(t.text).includes(q));
  });

  const grade: GradeDoc = {
    _id: call._id, call_id: call._id,
    config_version_id: call.config_version_id, outcome: call.outcome,
    scores: out.scores, overall: overallScore(out.scores), frustration: out.frustration,
    rationale: out.rationale, issues, model, created_at: now,
  };

  const nextId = configId(nextVersion);
  let rules: Rule[] = cfg.rules.map((r) => ({ ...r }));
  let applied = 0;

  const askedQuestions = [...(extra.existingQuestions ?? [])];
  let ownerQuestions = 0;

  const improvements: ImprovementDoc[] = out.improvements.map((p, i) => {
    const doc: ImprovementDoc = {
      _id: `${call._id}_imp${i + 1}`, source_call_ids: [call._id],
      type: p.type, status: "proposed",
      payload: { op: p.op, rule_id: p.rule_id, rule_kind: p.rule_kind, text: p.text, question: p.question },
      evidence_turns: p.evidence_turns, reason: p.reason, created_at: now,
    };
    const reject = (why: string) => ({ ...doc, status: "rejected" as const, rejected_reason: why });

    if (!p.evidence_turns.length || !p.evidence_turns.every((t) => turns.has(t)))
      return reject("evidence turns missing or not in transcript");

    // context = a question for the owner; tool/schema = proposal only. Never auto-applied.
    if (p.type === "context") {
      const q = (p.question ?? "").replace(/\s+/g, " ").trim();
      if (!q) return reject("context needs a question for the owner");
      if (q.length >= LIMITS.maxQuestionLength) return reject(`question must be under ${LIMITS.maxQuestionLength} characters`);
      if (ownerQuestions >= LIMITS.maxOwnerQuestionsPerCall) return reject(`at most ${LIMITS.maxOwnerQuestionsPerCall} owner questions per call`);
      if (askedQuestions.some((e) => similarQuestion(e, q))) return reject("the owner was already asked this question (open or answered)");
      ownerQuestions++;
      askedQuestions.push(q);
      return { ...doc, payload: { ...doc.payload, question: q } };
    }
    if (p.type !== "prompt") return p.text?.trim() ? doc : reject("proposal needs a description");

    if (applied >= LIMITS.maxPromptChangesPerCall) return reject("per-call change cap reached");
    const text = (p.text ?? "").replace(/\s+/g, " ").trim(); // one line: rules are stored as lines of text

    if (p.op === "add" || p.op === "modify") {
      if (!text) return reject("rule text is empty");
      if (text.length > LIMITS.maxRuleLength) return reject("rule too long");
      const bad = inventedNumbers(text, cfg);
      if (bad.length) return reject(`rule contains facts not in the knowledge base: ${bad.join(", ")}`);
    }

    if (p.op === "add") {
      if (rules.some((r) => similar(r.text, text))) return reject("duplicates an existing rule");
      if (rules.length >= LIMITS.maxRules) return reject("rule cap reached; merge or remove first");
      const n = Math.max(0, ...rules.map((r) => Number(r.id.replace(/\D/g, "")) || 0)) + 1;
      rules.push({ id: `r${n}`, kind: p.rule_kind ?? "behavior", text });
      doc.payload.rule_id = `r${n}`;
    } else if (p.op === "modify" || p.op === "remove") {
      const target = rules.find((r) => r.id === p.rule_id);
      if (!target) return reject(p.rule_id ? `rule ${p.rule_id} does not exist` : `${p.op} needs a rule_id`);
      if (target.locked) return reject(`rule ${p.rule_id} is locked`);
      if (p.op === "remove") rules = rules.filter((r) => r.id !== target.id);
      else target.text = text;
    } else return reject("prompt change needs op add, modify or remove");

    applied++;
    return { ...doc, status: "applied" as const, applied_in_config_id: nextId };
  });

  // Capability gap: at most one tool proposal per call, validated in code. Always stored as an improvement of type "tool".
  let toolProposal: ToolProposal | null = null;
  if (out.tool_proposal) {
    const v = validateToolProposal(out.tool_proposal, call, now, extra.recipeCheck);
    const tp = out.tool_proposal;
    const doc: ImprovementDoc = {
      _id: `${call._id}_imp${improvements.length + 1}`, source_call_ids: [call._id], type: "tool", status: "proposed",
      payload: { text: tp.description, tool_name: tp.name },
      evidence_turns: v.ok ? v.proposal.evidence.map((e) => e.turn) : [],
      reason: tp.why, created_at: now,
    };
    if (v.ok) { toolProposal = v.proposal; improvements.push(doc); }
    else improvements.push({ ...doc, status: "rejected", rejected_reason: `tool proposal: ${v.reason}` });
  }

  const nextConfig: ConfigVersionDoc | null = applied === 0 ? null : {
    ...cfg, _id: nextId, version: nextVersion, rules, parent_id: cfg._id,
    created_by: "teacher", source_call_id: call._id, created_at: now,
    note: `Teacher: ${applied} rule change${applied === 1 ? "" : "s"} after call ${call._id}`,
  };
  return { grade, improvements, nextConfig, toolProposal };
}

// ---------------------------------------------------------------------------------------------
// Tool proposals (capability gaps). Tools are declarative: the bridge saves the args as a record
// (write) or lists that caller's records (read). This validation is the safety gate.

export const BUILTIN_TOOLS = [
  "get_order", "lookup_price", "list_prices", "add_order_note", "take_message", "update_customer_profile",
  "create_order", "set_order_type", "cancel_order", "schedule_appointment", "quote_turnaround",
];
export const TOOL_LIMITS = { maxParams: 6, minDialogue: 2, maxDialogue: 8, maxDescription: 300, maxParamDescription: 200 };
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PARAM_TYPES = ["string", "number", "boolean"];
const DIALOGUE_ROLES = ["caller", "agent", "tool"];
// External systems, credentials, payments: not expressible as "save these fields", so never allowed.
const FORBIDDEN = [
  /https?:/i, /www\./i, /\.(com|net|org|io)\b/i, /\burls?\b/i, /\bwebhooks?\b/i,
  /password/i, /credential/i, /api[ _-]?key/i, /\bsecrets?\b/i, /\btokens?\b/i, /\bssn\b/i, /social security/i,
  /payment/i, /\bpay(s|ing)?\b/i, /credit/i, /debit/i, /card[ _-]?(number|no|num)/i, /\bcvv\b/i, /billing/i, /\bcharge[sd]?\b/i,
];

export type ToolValidation = { ok: true; proposal: ToolProposal } | { ok: false; reason: string };

export function validateToolProposal(
  p: NonNullable<JudgeOutput["tool_proposal"]>, call: CallDoc, now = new Date(), recipeCheck?: RecipeCheck,
): ToolValidation {
  const no = (reason: string): ToolValidation => ({ ok: false, reason });
  const name = p.name.trim(), description = p.description.trim(), why = p.why.trim();
  if (!SNAKE.test(name) || name.length < 3 || name.length > 40) return no("name must be snake_case, 3-40 characters");
  if (BUILTIN_TOOLS.includes(name)) return no(`${name} is a built-in tool`);
  if (!description || description.length >= TOOL_LIMITS.maxDescription) return no("description must be non-empty and under 300 characters");
  if (!why) return no("why is empty");
  if (p.params.length > TOOL_LIMITS.maxParams) return no(`more than ${TOOL_LIMITS.maxParams} params`);
  const seen = new Set<string>();
  for (const q of p.params) {
    if (!SNAKE.test(q.name)) return no(`param name "${q.name}" is not snake_case`);
    if (seen.has(q.name)) return no(`duplicate param "${q.name}"`);
    seen.add(q.name);
    if (!PARAM_TYPES.includes(q.type)) return no(`param "${q.name}" has type "${q.type}", allowed: string, number, boolean`);
    const d = q.description.trim();
    if (!d || d.length >= TOOL_LIMITS.maxParamDescription) return no(`param "${q.name}" description must be non-empty and under 200 characters`);
  }
  const m = p.mockup;
  if (!m) return no("mockup is missing");
  if (m.sampleDialogue.length < TOOL_LIMITS.minDialogue || m.sampleDialogue.length > TOOL_LIMITS.maxDialogue)
    return no("sample dialogue must have 2 to 8 turns");
  if (m.sampleDialogue.some((t) => !DIALOGUE_ROLES.includes(t.role) || !t.text.trim()))
    return no("sample dialogue turns need role caller, agent or tool and non-empty text");
  const stray = Object.keys(m.exampleArgs).filter((k) => !seen.has(k));
  if (stray.length) return no(`exampleArgs has keys that are not params: ${stray.join(", ")}`);

  // Evidence: every quote must be in the transcript (same normalization as issues). Turn is corrected to where it is found.
  if (!p.evidence.length) return no("no evidence quote");
  const evidence: ToolProposal["evidence"] = [];
  for (const e of p.evidence) {
    const q = norm(e.quote);
    const hits = call.transcript.filter((t) => q.length > 0 && norm(t.text).includes(q));
    if (!hits.length) return no(`evidence quote not found in transcript: "${e.quote.slice(0, 60)}"`);
    evidence.push({ turn: (hits.find((t) => t.turn === e.turn) ?? hits[0]!).turn, quote: e.quote.trim() });
  }

  let recipe: Recipe | undefined;
  if (p.recipe) {
    const bad = checkRecipeStatic(p.recipe, p.params, p.write);
    if (bad) return no(`recipe: ${bad}`);
    if (/https?:|www\./i.test(JSON.stringify(p.recipe))) return no("recipe: mentions a URL");
    if (!recipeCheck) return no("recipe: the self-check was not run");
    if (!recipeCheck.ok) return no(`recipe self-check failed: ${recipeCheck.error}`);
    recipe = p.recipe as unknown as Recipe;
  }

  const scanned = JSON.stringify([name, description, why, p.params, m]);
  const bad = FORBIDDEN.find((re) => re.test(scanned));
  if (bad) return no(`mentions an external system, credentials or payments (${bad.source}); tools may only save or look up fields`);

  const iso = now.toISOString();
  return { ok: true, proposal: {
    name, description, write: p.write, why,
    params: p.params.map((q) => ({ name: q.name, type: q.type as "string" | "number" | "boolean", description: q.description.trim(), required: q.required })),
    mockup: {
      sampleDialogue: m.sampleDialogue.map((t) => ({ role: t.role as "caller" | "agent" | "tool", text: t.text.trim() })),
      exampleArgs: m.exampleArgs, exampleResult: m.exampleResult,
    },
    ...(recipe ? { recipe, recipeVerified: true } : {}),
    status: "proposed", requestCount: 1, sourceCallSids: [call._id], evidence, createdAt: iso, updatedAt: iso,
  } };
}

export const TOOL_DEFAULTS = { gradeThreshold: 7 };

export interface ToolDecision {
  action: "create" | "bump" | "skip"; // create = insert new; bump = existing, only count/sources/updatedAt (plus status if promoted); skip = owner decided no
  status: ToolProposal["status"]; // status the stored proposal ends up with
  promote: boolean; // true when status becomes "enabled" now (by the teacher)
  threshold: number;
}

/**
 * Pure decision: what to do with a validated proposal. Auto-enable (declarative tools only; validateToolProposal is the
 * safety gate) when TEACHER_AUTO_ENABLE_TOOLS is not "0" and the call's overall grade is below TOOL_GRADE_THRESHOLD
 * (default 7). A "disabled" or "declined" tool is never touched. An already enabled tool only gets its counters bumped.
 */
export function decideToolStatus(
  overall: number, existing: ToolProposal["status"] | null,
  env: { TEACHER_AUTO_ENABLE_TOOLS?: string; TOOL_GRADE_THRESHOLD?: string } = {},
): ToolDecision {
  const t = Number(env.TOOL_GRADE_THRESHOLD);
  const threshold = env.TOOL_GRADE_THRESHOLD?.trim() && Number.isFinite(t) ? t : TOOL_DEFAULTS.gradeThreshold;
  const auto = env.TEACHER_AUTO_ENABLE_TOOLS !== "0" && overall < threshold;
  if (existing === "disabled" || existing === "declined") return { action: "skip", status: existing, promote: false, threshold };
  if (existing === "enabled") return { action: "bump", status: "enabled", promote: false, threshold };
  if (existing === "proposed") return { action: "bump", status: auto ? "enabled" : "proposed", promote: auto, threshold };
  return { action: "create", status: auto ? "enabled" : "proposed", promote: auto, threshold };
}

/** Merges a repeat request into the stored proposal. Never touches status here; see decideToolStatus. Idempotent per call. */
export function mergeToolProposal(existing: ToolProposal, incoming: ToolProposal, now = new Date()): ToolProposal {
  const already = incoming.sourceCallSids.every((s) => existing.sourceCallSids.includes(s));
  return {
    ...existing,
    requestCount: already ? existing.requestCount : existing.requestCount + 1,
    sourceCallSids: [...new Set([...existing.sourceCallSids, ...incoming.sourceCallSids])],
    evidence: already ? existing.evidence : [...existing.evidence, ...incoming.evidence].slice(0, 6),
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Recipes: static validation, self-check against a mock io, and a plain-English description.

type RawParam = { name: string; type: string };

/** Static checks: the shared validateRecipe, plus the `confirmed` rule for data-changing built-ins. Error text or null. */
export function checkRecipeStatic(recipe: unknown, params: RawParam[], write: boolean): string | null {
  const bad = validateRecipe(recipe, params.map((q) => q.name), write);
  if (bad) return bad;
  const steps = (recipe as Recipe).steps;
  const writeCalls = steps.filter((s) => s.do === "call" && WRITE_CALLS.includes(s.tool));
  if (!writeCalls.length) return null;
  const conf = params.find((q) => q.name === "confirmed");
  if (!conf || conf.type !== "boolean") return 'a recipe that changes data needs a boolean param named "confirmed"';
  for (const s of writeCalls) {
    if (s.do !== "call") continue;
    const c = s.args.confirmed as Expr | undefined;
    if (!c || typeof c !== "object" || !("ref" in c) || c.ref !== "confirmed")
      return `call ${s.tool} must pass confirmed: {"ref":"confirmed"}`;
  }
  return null;
}

export type RecipeCheck = { ok: true } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function placeholderFor(key: string, now: Date): unknown {
  if (/date|day$/i.test(key)) return now.toISOString().slice(0, 10);
  if (/price|fee|total|cost|amount|extra|days|hours|count|number|minutes/i.test(key)) return 1;
  return "x";
}

/** Stub results for `call` steps: every key the recipe later reads with `get` (also nested) is set to a non-null placeholder. */
function stubResults(recipe: Recipe, now: Date): Record<string, Record<string, unknown>> {
  const pathOf = new Map<string, string[]>(); // variable -> path inside its call result
  const callOf = new Map<string, string>(); // variable -> the call step it comes from
  const wanted = new Map<string, string[][]>(); // call `as` -> paths that are read
  for (const s of recipe.steps) if (s.do === "call") { pathOf.set(s.as, []); callOf.set(s.as, s.as); wanted.set(s.as, []); }

  const resolve = (e: Expr): { call: string; path: string[] } | null => {
    if (!isObj(e)) return null;
    if ("ref" in e) { const p = pathOf.get(String(e.ref)); return p ? { call: callOf.get(String(e.ref))!, path: p } : null; }
    if ("op" in e && e.op === "get" && Array.isArray(e.args) && typeof e.args[1] === "string") {
      const base = resolve(e.args[0] as Expr);
      return base ? { call: base.call, path: [...base.path, e.args[1]] } : null;
    }
    return null;
  };
  const walk = (e: Expr): void => {
    if (!isObj(e)) return;
    if ("op" in e && Array.isArray(e.args)) {
      const r = resolve(e);
      if (r) wanted.get(r.call)!.push(r.path);
      for (const a of e.args) walk(a);
    }
  };
  for (const s of recipe.steps) {
    if (s.do === "compute") {
      const r = resolve(s.expr);
      if (r) { pathOf.set(s.as, r.path); callOf.set(s.as, r.call); }
      walk(s.expr);
    } else if (s.do === "require") walk(s.when);
    else if (s.do === "save") Object.values(s.fields).forEach(walk);
    else if (s.do === "call") Object.values(s.args).forEach(walk);
    else if (s.do === "lookup" && s.query !== undefined) walk(s.query);
  }
  Object.values(recipe.response).forEach(walk);

  const out: Record<string, Record<string, unknown>> = {};
  for (const [as, paths] of wanted) {
    const stub: Record<string, unknown> = { ok: true };
    for (const path of paths.filter((p) => p.length).sort((a, b) => a.length - b.length)) {
      let o = stub;
      path.forEach((k, i) => {
        if (i === path.length - 1) { if (!isObj(o[k])) o[k] = placeholderFor(k, now); }
        else { if (!isObj(o[k])) o[k] = {}; o = o[k] as Record<string, unknown>; }
      });
    }
    out[as] = stub;
  }
  return out;
}

/**
 * Runs the proposal's own recipe on its own exampleArgs against a mock io (save -> REC-TEST, lookup -> [], call -> stub).
 * Pure: no database, no model. Returns ok:true only when the recipe passes the static checks AND runs without error.
 */
export async function selfCheckRecipe(
  recipe: unknown, params: RawParam[], write: boolean, exampleArgs: Record<string, unknown>, now = new Date(),
): Promise<RecipeCheck> {
  const bad = checkRecipeStatic(recipe, params, write);
  if (bad) return { ok: false, error: bad };
  const r = recipe as Recipe;
  const stubs = stubResults(r, now);
  let callIndex = 0;
  const io: RecipeIO = {
    async save() { return { recordId: "REC-TEST" }; },
    async lookup() { return []; },
    async call(tool: CallableTool) {
      if (!CALLABLE_TOOLS.includes(tool)) return { error: `cannot call ${tool}` };
      // Steps run in order, so the n-th call gets the n-th call step's stub.
      const step = r.steps.filter((s) => s.do === "call")[callIndex++];
      return step && step.do === "call" ? stubs[step.as] ?? { ok: true } : { ok: true };
    },
  };
  const res = await runRecipe(r, exampleArgs, io, now);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Async wrapper used by teach(): self-check the proposal's recipe, if it has one. undefined when there is none. */
export async function verifyToolRecipe(tp: NonNullable<JudgeOutput["tool_proposal"]>): Promise<RecipeCheck | undefined> {
  if (!tp.recipe) return undefined;
  return selfCheckRecipe(tp.recipe, tp.params, tp.write, tp.mockup?.exampleArgs ?? {});
}

const SYMBOLS: Record<string, string> = { add: "+", sub: "-", mul: "*", div: "/", gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "!=" };

function showExpr(e: Expr): string {
  if (e === null) return "nothing";
  if (typeof e === "string") return JSON.stringify(e);
  if (typeof e !== "object") return String(e);
  if ("ref" in e) return e.ref;
  const args = e.args.map(showExpr);
  const sym = SYMBOLS[e.op];
  if (sym && args.length >= 2) return `(${args.join(` ${sym} `)})`;
  if (e.op === "and" || e.op === "or") return `(${args.join(` ${e.op} `)})`;
  if (e.op === "not") return `not ${args[0]}`;
  if (e.op === "if") return `if ${args[0]} then ${args[1]} else ${args[2]}`;
  if (e.op === "get") return `${args[0]}.${typeof e.args[1] === "string" ? e.args[1] : args[1]}`;
  if (e.op === "today") return "today's date";
  return `${e.op}(${args.join(", ")})`;
}
const showMap = (m: Record<string, Expr>) => Object.entries(m).map(([k, v]) => `${k} = ${showExpr(v)}`).join(", ");

/** One plain-English line per recipe step, plus the reply. Simple on purpose. */
export function describeRecipe(recipe: Recipe): string[] {
  const lines = recipe.steps.map((s): string => {
    switch (s.do) {
      case "compute": return `Calculate ${s.as} = ${showExpr(s.expr)}`;
      case "require": {
        const w = s.when;
        const cond = typeof w === "object" && w !== null && "ref" in w ? `${w.ref} is true` : showExpr(w);
        return `Check that ${cond}`;
      }
      case "save": return `Save a record with ${showMap(s.fields)}`;
      case "lookup": return `Look up this caller's saved records${s.query === undefined ? "" : ` matching ${showExpr(s.query)}`} as ${s.as}`;
      case "call": return `Call ${s.tool}${Object.keys(s.args).length ? ` with ${showMap(s.args)}` : ""} as ${s.as}`;
      default: return "Unknown step";
    }
  });
  lines.push(`Reply with ${showMap(recipe.response)}`);
  return lines;
}
