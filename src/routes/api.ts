import { z } from "zod";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getStore } from "../services/gemini/liveSession";
import { getActiveCalls } from "../services/calls/recorder";
import { BUILTIN_TOOL_NAMES } from "../services/gemini/tools";
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
  "/appointments",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listAppointments());
  })
);

apiRouter.get(
  "/customers",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listCustomers());
  })
);

const customerSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().max(120).optional(),
  preferences: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
  vip: z.boolean().optional(),
});

// Owner edit. An empty string clears a field.
apiRouter.put(
  "/customers/:phone",
  wrap(async (req, res) => {
    const parsed = customerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const saved = await (await getStore()).editCustomer(String(req.params.phone), parsed.data);
    if (!saved) {
      res.status(404).json({ error: "customer not found" });
      return;
    }
    res.json(saved);
  })
);

apiRouter.get(
  "/messages",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listMessages());
  })
);

apiRouter.get(
  "/tools",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listToolProposals());
  })
);

for (const [action, status] of [
  ["enable", "enabled"],
  ["disable", "disabled"],
  ["decline", "declined"],
] as const) {
  apiRouter.post(
    `/tools/:name/${action}`,
    wrap(async (req, res) => {
      const name = String(req.params.name);
      if (status === "enabled" && BUILTIN_TOOL_NAMES.has(name)) {
        res.status(400).json({ error: `"${name}" collides with a built-in tool` });
        return;
      }
      const updated = await (await getStore()).setToolStatus(name, status);
      if (!updated) {
        res.status(404).json({ error: "tool not found" });
        return;
      }
      res.json(updated);
    })
  );
}

apiRouter.get(
  "/records",
  wrap(async (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    const tool = typeof req.query.tool === "string" && req.query.tool ? req.query.tool : undefined;
    res.json(await (await getStore()).listCustomRecords({ tool, limit }));
  })
);

apiRouter.get(
  "/grades",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listGrades());
  })
);

apiRouter.get(
  "/improvements",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listImprovements());
  })
);

const answerSchema = z.object({ answer: z.string().trim().min(1).max(600) });

apiRouter.post(
  "/improvements/:id/answer",
  wrap(async (req, res) => {
    const parsed = answerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const id = String(req.params.id);
    const store = await getStore();
    const result = await store.answerImprovement(id, parsed.data.answer);
    if (!result.ok) {
      const missing = /not found/i.test(result.error);
      res.status(missing || result.error === "needs MongoDB" ? 404 : 400).json({ error: result.error });
      return;
    }
    res.json(result);
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

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api] error:", err);
  res.status(500).json({ error: "internal error" });
});
