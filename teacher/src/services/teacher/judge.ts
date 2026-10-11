import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { CallDoc, ConfigVersionDoc } from "../mongo/types.js";
import { validateRecipe } from "./recipe.js";

const score = z.coerce.number().min(0).max(10);

export const JudgeOutput = z.object({
  scores: z.object({
    accuracy: score, tool_use: score, task_completion: score, tone: score, brevity: score,
  }),
  frustration: score,
  rationale: z.string(),
  issues: z.array(z.object({
    type: z.string(),
    turn: z.coerce.number().int(),
    quote: z.string(),
    explanation: z.string(),
  })).default([]),
  improvements: z.array(z.object({
    type: z.enum(["prompt", "context", "tool", "schema"]),
    op: z.enum(["add", "modify", "remove"]).optional(),
    rule_id: z.string().optional(),
    rule_kind: z.enum(["guardrail", "behavior"]).optional(),
    text: z.string().optional(),
    question: z.string().optional(),
    evidence_turns: z.array(z.coerce.number().int()).default([]),
    reason: z.string().default(""),
  })).default([]),
  // At most one per call; null/absent when there is no capability gap. Kept lenient here (strings, not enums):
  // plan.ts validates it in code, so a sloppy proposal is rejected and recorded instead of failing the whole judgement.
  tool_proposal: z.object({
    name: z.string(),
    description: z.string(),
    params: z.array(z.object({
      name: z.string(), type: z.string(), description: z.string().default(""), required: z.boolean().default(false),
    })).default([]),
    write: z.boolean(),
    why: z.string().default(""),
    mockup: z.object({
      sampleDialogue: z.array(z.object({ role: z.string(), text: z.string() })).default([]),
      exampleArgs: z.record(z.string(), z.unknown()).default({}),
      exampleResult: z.record(z.string(), z.unknown()).default({}),
    }).nullish(),
    evidence: z.array(z.object({ turn: z.coerce.number().int(), quote: z.string() })).default([]),
    // Optional recipe (see RECIPES in the prompt). Kept lenient here; plan.ts runs validateRecipe + a self-check.
    recipe: z.object({
      steps: z.array(z.record(z.string(), z.unknown())),
      response: z.record(z.string(), z.unknown()),
    }).nullish(),
  }).nullish(),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export type Judge = (call: CallDoc, cfg: ConfigVersionDoc) => Promise<JudgeOutput>;

// The shared recipe validator only accepts snake_case names in a call's args. The built-ins' own argument names include
// camelCase ones (orderId, customerName), so a recipe cannot pass them until ../src/services/tools/recipe.ts (and the
// synced copy here) allows it. The prompt adapts, so the judge is never taught an example the validator rejects.
const CAMEL_ARGS_OK = validateRecipe(
  { steps: [{ do: "call", tool: "get_order", args: { orderId: "x" }, as: "o" }], response: { a: 1 } }, [], false) === null;

const BUILTIN_ARGS = CAMEL_ARGS_OK
  ? "The built-ins take: get_order {orderId, customerName, phone}; lookup_price {item, speed}; quote_turnaround {speed, item}; schedule_appointment {kind: pickup|delivery|dropoff, date YYYY-MM-DD, window, address, orderId, notes, name, phone, confirmed}; set_order_type {orderId, speed: Regular|Expedited}; create_order {garment, speed, notes, confirmed}."
  : "The built-ins take: get_order {phone}; lookup_price {item, speed}; quote_turnaround {speed, item}; schedule_appointment {kind: pickup|delivery|dropoff, date YYYY-MM-DD, window, address, notes, name, phone, confirmed}; create_order {garment, speed, notes, confirmed}. Argument names in a recipe must be lowercase, so do NOT use set_order_type or any argument written in camelCase (orderId, customerName) for now.";
const SET_ORDER_RETURNS = CAMEL_ARGS_OK ? "set_order_type returns {updated, order:{expectedDate,...}}; " : "";

const EXAMPLE3 = CAMEL_ARGS_OK
  ? `3. Rush booking: make an order Expedited, then book a pickup on its ready date (write tool, two call steps, date from the first result via get). params: order_id:string, address:string, window:string, confirmed:boolean.
{"steps":[{"do":"require","when":{"ref":"confirmed"},"else":"Read the details back and get a yes first."},{"do":"call","tool":"set_order_type","args":{"orderId":{"ref":"order_id"},"speed":"Expedited","confirmed":{"ref":"confirmed"}},"as":"rush"},{"do":"compute","as":"ready","expr":{"op":"get","args":[{"op":"get","args":[{"ref":"rush"},"order"]},"expectedDate"]}},{"do":"call","tool":"schedule_appointment","args":{"kind":"pickup","date":{"ref":"ready"},"window":{"ref":"window"},"address":{"ref":"address"},"orderId":{"ref":"order_id"},"confirmed":{"ref":"confirmed"}},"as":"booking"}],"response":{"rushed":true,"pickup_date":{"ref":"ready"},"scheduled":{"op":"get","args":[{"ref":"booking"},"scheduled"]}}}`
  : `3. Rush pickup booking: quote the Expedited turnaround, then book a pickup on its ready date (write tool, a read call then a data-changing call, date from the first result via get). params: address:string, window:string, confirmed:boolean.
{"steps":[{"do":"require","when":{"ref":"confirmed"},"else":"Read the details back and get a yes first."},{"do":"call","tool":"quote_turnaround","args":{"speed":"Expedited"},"as":"quote"},{"do":"compute","as":"ready","expr":{"op":"get","args":[{"ref":"quote"},"readyDate"]}},{"do":"call","tool":"schedule_appointment","args":{"kind":"pickup","date":{"ref":"ready"},"window":{"ref":"window"},"address":{"ref":"address"},"confirmed":{"ref":"confirmed"}},"as":"booking"}],"response":{"pickup_date":{"ref":"ready"},"scheduled":{"op":"get","args":[{"ref":"booking"},"scheduled"]}}}`;

// The rubric is fixed in code. The teacher can never edit it.
const SYSTEM = `You are the TEACHER for an AI phone receptionist that serves a small business.
You review one finished call and (1) grade it, (2) propose small changes to the receptionist's harness.

RUBRIC, each 0-10:
- accuracy: every factual statement by the agent is supported by BUSINESS KNOWLEDGE or by a tool result in TOOL TRACE. Any invented price, time, policy or availability caps this at 3.
- tool_use: right tool, right arguments, at the right moment; tool results relayed correctly. 10 if no tool was needed and none was called.
- task_completion: the caller got what they needed, or a clear next step (message taken, escalation).
- tone: natural, polite, sounds like a person on the phone.
- brevity: short spoken turns, no rambling, no repeated questions.
Also: frustration 0-10 = how frustrated the caller sounded (repeated questions, "this isn't working", asking for a human). Estimate from the text only.

ISSUES: each needs the turn number and an EXACT quote copied from that turn. No quote, no issue.

IMPROVEMENTS (at most 3, fewer is better, zero is fine for a good call):
- type "prompt": change a RULE. op "add" (give rule_kind + text), "modify" (rule_id + new text), or "remove" (rule_id).
  rule_id must be the id of a rule listed in CURRENT RULES, for example "r2". Locked rules cannot be modified or removed.
  Rules describe BEHAVIOR and must generalize beyond this one call. A rule must NEVER contain a business fact (price, hour, address, policy).
- type "context": the agent lacked a business fact. Do NOT guess the fact. Put the question the OWNER must answer in "question".
  Use this whenever the agent said "I don't have that on file" or had to deflect on pricing, scheduling or hours, the delivery area, or a policy. Ask AT MOST 2 questions per call, each short, specific and answerable in a sentence or two (for example: "What do you charge to hem pants?", "Do you offer same-day pickup on Saturdays?"). Never guess or suggest the answer, never ask about something BUSINESS KNOWLEDGE already states, and give each question evidence_turns (the turns where the fact was missing). The owner's answers are added to BUSINESS KNOWLEDGE, so good questions make the receptionist better over time.
- type "schema": a missing data field. Describe it in "text". This is a proposal only. For a missing TOOL, use "tool_proposal" (below), not an improvement.
Every improvement needs evidence_turns (turn numbers) and a one-sentence reason. Do not add a rule that duplicates an existing one; modify it instead.
When the agent got something wrong, propose the rule that would have prevented it, saying exactly what to do in that situation. Do this even if a broader rule already exists, because it was not enough: modify that rule if it is not locked, otherwise add a more specific one. Do not propose rules for things the agent did well.

TOOL_PROPOSAL (optional, at most ONE per call, null when there is no capability gap):
Propose a NEW TOOL only when the transcript PROVES a capability gap: the caller made a clear request and no existing tool covered it, and the agent said it cannot do it, deflected, or only took a message for something a tool could have handled. Do not propose a tool for a call that went fine, for a missing business fact (that is a "context" question), or for a mistake the agent made with a tool it already had.
Existing built-in tools (never propose a duplicate or a variant of these): get_order, lookup_price, list_prices, add_order_note, take_message, update_customer_profile, create_order, set_order_type, cancel_order, schedule_appointment, quote_turnaround.
Tools are declarative: a "write" tool (write=true) saves the given fields as a record the owner can see later; a read tool (write=false) looks up that caller's earlier saved records. A tool can also carry a RECIPE (below) that really implements behaviour. NEVER propose tools that need external systems, payments, card numbers, credentials, URLs or custom code.
Fields: name (snake_case verb phrase, 3-40 chars, e.g. record_delivery_instructions, file_damage_claim); description (1-2 sentences, under 300 chars, when the agent should call it); params (at most 6, each {name snake_case, type "string"|"number"|"boolean", description under 200 chars, required}); write; why (plain English, cite what happened in the call); mockup: sampleDialogue (4 to 8 turns, roles "caller" | "agent" | "tool", showing the tool used correctly and ENDING with the agent confirming to the caller), exampleArgs (only keys that are in params), exampleResult (what the tool returns, e.g. {"saved": true, ...}); evidence: one or two {turn, quote} where quote is copied EXACTLY, word for word, from that caller turn of the transcript.

RECIPES (optional "recipe" inside tool_proposal): a recipe is JSON, never code. Use a recipe whenever the tool needs a calculation, a rule or limit, or the calendar / rush features. A plain save-fields or look-up tool needs NO recipe (leave it out).
Recipe = {"steps":[...], "response":{key: expr}}. At most 12 steps. Names are snake_case.
Expression (expr) = a literal (string, number, boolean, null) | {"ref":"name"} (a param, a compute/call "as" name, or "record_id" after save) | {"op":"name","args":[expr,...]}.
Ops (exact list): add sub mul div min max round abs concat upper lower len contains coalesce eq neq gt gte lt lte and or not if today addDays get. sub, div, eq, neq, gt, gte, lt, lte take 2 args; abs, upper, lower, len, not take 1; if takes 3 (cond, then, else); today takes 0; addDays(date "YYYY-MM-DD", days); get(object, "key") reads one key of a call result (nest get for deeper keys); round(x, decimals) ; add/mul/min/max/concat/and/or/coalesce take 1 or more.
Step kinds:
- {"do":"compute","as":"total","expr":expr}
- {"do":"require","when":expr,"else":"short message said to the caller when false"} (stops the tool; use it for limits and rules)
- {"do":"save","fields":{name: expr}} (write tools only, at most one; gives record_id)
- {"do":"lookup","as":"rows","query":expr} (read tools only, at most one; also sets "count")
- {"do":"call","tool":"get_order|lookup_price|quote_turnaround|schedule_appointment|set_order_type|create_order","args":{name: expr},"as":"result_name"} (at most 3 calls). ${BUILTIN_ARGS} quote_turnaround returns readyDate, price, regularPrice, expeditedPrice, expediteExtra; ${SET_ORDER_RETURNS}schedule_appointment returns {scheduled, appointment:{date,...}}.
DATA-CHANGING calls are schedule_appointment, set_order_type and create_order: only a write tool (write=true) may use them, the tool MUST declare a boolean param named "confirmed", and the FIRST step of such a tool MUST be a require step on {"ref":"confirmed"} (steps are not atomic, so nothing may change before the caller says yes), and EVERY such call MUST pass "confirmed":{"ref":"confirmed"} in its args. A read tool may only use get_order, lookup_price and quote_turnaround.
The "response" map is what the tool returns to the receptionist (1 to 12 keys), built from exprs. Never invent business numbers: prices, fees and limits must come from BUSINESS KNOWLEDGE, a built-in call result, a param, or be stated in the call itself (as the $200 limit is in example 2).
Rules for a recipe: params MUST include every name the recipe refs (and "confirmed": boolean when it calls a data-changing built-in); mockup.exampleArgs must include values for them (confirmed true) so the recipe runs end to end, and the code runs it on exampleArgs to verify it; the sampleDialogue should read naturally, like a real phone call, with the agent reading back details and only then calling the tool.
Three worked examples (shortened):
1. Alteration price quote with a rush fee (read tool, compute only). params: base_price:number, rush:boolean, rush_fee:number (the agent passes the prices it has from the price list or the owner).
{"steps":[{"do":"compute","as":"fee","expr":{"op":"if","args":[{"ref":"rush"},{"ref":"rush_fee"},0]}},{"do":"compute","as":"total","expr":{"op":"add","args":[{"ref":"base_price"},{"ref":"fee"}]}}],"response":{"total":{"ref":"total"},"rush_fee":{"ref":"fee"},"summary":{"op":"concat","args":["Total is $",{"ref":"total"}]}}}
2. Damage claim with a $200 policy limit (write tool, require + save). params: order_id:string, description:string, amount:number, confirmed:boolean.
{"steps":[{"do":"require","when":{"ref":"confirmed"},"else":"Please confirm the details with the caller first."},{"do":"require","when":{"op":"lte","args":[{"ref":"amount"},200]},"else":"Claims over $200 need the owner; offer to take a message."},{"do":"save","fields":{"order_id":{"ref":"order_id"},"description":{"ref":"description"},"amount":{"ref":"amount"}}}],"response":{"filed":true,"claim_id":{"ref":"record_id"}}}
${EXAMPLE3}

Reply with ONLY a JSON object:
{"scores":{"accuracy":0,"tool_use":0,"task_completion":0,"tone":0,"brevity":0},"frustration":0,"rationale":"2-3 sentences",
 "issues":[{"type":"invented_fact|missed_question|rule_violation|tool_error|tone|verbosity|other","turn":0,"quote":"","explanation":""}],
 "improvements":[{"type":"prompt","op":"add","rule_kind":"guardrail","text":"","evidence_turns":[0],"reason":""},
                 {"type":"prompt","op":"modify","rule_id":"r0","text":"","evidence_turns":[0],"reason":""},
                 {"type":"context","question":"","evidence_turns":[0],"reason":""}],
 "tool_proposal":null}
or, when there is a capability gap, "tool_proposal":{"name":"","description":"","params":[{"name":"","type":"string","description":"","required":true}],"write":true,"why":"",
 "mockup":{"sampleDialogue":[{"role":"caller","text":""},{"role":"agent","text":""},{"role":"tool","text":""},{"role":"agent","text":""}],"exampleArgs":{},"exampleResult":{}},
 "evidence":[{"turn":0,"quote":""}],"recipe":null}  (recipe: omit or null for a plain save/look-up tool, otherwise the recipe object described above)`;

export function buildJudgeInput(call: CallDoc, cfg: ConfigVersionDoc): string {
  const rules = cfg.rules.map((r) => `${r.id} [${r.kind}${r.locked ? ", locked" : ""}]: ${r.text}`).join("\n");
  const transcript = call.transcript.map((t) => `[${t.turn}] ${t.role}: ${t.text}`).join("\n");
  const tools = call.tool_trace.length ? JSON.stringify(call.tool_trace, null, 1) : "(no tool calls)";
  return `CURRENT RULES (config v${cfg.version}):
${rules || "(none)"}

BUSINESS KNOWLEDGE (${cfg.company_name}):
${cfg.context || "(none)"}

OUTCOME LABEL: ${call.outcome}
(from tool results only: "message_taken" = a message was saved, "failed" = a tool returned an error, "answered" = neither, which does not mean the caller was satisfied)

TOOL TRACE:
${tools}

TRANSCRIPT:
${transcript}`;
}

export function teacherModel() {
  return process.env.GEMINI_TEACHER_MODEL ?? "gemini-3.8-flash";
}

/** Real judge: one Gemini call, JSON out, validated with zod, one retry. */
export const geminiJudge: Judge = async (call, cfg) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (set it in .env, see README)");
  const ai = new GoogleGenAI({ apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: teacherModel(),
        contents: buildJudgeInput(call, cfg),
        config: { systemInstruction: SYSTEM, temperature: 0.1, responseMimeType: "application/json" },
      });
      const raw = (res.text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      return JudgeOutput.parse(JSON.parse(raw));
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 3000)); // the model is often briefly overloaded
    }
  }
  throw new Error(`teacher judge failed twice: ${String(lastErr)}`);
};
