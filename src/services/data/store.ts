import { MongoClient, type Collection, type OptionalUnlessRequiredId } from "mongodb";
import { SEED_CONFIG, SEED_HOURS, SEED_ORDERS, SEED_PRICING } from "./seed";
import { localToday, type Appointment, type Customer, type OrderItem, type StageEvent, type StoreHours } from "./shop";

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
  // Added for orders created by the agent. Older orders only have the flat fields above.
  items?: OrderItem[];
  stageHistory?: StageEvent[];
  createdAt?: string;
  source?: "phone" | "walk_in";
}

export interface PriceRow {
  category: string;
  item: string;
  regularPrice: number;
  expeditedPrice: number;
  notes: string;
  aliases?: string[]; // what callers actually say: "blazer" finds "Suit jacket"
  turnaroundDays?: { regular: number; expedited: number }; // open days
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

/** A tool the teacher requested and an owner built and enabled (collection `tool_requests`). */
export interface CustomTool {
  name: string;
  description: string;
  parameters: { name: string; type: "string" | "number" | "integer" | "boolean"; description: string; required: boolean }[];
  side_effect: "read" | "write";
  endpoint: string;
}

export interface NewOrder {
  customerName: string;
  phone: string;
  items: OrderItem[];
  speed: Speed;
  notes: string;
  expectedDate: string;
}

export interface CollectionInfo {
  name: string;
  count: number;
  sample?: unknown;
}

export interface TeacherDocs {
  grades: Record<string, unknown>[];
  improvements: Record<string, unknown>[];
  toolRequests: Record<string, unknown>[];
}

export interface DataStore {
  getHours(): Promise<StoreHours>;
  getCustomer(phone: string): Promise<Customer | null>;
  createOrder(input: NewOrder): Promise<Order>;
  /** Books a slot, or returns null if that window is full. Capacity is enforced here so it holds under concurrent calls. */
  bookAppointment(input: Omit<Appointment, "appointmentId" | "status" | "createdAt">, capacity: number): Promise<Appointment | null>;
  /** Moves a booking to another slot (null if full). */
  moveAppointment(appointmentId: string, date: string, window: Appointment["window"], capacity: number): Promise<Appointment | null>;
  cancelAppointment(appointmentId: string): Promise<Appointment | null>;
  setAppointmentSync(appointmentId: string, sync: { externalEventId?: string; calendarSync: "synced" | "failed" | "off" }): Promise<void>;
  getAppointments(orderId: string): Promise<Appointment[]>;
  /** Scheduled appointments from `from` to `to` inclusive (YYYY-MM-DD). */
  listAppointments(from: string, to: string): Promise<Appointment[]>;
  describeCollections(): Promise<{ mode: "atlas" | "memory"; db: string; collections: CollectionInfo[] }>;
  getTeacherDocs(): Promise<TeacherDocs>;
  answerOwnerQuestion(improvementId: string, answer: string): Promise<Record<string, unknown>>;
  setToolRequestStatus(name: string, action: "approve" | "decline" | "enable" | "disable", endpoint?: string): Promise<Record<string, unknown>>;
  getEnabledTools(): Promise<CustomTool[]>;
  getActiveConfig(): Promise<ConfigVersion>;
  listConfigVersions(): Promise<ConfigVersion[]>;
  saveConfigVersion(input: ConfigInput): Promise<ConfigVersion>;
  activateConfigVersion(version: number): Promise<ConfigVersion | null>;
  getOrderById(orderId: string): Promise<Order | null>;
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

export function findPriceRow(rows: PriceRow[], item: string): PriceRow | undefined {
  const q = item.trim().toLowerCase();
  const names = (r: PriceRow) => [r.item, ...(r.aliases ?? [])].map((n) => n.toLowerCase());
  return (
    rows.find((r) => names(r).includes(q)) ??
    rows.find((r) => names(r).some((n) => n.includes(q) || q.includes(n)))
  );
}

export function nextOrderId(existing: string[]): string {
  const max = existing.reduce((m, id) => Math.max(m, Number(id.replace(/\D/g, "")) || 0), 0);
  return `ORD-${String(max + 1).padStart(4, "0")}`;
}

const TOOL_ACTIONS = {
  approve: { from: ["requested"], to: "approved" },
  decline: { from: ["requested", "approved"], to: "declined" },
  enable: { from: ["approved", "disabled"], to: "enabled" },
  disable: { from: ["enabled"], to: "disabled" },
} as const;

export function toolTransition(status: string, action: keyof typeof TOOL_ACTIONS, endpoint?: string): { to: string; endpoint?: string } {
  const t = TOOL_ACTIONS[action];
  if (!(t.from as readonly string[]).includes(status)) throw new Error(`Tool is ${status}, cannot ${action}`);
  if (action === "enable") {
    let u: URL;
    try { u = new URL(endpoint ?? ""); } catch { throw new Error("Endpoint must be an https URL"); }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if ((u.protocol !== "https:" && !(local && u.protocol === "http:")) || u.username || u.password) throw new Error("Endpoint must be an https URL without credentials");
    return { to: t.to, endpoint: u.toString() };
  }
  return { to: t.to };
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

function buildOrder(orderId: string, input: NewOrder, now: string): Order {
  const garment = input.items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.item}` : i.item)).join(", ");
  const total = Math.round(input.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;
  return {
    orderId, customerName: input.customerName, phone: normalizePhone(input.phone), garment, stage: "Received",
    orderType: input.speed, price: total, payment: "Unpaid", notes: input.notes, expectedDate: input.expectedDate,
    items: input.items, stageHistory: [{ stage: "Received", at: now }], createdAt: now, source: "phone",
  };
}

function customersFromOrders(rows: Order[]): Customer[] {
  const byPhone = new Map<string, Customer>();
  for (const o of rows) {
    const phone = normalizePhone(o.phone);
    const prev = byPhone.get(phone);
    byPhone.set(phone, { phone, name: prev?.name ?? o.customerName, preferences: {}, orderCount: (prev?.orderCount ?? 0) + 1, lastOrderId: o.orderId, createdAt: new Date().toISOString() });
  }
  return [...byPhone.values()];
}

export function createMemoryStore(): DataStore {
  const orders: Order[] = structuredClone(SEED_ORDERS);
  const pricing: PriceRow[] = structuredClone(SEED_PRICING);
  const messages: Message[] = [];
  const calls = new Map<string, CallRecord>();
  const hours: StoreHours = structuredClone(SEED_HOURS);
  const customers = new Map<string, Customer>(customersFromOrders(SEED_ORDERS).map((c) => [c.phone, c]));
  const appointments: Appointment[] = [];
  const configs: ConfigVersion[] = [structuredClone(SEED_CONFIG)];
  let activeVersion = SEED_CONFIG.version;
  const findOrder = (orderId: string) => {
    const id = orderId.trim().toUpperCase();
    return orders.find((o) => o.orderId.toUpperCase() === id) ?? null;
  };

  return {
    async getHours() {
      return structuredClone(hours);
    },
    async getCustomer(phone) {
      const c = customers.get(normalizePhone(phone));
      return c ? structuredClone(c) : null;
    },
    async createOrder(input) {
      const now = new Date().toISOString();
      const order: Order = buildOrder(nextOrderId(orders.map((o) => o.orderId)), input, now);
      orders.push(order);
      const phone = order.phone;
      const prev = customers.get(phone);
      customers.set(phone, {
        phone, name: prev?.name ?? input.customerName, preferences: prev?.preferences ?? {},
        orderCount: (prev?.orderCount ?? 0) + 1, lastOrderId: order.orderId, createdAt: prev?.createdAt ?? now,
      });
      return structuredClone(order);
    },
    async bookAppointment(input, capacity) {
      const taken = appointments.filter((x) => x.status === "scheduled" && x.date === input.date && x.window === input.window).length;
      if (taken >= capacity) return null;
      const appt: Appointment = { ...input, appointmentId: `APT-${String(appointments.length + 1).padStart(4, "0")}`, status: "scheduled", createdAt: new Date().toISOString() };
      appointments.push(appt);
      return structuredClone(appt);
    },
    async moveAppointment(id, date, window, capacity) {
      const appt = appointments.find((x) => x.appointmentId === id && x.status === "scheduled");
      if (!appt) return null;
      const taken = appointments.filter((x) => x.status === "scheduled" && x.date === date && x.window === window && x.appointmentId !== id).length;
      if (taken >= capacity) return null;
      Object.assign(appt, { date, window, updatedAt: new Date().toISOString() });
      return structuredClone(appt);
    },
    async cancelAppointment(id) {
      const appt = appointments.find((x) => x.appointmentId === id && x.status === "scheduled");
      if (!appt) return null;
      Object.assign(appt, { status: "cancelled", updatedAt: new Date().toISOString() });
      return structuredClone(appt);
    },
    async setAppointmentSync(id, sync) {
      const appt = appointments.find((x) => x.appointmentId === id);
      if (appt) Object.assign(appt, sync);
    },
    async listAppointments(from, to) {
      return structuredClone(appointments.filter((x) => x.status === "scheduled" && x.date >= from && x.date <= to).sort((a, b) => a.date.localeCompare(b.date)));
    },
    async getAppointments(orderId) {
      return structuredClone(appointments.filter((a) => a.orderId === orderId && a.status === "scheduled"));
    },
    async describeCollections() {
      const one = <T,>(a: T[]) => (a.length ? a[0] : undefined);
      return { mode: "memory" as const, db: "in-memory", collections: [
        { name: "customers", count: customers.size, sample: one([...customers.values()]) },
        { name: "orders", count: orders.length, sample: orders.find((o) => o.items) ?? orders[0] },
        { name: "pricing", count: pricing.length, sample: pricing.find((p) => p.aliases) ?? pricing[0] },
        { name: "store_hours", count: 1, sample: hours },
        { name: "appointments", count: appointments.length, sample: one(appointments) },
        { name: "claims", count: 0 },
        { name: "messages", count: messages.length, sample: one(messages) },
        { name: "calls", count: calls.size, sample: one([...calls.values()].map(({ transcript, ...c }) => c)) },
        { name: "config_versions", count: configs.length, sample: configs[configs.length - 1] },
        { name: "config_state", count: 1, sample: { _id: "active", version: activeVersion } },
        { name: "grades", count: 0 }, { name: "improvements", count: 0 }, { name: "tool_requests", count: 0 },
      ] };
    },
    async getTeacherDocs() {
      return { grades: [], improvements: [], toolRequests: [] };
    },
    async answerOwnerQuestion() {
      throw new Error("The teacher needs MongoDB (set MONGODB_URI)");
    },
    async setToolRequestStatus() {
      throw new Error("Tool requests need MongoDB (set MONGODB_URI)");
    },
    async getEnabledTools() {
      return [];
    },
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
      return findOrder(orderId);
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
      return toLookup(item, speed, findPriceRow(pricing, item));
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
  const toolRequests = db.collection<CustomTool & { status: string }>("tool_requests");
  const messages = db.collection<Message>("messages");
  const calls = db.collection<CallRecord>("calls");
  const customers = db.collection<Customer>("customers");
  const storeHours = db.collection<StoreHours & { _id: "main" }>("store_hours");
  const appointments = db.collection<Appointment>("appointments");
  const claims = db.collection("claims");
  const grades = db.collection("grades");
  const improvements = db.collection("improvements");
  const phoneOf = (o: Order) => normalizePhone(o.phone);

  await orders.createIndex({ orderId: 1 }, { unique: true });
  await pricing.createIndex({ item: 1 }, { unique: true });
  await calls.createIndex({ callSid: 1 }, { unique: true });
  const configVersions = db.collection<ConfigVersion>("config_versions");
  const configState = db.collection<{ _id: string; version: number }>("config_state");
  await configVersions.createIndex({ version: 1 }, { unique: true });
  await seedIfEmpty(configVersions, [SEED_CONFIG]);
  await configState.updateOne({ _id: "active" }, { $setOnInsert: { version: SEED_CONFIG.version } }, { upsert: true });
  await seedIfEmpty(orders, SEED_ORDERS);
  await seedIfEmpty(pricing, SEED_PRICING);
  await customers.createIndex({ phone: 1 }, { unique: true });
  await orders.createIndex({ phone: 1, createdAt: -1 });
  await appointments.createIndex({ orderId: 1, status: 1 });
  await appointments.createIndex({ date: 1, window: 1 });
  await claims.createIndex({ status: 1, createdAt: -1 });
  await toolRequests.createIndex({ name: 1 }, { unique: true }).catch(() => undefined);
  await storeHours.updateOne({ _id: "main" }, { $setOnInsert: SEED_HOURS }, { upsert: true });
  await seedIfEmpty(customers, customersFromOrders(SEED_ORDERS));
  console.log(`[data] MongoDB connected: db=${dbName}`);

  const proj = { projection: { _id: 0 } } as const;

  const self: DataStore = {
    async getHours() {
      return (await storeHours.findOne({ _id: "main" }, proj)) ?? structuredClone(SEED_HOURS);
    },
    async getCustomer(phone) {
      return customers.findOne({ phone: normalizePhone(phone) }, proj);
    },
    async createOrder(input) {
      const now = new Date().toISOString();
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await orders.find({}, { projection: { orderId: 1 } }).sort({ orderId: -1 }).limit(1).toArray();
        const order = buildOrder(nextOrderId(last.map((o) => o.orderId)), input, now);
        try {
          await orders.insertOne({ ...order });
        } catch (err) {
          if ((err as { code?: number }).code === 11000 && attempt < 4) continue; // another call took this number
          throw err;
        }
        await customers.updateOne(
          { phone: phoneOf(order) },
          { $setOnInsert: { name: input.customerName, preferences: {}, createdAt: now }, $set: { lastOrderId: order.orderId }, $inc: { orderCount: 1 } },
          { upsert: true }
        );
        return order;
      }
      throw new Error("Could not allocate an order number");
    },
    async bookAppointment(input, capacity) {
      const slot = { date: input.date, window: input.window, status: "scheduled" as const };
      if ((await appointments.countDocuments(slot)) >= capacity) return null;
      const count = await appointments.countDocuments();
      const appt: Appointment = { ...input, appointmentId: `APT-${String(count + 1).padStart(4, "0")}`, status: "scheduled", createdAt: new Date().toISOString() };
      await appointments.insertOne({ ...appt });
      // Optimistic check: two calls can pass the count above at once, so re-count and let the later one back out.
      const mine = await appointments.find(slot, { projection: { _id: 1, appointmentId: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
      if (mine.length > capacity && !mine.slice(0, capacity).some((m) => m.appointmentId === appt.appointmentId)) {
        await appointments.deleteOne({ appointmentId: appt.appointmentId });
        return null;
      }
      return appt;
    },
    async moveAppointment(id, date, window, capacity) {
      const appt = await appointments.findOne({ appointmentId: id, status: "scheduled" }, proj);
      if (!appt) return null;
      const taken = await appointments.countDocuments({ date, window, status: "scheduled", appointmentId: { $ne: id } });
      if (taken >= capacity) return null;
      await appointments.updateOne({ appointmentId: id }, { $set: { date, window, updatedAt: new Date().toISOString() } });
      return { ...appt, date, window };
    },
    async cancelAppointment(id) {
      const res = await appointments.findOneAndUpdate({ appointmentId: id, status: "scheduled" }, { $set: { status: "cancelled", updatedAt: new Date().toISOString() } }, { returnDocument: "after", projection: { _id: 0 } });
      return res;
    },
    async setAppointmentSync(id, sync) {
      await appointments.updateOne({ appointmentId: id }, { $set: sync });
    },
    async listAppointments(from, to) {
      return appointments.find({ status: "scheduled", date: { $gte: from, $lte: to } }, proj).sort({ date: 1, window: 1 }).toArray();
    },
    async getAppointments(orderId) {
      return appointments.find({ orderId, status: "scheduled" }, proj).toArray();
    },
    async describeCollections() {
      const names = ["customers", "orders", "pricing", "store_hours", "appointments", "claims", "messages", "calls", "config_versions", "config_state", "grades", "improvements", "tool_requests"];
      const collections = await Promise.all(names.map(async (name) => {
        const col = db.collection(name);
        const doc = await col.find({}, { projection: name === "calls" ? { _id: 0, transcript: 0 } : { _id: 0 } }).sort({ _id: -1 }).limit(1).next();
        return { name, count: await col.estimatedDocumentCount(), ...(doc ? { sample: doc } : {}) };
      }));
      return { mode: "atlas" as const, db: dbName, collections };
    },
    async getTeacherDocs() {
      const [g, i, t] = await Promise.all([
        grades.find({}).sort({ created_at: -1 }).limit(200).toArray(),
        improvements.find({}).sort({ created_at: -1 }).limit(200).toArray(),
        toolRequests.find({}).sort({ request_count: -1 }).toArray(),
      ]);
      return { grades: g, improvements: i, toolRequests: t } as TeacherDocs;
    },
    async answerOwnerQuestion(improvementId, answer) {
      const text = answer.trim();
      if (!text || text.length > 1000) throw new Error("Answer must be 1-1000 characters");
      const imp = await improvements.findOne({ _id: improvementId as never });
      const question = (imp?.payload as { question?: string } | undefined)?.question;
      if (!imp || imp.type !== "context" || imp.status !== "proposed" || !question) throw new Error("Not an open question");
      const current = await self.getActiveConfig();
      const created = await self.saveConfigVersion({
        companyName: current.companyName, greeting: current.greeting,
        context: `${current.context}\n${question} ${text}`.trim().slice(0, 8000),
        author: "manager", note: `Owner answered: ${question}`.slice(0, 200),
      });
      await improvements.updateOne({ _id: improvementId as never }, { $set: { status: "applied", "payload.answer": text, applied_in_config_id: `v${created.version}` } });
      return (await improvements.findOne({ _id: improvementId as never })) as Record<string, unknown>;
    },
    async setToolRequestStatus(name, action, endpoint) {
      const tr = await toolRequests.findOne({ name });
      if (!tr) throw new Error("Unknown tool request");
      const t = toolTransition(tr.status, action, endpoint);
      await toolRequests.updateOne({ name, status: tr.status }, { $set: { status: t.to, updated_at: new Date(), ...(t.endpoint ? { endpoint: t.endpoint, enabled_at: new Date() } : {}) } });
      return (await toolRequests.findOne({ name })) as Record<string, unknown>;
    },
    async getEnabledTools() {
      const rows = await toolRequests.find({ status: "enabled", endpoint: { $type: "string" } }).toArray();
      return rows.map(({ name, description, parameters, side_effect, endpoint }) => ({ name, description, parameters, side_effect, endpoint }));
    },
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
      // The price list is small, so match in code (names and aliases) with the same rules as the in-memory store.
      return toLookup(item, speed, findPriceRow(await pricing.find({}, proj).toArray(), item));
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
