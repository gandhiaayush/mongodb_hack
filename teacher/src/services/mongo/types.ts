// Two groups of shapes:
//  1. Bridge* = documents owned by the voice bridge (github.com/gandhiaayush/mongodb_hack,
//     src/services/data/store.ts). Do not change them here without telling the partner.
//  2. Everything else = the teacher's own view. src/services/mongo/bridge.ts converts between the two.

import type { Recipe } from "../teacher/recipe.js";

/** `calls` collection, written by the bridge's CallRecorder. Keyed by callSid. */
export interface BridgeCall {
  callSid: string;
  from?: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  transcript: { role: "caller" | "agent"; text: string; ts: string }[];
  toolCalls: { name: string; args: Record<string, unknown>; result: unknown; ts: string }[];
  status: "active" | "completed";
  configVersion?: number; // version that handled the call
}

/** `config_versions` collection. Immutable, unique `version`. The bridge injects `context` into its system prompt. */
export interface BridgeConfig {
  version: number;
  companyName: string;
  greeting: string;
  context: string; // company text, followed by the teacher's LEARNED RULES block
  author: "manager" | "teacher" | "system";
  note?: string;
  createdAt: string;
  // Added by the teacher. The bridge ignores them.
  parentVersion?: number;
  sourceCallSid?: string;
}

/** `config_state` collection: one document `{ _id: "active", version }`. */
export interface BridgeConfigState {
  _id: string;
  version: number;
}

export type Turn = { turn: number; role: "caller" | "agent"; text: string };
export type ToolCall = { name: string; args?: unknown; result?: unknown };
export type Outcome = "booked" | "message_taken" | "answered" | "escalated" | "failed";

/** A finished call as the teacher sees it. `_id` is the callSid. */
export interface CallDoc {
  _id: string;
  config_version_id: string | null; // "v<N>", null if the bridge did not record it
  transcript: Turn[];
  tool_trace: ToolCall[];
  outcome: Outcome; // derived from the tool trace, see deriveOutcome
  duration_sec?: number;
  created_at: Date;
}

export interface Rule {
  id: string;
  kind: "guardrail" | "behavior";
  text: string;
  locked?: boolean; // teacher may not modify or remove
}

/** One config version as the teacher sees it: company text and rules split apart. */
export interface ConfigVersionDoc {
  _id: string; // "v<N>"
  version: number;
  company_name: string;
  greeting: string;
  context: string; // company-written text only. The teacher never changes it.
  rules: Rule[];
  parent_id: string | null; // null for versions the teacher did not create
  created_by: "manager" | "teacher" | "system";
  source_call_id: string | null;
  note?: string;
  created_at: Date;
}

export interface Scores {
  accuracy: number;
  tool_use: number;
  task_completion: number;
  tone: number;
  brevity: number;
}

export interface Issue {
  type: string;
  turn: number;
  quote: string;
  explanation: string;
}

export interface GradeDoc {
  _id: string; // same as call id (callSid)
  call_id: string;
  config_version_id: string | null;
  outcome: Outcome;
  scores: Scores;
  overall: number; // computed in code, never by the model
  frustration: number; // 0 calm .. 10 very frustrated (transcript estimate)
  rationale: string;
  issues: Issue[];
  model: string;
  created_at: Date;
}

export type ImprovementType = "prompt" | "context" | "tool" | "schema";
export type ImprovementStatus = "proposed" | "applied" | "rejected" | "rolled_back";

export interface ImprovementDoc {
  _id: string;
  source_call_ids: string[];
  type: ImprovementType;
  status: ImprovementStatus;
  payload: {
    op?: "add" | "modify" | "remove";
    rule_id?: string;
    rule_kind?: "guardrail" | "behavior";
    text?: string;
    question?: string; // context: question for the owner
    answer?: string; // filled in when the owner replies
    tool_name?: string; // tool improvements from a tool_proposal: the proposed tool's name (= _id in tool_proposals)
  };
  evidence_turns: number[];
  reason: string;
  rejected_reason?: string;
  rolled_back_reason?: string; // why the version that applied it was rolled back
  applied_in_config_id?: string;
  created_at: Date;
}

/** `tool_proposals` collection, `_id` = tool name. Shared contract with the bridge and dashboard.
 *  The teacher only ever inserts "proposed" documents and bumps requestCount; the owner changes `status`. */
export interface ToolProposal {
  name: string; // snake_case, 3-40 chars
  description: string; // when the agent should call it
  params: { name: string; type: "string" | "number" | "boolean"; description: string; required: boolean }[]; // max 6
  write: boolean; // true = saves a record the owner can see later, false = looks up that caller's earlier records
  why: string;
  mockup: {
    sampleDialogue: { role: "caller" | "agent" | "tool"; text: string }[]; // 4 to 8 turns
    exampleArgs: Record<string, unknown>;
    exampleResult: Record<string, unknown>;
  };
  recipe?: Recipe; // optional: how the tool really behaves (shared safe recipe language, see teacher/recipe.ts)
  recipeVerified?: boolean; // true when the teacher ran the recipe on exampleArgs against a mock io and it passed
  status: "proposed" | "enabled" | "disabled" | "declined";
  requestCount: number;
  sourceCallSids: string[];
  evidence: { turn: number; quote: string }[];
  createdAt: string;
  updatedAt: string;
  enabledAt?: string;
  enabledBy?: "teacher" | "owner"; // who enabled it: the teacher (auto, low-grade call) or the owner (dashboard)
}
export type ToolProposalDoc = ToolProposal & { _id: string };
