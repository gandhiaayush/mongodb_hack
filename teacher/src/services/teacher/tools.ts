// Tool requests: pure validation, no database. The teacher proposes the SHAPE of a tool;
// a person decides, and only an owner can attach the endpoint that makes it real.

import type { ToolParam, ToolParamType, ToolSpec } from "../mongo/types.js";

/** The tools the bridge ships with (src/services/gemini/tools.ts). A request may not reuse these names. */
export const BUILT_IN_TOOLS = [
  "get_order", "lookup_price", "list_prices", "add_order_note", "take_message",
  "get_hours", "quote_estimate", "check_turnaround", "create_order", "schedule_pickup", "get_customer",
  "check_pickup_slots", "reschedule_pickup", "cancel_pickup",
];

export const TOOL_LIMITS = { maxParams: 6, maxEnabled: 8, descriptionLength: 400 };

const NAME = /^[a-z][a-z0-9_]{2,39}$/;
const PARAM_TYPES: ToolParamType[] = ["string", "number", "integer", "boolean"];

export function validateToolSpec(raw: unknown): { spec: ToolSpec } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "tool request needs a structured tool spec" };
  const t = raw as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!NAME.test(name)) return { error: `tool name "${name}" must be snake_case, 3-40 chars` };
  if (BUILT_IN_TOOLS.includes(name)) return { error: `${name} is a built-in tool` };
  const description = typeof t.description === "string" ? t.description.replace(/\s+/g, " ").trim() : "";
  if (!description) return { error: "tool needs a description" };
  if (description.length > TOOL_LIMITS.descriptionLength) return { error: "tool description too long" };
  const params = Array.isArray(t.parameters) ? t.parameters : [];
  if (params.length > TOOL_LIMITS.maxParams) return { error: `more than ${TOOL_LIMITS.maxParams} parameters` };
  const parameters: ToolParam[] = [];
  for (const p of params as Record<string, unknown>[]) {
    const pn = typeof p.name === "string" ? p.name.trim() : "";
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(pn)) return { error: `bad parameter name "${pn}"` };
    if (!PARAM_TYPES.includes(p.type as ToolParamType)) return { error: `parameter ${pn} has unsupported type ${String(p.type)}` };
    if (parameters.some((x) => x.name === pn)) return { error: `duplicate parameter ${pn}` };
    parameters.push({
      name: pn, type: p.type as ToolParamType,
      description: typeof p.description === "string" ? p.description.slice(0, 200) : "",
      required: p.required !== false,
    });
  }
  const side_effect = t.side_effect === "write" ? "write" : "read";
  return { spec: { name, description, parameters, side_effect } };
}

/** Owners must give a real https endpoint (plain http only for localhost, for development). */
export function validateEndpoint(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "endpoint is not a valid URL"; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "endpoint must be https";
  if (u.username || u.password) return "endpoint must not contain credentials";
  return null;
}
