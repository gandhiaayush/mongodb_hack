import { FunctionDeclaration, Type } from "@google/genai";
import { findPriceRow, type CustomTool, type DataStore, type Speed } from "../data/store";
import { WINDOWS, hoursFor, isDate, localTime, localToday, nextOpenDate, readyBy, type AppointmentWindow } from "../data/shop";

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
    name: "get_hours",
    description:
      "Store hours, address and phone. Use when the caller asks if you are open, when you close, or where you are. Omit date for today. The result says whether the store is open right now.",
    parameters: {
      type: Type.OBJECT,
      properties: { date: { type: Type.STRING, description: "YYYY-MM-DD. Omit for today." } },
    },
  },
  {
    name: "quote_estimate",
    description:
      "Price several garments at once with the speed and the date they would be ready. Use when the caller lists items and asks for a total. Item names can be what the caller says, like blazer or jeans.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          description: "Garments to price",
          items: {
            type: Type.OBJECT,
            properties: {
              item: { type: Type.STRING, description: "Garment, e.g. dress shirt" },
              quantity: { type: Type.INTEGER, description: "How many, default 1" },
            },
            required: ["item"],
          },
        },
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "Regular or Expedited" },
      },
      required: ["items", "speed"],
    },
  },
  {
    name: "check_turnaround",
    description:
      "When a drop-off made today would be ready for one garment type and speed. Use for how long or how fast questions about new orders. For an existing order use get_order.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        item: { type: Type.STRING, description: "Garment, e.g. wool coat" },
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "Regular or Expedited" },
      },
      required: ["item", "speed"],
    },
  },
  {
    name: "create_order",
    description:
      "Start a new order for a drop-off. Only call after the caller has confirmed the items, the speed and the total from quote_estimate, and you have their name and phone number. Returns the order number to read back.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING, description: "Caller's name" },
        phone: { type: Type.STRING, description: "Callback phone number" },
        items: {
          type: Type.ARRAY,
          description: "Garments being dropped off",
          items: {
            type: Type.OBJECT,
            properties: {
              item: { type: Type.STRING, description: "Garment" },
              quantity: { type: Type.INTEGER, description: "How many, default 1" },
              notes: { type: Type.STRING, description: "Special handling for this garment" },
            },
            required: ["item"],
          },
        },
        speed: { type: Type.STRING, enum: ["Regular", "Expedited"], description: "Regular or Expedited" },
        notes: { type: Type.STRING, description: "Anything for the whole order" },
      },
      required: ["customerName", "phone", "items", "speed"],
    },
  },
  {
    name: "schedule_pickup",
    description:
      "Book a customer pickup or a home delivery for an existing order, on a day the store is open. Use after get_order shows the order. A delivery needs an address. To change an existing booking, take a message instead.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        date: { type: Type.STRING, description: "YYYY-MM-DD" },
        window: { type: Type.STRING, enum: ["morning", "afternoon", "evening"], description: "Time window" },
        type: { type: Type.STRING, enum: ["pickup", "delivery"], description: "pickup (default) or delivery" },
        address: { type: Type.STRING, description: "Delivery address, required for delivery" },
      },
      required: ["orderId", "date", "window"],
    },
  },
  {
    name: "get_customer",
    description:
      "The caller's profile, recent orders and what they owe. Use when the caller asks about their account or balance, or to greet a returning customer. Pass the caller's phone.",
    parameters: {
      type: Type.OBJECT,
      properties: { phone: { type: Type.STRING, description: "Phone number, e.g. +14155550123" } },
      required: ["phone"],
    },
  },
];

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

