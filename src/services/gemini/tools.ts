import { FunctionDeclaration, Type } from "@google/genai";
import {
  CANCELLABLE_STAGES,
  computeExpectedDate,
  priceGarment,
  weekdayName,
  type AppointmentKind,
  type CustomerPatch,
  type DataStore,
  type Speed,
  type ToolProposal,
} from "../data/store";
import { CALLABLE_TOOLS, runRecipe, validateRecipe, type CallableTool, type RecipeIO } from "../tools/recipe";

const CONFIRM_ERROR = "Read the details back to the caller and get a yes first.";

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "get_order",
    description:
      "Look up an order. Use when the caller gives an order number (like ORD-0010), their name, or the phone number. Pass exactly one of orderId, customerName, or phone. Always call this before stating any order detail.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        customerName: { type: Type.STRING, description: "Customer name or part of it" },
        phone: { type: Type.STRING, description: "Phone number, e.g. +14155550123" },
      },
    },
  },
  {
    name: "lookup_price",
    description:
      "Get the price for one garment at a given speed. Use when the caller asks what something costs or what expedited costs more. Item must match the pricing list name; call list_prices if unsure.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        item: { type: Type.STRING, description: "Garment name from the pricing list, e.g. Suit (2-piece)" },
        speed: {
          type: Type.STRING,
          enum: ["Regular", "Expedited"],
          description: "Regular or Expedited",
        },
      },
      required: ["item", "speed"],
    },
  },
  {
    name: "list_prices",
    description:
      "Return the full price list. Use when the caller asks for general prices or for the exact name of an item.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "add_order_note",
    description:
      "Write a note on an existing order. Use to record special handling requests such as delicate fabric, no starch, or stain details. Look up the order first so you have its orderId.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        note: { type: Type.STRING, description: "The note to save, short and specific" },
      },
      required: ["orderId", "note"],
    },
  },
  {
    name: "take_message",
    description:
      "Save a message for staff to call back. Use when the caller asks for a human, has a question you cannot answer from the tools, or wants a callback. Get the caller's name, callback number, and message before calling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's name" },
        phone: { type: Type.STRING, description: "Callback phone number" },
        message: { type: Type.STRING, description: "What the caller needs staff to know" },
      },
      required: ["name", "phone", "message"],
    },
  },
  {
    name: "create_order",
    description:
      "Place a NEW order for the caller. Use when the caller wants to drop off or send in items and have us clean them. First collect the items (with quantities) and the speed (Regular or Expedited), call quote_turnaround to get the price and ready date, then read back the items, speed, price and ready date and get a yes. Only then call with confirmed=true. Name and phone default to the caller's profile and caller ID. If the price comes back unconfirmed, tell the caller staff will confirm it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        garment: { type: Type.STRING, description: "Items with quantities, e.g. 'Suit (2-piece), Shirt (dress) x3'. Use names from the price list when possible." },
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "Regular (3 days) or Expedited (next day)" },
        customerName: { type: Type.STRING, description: "Caller's name; defaults to the caller profile" },
        phone: { type: Type.STRING, description: "Phone number; defaults to the caller ID" },
        notes: { type: Type.STRING, description: "Special handling, e.g. light starch, stain on left sleeve" },
        confirmed: { type: Type.BOOLEAN, description: "Must be true, and only after the caller said yes to your readback" },
      },
      required: ["garment", "speed", "confirmed"],
    },
  },
  {
    name: "set_order_type",
    description:
      "Change an existing order to Expedited (rush) or back to Regular. Use when the caller wants it faster or sooner. First look up the order, then use quote_turnaround or lookup_price to tell the caller the price difference and the new ready date, and get a yes. Only works on orders that are not yet ready or delivered. The price and ready date are recomputed.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "The new speed" },
      },
      required: ["orderId", "speed"],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel an order. Use only when the caller clearly asks to cancel. Look up the order first, confirm the caller's name, read back which order (id and items) and get a yes, then call with confirmed=true. Only orders still Received or Sorting can be cancelled; if work has started the tool refuses, and you should offer to take a message for staff.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        reason: { type: Type.STRING, description: "Why the caller is cancelling, if they said" },
        confirmed: { type: Type.BOOLEAN, description: "Must be true, and only after the caller said yes to your readback" },
      },
      required: ["orderId", "confirmed"],
    },
  },
  {
    name: "schedule_appointment",
    description:
      "Book a pickup (we collect from the caller), a delivery (we bring items to the caller), or a drop-off time (the caller brings items to the shop). Collect the kind, date, time window, and for pickup or delivery the street address, plus an order number if it relates to one. We are closed Sundays and cannot book past dates; the tool rejects them, so offer another day. Read back kind, date, window and address and get a yes, then call with confirmed=true. Fees for pickup and delivery come from the company information; do not promise free service unless it says so.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: { type: Type.STRING, enum: ["pickup", "delivery", "dropoff"], description: "pickup, delivery, or dropoff" },
        date: { type: Type.STRING, description: "Date as YYYY-MM-DD; work it out from today's date" },
        window: { type: Type.STRING, description: "Time window, e.g. 10am-12pm" },
        address: { type: Type.STRING, description: "Street address; required for pickup and delivery" },
        orderId: { type: Type.STRING, description: "Related order number, if any" },
        notes: { type: Type.STRING, description: "Gate code, leave with doorman, etc." },
        name: { type: Type.STRING, description: "Caller's name; defaults to the caller profile" },
        phone: { type: Type.STRING, description: "Phone number; defaults to the caller ID" },
        confirmed: { type: Type.BOOLEAN, description: "Must be true, and only after the caller said yes to your readback" },
      },
      required: ["kind", "date", "window", "confirmed"],
    },
  },
  {
    name: "quote_turnaround",
    description:
      "Quote when an order would be ready if placed or rushed today, and the price. Use before create_order, before set_order_type, and when the caller asks how long something takes or how fast we can do it. Pass the speed; add the items to also get the price (and the regular vs expedited difference). Does not change anything.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "Regular or Expedited" },
        item: { type: Type.STRING, description: "Optional item(s) with quantities, e.g. 'Suit (2-piece) x2'" },
      },
      required: ["speed"],
    },
  },
  {
    name: "update_customer_profile",
    description:
      "Save or update what we know about the current caller (matched by their caller ID). Use when they tell you their name or email, or a preference worth remembering. Notes are appended, other fields are replaced.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's name" },
        email: { type: Type.STRING, description: "Caller's email address" },
        preferences: { type: Type.STRING, description: "Standing preferences, e.g. light starch on shirts" },
        notes: { type: Type.STRING, description: "A short note for staff to remember about this customer" },
      },
    },
  },
];

