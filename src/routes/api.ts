import { z } from "zod";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getStore } from "../services/gemini/liveSession";
import { TOOLS } from "../services/gemini/tools";
import { getCalendar } from "../services/calendar/provider";
import { addDays, hoursFor, localToday, slotsFor } from "../services/data/shop";
import { getActiveCalls } from "../services/calls/recorder";
import type { CallRecord } from "../services/data/store";

export const apiRouter = Router();

const CLOSED_STAGES = new Set(["picked up", "complete", "completed", "delivered"]);
const allowedOrigins = (config.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-token, ngrok-skip-browser-warning");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const token = config.DASHBOARD_TOKEN;
  if (!token || req.method === "OPTIONS" || req.path === "/health") {
    next();
    return;
  }
  if (req.headers["x-dashboard-token"] !== token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

apiRouter.use(cors, auth);

// Stored calls overlaid with the live in-memory copy of active calls
async function allCalls(limit: number): Promise<CallRecord[]> {
  const store = await getStore();
  const stored = await store.listCalls(limit);
  const live = new Map(getActiveCalls().map((c) => [c.callSid, c]));
  const merged = stored.map((c) => live.get(c.callSid) ?? c);
  for (const [sid, c] of live) if (!stored.some((s) => s.callSid === sid)) merged.push(c);
  return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

apiRouter.get(
  "/stats",
  wrap(async (_req, res) => {
    const store = await getStore();
    const [calls, orders, messages] = await Promise.all([
      allCalls(100000),
      store.listOrders(),
      store.listMessages(),
    ]);
    res.json({
      calls: calls.length,
      activeCalls: calls.filter((c) => c.status === "active").length,
      orders: orders.length,
      openOrders: orders.filter((o) => !CLOSED_STAGES.has(o.stage.trim().toLowerCase())).length,
      messages: messages.length,
    });
  })
);

apiRouter.get(
  "/calls",
  wrap(async (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 50;
    res.json(await allCalls(limit));
  })
);

apiRouter.get(
  "/calls/:callSid",
  wrap(async (req, res) => {
    const call = (await allCalls(100000)).find((c) => c.callSid === req.params.callSid);
    if (!call) {
      res.status(404).json({ error: "call not found" });
      return;
    }
    res.json(call);
  })
);

apiRouter.get(
  "/orders",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listOrders());
  })
);

apiRouter.get(
  "/messages",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listMessages());
  })
);

const configSchema = z.object({
  companyName: z.string().trim().min(1).max(80),
  greeting: z.string().trim().min(1).max(300),
  context: z.string().trim().max(8000),
  note: z.string().trim().max(300).optional(),
});
const activateSchema = z.object({ version: z.number().int().positive() });

function badRequest(res: Response, err: z.ZodError): void {
  const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  res.status(400).json({ error: msg });
}

apiRouter.get(
  "/config",
  wrap(async (_req, res) => {
    const store = await getStore();
    const [active, versions] = await Promise.all([store.getActiveConfig(), store.listConfigVersions()]);
    res.json({ active, versions });
  })
);

apiRouter.put(
  "/config",
  wrap(async (req, res) => {
    const parsed = configSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const { note, ...rest } = parsed.data;
    const saved = await (await getStore()).saveConfigVersion({
      ...rest,
      author: "manager",
      ...(note ? { note } : {}),
    });
    res.status(201).json(saved);
  })
);

apiRouter.post(
  "/config/activate",
  wrap(async (req, res) => {
    const parsed = activateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const activated = await (await getStore()).activateConfigVersion(parsed.data.version);
    if (!activated) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    res.json(activated);
  })
);


const WRITE_TOOLS = new Set(["add_order_note", "take_message", "create_order", "schedule_pickup", "reschedule_pickup", "cancel_pickup"]);

