import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { toConfig } from "./bridge.js";
import type {
  BridgeCall, BridgeConfig, BridgeConfigState, ConfigVersionDoc, GradeDoc, ImprovementDoc, ToolRequestDoc,
} from "./types.js";

let client: MongoClient | null = null;

export const dbName = () => process.env.MONGODB_DB ?? "snoopy";

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set (set it in .env, see README)");
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db(dbName());
}

export async function closeDb() {
  await client?.close();
  client = null;
}

export async function cols() {
  const db = await getDb();
  return {
    // Owned by the bridge. The teacher reads calls and adds config versions in the bridge's shape.
    calls: db.collection<BridgeCall>("calls"),
    configVersions: db.collection<BridgeConfig>("config_versions"),
    configState: db.collection<BridgeConfigState>("config_state"),
    // Owned by the teacher.
    grades: db.collection<GradeDoc>("grades"),
    improvements: db.collection<ImprovementDoc>("improvements"),
    // Written by the teacher (requests) and the owner (decisions). The bridge reads the enabled ones.
    toolRequests: db.collection<ToolRequestDoc>("tool_requests"),
  };
}

export async function getConfig(version: number): Promise<ConfigVersionDoc | null> {
  const doc = await (await cols()).configVersions.findOne({ version }, { projection: { _id: 0 } });
  return doc ? toConfig(doc) : null;
}

/** The version the bridge will load for the next call. */
export async function getActiveConfig(): Promise<ConfigVersionDoc> {
  const c = await cols();
  const state = await c.configState.findOne({ _id: "active" });
  if (!state) throw new Error(`no active config in db "${dbName()}" (start the bridge once, or run: npm run seed)`);
  const cfg = await getConfig(state.version);
  if (!cfg) throw new Error(`config version ${state.version} not found`);
  return cfg;
}
