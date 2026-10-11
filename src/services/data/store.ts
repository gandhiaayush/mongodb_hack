import { MongoClient, type Collection, type OptionalUnlessRequiredId } from "mongodb";
import type { Recipe } from "../tools/recipe";
import { SEED_APPOINTMENTS, SEED_CONFIG, SEED_CUSTOMERS, SEED_ORDERS, SEED_PRICING } from "./seed";

export type Speed = "Regular" | "Expedited";

export interface Order {
  orderId: string;
  customerName: string;
  phone: string;
  garment: string;
  stage: string;
  orderType: Speed;
  price: number;
  payment: string;
  notes: string;
  expectedDate: string;
}

export interface PriceRow {
  category: string;
  item: string;
  regularPrice: number;
  expeditedPrice: number;
  notes: string;
}

export interface PriceLookup {
  found: boolean;
  item: string;
  orderType: Speed;
  price: number | null;
  category: string | null;
  notes: string | null;
}

export interface Message {
  name: string;
  phone: string;
  message: string;
  createdAt: string;
}

export interface CallTranscriptEntry {
  role: "caller" | "agent";
  text: string;
  ts: string;
}

export interface CallToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ts: string;
}

export interface CallRecord {
  callSid: string;
  from?: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  transcript: CallTranscriptEntry[];
  toolCalls: CallToolCall[];
  status: "active" | "completed";
  configVersion?: number;
}

export interface ConfigVersion {
  version: number;
  companyName: string;
  greeting: string;
  context: string;
  author: "manager" | "teacher" | "system";
  note?: string;
  createdAt: string;
}

export interface ConfigInput {
  companyName: string;
  greeting: string;
  context: string;
  author: ConfigVersion["author"];
  note?: string;
}

export interface Customer {
  phone: string;
  name?: string;
  email?: string;
  preferences?: string;
  notes?: string;
  vip?: boolean;
  firstSeenAt: string;
  lastCallAt?: string;
  callCount: number;
}

export type CustomerPatch = Partial<Pick<Customer, "name" | "email" | "preferences" | "notes" | "vip">>;

/** Splits an owner edit into fields to set and fields to clear. */
function splitEdit(patch: CustomerPatch): { set: CustomerPatch; unset: string[] } {
  const set: CustomerPatch = {};
  const unset: string[] = [];
  for (const key of ["name", "email", "preferences", "notes"] as const) {
    const v = patch[key];
    if (typeof v !== "string") continue;
    if (v.trim()) set[key] = v.trim();
    else unset.push(key);
  }
  if (typeof patch.vip === "boolean") set.vip = patch.vip;
  return { set, unset };
}