type Args = Record<string, unknown>;

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_order",
  "lookup_price",
  "list_prices",
  "add_order_note",
  "take_message",
  "update_customer_profile",
  "create_order",
  "set_order_type",
  "cancel_order",
  "schedule_appointment",
  "quote_turnaround",
]);

const SNAKE = /^[a-z][a-z0-9_]*$/;
const GEMINI_TYPES = { string: Type.STRING, number: Type.NUMBER, boolean: Type.BOOLEAN } as const;
const MAX_STR = 500;
const MAX_CUSTOM_WRITES_PER_CALL = 20;

export function isValidCustomSpec(spec: ToolProposal): boolean {
  if (!spec || typeof spec.name !== "string") return false;
  if (spec.name.length < 3 || spec.name.length > 40 || !SNAKE.test(spec.name)) return false;
  if (BUILTIN_TOOL_NAMES.has(spec.name)) return false;
  if (!Array.isArray(spec.params) || spec.params.length > 6) return false;
  return spec.params.every((p) => p && SNAKE.test(p.name ?? "") && p.type in GEMINI_TYPES);
}

export function buildCustomToolDeclarations(enabled: ToolProposal[]): FunctionDeclaration[] {
  const out: FunctionDeclaration[] = [];
  for (const spec of enabled) {
    if (!isValidCustomSpec(spec)) {
      console.warn(`[tools] skipping custom tool "${spec?.name}" (invalid or collides with a built-in)`);
      continue;
    }
    if (spec.recipe) {
      const bad = validateRecipe(spec.recipe, spec.params.map((p) => p.name), spec.write);
      if (bad) {
        console.warn(`[tools] skipping custom tool "${spec.name}" (invalid recipe: ${bad})`);
        continue;
      }
    }
    const properties: Record<string, { type: Type; description: string }> = {};
    for (const p of spec.params) properties[p.name] = { type: GEMINI_TYPES[p.type], description: p.description || p.name };
    const required = spec.params.filter((p) => p.required).map((p) => p.name);
    out.push({
      name: spec.name,
      description: spec.description,
      parameters: { type: Type.OBJECT, properties, ...(required.length ? { required } : {}) },
    });
  }
  return out;
}

