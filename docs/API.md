# Dashboard API (for any UI)

Anything that speaks HTTP can be the dashboard. The bundled one is `web/index.html` (static, no build).

## Connecting

- **Base URL:** the voice server. Locally `http://localhost:3000`; with `npm run live` it is the ngrok URL printed in the terminal, e.g. `https://bruising-boogieman-unreal.ngrok-free.dev`. It changes if ngrok restarts (a reserved ngrok domain keeps it stable).
- **Every request** should send `ngrok-skip-browser-warning: 1` (otherwise a free ngrok URL answers with an HTML interstitial) and, when `DASHBOARD_TOKEN` is set on the server, `x-dashboard-token: <token>`. `GET /api/health` needs no token.
- **CORS:** `GET, PUT, POST, OPTIONS`; headers `Content-Type, x-dashboard-token, ngrok-skip-browser-warning`. Restrict origins with `ALLOWED_ORIGINS` on the server.
- **Polling:** the bundled UI polls every 3 seconds while a tab is visible. There is no websocket.
- **Prefill:** `web/index.html?api=<base-url>` stores the base URL; the token is entered in Settings. `?demo=1` shows mock data with no backend.
- Errors are JSON `{ "error": "..." }` with 400, 401, 404 or 500.

## Read

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{ status: "ok" }` |
| `GET /api/stats` | `{ calls, activeCalls, orders, openOrders, messages }` |
| `GET /api/calls?limit=50` | `CallRecord[]` newest first: `{ callSid, from?, startedAt, endedAt?, durationSec?, status: "active"\|"completed", configVersion?, transcript: [{role: "caller"\|"agent", text, ts}], toolCalls: [{name, args, result, ts}] }`. Active calls appear with their live transcript |
| `GET /api/calls/:callSid` | one `CallRecord` or 404 |
| `GET /api/customers` | `{ phone, name?, email?, preferences?, notes?, vip?, firstSeenAt, lastCallAt?, callCount }[]` |
| `GET /api/orders` | `{ orderId, customerName, phone, garment, stage, orderType, price, payment, notes, expectedDate }[]` |
| `GET /api/appointments` | `{ id, phone, name, kind: "pickup"\|"delivery"\|"dropoff", date, window, address?, orderId?, notes?, status, createdAt }[]` |
| `GET /api/messages` | `{ name, phone, message, createdAt }[]` |
| `GET /api/config` | `{ active: ConfigVersion, versions: ConfigVersion[] }`; `ConfigVersion = { version, companyName, greeting, context, author: "manager"\|"teacher"\|"system", note?, createdAt }` |
| `GET /api/grades` | the teacher's grades, one per graded call (see `docs/TEAM_HANDOFF.md` section 6): `{ _id, call_id, config_version_id, outcome, scores{accuracy,tool_use,task_completion,tone,brevity}, overall, frustration, rationale, issues[], model, created_at }[]`. Empty without MongoDB |
| `GET /api/improvements` | the teacher's changes and questions: `{ _id, source_call_ids, type: "prompt"\|"context"\|"tool"\|"schema", status: "applied"\|"proposed"\|"rejected"\|"rolled_back", payload, evidence_turns, reason, applied_in_config_id?, rejected_reason?, rolled_back_reason?, created_at }[]` |
| `GET /api/tools` | `ToolProposal[]` (below) |
| `GET /api/records?tool=&limit=` | `{ id, tool, phone?, callSid?, fields, createdAt }[]`: records saved by custom tools |

## Write

| Endpoint | Body | Effect |
|---|---|---|
| `PUT /api/config` | `{ companyName, greeting, context, note? }` | New config version, active on the next call. 201 with the version. Limits: name 80, greeting 300, context 8000 characters |
| `POST /api/config/activate` | `{ version }` | Re-activate any version (rollback). 404 if unknown |
| `POST /api/tools/:name/enable` `/disable` `/decline` | none | Change a tool's status; returns the tool. Enabling a name that collides with a built-in returns 400 |
| `POST /api/improvements/:id/answer` | `{ answer }` (max 600 chars) | Answers an open owner question (type `context`, status `proposed`): the answer is appended to the company context as a new version (author `manager`) and the question becomes `applied`. MongoDB only |

## ToolProposal

```
{ name, description, write: boolean, why,
  params: [{ name, type: "string"|"number"|"boolean", description, required }],
  mockup: { sampleDialogue: [{role: "caller"|"agent"|"tool", text}], exampleArgs, exampleResult },
  status: "proposed"|"enabled"|"disabled"|"declined",
  enabledBy?: "teacher"|"owner", requestCount, sourceCallSids, evidence: [{turn, quote}],
  recipe?: { steps: Step[], response: { [key]: Expr } },   // how the tool really works
  recipeVerified?: boolean,                                 // the teacher ran it on its own example before enabling
  createdAt, updatedAt, enabledAt? }
```
A tool without a `recipe` just saves its arguments as a record (write) or lists the caller's earlier records (read). With a recipe it can calculate, enforce rules, and call the built-in calendar, rush and quote tools. The recipe language is defined in `src/services/tools/recipe.ts`.

## Plugging a different UI in

1. Point it at the base URL above and send the two headers.
2. The tabs in `web/index.html` map one-to-one to the endpoints above: Overview (`/stats`), Live Calls (`/calls`), Customers, Orders, Messages, Company Context (`/config`), Improvements (`/grades`, `/improvements`, `/tools`, `/records`).
3. Anything else reads the same JSON; nothing in the server depends on the UI.