function cleanPatch(patch: CustomerPatch): CustomerPatch {
  const out: CustomerPatch = {};
  for (const key of ["name", "email", "preferences", "notes"] as const) {
    const v = patch[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  if (typeof patch.vip === "boolean") out.vip = patch.vip;
  return out;
}

export type ToolParamType = "string" | "number" | "boolean";
export type ToolStatus = "proposed" | "enabled" | "disabled" | "declined";

export interface ToolProposal {
  name: string;
  description: string;
  params: { name: string; type: ToolParamType; description: string; required: boolean }[];
  write: boolean;
  why: string;
  mockup: {
    sampleDialogue: { role: "caller" | "agent" | "tool"; text: string }[];
    exampleArgs: Record<string, unknown>;
    exampleResult: Record<string, unknown>;
  };
  status: ToolStatus;
  requestCount: number;
  sourceCallSids: string[];
  evidence: { turn: number; quote: string }[];
  createdAt: string;
  updatedAt: string;
  enabledAt?: string;
  enabledBy?: "teacher" | "owner";
  /** Optional declarative implementation written by the teacher; see src/services/tools/recipe.ts */
  recipe?: Recipe;
  recipeVerified?: boolean;
}

export interface CustomRecord {
  id: string;
  tool: string;
  phone?: string;
  callSid?: string;
  fields: Record<string, unknown>;
  createdAt: string;
}

export interface CustomRecordInput {
  tool: string;
  phone?: string;
  callSid?: string;
  fields: Record<string, unknown>;
}

export interface CustomRecordQuery {
  tool?: string;
  phone?: string;
  limit?: number;
}

export type AnswerImprovementResult =
  | { ok: true; version: number; improvementId: string }
  | { ok: false; error: string };

function mergeProposal(existing: ToolProposal, incoming: ToolProposal): ToolProposal {
  const replaceRecipe = !!incoming.recipe && existing.status === "proposed";
  return {
    ...existing,
    ...(replaceRecipe
      ? {
          recipe: structuredClone(incoming.recipe),
          ...(incoming.recipeVerified !== undefined ? { recipeVerified: incoming.recipeVerified } : { recipeVerified: undefined }),
        }
      : {}),
    requestCount: (existing.requestCount || 1) + 1,
    sourceCallSids: [...new Set([...(existing.sourceCallSids ?? []), ...(incoming.sourceCallSids ?? [])])],
    evidence: [...(existing.evidence ?? []), ...(incoming.evidence ?? [])].slice(-10),
    updatedAt: new Date().toISOString(),
  };
}

function newRecord(input: CustomRecordInput): CustomRecord {
  return {
    id: `REC-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    tool: input.tool,
    ...(input.phone ? { phone: normalizePhone(input.phone) } : {}),
    ...(input.callSid ? { callSid: input.callSid } : {}),
    fields: input.fields,
    createdAt: new Date().toISOString(),
  };
}

export type AppointmentKind = "pickup" | "delivery" | "dropoff";

export interface Appointment {
  id: string;
  phone: string;
  name: string;
  kind: AppointmentKind;
  date: string; // YYYY-MM-DD
  window: string; // e.g. "10am-12pm"
  address?: string;
  orderId?: string;
  notes?: string;
  status: "scheduled";
  createdAt: string;
}

export interface AppointmentInput {
  phone: string;
  name: string;
  kind: AppointmentKind;
  date: string;
  window: string;
  address?: string;
  orderId?: string;
  notes?: string;
}

export interface CreateOrderInput {
  customerName: string;
  phone: string;
  garment: string;
  orderType?: Speed;
  notes?: string;
}

export interface OrderResult {
  ok: boolean;
  order?: Order;
  reason?: string;
}

export interface AppointmentResult {
  ok: boolean;
  appointment?: Appointment;
  reason?: string;
}

/** Days of the week (0 = Sunday) the business is closed. Used for turnaround and scheduling. */
export const CLOSED_DAYS: readonly number[] = [0];
export const TURNAROUND_DAYS: Record<Speed, number> = { Regular: 3, Expedited: 1 };
/** Stages in which an order can still be cancelled. */
export const CANCELLABLE_STAGES: readonly string[] = ["Received", "Sorting"];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date `days` open days after `from` (YYYY-MM-DD, default today), skipping closed days. */
export function computeExpectedDate(speed: Speed, from: string = todayISO()): string {
  const d = new Date(`${from}T00:00:00Z`);
  let left = TURNAROUND_DAYS[speed];
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!CLOSED_DAYS.includes(d.getUTCDay())) left--;
  }
  return d.toISOString().slice(0, 10);
}

function findPriceRow(rows: PriceRow[], item: string): PriceRow | undefined {
  const q = item.trim().toLowerCase();
  if (!q) return undefined;
  return (
    rows.find((r) => r.item.toLowerCase() === q) ??
    rows.find((r) => r.item.toLowerCase().includes(q) || q.includes(r.item.toLowerCase()))
  );
}

/**
 * Price a free-text garment string that may list several items, e.g. "Suit (2-piece) x2, Shirt (dress) x3".
 * Quantity forms: "x3", "3x", or a leading number. Returns matched=false if any segment is not in the table.
 */
export function priceGarment(garment: string, speed: Speed, rows: PriceRow[]): { price: number; matched: boolean } {
  const segments = garment.split(/,|;|\band\b|\+/i).map((x) => x.trim()).filter(Boolean);
  if (segments.length === 0) return { price: 0, matched: false };
  let total = 0;
  for (const seg of segments) {
    let qty = 1;
    let name = seg;
    let m = name.match(/\s*[x×]\s*(\d+)\s*$/i) ?? name.match(/\s*\(?\s*(\d+)\s*[x×]\s*\)?\s*$/i);
    if (m) {
      qty = Number.parseInt(m[1], 10);
      name = name.slice(0, m.index).trim();
    } else if ((m = name.match(/^(\d+)\s*[x×]?\s+(.+)$/i))) {
      qty = Number.parseInt(m[1], 10);
      name = m[2].trim();
    }
    const row = findPriceRow(rows, name);
    if (!row || qty < 1) return { price: 0, matched: false };
    total += (speed === "Expedited" ? row.expeditedPrice : row.regularPrice) * qty;
  }
  return { price: Math.round(total * 100) / 100, matched: true };
}

const PRICE_TBC_NOTE = "Price to be confirmed.";

function buildNewOrder(orderId: string, input: CreateOrderInput, rows: PriceRow[]): Order {
  const speed: Speed = input.orderType === "Expedited" ? "Expedited" : "Regular";
  const garment = input.garment.trim();
  const { price, matched } = priceGarment(garment, speed, rows);
  const day = todayISO();
  const notes = [input.notes?.trim() ? `[${day}] ${input.notes.trim()}` : "", matched ? "" : `[${day}] ${PRICE_TBC_NOTE}`]
    .filter(Boolean)
    .join(" ");
  return {
    orderId,
    customerName: input.customerName.trim(),
    phone: normalizePhone(input.phone),
    garment,
    stage: "Received",
    orderType: speed,
    price,
    payment: "Unpaid",
    notes,
    expectedDate: computeExpectedDate(speed),
  };
}

function nextId(prefix: string, existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const m = id.match(new RegExp(`^${prefix}-(\\d+)$`, "i"));
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

function applySpeed(order: Order, speed: Speed, rows: PriceRow[]): Order {
  const { price, matched } = priceGarment(order.garment, speed, rows);
  return {
    ...order,
    orderType: speed,
    price: matched ? price : order.price,
    expectedDate: computeExpectedDate(speed),
  };
}

function cancelledOrder(order: Order, reason?: string): OrderResult {
  if (order.stage.trim().toLowerCase() === "cancelled") {
    return { ok: false, order, reason: `Order ${order.orderId} is already cancelled.` };
  }
  if (!CANCELLABLE_STAGES.some((s) => s.toLowerCase() === order.stage.trim().toLowerCase())) {
    return {
      ok: false,
      order,
      reason: `Order ${order.orderId} cannot be cancelled because work has started (stage: ${order.stage}).`,
    };
  }
  const line = `[${todayISO()}] Cancelled by caller${reason?.trim() ? `: ${reason.trim()}` : "."}`;
  return { ok: true, order: { ...order, stage: "Cancelled", notes: order.notes ? `${order.notes} ${line}` : line } };
}

/** Returns a human-readable rejection reason, or null when the booking input is valid. */
export function validateAppointment(input: AppointmentInput, today: string = todayISO()): string | null {
  if (!["pickup", "delivery", "dropoff"].includes(input.kind)) return "Kind must be pickup, delivery or dropoff.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    return "Date must be a real date in YYYY-MM-DD format.";
  }
  if (input.date < today) return `${input.date} is in the past. Ask for a date from today (${today}) onward.`;
  const dow = new Date(`${input.date}T00:00:00Z`).getUTCDay();
  if (CLOSED_DAYS.includes(dow)) return `We are closed on ${WEEKDAYS[dow]}s. Offer a different day.`;
  if (!input.window.trim()) return "A time window is required, for example 10am-12pm.";
  return null;
}

function buildAppointment(id: string, input: AppointmentInput): Appointment {
  return {
    id,
    phone: normalizePhone(input.phone),
    name: input.name.trim(),
    kind: input.kind,
    date: input.date,
    window: input.window.trim(),
    ...(input.address?.trim() ? { address: input.address.trim() } : {}),
    ...(input.orderId?.trim() ? { orderId: input.orderId.trim().toUpperCase() } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };
}

export interface DataStore {
  getActiveConfig(): Promise<ConfigVersion>;
  listConfigVersions(): Promise<ConfigVersion[]>;
  saveConfigVersion(input: ConfigInput): Promise<ConfigVersion>;
  activateConfigVersion(version: number): Promise<ConfigVersion | null>;
  getOrderById(orderId: string): Promise<Order | null>;
  upsertOrder(order: Order): Promise<void>;
  searchOrdersByName(name: string): Promise<Order[]>;
  getOrdersByPhone(phone: string): Promise<Order[]>;
  listPrices(): Promise<PriceRow[]>;
  lookupPrice(item: string, speed: Speed): Promise<PriceLookup>;
  appendOrderNote(orderId: string, note: string): Promise<Order | null>;
  takeMessage(input: { name: string; phone: string; message: string }): Promise<Message>;
  saveCall(record: CallRecord): Promise<void>;
  listCalls(limit: number): Promise<CallRecord[]>;
  listOrders(): Promise<Order[]>;
  listMessages(): Promise<Message[]>;
  getCustomerByPhone(phone: string): Promise<Customer | null>;
  upsertCustomer(phone: string, patch: CustomerPatch): Promise<Customer>;
  /** Owner edit: unlike upsertCustomer, an empty string clears the field. Returns null if the customer does not exist. */
  editCustomer(phone: string, patch: CustomerPatch): Promise<Customer | null>;
  recordCustomerCall(phone: string): Promise<void>;
  listCustomers(): Promise<Customer[]>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  setOrderType(orderId: string, speed: Speed): Promise<Order | null>;
  cancelOrder(orderId: string, reason?: string): Promise<OrderResult>;
  scheduleAppointment(input: AppointmentInput): Promise<AppointmentResult>;
  listAppointments(): Promise<Appointment[]>;
  listAppointmentsByPhone(phone: string): Promise<Appointment[]>;
  upsertToolProposal(p: ToolProposal): Promise<ToolProposal>;
  listToolProposals(): Promise<ToolProposal[]>;
  getToolProposal(name: string): Promise<ToolProposal | null>;
  setToolStatus(name: string, status: "enabled" | "disabled" | "declined"): Promise<ToolProposal | null>;
  listEnabledTools(): Promise<ToolProposal[]>;
  saveCustomRecord(input: CustomRecordInput): Promise<CustomRecord>;
  listCustomRecords(q?: CustomRecordQuery): Promise<CustomRecord[]>;
  listGrades(): Promise<Record<string, unknown>[]>;
  listImprovements(): Promise<Record<string, unknown>[]>;
  answerImprovement(id: string, answer: string): Promise<AnswerImprovementResult>;
}

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newVersion(version: number, input: ConfigInput): ConfigVersion {
  return {
    version,
    companyName: input.companyName,
    greeting: input.greeting,
    context: input.context,
    author: input.author,
    ...(input.note ? { note: input.note } : {}),
    createdAt: new Date().toISOString(),
  };
}

function toLookup(item: string, speed: Speed, row: PriceRow | undefined): PriceLookup {
  return {
    found: !!row,
    item,
    orderType: speed,
    price: row ? (speed === "Expedited" ? row.expeditedPrice : row.regularPrice) : null,
    category: row?.category ?? null,
    notes: row?.notes || null,
  };
}

export function createMemoryStore(): DataStore {
  const orders: Order[] = structuredClone(SEED_ORDERS);
  const pricing: PriceRow[] = structuredClone(SEED_PRICING);
  const messages: Message[] = [];
  const customers = new Map<string, Customer>(SEED_CUSTOMERS.map((c) => [c.phone, structuredClone(c)]));
  const appointments: Appointment[] = structuredClone(SEED_APPOINTMENTS);
  const calls = new Map<string, CallRecord>();
  const configs: ConfigVersion[] = [structuredClone(SEED_CONFIG)];
  const proposals = new Map<string, ToolProposal>();
  const records: CustomRecord[] = [];
  let activeVersion = SEED_CONFIG.version;
  const findOrder = (orderId: string) => {
    const id = orderId.trim().toUpperCase();
    return orders.find((o) => o.orderId.toUpperCase() === id) ?? null;
  };

  return {
    async getActiveConfig() {
      return structuredClone(configs.find((c) => c.version === activeVersion) ?? configs[0]);
    },
    async listConfigVersions() {
      return structuredClone([...configs].sort((a, b) => b.version - a.version));
    },
    async saveConfigVersion(input) {
      const created = newVersion(Math.max(...configs.map((c) => c.version)) + 1, input);
      configs.push(created);
      activeVersion = created.version;
      return structuredClone(created);
    },
    async activateConfigVersion(version) {
      const found = configs.find((c) => c.version === version);
      if (!found) return null;
      activeVersion = version;
      return structuredClone(found);
    },
    async getOrderById(orderId) {
      const o = findOrder(orderId);
      return o ? { ...o } : null;
    },
    async upsertOrder(order) {
      const id = order.orderId.toUpperCase();
      const next = { ...order, orderId: id, phone: normalizePhone(order.phone) };
      const idx = orders.findIndex((o) => o.orderId.toUpperCase() === id);
      if (idx >= 0) orders[idx] = next;
      else orders.push(next);
    },
    async searchOrdersByName(name) {
      const q = name.trim().toLowerCase();
      return orders.filter((o) => o.customerName.toLowerCase().includes(q)).slice(0, 5);
    },
    async getOrdersByPhone(phone) {
      const p = normalizePhone(phone);
      return orders.filter((o) => normalizePhone(o.phone) === p).slice(0, 5);
    },
    async listPrices() {
      return pricing.map((r) => ({ ...r }));
    },
    async lookupPrice(item, speed) {
      const q = item.trim().toLowerCase();
      const row =
        pricing.find((r) => r.item.toLowerCase() === q) ??
        pricing.find((r) => r.item.toLowerCase().includes(q) || q.includes(r.item.toLowerCase()));
      return toLookup(item, speed, row);
    },
    async appendOrderNote(orderId, note) {
      const order = findOrder(orderId);
      if (!order) return null;
      const line = `[${today()}] ${note.trim()}`;
      order.notes = order.notes ? `${order.notes} ${line}` : line;
      return { ...order };
    },
    async takeMessage(input) {
      const msg: Message = {
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        message: input.message.trim(),
        createdAt: new Date().toISOString(),
      };
      messages.push(msg);
      return { ...msg };
    },
    async saveCall(record) {
      calls.set(record.callSid, structuredClone(record));
    },
    async listCalls(limit) {
      return [...calls.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((c) => structuredClone(c));
    },
    async listOrders() {
      return structuredClone(orders);
    },
    async listMessages() {
      return [...messages].reverse().map((m) => ({ ...m }));
    },
    async getCustomerByPhone(phone) {
      const c = customers.get(normalizePhone(phone));
      return c ? { ...c } : null;
    },
    async upsertCustomer(phone, patch) {
      const key = normalizePhone(phone);
      const existing = customers.get(key) ?? { phone: key, firstSeenAt: new Date().toISOString(), callCount: 0 };
      const next = { ...existing, ...cleanPatch(patch) };
      customers.set(key, next);
      return { ...next };
    },
    async editCustomer(phone, patch) {
      const key = normalizePhone(phone);
      const existing = customers.get(key);
      if (!existing) return null;
      const { set, unset } = splitEdit(patch);
      const next: Customer = { ...existing, ...set };
      for (const k of unset) delete (next as unknown as Record<string, unknown>)[k];
      customers.set(key, next);
      return { ...next };
    },
    async recordCustomerCall(phone) {
      const key = normalizePhone(phone);
      const now = new Date().toISOString();
      const existing = customers.get(key) ?? { phone: key, firstSeenAt: now, callCount: 0 };
      customers.set(key, { ...existing, callCount: existing.callCount + 1, lastCallAt: now });
    },
    async listCustomers() {
      return [...customers.values()]
        .sort((a, b) => (b.lastCallAt ?? b.firstSeenAt).localeCompare(a.lastCallAt ?? a.firstSeenAt))
        .map((c) => ({ ...c }));
    },
    async createOrder(input) {
      const order = buildNewOrder(
        nextId("ORD", orders.map((o) => o.orderId)),
        input,
        pricing
      );
      orders.push(order);
      return { ...order };
    },
    async setOrderType(orderId, speed) {
      const order = findOrder(orderId);
      if (!order) return null;
      Object.assign(order, applySpeed(order, speed, pricing));
      return { ...order };
    },
    async cancelOrder(orderId, reason) {
      const order = findOrder(orderId);
      if (!order) return { ok: false, reason: `No order ${orderId}.` };
      const res = cancelledOrder(order, reason);
      if (!res.ok) return { ...res, order: { ...order } };
      Object.assign(order, res.order);
      return { ok: true, order: { ...order } };
    },
    async scheduleAppointment(input) {
      const reason = validateAppointment(input);
      if (reason) return { ok: false, reason };
      const appt = buildAppointment(
        nextId("APT", appointments.map((a) => a.id)),
        input
      );
      appointments.push(appt);
      return { ok: true, appointment: { ...appt } };
    },
    async listAppointments() {
      return [...appointments].reverse().map((a) => ({ ...a }));
    },
    async listAppointmentsByPhone(phone) {
      const p = normalizePhone(phone);
      return appointments.filter((a) => a.phone === p).reverse().map((a) => ({ ...a }));
    },
    async upsertToolProposal(p) {
      const existing = proposals.get(p.name);
      if (!existing) {
        proposals.set(p.name, structuredClone(p));
        return structuredClone(p);
      }
      if (existing.status === "declined") return structuredClone(existing);
      const merged = mergeProposal(existing, p);
      proposals.set(p.name, merged);
      return structuredClone(merged);
    },
    async listToolProposals() {
      return structuredClone([...proposals.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },
    async getToolProposal(name) {
      const p = proposals.get(name);
      return p ? structuredClone(p) : null;
    },
    async setToolStatus(name, status) {
      const p = proposals.get(name);
      if (!p) return null;
      const now = new Date().toISOString();
      p.status = status;
      p.updatedAt = now;
      if (status === "enabled") {
        p.enabledAt = now;
        p.enabledBy = "owner";
      }
      return structuredClone(p);
    },
    async listEnabledTools() {
      return structuredClone([...proposals.values()].filter((p) => p.status === "enabled"));
    },
    async saveCustomRecord(input) {
      const rec = newRecord(input);
      records.push(rec);
      return structuredClone(rec);
    },
    async listCustomRecords(q = {}) {
      const phone = q.phone ? normalizePhone(q.phone) : undefined;
      return structuredClone(
        records
          .filter((r) => (!q.tool || r.tool === q.tool) && (!phone || r.phone === phone))
          .reverse()
          .slice(0, q.limit ?? 100)
      );
    },
    async listGrades() {
      return [];
    },
    async listImprovements() {
      return [];
    },
    async answerImprovement() {
      return { ok: false, error: "needs MongoDB" };
    },
  };
}

async function seedIfEmpty<T extends object>(col: Collection<T>, docs: T[]): Promise<void> {
  if ((await col.estimatedDocumentCount()) > 0 || docs.length === 0) return;
  await col.insertMany(docs.map((d) => ({ ...d })) as OptionalUnlessRequiredId<T>[], { ordered: false }).catch((err: unknown) => {
    if ((err as { code?: number })?.code !== 11000) throw err;
  });
}

export async function createMongoStore(uri: string, dbName: string): Promise<DataStore> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const orders = db.collection<Order>("orders");
  const pricing = db.collection<PriceRow>("pricing");
  const messages = db.collection<Message>("messages");
  const calls = db.collection<CallRecord>("calls");
  const customers = db.collection<Customer>("customers");
  const appointments = db.collection<Appointment>("appointments");

  await orders.createIndex({ orderId: 1 }, { unique: true });
  await pricing.createIndex({ item: 1 }, { unique: true });
  await calls.createIndex({ callSid: 1 }, { unique: true });
  const configVersions = db.collection<ConfigVersion>("config_versions");
  const configState = db.collection<{ _id: string; version: number }>("config_state");
  await configVersions.createIndex({ version: 1 }, { unique: true });
  await seedIfEmpty(configVersions, [SEED_CONFIG]);
  await configState.updateOne({ _id: "active" }, { $setOnInsert: { version: SEED_CONFIG.version } }, { upsert: true });
  await seedIfEmpty(orders, SEED_ORDERS);
  await customers.createIndex({ phone: 1 }, { unique: true });
  await seedIfEmpty(pricing, SEED_PRICING);
  await seedIfEmpty(customers, SEED_CUSTOMERS);
  await appointments.createIndex({ phone: 1 });
  await appointments.createIndex({ id: 1 }, { unique: true });
  await seedIfEmpty(appointments, SEED_APPOINTMENTS);
  const proposalsCol = db.collection<ToolProposal & { _id: string }>("tool_proposals");
  const recordsCol = db.collection<CustomRecord>("custom_records");
  await proposalsCol.createIndex({ name: 1 }, { unique: true });
  await recordsCol.createIndex({ tool: 1, phone: 1 });
  await recordsCol.createIndex({ id: 1 }, { unique: true });
  console.log(`[data] MongoDB connected: db=${dbName}`);

  const proj = { projection: { _id: 0 } } as const;

  const self: DataStore = {
    async getActiveConfig() {
      const state = await configState.findOne({ _id: "active" });
      const active = state ? await configVersions.findOne({ version: state.version }, proj) : null;
      if (active) return active;
      const latest = await configVersions.find({}, proj).sort({ version: -1 }).limit(1).toArray();
      return latest[0] ?? structuredClone(SEED_CONFIG);
    },
    async listConfigVersions() {
      return configVersions.find({}, proj).sort({ version: -1 }).toArray();
    },
    async saveConfigVersion(input) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const top = await configVersions.find({}, proj).sort({ version: -1 }).limit(1).toArray();
        const created = newVersion((top[0]?.version ?? 0) + 1, input);
        try {
          await configVersions.insertOne({ ...created });
        } catch (err) {
          if ((err as { code?: number })?.code === 11000) continue;
          throw err;
        }
        await configState.updateOne({ _id: "active" }, { $set: { version: created.version } }, { upsert: true });
        return created;
      }
      throw new Error("could not allocate config version");
    },
    async activateConfigVersion(version) {
      const found = await configVersions.findOne({ version }, proj);
      if (!found) return null;
      await configState.updateOne({ _id: "active" }, { $set: { version } }, { upsert: true });
      return found;
    },
    async getOrderById(orderId) {
      const id = orderId.trim().toUpperCase();
      return orders.findOne({ orderId: id }, proj);
    },
    async upsertOrder(order) {
      const id = order.orderId.toUpperCase();
      await orders.replaceOne(
        { orderId: id },
        { ...order, orderId: id, phone: normalizePhone(order.phone) },
        { upsert: true }
      );
    },
    async searchOrdersByName(name) {
      return orders
        .find({ customerName: { $regex: escapeRegex(name.trim()), $options: "i" } }, proj)
        .limit(5)
        .toArray();
    },
    async getOrdersByPhone(phone) {
      return orders.find({ phone: normalizePhone(phone) }, proj).limit(5).toArray();
    },
    async listPrices() {
      return pricing.find({}, proj).sort({ category: 1, item: 1 }).toArray();
    },
    async lookupPrice(item, speed) {
      const row = await pricing.findOne(
        { item: { $regex: `^${escapeRegex(item.trim())}$`, $options: "i" } },
        proj
      ) ?? await pricing.findOne(
        { item: { $regex: escapeRegex(item.trim()), $options: "i" } },
        proj
      );
      return toLookup(item, speed, row ?? undefined);
    },
    async appendOrderNote(orderId, note) {
      const line = `[${today()}] ${note.trim()}`;
      const res = await orders.updateOne({ orderId: orderId.trim().toUpperCase() }, [
        {
          $set: {
            notes: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$notes", ""] } }, 0] },
                { $concat: [{ $ifNull: ["$notes", ""] }, " ", { $literal: line }] },
                { $literal: line },
              ],
            },
          },
        },
      ]);
      if (res.matchedCount === 0) return null;
      return orders.findOne({ orderId: orderId.trim().toUpperCase() }, proj);
    },
    async takeMessage(input) {
      const doc: Message = {
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        message: input.message.trim(),
        createdAt: new Date().toISOString(),
      };
      await messages.insertOne({ ...doc });
      return doc;
    },
    async saveCall(record) {
      await calls.replaceOne({ callSid: record.callSid }, structuredClone(record), { upsert: true });
    },
    async listCalls(limit) {
      return calls.find({}, proj).sort({ startedAt: -1 }).limit(limit).toArray();
    },
    async listOrders() {
      return orders.find({}, proj).sort({ orderId: 1 }).toArray();
    },
    async listMessages() {
      return messages.find({}, proj).sort({ createdAt: -1 }).toArray();
    },
    async getCustomerByPhone(phone) {
      return customers.findOne({ phone: normalizePhone(phone) }, proj);
    },
    async upsertCustomer(phone, patch) {
      const key = normalizePhone(phone);
      const set = cleanPatch(patch);
      await customers.updateOne(
        { phone: key },
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          $setOnInsert: { firstSeenAt: new Date().toISOString(), callCount: 0 },
        },
        { upsert: true }
      );
      return (await customers.findOne({ phone: key }, proj)) as Customer;
    },
    async editCustomer(phone, patch) {
      const key = normalizePhone(phone);
      const { set, unset } = splitEdit(patch);
      const update: Record<string, unknown> = {};
      if (Object.keys(set).length) update.$set = set;
      if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [k, ""]));
      if (!Object.keys(update).length) return customers.findOne({ phone: key }, proj);
      const res = await customers.findOneAndUpdate({ phone: key }, update, { returnDocument: "after", projection: { _id: 0 } });
      return res;
    },
    async recordCustomerCall(phone) {
      const now = new Date().toISOString();
      await customers.updateOne(
        { phone: normalizePhone(phone) },
        { $set: { lastCallAt: now }, $inc: { callCount: 1 }, $setOnInsert: { firstSeenAt: now } },
        { upsert: true }
      );
    },
    async listCustomers() {
      return customers.find({}, proj).sort({ lastCallAt: -1, firstSeenAt: -1 }).toArray();
    },
    async createOrder(input) {
      const rows = await pricing.find({}, proj).toArray();
      for (let attempt = 0; attempt < 8; attempt++) {
        const ids = await orders.find({}, { projection: { _id: 0, orderId: 1 } }).toArray();
        const order = buildNewOrder(nextId("ORD", ids.map((o) => o.orderId)), input, rows);
        try {
          await orders.insertOne({ ...order });
        } catch (err) {
          if ((err as { code?: number })?.code === 11000) continue;
          throw err;
        }
        return order;
      }
      throw new Error("could not allocate order id");
    },
    async setOrderType(orderId, speed) {
      const id = orderId.trim().toUpperCase();
      const order = await orders.findOne({ orderId: id }, proj);
      if (!order) return null;
      const rows = await pricing.find({}, proj).toArray();
      const next = applySpeed(order, speed, rows);
      await orders.updateOne({ orderId: id }, { $set: { orderType: next.orderType, price: next.price, expectedDate: next.expectedDate } });
      return next;
    },
    async cancelOrder(orderId, reason) {
      const id = orderId.trim().toUpperCase();
      const order = await orders.findOne({ orderId: id }, proj);
      if (!order) return { ok: false, reason: `No order ${orderId}.` };
      const res = cancelledOrder(order, reason);
      if (!res.ok || !res.order) return res;
      // Guard on the stage we read so a concurrent stage change cannot be overwritten
      const upd = await orders.updateOne(
        { orderId: id, stage: order.stage },
        { $set: { stage: res.order.stage, notes: res.order.notes } }
      );
      if (upd.matchedCount === 0) {
        return { ok: false, reason: `Order ${id} changed while cancelling. Check its status and try again.` };
      }
      return res;
    },
    async scheduleAppointment(input) {
      const reason = validateAppointment(input);
      if (reason) return { ok: false, reason };
      for (let attempt = 0; attempt < 8; attempt++) {
        const ids = await appointments.find({}, { projection: { _id: 0, id: 1 } }).toArray();
        const appt = buildAppointment(nextId("APT", ids.map((a) => a.id)), input);
        try {
          await appointments.insertOne({ ...appt });
        } catch (err) {
          if ((err as { code?: number })?.code === 11000) continue;
          throw err;
        }
        return { ok: true, appointment: appt };
      }
      throw new Error("could not allocate appointment id");
    },
    async listAppointments() {
      return appointments.find({}, proj).sort({ createdAt: -1, id: -1 }).toArray();
    },
    async listAppointmentsByPhone(phone) {
      return appointments.find({ phone: normalizePhone(phone) }, proj).sort({ createdAt: -1, id: -1 }).toArray();
    },
    async upsertToolProposal(p) {
      const doc = Object.fromEntries(
        Object.entries({ ...structuredClone(p), _id: p.name }).filter(([, v]) => v !== undefined)
      );
      const inserted = await proposalsCol
        .insertOne(doc as never)
        .then(() => true)
        .catch((err: unknown) => {
          if ((err as { code?: number })?.code === 11000) return false;
          throw err;
        });
      if (inserted) return structuredClone(p);
      const existing = await proposalsCol.findOne({ name: p.name }, proj);
      if (!existing) return structuredClone(p);
      if (existing.status === "declined") return existing;
      await proposalsCol.updateOne(
        { name: p.name },
        {
          $inc: { requestCount: 1 },
          $addToSet: { sourceCallSids: { $each: p.sourceCallSids ?? [] } },
          $set: { updatedAt: new Date().toISOString() },
        }
      );
      if (p.recipe && existing.status === "proposed") {
        await proposalsCol.updateOne(
          { name: p.name, status: "proposed" },
          p.recipeVerified === undefined
            ? { $set: { recipe: structuredClone(p.recipe) }, $unset: { recipeVerified: "" } }
            : { $set: { recipe: structuredClone(p.recipe), recipeVerified: p.recipeVerified } }
        );
      }
      return (await proposalsCol.findOne({ name: p.name }, proj)) ?? existing;
    },
    async listToolProposals() {
      return proposalsCol.find({}, proj).sort({ updatedAt: -1 }).toArray();
    },
    async getToolProposal(name) {
      return proposalsCol.findOne({ name }, proj);
    },
    async setToolStatus(name, status) {
      const now = new Date().toISOString();
      const res = await proposalsCol.updateOne(
        { name },
        { $set: { status, updatedAt: now, ...(status === "enabled" ? { enabledAt: now, enabledBy: "owner" as const } : {}) } }
      );
      if (res.matchedCount === 0) return null;
      return proposalsCol.findOne({ name }, proj);
    },
    async listEnabledTools() {
      return proposalsCol.find({ status: "enabled" }, proj).toArray();
    },
    async saveCustomRecord(input) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const rec = newRecord(input);
        try {
          await recordsCol.insertOne({ ...rec });
        } catch (err) {
          if ((err as { code?: number })?.code === 11000) continue;
          throw err;
        }
        return rec;
      }
      throw new Error("could not allocate record id");
    },
    async listCustomRecords(q = {}) {
      const filter: Record<string, unknown> = {};
      if (q.tool) filter.tool = q.tool;
      if (q.phone) filter.phone = normalizePhone(q.phone);
      return recordsCol
        .find(filter, proj)
        .sort({ createdAt: -1 })
        .limit(q.limit ?? 100)
        .toArray();
    },
    async listGrades() {
      return db.collection("grades").find({}).sort({ created_at: 1 }).toArray() as unknown as Record<string, unknown>[];
    },
    async listImprovements() {
      return db.collection("improvements").find({}).sort({ created_at: -1 }).toArray() as unknown as Record<string, unknown>[];
    },
    async answerImprovement(id, answer) {
      const col = db.collection<{ _id: string; type?: string; status?: string; payload?: { question?: string } }>("improvements");
      const imp = await col.findOne({ _id: id });
      if (!imp) return { ok: false, error: "improvement not found" };
      if (imp.type !== "context" || imp.status !== "proposed") return { ok: false, error: `${id} is not an open owner question` };
      // Claim it first so two concurrent answers cannot both apply
      const claim = await col.updateOne({ _id: id, status: "proposed" }, { $set: { status: "applying" } });
      if (claim.matchedCount === 0) return { ok: false, error: `${id} is not an open owner question` };
      try {
        const cfg = await self.getActiveConfig();
        const question = imp.payload?.question ?? "";
        const saved = await self.saveConfigVersion({
          companyName: cfg.companyName,
          greeting: cfg.greeting,
          context: `${cfg.context}\n${question} ${answer.trim()}`.trim(),
          author: "manager",
          note: `Owner answered: ${question}`.slice(0, 300),
        });
        await col.updateOne(
          { _id: id },
          { $set: { status: "applied", "payload.answer": answer, applied_in_config_id: `v${saved.version}` } }
        );
        return { ok: true, version: saved.version, improvementId: id };
      } catch (err) {
        await col.updateOne({ _id: id, status: "applying" }, { $set: { status: "proposed" } }).catch(() => undefined);
        throw err;
      }
    },
  };
  return self;
}

export async function createDataStore(): Promise<DataStore> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.log("[data] MONGODB_URI unset, using in-memory store");
    return createMemoryStore();
  }
  return createMongoStore(uri, process.env.MONGODB_DB?.trim() || "snoopy");
}
