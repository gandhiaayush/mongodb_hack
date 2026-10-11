// Pure logic, no database and no model. This is the guardrail layer between
// what the teacher proposes and what is allowed to reach the receptionist.

import { configId } from "../mongo/bridge.js";
import type {
  CallDoc, ConfigVersionDoc, GradeDoc, ImprovementDoc, Issue, Rule, Scores, ToolRequestDoc,
} from "../mongo/types.js";
import type { JudgeOutput } from "./judge.js";
import { validateToolSpec } from "./tools.js";

export const LIMITS = { maxPromptChangesPerCall: 3, maxRules: 20, maxRuleLength: 300, rollbackWindow: 2 };

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

/** A rule may not smuggle in a business fact: any number it contains must already exist in the config. */
function inventedNumbers(text: string, cfg: ConfigVersionDoc): string[] {
  const known = [cfg.company_name, cfg.greeting, cfg.context, ...cfg.rules.map((r) => r.text)].join(" ");
  return (text.match(/\d+(?:[.:]\d+)?/g) ?? []).filter((n) => !known.includes(n));
}

export interface Plan {
  grade: GradeDoc;
  improvements: ImprovementDoc[]; // every proposal, with final status
  nextConfig: ConfigVersionDoc | null; // null when nothing was applied
  toolRequests: ToolRequestDoc[]; // new asks for tools; always status "requested", merged into the DB by teach()
}

export function buildPlan(
  out: JudgeOutput, call: CallDoc, cfg: ConfigVersionDoc, model: string, now = new Date(),
  nextVersion = cfg.version + 1, // higher after a rollback, when cfg is not the newest version
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
  const toolRequests: ToolRequestDoc[] = [];

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
    if (p.type === "context") return p.question?.trim() ? doc : reject("context needs a question for the owner");
    if (p.type === "tool") {
      // A tool is only ever REQUESTED. The owner decides, and supplies the endpoint that makes it real.
      const v = validateToolSpec(p.tool);
      if ("error" in v) return reject(v.error);
      toolRequests.push({
        ...v.spec, _id: v.spec.name, status: "requested", reason: p.reason, request_count: 1,
        source_call_ids: [call._id], created_at: now, updated_at: now,
      });
      doc.payload.tool = v.spec;
      return doc;
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

  const nextConfig: ConfigVersionDoc | null = applied === 0 ? null : {
    ...cfg, _id: nextId, version: nextVersion, rules, parent_id: cfg._id,
    created_by: "teacher", source_call_id: call._id, created_at: now,
    note: `Teacher: ${applied} rule change${applied === 1 ? "" : "s"} after call ${call._id}`,
  };
  return { grade, improvements, nextConfig, toolRequests };
}