export async function executeTool(
  name: string,
  args: Args,
  store: DataStore
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

    case "get_hours": {
      const h = await store.getHours();
      const today = localToday(h.timezone);
      const requested = str(args, "date");
      const date = !requested || requested.toLowerCase() === "today" ? today : requested;
      if (!isDate(date)) return { error: "date must be YYYY-MM-DD" };
      const day = hoursFor(h, date);
      const openNow = date === today && day.isOpen && localTime(h.timezone) >= day.opens! && localTime(h.timezone) < day.closes!;
      return { ...day, today, openNow: date === today ? openNow : null, nextOpenDate: day.isOpen ? null : nextOpenDate(h, date), address: h.address, phone: h.phone };
    }

    case "check_turnaround": {
      const item = str(args, "item");
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      if (!item) return { error: "Provide the item." };
      const [h, rows, price] = await Promise.all([store.getHours(), store.listPrices(), store.lookupPrice(item, speed)]);
      if (!price.found) return { found: false, item, hint: "Call list_prices for exact names." };
      const row = findPriceRow(rows, item)!;
      const days = row.turnaroundDays?.[speed === "Expedited" ? "expedited" : "regular"] ?? (speed === "Expedited" ? 1 : 3);
      return { found: true, item: row.item, speed, businessDays: days, readyBy: readyBy(h, localToday(h.timezone), days) };
    }

    case "quote_estimate":
    case "create_order": {
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      const raw = Array.isArray(args.items) ? (args.items as Args[]) : [];
      if (!raw.length || raw.length > 20) return { error: "Provide between 1 and 20 items." };
      const [h, rows] = await Promise.all([store.getHours(), store.listPrices()]);
      const lines = [];
      const notFound: string[] = [];
      let maxDays = 0;
      for (const r of raw) {
        const name = str(r, "item");
        const qty = Math.min(Math.max(Math.trunc(Number(r.quantity ?? 1)) || 1, 1), 50);
        const row = name ? findPriceRow(rows, name) : undefined;
        if (!row) { notFound.push(name || "(blank)"); continue; }
        const unit = speed === "Expedited" ? row.expeditedPrice : row.regularPrice;
        maxDays = Math.max(maxDays, row.turnaroundDays?.[speed === "Expedited" ? "expedited" : "regular"] ?? (speed === "Expedited" ? 1 : 3));
        lines.push({ item: row.item, quantity: qty, unitPrice: unit, lineTotal: Math.round(unit * qty * 100) / 100, ...(str(r, "notes") ? { notes: str(r, "notes") } : {}) });
      }
      const total = Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100;
      const ready = readyBy(h, localToday(h.timezone), maxDays);
      if (name === "quote_estimate") return { speed, items: lines, notFound, total, readyBy: lines.length ? ready : null };
      const callerName = str(args, "customerName");
      const phone = str(args, "phone");
      if (!callerName || !phone) return { error: "Provide customerName and phone." };
      if (notFound.length) return { created: false, error: `No price for: ${notFound.join(", ")}. Call list_prices for exact names.` };
      const order = await store.createOrder({ customerName: callerName, phone, items: lines, speed, notes: str(args, "notes"), expectedDate: ready });
      return { created: true, orderId: order.orderId, total: order.price, speed, readyBy: order.expectedDate, items: order.items };
    }

    case "schedule_pickup": {
      const orderId = str(args, "orderId");
      const date = str(args, "date");
      const window = str(args, "window") as AppointmentWindow;
      const type = str(args, "type") === "delivery" ? "delivery" : "pickup";
      const address = str(args, "address");
      if (!orderId || !isDate(date) || !WINDOWS.includes(window)) return { error: "Provide orderId, date (YYYY-MM-DD) and window (morning, afternoon or evening)." };
      const order = await store.getOrderById(orderId);
      if (!order) return { scheduled: false, error: `No order ${orderId}.` };
      const h = await store.getHours();
      if (date < localToday(h.timezone)) return { scheduled: false, error: "That date has passed." };
      const day = hoursFor(h, date);
      if (!day.isOpen) return { scheduled: false, error: `Closed on ${date}${day.reason ? ` (${day.reason})` : ""}.`, nextOpenDate: nextOpenDate(h, date) };
      if (type === "delivery" && !address) return { scheduled: false, error: "A delivery needs an address." };
      if ((await store.getAppointments(order.orderId)).some((a) => a.type === type)) return { scheduled: false, error: `${order.orderId} already has a ${type} booked. Take a message to change it.` };
      const appt = await store.createAppointment({ type, orderId: order.orderId, phone: order.phone, date, window, ...(address ? { address } : {}) });
      return { scheduled: true, appointmentId: appt.appointmentId, type, orderId: order.orderId, date, window, opens: day.opens, closes: day.closes };
    }

    case "get_customer": {
      const phone = str(args, "phone");
      if (!phone) return { error: "Provide phone." };
      const customer = await store.getCustomer(phone);
      const orders = await store.getOrdersByPhone(phone);
      const unpaid = orders.filter((o) => o.payment.toLowerCase() === "unpaid" && !["picked up", "delivered"].includes(o.stage.toLowerCase()));
      return {
        found: !!customer || orders.length > 0,
        name: customer?.name ?? orders[0]?.customerName ?? null,
        preferences: customer?.preferences ?? {},
        recentOrders: orders.map((o) => ({ orderId: o.orderId, garment: o.garment, stage: o.stage, expectedDate: o.expectedDate })),
        balanceDue: Math.round(unpaid.reduce((sum, o) => sum + o.price, 0) * 100) / 100,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- Custom tools -----------------------------------------------------------------------------
// Requested by the teacher, built by the CRM owner, enabled by the owner with an https endpoint.
// The bridge only forwards declared arguments to that endpoint and never lets a custom tool shadow a built-in.

const BUILT_IN = new Set(TOOLS.map((t) => t.name));
const TYPE_MAP = { string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER, boolean: Type.BOOLEAN } as const;
const CUSTOM_TIMEOUT_MS = 5000;
const MAX_RESPONSE_CHARS = 8000;

export function usableCustomTools(tools: CustomTool[]): CustomTool[] {
  return tools.filter((t) => !BUILT_IN.has(t.name));
}

export function customDeclarations(tools: CustomTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(t.parameters.map((p) => [p.name, { type: TYPE_MAP[p.type], description: p.description }])),
      required: t.parameters.filter((p) => p.required).map((p) => p.name),
    },
  }));
}

export async function executeCustomTool(tool: CustomTool, args: Args): Promise<Record<string, unknown>> {
  const declared = new Set(tool.parameters.map((p) => p.name));
  const clean = Object.fromEntries(Object.entries(args).filter(([k]) => declared.has(k)));
  const missing = tool.parameters.filter((p) => p.required && clean[p.name] === undefined).map((p) => p.name);
  if (missing.length) return { error: `Missing: ${missing.join(", ")}` };
  const secret = process.env.CUSTOM_TOOL_SECRET;
  try {
    const res = await fetch(tool.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-tool-secret": secret } : {}) },
      body: JSON.stringify({ tool: tool.name, args: clean }),
      signal: AbortSignal.timeout(CUSTOM_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    if (!res.ok) return { error: `${tool.name} failed with HTTP ${res.status}` };
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      return { result: text };
    }
  } catch (err) {
    return { error: `${tool.name} unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