// What each collection is for. Counts and samples come from the live database.
const COLLECTION_META: Record<string, { owner: string; purpose: string; indexes: string[] }> = {
  customers: { owner: "bridge", purpose: "One per person, keyed by phone. Preferences the agent can use (starch, hangers) and a running summary.", indexes: ["phone (unique)"] },
  orders: { owner: "bridge", purpose: "Each order embeds its garments and stage history, so one read answers any status question.", indexes: ["orderId (unique)", "phone + createdAt"] },
  pricing: { owner: "bridge", purpose: "Price list with aliases ('blazer' finds 'Suit jacket') and turnaround days per speed.", indexes: ["item (unique)"] },
  store_hours: { owner: "owner", purpose: "Weekly hours plus holiday exceptions, so 'are you open today?' is computed, not guessed.", indexes: ["_id: main"] },
  appointments: { owner: "bridge", purpose: "Pickups and deliveries with a time window, created by the schedule_pickup tool.", indexes: ["orderId + status", "date + window"] },
  claims: { owner: "bridge", purpose: "Damage or missing-item reports for the owner to review. Written once the create_claim tool is approved and live.", indexes: ["status + createdAt"] },
  messages: { owner: "bridge", purpose: "Messages left for staff, with callback number.", indexes: ["createdAt"] },
  calls: { owner: "bridge", purpose: "Every call: transcript, tool calls, which config version handled it.", indexes: ["callSid (unique)", "startedAt"] },
  config_versions: { owner: "bridge", purpose: "Immutable versions of the agent's business info. Author is manager or teacher.", indexes: ["version (unique)"] },
  config_state: { owner: "bridge", purpose: "One document pointing at the live version. Rolling back moves this pointer.", indexes: ["_id: active"] },
  grades: { owner: "teacher", purpose: "One per graded call: five scores, frustration, quoted issues.", indexes: ["_id = callSid", "config_version_id + created_at"] },
  improvements: { owner: "teacher", purpose: "Everything the teacher proposed, with evidence turns and final status.", indexes: ["status + created_at", "source_call_ids"] },
  tool_requests: { owner: "teacher", purpose: "New tools the teacher wants. Only the owner can enable one and set its endpoint.", indexes: ["name (unique)", "status + request_count"] },
};

apiRouter.get(
  "/appointments",
  wrap(async (req, res) => {
    const store = await getStore();
    const h = await store.getHours();
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : localToday(h.timezone);
    const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? "7"), 10) || 7, 1), 31);
    const to = addDays(from, days - 1);
    const booked = await store.listAppointments(from, to);
    const orders = new Map((await store.listOrders()).map((o) => [o.orderId, o]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i);
      const day = hoursFor(h, date);
      const here = booked.filter((a) => a.date === date);
      const counts: Record<string, number> = {};
      for (const a of here) counts[a.window] = (counts[a.window] ?? 0) + 1;
      out.push({
        ...day,
        windows: slotsFor(h, date, counts),
        appointments: here.map((a) => ({ ...a, customerName: orders.get(a.orderId)?.customerName ?? null })),
      });
    }
    res.json({ timezone: h.timezone, from, to, days: out, calendar: getCalendar()?.name ?? null });
  })
);

apiRouter.get("/grades", wrap(async (_req, res) => { res.json((await (await getStore()).getTeacherDocs()).grades); }));
apiRouter.get("/improvements", wrap(async (_req, res) => { res.json((await (await getStore()).getTeacherDocs()).improvements); }));
apiRouter.get(
  "/tool-requests",
  wrap(async (_req, res) => {
    const docs = await (await getStore()).getTeacherDocs();
    const builtIn = TOOLS.map((t) => ({ name: t.name, description: t.description, sideEffect: WRITE_TOOLS.has(t.name ?? "") ? "write" : "read" }));
    res.json({ requests: docs.toolRequests, builtIn });
  })
);
apiRouter.get(
  "/atlas",
  wrap(async (_req, res) => {
    const info = await (await getStore()).describeCollections();
    res.json({ ...info, collections: info.collections.map((c) => ({ ...c, ...(COLLECTION_META[c.name] ?? { owner: "bridge", purpose: "", indexes: [] }) })) });
  })
);

// Owner decisions. Failures here are the caller's problem (409), not a server error.
function ownerAction(fn: (req: Request) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req).then((out) => res.json(out)).catch((err: Error) => {
      if (/^(Not an open|Unknown|Tool is|Endpoint|Answer|The teacher|Tool requests)/.test(err.message)) res.status(409).json({ error: err.message });
      else next(err);
    });
  };
}
apiRouter.post("/improvements/:id/answer", ownerAction(async (req) => (await getStore()).answerOwnerQuestion(String(req.params.id), String(req.body?.answer ?? ""))));
apiRouter.post("/tool-requests/:name/:action", ownerAction(async (req) => {
  const action = String(req.params.action);
  if (!["approve", "decline", "enable", "disable"].includes(action)) throw new Error("Unknown action");
  return (await getStore()).setToolRequestStatus(String(req.params.name), action as "approve", typeof req.body?.endpoint === "string" ? req.body.endpoint : undefined);
}));

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api] error:", err);
  res.status(500).json({ error: "internal error" });
});
