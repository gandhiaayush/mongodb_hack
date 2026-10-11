// Tool recipes: a tiny, safe, declarative language the teaching agent writes to IMPLEMENT a tool.
// No code is ever executed: a recipe is JSON that can only do arithmetic, comparisons, string and date
// helpers, validate inputs, and save or look up this tool's own records. It always terminates (no loops,
// bounded size). This file has no imports so the bridge (src/) and the teacher (teacher/) share an
// identical copy; keep the two copies in sync.

export type Expr =
  | string
  | number
  | boolean
  | null
  | { ref: string }
  | { op: string; args: Expr[] };

export type Step =
  | { do: "compute"; as: string; expr: Expr }
  | { do: "require"; when: Expr; else: string }
  | { do: "save"; fields: Record<string, Expr> }
  | { do: "lookup"; as: string; query?: Expr }
  // Calls one of the receptionist's own built-in tools (calendar, rush, quotes) and keeps its result
  | { do: "call"; tool: CallableTool; args: Record<string, Expr>; as: string };

export type CallableTool =
  | "get_order"
  | "lookup_price"
  | "quote_turnaround"
  | "schedule_appointment"
  | "set_order_type"
  | "create_order";

/** Built-in tools a recipe may call. The ones in WRITE_CALLS change data (and still enforce `confirmed`). */
export const CALLABLE_TOOLS: CallableTool[] = [
  "get_order", "lookup_price", "quote_turnaround", "schedule_appointment", "set_order_type", "create_order",
];
export const WRITE_CALLS: CallableTool[] = ["schedule_appointment", "set_order_type", "create_order"];

export interface Recipe {
  steps: Step[];
  response: Record<string, Expr>;
}

