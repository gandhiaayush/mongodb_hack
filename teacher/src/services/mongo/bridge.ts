// Pure conversion between the bridge's documents and the teacher's view. No database.
//
// The bridge's config has one free-text `context` field and no place for rules, so the teacher
// keeps its rules in a marked block at the end of that text. The bridge already injects `context`
// into the system prompt and shows it in the dashboard editor, so rules reach the receptionist
// and stay visible to the manager without any change on the bridge side.

import { TOOL_NAMES } from "./types.js";
import type {
  BridgeCall, BridgeConfig, CallDoc, ConfigVersionDoc, Outcome, Permission, Rule, ToolCall, ToolName, ToolPermissions,
} from "./types.js";

const RULES_START = "LEARNED RULES (added by the teaching agent after reviewing calls; follow every one):";
const RULES_END = "END OF LEARNED RULES";
const RULE_LINE = /^- \((r\d+), (guardrail|behavior)(, locked)?\) (.+)$/;

export const configId = (version: number) => `v${version}`;
export const versionOf = (id: string) => Number(id.slice(1));

const TOOLS_START = "BOOKING TOOLS (permission for each calendar tool, set by the teaching agent or the owner):";
const TOOLS_LEGEND = "auto = use the tool yourself. requires_approval = the request goes to the owner, so tell the caller the owner will confirm. disabled = do not use the tool, offer to take a message instead.";
const TOOLS_END = "END OF BOOKING TOOLS";
const TOOL_LINE = /^- (check_availability|book_appointment): (disabled|requires_approval|auto)$/;

export const NO_TOOLS: ToolPermissions = { check_availability: "disabled", book_appointment: "disabled" };

/** Cuts a marked block out of the text. `inside` is null when the block is absent. */
function takeBlock(lines: string[], startsWith: string, endsWith: string): { inside: string[] | null; rest: string[] } {
  const start = lines.findIndex((l) => l.trim().startsWith(startsWith));
  if (start < 0) return { inside: null, rest: lines };
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith(endsWith));
  if (end < 0) end = lines.length;
  return { inside: lines.slice(start + 1, end), rest: [...lines.slice(0, start), ...lines.slice(end + 1)] };
}

/** Splits the bridge's context text into the company's own text, the teacher's rules and the tool permissions. */
export function splitContext(text: string): { context: string; rules: Rule[]; tools: ToolPermissions } {
  const ruleBlock = takeBlock(text.split("\n"), "LEARNED RULES", RULES_END);
  const toolBlock = takeBlock(ruleBlock.rest, "BOOKING TOOLS", TOOLS_END);
  const rules: Rule[] = [];
  const tools: ToolPermissions = { ...NO_TOOLS };
  const stray: string[] = []; // lines a person typed inside a block: keep them as company text
  for (const line of ruleBlock.inside ?? []) {
    const m = RULE_LINE.exec(line.trim());
    if (m) rules.push({ id: m[1]!, kind: m[2] as Rule["kind"], text: m[4]!, ...(m[3] ? { locked: true } : {}) });
    else if (line.trim()) stray.push(line);
  }
  for (const line of toolBlock.inside ?? []) {
    const m = TOOL_LINE.exec(line.trim());
    if (m) tools[m[1] as ToolName] = m[2] as Permission;
    else if (line.trim() && line.trim() !== TOOLS_LEGEND) stray.push(line);
  }
  return { context: [...toolBlock.rest, ...stray].join("\n").trim(), rules, tools };
}

/** The context text exactly as the bridge will put it in the receptionist's system prompt. */
export function renderContext(cfg: Pick<ConfigVersionDoc, "context" | "rules" | "tools">): string {
  const parts = [cfg.context];
  // The block is left out while every tool is disabled, so a business without a calendar never sees it.
  if (TOOL_NAMES.some((t) => cfg.tools[t] !== "disabled"))
    parts.push([TOOLS_START, ...TOOL_NAMES.map((t) => `- ${t}: ${cfg.tools[t]}`), TOOLS_LEGEND, TOOLS_END].join("\n"));
  if (cfg.rules.length) {
    const lines = cfg.rules.map((r) => `- (${r.id}, ${r.kind}${r.locked ? ", locked" : ""}) ${r.text}`);
    parts.push([RULES_START, ...lines, RULES_END].join("\n"));
  }
  return parts.join("\n\n").trim();
}

export function toConfig(doc: BridgeConfig): ConfigVersionDoc {
  return {
    _id: configId(doc.version), version: doc.version, company_name: doc.companyName, greeting: doc.greeting,
    ...splitContext(doc.context),
    parent_id: doc.parentVersion ? configId(doc.parentVersion) : null,
    created_by: doc.author, source_call_id: doc.sourceCallSid ?? null,
    ...(doc.note ? { note: doc.note } : {}), created_at: new Date(doc.createdAt),
  };
}

export function fromConfig(cfg: ConfigVersionDoc): BridgeConfig {
  return {
    version: cfg.version, companyName: cfg.company_name, greeting: cfg.greeting, context: renderContext(cfg),
    author: cfg.created_by, ...(cfg.note ? { note: cfg.note } : {}), createdAt: cfg.created_at.toISOString(),
    ...(cfg.parent_id ? { parentVersion: versionOf(cfg.parent_id) } : {}),
    ...(cfg.source_call_id ? { sourceCallSid: cfg.source_call_id } : {}),
  };
}

export const toolResult = (t: ToolCall) =>
  (t.result && typeof t.result === "object" ? t.result : {}) as Record<string, unknown>;
/** A tool call failed if the gateway or the tool reported an error. A refusal with a `reason` is not an error. */
export const toolFailed = (t: ToolCall) => t.error !== undefined || toolResult(t).error !== undefined;

/**
 * The bridge does not label outcomes, so the label comes from tool results only:
 * an appointment booked, else a saved message, else a tool error, else "answered" (which only means none of those).
 */
export function deriveOutcome(tools: ToolCall[]): Outcome {
  if (tools.some((t) => t.name === "book_appointment" && toolResult(t).booked === true)) return "booked";
  if (tools.some((t) => t.name === "take_message" && toolResult(t).saved === true)) return "message_taken";
  if (tools.some(toolFailed)) return "failed";
  return "answered";
}

export function toCall(rec: BridgeCall): CallDoc {
  const tool_trace = rec.toolCalls.map(({ name, args, result }) => ({ name, args, result }));
  return {
    _id: rec.callSid,
    config_version_id: rec.configVersion ? configId(rec.configVersion) : null,
    transcript: rec.transcript.map((t, i) => ({ turn: i + 1, role: t.role, text: t.text })),
    tool_trace, outcome: deriveOutcome(tool_trace),
    ...(rec.durationSec !== undefined ? { duration_sec: rec.durationSec } : {}),
    created_at: new Date(rec.startedAt),
  };
}