const customWrites = new Map<string, number>();

export async function executeCustomTool(
  spec: ToolProposal,
  args: Args,
  store: DataStore,
  ctx: { callerPhone?: string; callSid?: string } = {}
): Promise<Record<string, unknown>> {
  try {
    if (!isValidCustomSpec(spec)) return { error: "This tool is not available." };
    const clean: Record<string, unknown> = {};
    for (const p of spec.params) {
      const raw = args?.[p.name];
      if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
        if (p.required) return { error: `Missing required argument: ${p.name}.` };
        continue;
      }
      if (p.type === "string") {
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
          return { error: `Argument ${p.name} must be text.` };
        }
        clean[p.name] = String(raw).trim().slice(0, MAX_STR);
      } else if (p.type === "number") {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) return { error: `Argument ${p.name} must be a number.` };
        clean[p.name] = n;
      } else {
        if (typeof raw === "boolean") clean[p.name] = raw;
        else if (raw === "true" || raw === "false") clean[p.name] = raw === "true";
        else return { error: `Argument ${p.name} must be true or false.` };
      }
    }

    const takeWriteSlot = (): string | null => {
      const key = ctx.callSid ?? "";
      if (!key) return null;
      const used = customWrites.get(key) ?? 0;
      if (used >= MAX_CUSTOM_WRITES_PER_CALL) return "Too many records saved on this call. Take a message for staff instead.";
      customWrites.set(key, used + 1);
      return null;
    };

    if (spec.recipe) {
      // Never trust stored data: re-check the recipe every time it runs
      const bad = validateRecipe(spec.recipe, spec.params.map((p) => p.name), spec.write);
      if (bad) return { error: `This tool is not available (invalid recipe: ${bad}).` };
      const io: RecipeIO = {
        async save(fields) {
          const full = takeWriteSlot();
          if (full) throw new Error(full);
          const rec = await store.saveCustomRecord({ tool: spec.name, phone: ctx.callerPhone, callSid: ctx.callSid, fields });
          return { recordId: rec.id };
        },
        async lookup(query) {
          const all = await store.listCustomRecords({ tool: spec.name, phone: ctx.callerPhone, limit: 100 });
          const q = query ? query.toLowerCase() : "";
          const matched = q ? all.filter((r) => JSON.stringify(r.fields).toLowerCase().includes(q)) : all;
          return matched.map((r) => ({ ...r.fields }));
        },
        async call(tool: CallableTool, callArgs) {
          if (!CALLABLE_TOOLS.includes(tool)) return { error: `Tool ${String(tool)} cannot be called from a recipe.` };
          // Recipe argument names must be snake_case but the built-ins use camelCase (orderId): convert
          const mapped: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(callArgs)) mapped[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
          return executeTool(tool, mapped, store, { callerPhone: ctx.callerPhone });
        },
      };
      const out = await runRecipe(spec.recipe, clean, io);
      return out.ok ? out.result : { error: out.error };
    }

    if (spec.write) {
      const full = takeWriteSlot();
      if (full) return { error: full };
      const rec = await store.saveCustomRecord({
        tool: spec.name,
        phone: ctx.callerPhone,
        callSid: ctx.callSid,
        fields: clean,
      });
      return { saved: true, recordId: rec.id, ...clean };
    }

    const all = await store.listCustomRecords({ tool: spec.name, phone: ctx.callerPhone, limit: 100 });
    const q = typeof clean.query === "string" ? clean.query.toLowerCase() : "";
    const matched = q ? all.filter((r) => JSON.stringify(r.fields).toLowerCase().includes(q)) : all;
    const records = matched.slice(0, 5).map((r) => ({ recordId: r.id, createdAt: r.createdAt, ...r.fields }));
    return { records, count: matched.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

export async function executeTool(
  name: string,
  args: Args,
  store: DataStore,
  ctx: { callerPhone?: string } = {}
): Promise<Record<string, unknown>> {
  switch (name) {
    case "get_order": {
      const orderId = str(args, "orderId");
      const customerName = str(args, "customerName");
      const phone = str(args, "phone");
      if (orderId) {
        const order = await store.getOrderById(orderId);
        return { found: !!order, orders: order ? [order] : [] };
      }
      if (phone) {
        const orders = await store.getOrdersByPhone(phone);
        return { found: orders.length > 0, orders };
      }
      if (customerName) {
        const orders = await store.searchOrdersByName(customerName);
        return { found: orders.length > 0, orders };
      }
      return { error: "Provide orderId, customerName, or phone." };
    }

    case "lookup_price": {
      const item = str(args, "item");
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      if (!item) return { error: "Provide the item name." };
      return { ...(await store.lookupPrice(item, speed)) };
    }

    case "list_prices": {
      const prices = await store.listPrices();
      return { prices };
    }

    case "add_order_note": {
      const orderId = str(args, "orderId");
      const note = str(args, "note");
      if (!orderId || !note) return { error: "Provide orderId and note." };
      const order = await store.appendOrderNote(orderId, note);
      if (!order) return { saved: false, error: `No order ${orderId}.` };
      return { saved: true, orderId: order.orderId, notes: order.notes };
    }

    case "take_message": {
      const callerName = str(args, "name");
      const phone = str(args, "phone");
      const message = str(args, "message");
      if (!callerName || !phone || !message) {
        return { error: "Provide name, phone, and message." };
      }
      const saved = await store.takeMessage({ name: callerName, phone, message });
      return { saved: true, message: saved };
    }

    case "create_order": {
      if (args.confirmed !== true) return { error: CONFIRM_ERROR };
      const garment = str(args, "garment");
      if (!garment) return { error: "Provide the items to be cleaned." };
      const phone = str(args, "phone") || ctx.callerPhone || "";
      if (!phone) return { error: "Ask for a phone number for the order." };
      const profile = ctx.callerPhone ? await store.getCustomerByPhone(ctx.callerPhone) : null;
      const customerName = str(args, "customerName") || profile?.name || "";
      if (!customerName) return { error: "Ask for the caller's name first." };
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      const order = await store.createOrder({ customerName, phone, garment, orderType: speed, notes: str(args, "notes") });
      if (ctx.callerPhone && !profile?.name) await store.upsertCustomer(ctx.callerPhone, { name: customerName });
      return {
        created: true,
        order,
        priceConfirmed: order.price > 0,
        ...(order.price > 0 ? {} : { note: "Price is not in the price list; staff will confirm it." }),
      };
    }

    case "set_order_type": {
      const orderId = str(args, "orderId");
      if (!orderId) return { error: "Provide the order number." };
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      const existing = await store.getOrderById(orderId);
      if (!existing) return { error: `No order ${orderId}.` };
      if (["ready for pickup", "delivered", "cancelled", "picked up", "complete", "completed"].includes(existing.stage.trim().toLowerCase())) {
        return { error: `Order ${existing.orderId} is ${existing.stage}, so its speed cannot be changed.` };
      }
      const order = await store.setOrderType(orderId, speed);
      if (!order) return { error: `No order ${orderId}.` };
      return {
        updated: true,
        order,
        previous: { orderType: existing.orderType, price: existing.price, expectedDate: existing.expectedDate },
      };
    }

    case "cancel_order": {
      if (args.confirmed !== true) return { error: CONFIRM_ERROR };
      const orderId = str(args, "orderId");
      if (!orderId) return { error: "Provide the order number." };
      const res = await store.cancelOrder(orderId, str(args, "reason") || undefined);
      if (!res.ok) {
        return {
          cancelled: false,
          error: res.reason ?? "Could not cancel.",
          cancellableStages: CANCELLABLE_STAGES,
          ...(res.order ? { stage: res.order.stage } : {}),
        };
      }
      return { cancelled: true, order: res.order };
    }

    case "schedule_appointment": {
      if (args.confirmed !== true) return { error: CONFIRM_ERROR };
      const kind = str(args, "kind") as AppointmentKind;
      const address = str(args, "address");
      if ((kind === "pickup" || kind === "delivery") && !address) return { error: "Ask for the street address." };
      const phone = str(args, "phone") || ctx.callerPhone || "";
      if (!phone) return { error: "Ask for a phone number for the booking." };
      const profile = ctx.callerPhone ? await store.getCustomerByPhone(ctx.callerPhone) : null;
      const apptName = str(args, "name") || profile?.name || "";
      if (!apptName) return { error: "Ask for the caller's name first." };
      const res = await store.scheduleAppointment({
        phone,
        name: apptName,
        kind,
        date: str(args, "date"),
        window: str(args, "window"),
        address,
        orderId: str(args, "orderId"),
        notes: str(args, "notes"),
      });
      if (!res.ok || !res.appointment) return { scheduled: false, error: res.reason ?? "Could not book that." };
      return { scheduled: true, appointment: res.appointment, weekday: weekdayName(res.appointment.date) };
    }

    case "quote_turnaround": {
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      const readyDate = computeExpectedDate(speed);
      const out: Record<string, unknown> = { speed, readyDate, readyWeekday: weekdayName(readyDate) };
      const item = str(args, "item");
      if (item) {
        const rows = await store.listPrices();
        const regular = priceGarment(item, "Regular", rows);
        const expedited = priceGarment(item, "Expedited", rows);
        if (regular.matched) {
          out.item = item;
          out.price = speed === "Expedited" ? expedited.price : regular.price;
          out.regularPrice = regular.price;
          out.expeditedPrice = expedited.price;
          out.expediteExtra = Math.round((expedited.price - regular.price) * 100) / 100;
        } else {
          out.priceFound = false;
          out.note = "Item not in the price list; call list_prices or offer a message for a quote.";
        }
      }
      return out;
    }

    case "update_customer_profile": {
      if (!ctx.callerPhone) return { error: "No caller phone number is available for this call." };
      const patch: CustomerPatch = {
        name: str(args, "name") || undefined,
        email: str(args, "email") || undefined,
        preferences: str(args, "preferences") || undefined,
      };
      const note = str(args, "notes");
      if (note) {
        const existing = await store.getCustomerByPhone(ctx.callerPhone);
        const dated = `[${new Date().toISOString().slice(0, 10)}] ${note}`;
        patch.notes = [existing?.notes, dated].filter(Boolean).join(" ");
      }
      if (!patch.name && !patch.email && !patch.preferences && !patch.notes) {
        return { error: "Provide at least one of name, email, preferences, or notes." };
      }
      const saved = await store.upsertCustomer(ctx.callerPhone, patch);
      return { saved: true, customer: saved };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