export interface RecipeIO {
  save(fields: Record<string, unknown>): Promise<{ recordId: string }>;
  lookup(query?: string): Promise<Record<string, unknown>[]>;
  call(tool: CallableTool, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const MAX_STEPS = 12;
const MAX_NODES = 80;
const MAX_DEPTH = 8;
const MAX_STRING = 500;
const MAX_RESPONSE_KEYS = 12;

const OPS: Record<string, number | "n"> = {
  add: "n", sub: 2, mul: "n", div: 2, min: "n", max: "n", round: "n", abs: 1,
  concat: "n", upper: 1, lower: 1, len: 1, contains: 2, coalesce: "n",
  eq: 2, neq: 2, gt: 2, gte: 2, lt: 2, lte: 2, and: "n", or: "n", not: 1, if: 3,
  today: 0, addDays: 2, get: 2,
};

const SNAKE = /^[a-z][a-z0-9_]{0,39}$/;
// Arguments passed to built-in tools use the built-ins' own names, which can be camelCase (orderId)
const ARG_NAME = /^[a-z][A-Za-z0-9_]{0,39}$/;

function isRef(e: Expr): e is { ref: string } {
  return typeof e === "object" && e !== null && "ref" in e;
}
function isOp(e: Expr): e is { op: string; args: Expr[] } {
  return typeof e === "object" && e !== null && "op" in e;
}

function checkExpr(e: Expr, known: Set<string>, depth: number, count: { n: number }): string | null {
  if (++count.n > MAX_NODES) return "expression is too large";
  if (depth > MAX_DEPTH) return "expression is nested too deeply";
  if (e === null || typeof e === "number" || typeof e === "boolean") return null;
  if (typeof e === "string") return e.length > MAX_STRING ? "string literal is too long" : null;
  if (isRef(e)) {
    if (typeof e.ref !== "string" || !SNAKE.test(e.ref)) return "invalid reference name";
    return known.has(e.ref) ? null : `"${e.ref}" is used before it is defined`;
  }
  if (isOp(e)) {
    const arity = OPS[e.op];
    if (arity === undefined) return `unknown operation "${e.op}"`;
    if (!Array.isArray(e.args)) return `"${e.op}" needs an args list`;
    if (arity !== "n" && e.args.length !== arity) return `"${e.op}" takes ${arity} argument(s)`;
    if (arity === "n" && e.args.length < 1) return `"${e.op}" needs at least one argument`;
    for (const a of e.args) {
      const err = checkExpr(a, known, depth + 1, count);
      if (err) return err;
    }
    return null;
  }
  return "unsupported expression";
}

/** Static check, run before a recipe is stored or enabled. Returns an error message or null. */
export function validateRecipe(recipe: unknown, paramNames: string[], write: boolean): string | null {
  const r = recipe as Recipe;
  if (!r || typeof r !== "object" || !Array.isArray(r.steps) || typeof r.response !== "object" || r.response === null) {
    return "recipe must have steps and response";
  }
  if (r.steps.length === 0 || r.steps.length > MAX_STEPS) return `recipe needs 1 to ${MAX_STEPS} steps`;
  const known = new Set<string>(paramNames);
  const count = { n: 0 };
  let saves = 0;
  let lookups = 0;
  let calls = 0;
  let writeCalls = 0;
  let confirmedGate = false; // set once a `require` step checks the caller's `confirmed` answer
  for (const s of r.steps) {
    if (!s || typeof s !== "object") return "invalid step";
    switch (s.do) {
      case "compute": {
        if (!SNAKE.test(s.as ?? "")) return "compute needs a snake_case name";
        const err = checkExpr(s.expr, known, 0, count);
        if (err) return `compute ${s.as}: ${err}`;
        known.add(s.as);
        break;
      }
      case "require": {
        const err = checkExpr(s.when, known, 0, count);
        if (err) return `require: ${err}`;
        if (typeof s.else !== "string" || !s.else.trim() || s.else.length > 200) return "require needs a short message";
        if (JSON.stringify(s.when).includes('"ref":"confirmed"')) confirmedGate = true;
        break;
      }
      case "save": {
        if (!write) return "a read tool cannot save";
        if (++saves > 1) return "only one save step is allowed";
        const keys = Object.keys(s.fields ?? {});
        if (keys.length === 0 || keys.length > 12) return "save needs 1 to 12 fields";
        for (const k of keys) {
          if (!SNAKE.test(k)) return `invalid field name "${k}"`;
          const err = checkExpr(s.fields[k], known, 0, count);
          if (err) return `save ${k}: ${err}`;
        }
        known.add("record_id");
        break;
      }
      case "lookup": {
        if (write) return "a write tool cannot look up";
        if (++lookups > 1) return "only one lookup step is allowed";
        if (!SNAKE.test(s.as ?? "")) return "lookup needs a snake_case name";
        if (s.query !== undefined) {
          const err = checkExpr(s.query, known, 0, count);
          if (err) return `lookup: ${err}`;
        }
        known.add(s.as);
        known.add("count");
        break;
      }
      case "call": {
        if (!CALLABLE_TOOLS.includes(s.tool)) return `cannot call "${s.tool}"`;
        if (++calls > 3) return "at most 3 call steps";
        if (WRITE_CALLS.includes(s.tool) && ++writeCalls > 2) return "at most 2 call steps may change data";
        if (WRITE_CALLS.includes(s.tool) && !write) return `a read tool cannot call ${s.tool}`;
        // Steps are not atomic, so nothing that changes data may run before the caller has confirmed
        if (WRITE_CALLS.includes(s.tool) && !confirmedGate) {
          return `put a require step on "confirmed" before ${s.tool}, so nothing changes until the caller says yes`;
        }
        if (!SNAKE.test(s.as ?? "")) return "call needs a snake_case name";
        const keys = Object.keys(s.args ?? {});
        if (keys.length > 8) return "call takes at most 8 arguments";
        for (const k of keys) {
          if (!ARG_NAME.test(k)) return `invalid argument name "${k}"`;
          const err = checkExpr(s.args[k], known, 0, count);
          if (err) return `call ${s.tool} ${k}: ${err}`;
        }
        known.add(s.as);
        break;
      }
      default:
        return "unknown step type";
    }
  }
  if (write && saves === 0 && writeCalls === 0) return "a write tool needs a save step or a call that changes data";
  const keys = Object.keys(r.response);
  if (keys.length === 0 || keys.length > MAX_RESPONSE_KEYS) return `response needs 1 to ${MAX_RESPONSE_KEYS} keys`;
  for (const k of keys) {
    if (!SNAKE.test(k)) return `invalid response key "${k}"`;
    const err = checkExpr(r.response[k], known, 0, count);
    if (err) return `response ${k}: ${err}`;
  }
  return null;
}

type Val = string | number | boolean | null | Record<string, unknown> | Record<string, unknown>[];

function num(v: Val): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error("expected a number");
  return n;
}
function str(v: Val): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}
function truthy(v: Val): boolean {
  return !(v === false || v === null || v === 0 || v === "" || v === undefined);
}

function evalExpr(e: Expr, vars: Map<string, Val>, now: Date): Val {
  if (e === null || typeof e === "number" || typeof e === "boolean" || typeof e === "string") return e;
  if (isRef(e)) return vars.get(e.ref) ?? null;
  const a = (e as { op: string; args: Expr[] }).args;
  const op = (e as { op: string }).op;
  const v = (i: number) => evalExpr(a[i], vars, now);
  switch (op) {
    case "add": return a.reduce<number>((t, _, i) => t + num(v(i)), 0);
    case "sub": return num(v(0)) - num(v(1));
    case "mul": return a.reduce<number>((t, _, i) => t * num(v(i)), 1);
    case "div": { const d = num(v(1)); if (d === 0) throw new Error("division by zero"); return num(v(0)) / d; }
    case "min": return Math.min(...a.map((_, i) => num(v(i))));
    case "max": return Math.max(...a.map((_, i) => num(v(i))));
    case "round": { const d = a.length > 1 ? Math.max(0, Math.min(4, Math.trunc(num(v(1))))) : 0; const f = 10 ** d; return Math.round(num(v(0)) * f) / f; }
    case "abs": return Math.abs(num(v(0)));
    case "concat": return str(a.map((_, i) => str(v(i))).join(""));
    case "upper": return str(v(0)).toUpperCase();
    case "lower": return str(v(0)).toLowerCase();
    case "len": return str(v(0)).length;
    case "contains": return str(v(0)).toLowerCase().includes(str(v(1)).toLowerCase());
    case "coalesce": { for (let i = 0; i < a.length; i++) { const x = v(i); if (x !== null && x !== "") return x; } return null; }
    case "eq": return v(0) === v(1);
    case "neq": return v(0) !== v(1);
    case "gt": return num(v(0)) > num(v(1));
    case "gte": return num(v(0)) >= num(v(1));
    case "lt": return num(v(0)) < num(v(1));
    case "lte": return num(v(0)) <= num(v(1));
    case "and": return a.every((_, i) => truthy(v(i)));
    case "or": return a.some((_, i) => truthy(v(i)));
    case "not": return !truthy(v(0));
    case "if": return truthy(v(0)) ? v(1) : v(2);
    case "get": {
      const o = v(0);
      const key = str(v(1));
      return o !== null && typeof o === "object" && !Array.isArray(o) ? ((o as Record<string, unknown>)[key] as Val) ?? null : null;
    }
    case "today": return now.toISOString().slice(0, 10);
    case "addDays": {
      const d = new Date(`${str(v(0))}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new Error("invalid date");
      d.setUTCDate(d.getUTCDate() + Math.trunc(num(v(1))));
      return d.toISOString().slice(0, 10);
    }
    default: throw new Error(`unknown operation ${op}`);
  }
}

export type RecipeResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** Runs a validated recipe. Never throws: any failure comes back as { ok: false, error }. */
export async function runRecipe(
  recipe: Recipe,
  args: Record<string, unknown>,
  io: RecipeIO,
  now: Date = new Date()
): Promise<RecipeResult> {
  const vars = new Map<string, Val>();
  for (const [k, val] of Object.entries(args)) {
    vars.set(k, typeof val === "string" ? str(val) : (val as Val));
  }
  try {
    for (const s of recipe.steps) {
      if (s.do === "compute") {
        vars.set(s.as, evalExpr(s.expr, vars, now));
      } else if (s.do === "require") {
        if (!truthy(evalExpr(s.when, vars, now))) return { ok: false, error: s.else };
      } else if (s.do === "save") {
        const fields: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(s.fields)) fields[k] = evalExpr(e, vars, now);
        const saved = await io.save(fields);
        vars.set("record_id", saved.recordId);
      } else if (s.do === "call") {
        const callArgs: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(s.args)) callArgs[k] = evalExpr(e, vars, now);
        const out = await io.call(s.tool, callArgs);
        if (typeof out.error === "string") return { ok: false, error: out.error };
        vars.set(s.as, out);
      } else if (s.do === "lookup") {
        const q = s.query === undefined ? undefined : str(evalExpr(s.query, vars, now));
        const rows = await io.lookup(q);
        vars.set(s.as, rows.slice(0, 5));
        vars.set("count", rows.length);
      }
    }
    const result: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(recipe.response)) result[k] = evalExpr(e, vars, now);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "recipe failed" };
  }
}
