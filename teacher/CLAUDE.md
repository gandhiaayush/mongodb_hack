# Teacher agent: full specification

This file is the source of truth for the teacher agent. Read it before changing anything in
`src/services/teacher/` or `src/services/mongo/`.
All paths below are relative to this `teacher/` folder. Team status and open decisions: `../docs/TEAM_HANDOFF.md`.

## 1. Context

- Project: Snoopy AI voice receptionist with recursive self-improvement. Hackathon build, submission due 5:00 PM PT on 2026-10-11. Favor small, working changes over refactors.
- Problem statement: "Recursive Harnessing", a self-improving agent harness that evolves its own rules, guardrails, context and tool access.
- Two agents:
  - **Receptionist / bridge** (Aayush's code, https://github.com/gandhiaayush/mongodb_hack, branch `claude/mongodb-harness-hackathon-7hdril`): Twilio Media Streams -> voice bridge -> Gemini Live. A dry cleaner demo ("Charlie's Cleaners"). Loads the active config version at call start.
  - **Teacher** (this code): runs after every call, grades it, and rewrites the receptionist's harness.
- Stack: TypeScript (ESM, NodeNext, strict), Node 22, `mongodb` driver, `@google/genai`, `zod`, `dotenv`, run with `tsx`. No agent framework. No Streamlit. Dashboard must stay minor.
- Hard rules from the hackathon: everything lives in the provided MongoDB Atlas Sandbox cluster; the repository is public, so never commit `.env` or keys; never present scripted or fabricated scores as real output.
- Roles for the calendar integration: the **voice agent uses** the calendar tools during a call, through `gateway.ts`. The **teacher never calls the calendar**. It grades how the tools were used and changes their permission.
- Where this spec and the bridge's `docs/PLAN.md` disagree, this spec wins for the teacher: the judge is Gemini (not Claude), every call gets the full teaching pass (not only successful ones), and the teacher never writes business facts (PLAN auto-applied `context` changes).

## 2. Files

| File | Purpose |
|---|---|
| `src/services/mongo/types.ts` | `Bridge*` shapes (the bridge's documents, copied from its `store.ts`) and the teacher's own shapes. Do not change a `Bridge*` shape without telling the partner. |
| `src/services/mongo/bridge.ts` | Pure conversion between the two: `toCall`, `toConfig`, `fromConfig`, `splitContext`, `renderContext`, `deriveOutcome`. No database. |
| `src/services/mongo/client.ts` | `getDb`, `cols`, `closeDb`, `getActiveConfig()`, `getConfig(version)` |
| `src/services/integrations/time.ts` | Pure time rules: local time <-> UTC in the workspace time zone, `checkSlot` (past, business hours), `overlaps`, `freeSlots`. |
| `src/services/integrations/calendar.ts` | Google Calendar calls: `checkAvailability` (freebusy query), `createEvent` (events insert, optional attendee invite). OAuth2 with a refresh token. |
| `src/services/integrations/gateway.ts` | `runTool(callSid, tool, args)`: the single entry point for the voice bridge. Enforces the tool permission. Also `approveAppointment`, `rejectAppointment`, `toolDeclarations`. |
| `src/services/teacher/judge.ts` | Rubric prompt, `JudgeOutput` zod schema, `geminiJudge` (the only model call), `buildJudgeInput` |
| `src/services/teacher/plan.ts` | Pure functions `buildPlan` (validation and guardrails) and `regression` (automatic rollback test). No database, no model. |
| `src/services/teacher/index.ts` | `teach`, `answerOwnerQuestion`, `setToolPermission`, `rollback`, `scoreTrend`, `watch`, `printResult`, `activeContext` |
| `fixtures/seed.ts` | Demo data in the bridge's shapes: a salon config v1, fake calls 1-5 (4 and 5 are dry cleaner calls; 5 asks for a rush plus pickup and a hem price), and the demo workspace (one staff member, Maya) |
| `scripts/cli.ts` | `seed`, `demo`, `teach`, `answer`, `rollback`, `trend`, `tools`, `context`, `watch`, `appointments`, `approve`, `reject`, `permission`, `calendar-setup` |
| `scripts/calendar-check.ts` | `npm run calendar:check`: live test of the Google connection. Reads free/busy for the next 3 hours and creates a real test event one hour from now. |
| `scripts/selftest.ts` | Offline assertions for `buildPlan`, `regression`, the bridge conversion, tool proposals and recipes, the time rules and the permission rules. Must keep passing. |

Commands: `npm run tools` (list tool proposals), `npm run typecheck`, `npm run selftest`, `npm run demo`, `npm run watch`.
Environment: `MONGODB_URI`, `MONGODB_DB` (default `snoopy`, must be the same database the bridge uses), `GEMINI_API_KEY`, `GEMINI_TEACHER_MODEL` (default `gemini-3.8-flash`).
Calendar environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (OAuth2, scope `https://www.googleapis.com/auth/calendar`; not a service account, which cannot invite attendees), `GOOGLE_CALENDAR_ID` (calendar for the demo staff member, default `primary`). There is no `.env.example`; the variables are listed in README.md. Never log these values.

The Gemini key is on the free tier: **20 requests per day per model**. One graded call is one request. `gemini-3.8-flash` was used up on 2026-10-11; the local `.env` uses `gemini-3.5-flash`. A quota error (429) is not retried.

`npm run seed` and `npm run demo` always use the database `snoopy_demo`, and `seed` refuses any database whose name does not end in `_demo`, because it wipes the collections. To run other commands on the demo data: `MONGODB_DB=snoopy_demo npm run answer ...`.

## 3. Collections

Owned by the bridge (shapes in its `src/services/data/store.ts`):
- `calls` (teacher only reads): `{ callSid, from?, startedAt, endedAt?, durationSec?, transcript: [{role: caller|agent, text, ts}], toolCalls: [{name, args, result, ts}], status: active|completed, configVersion? }`. No turn numbers and no outcome label.
- `config_versions` (immutable, unique `version`; teacher adds versions): `{ version, companyName, greeting, context, author: manager|teacher|system, note?, createdAt }`. The teacher also writes `parentVersion` and `sourceCallSid`, which the bridge ignores.
- `config_state`: `{ _id: "active", version }`, the active pointer.

Owned by the teacher's side (string `_id`):
- `workspaces`: one document `{ _id: "default", timezone, business_hours: { sun..sat: ["HH:MM","HH:MM"] | null }, staff: [{ id, name, calendar_id }] }`. Calendar settings. Default time zone `America/Los_Angeles`. Created by `npm run calendar:setup <staff name> <calendar id>`.
- `calendar_bookings` (written by the gateway; named so because the bridge owns a different `appointments` collection): `{ _id: "<callSid>_apt<N>", call_id, staff_id, customer_name, customer_phone, customer_email?, service, start, end, status: awaiting_approval|booked|failed|rejected, event_id?, event_link?, error?, config_version_id, created_at }`. `start` and `end` are local times `YYYY-MM-DDTHH:MM` in the workspace time zone.
- `grades`: `{ _id = callSid, call_id, config_version_id: "v<N>"|null, outcome, scores{accuracy, tool_use, task_completion, tone, brevity}, overall, frustration, rationale, issues[{type, turn, quote, explanation}], tools_used[], tools_failed[], model, created_at }`
- `tool_proposals`: `_id` = tool name; `ToolProposal` in `types.ts` (name, description, params, write, why, mockup, status proposed|enabled|disabled|declined, requestCount, sourceCallSids, evidence, createdAt, updatedAt, enabledAt?, enabledBy? teacher|owner). Read by the bridge/dashboard.
- `improvements`: `{ _id: "<callSid>_imp<N>", source_call_ids[], type: prompt|context|tool|schema, status: proposed|applied|rejected|rolled_back, payload{op?, rule_id?, rule_kind?, text?, question?, answer?, tool?, permission?, from_permission?}, evidence_turns[], reason, rejected_reason?, held_reason?, rolled_back_reason?, applied_in_config_id?, created_at }`

How the teacher's model maps onto the bridge's documents (`bridge.ts`):
- **Rules live inside `context`.** The bridge's config has one free-text field and no place for rules, so rules are a marked block at the end of `context`:
  ```
  LEARNED RULES (added by the teaching agent after reviewing calls; follow every one):
  - (r1, guardrail, locked) ...
  - (r2, behavior) ...
  END OF LEARNED RULES
  ```
  The bridge already injects `context` into the system prompt and shows it in the dashboard editor, so rules reach the receptionist, survive manager edits, and work with the dashboard's history, diff and re-activate, with no change on the bridge side. Everything outside the block is the company's own text; the teacher never changes it. A manager can lock a rule by typing `, locked` after its kind.
- **Tool permissions also live inside `context`**, for the same reason, in a second block:
  ```
  BOOKING TOOLS (permission for each calendar tool, set by the teaching agent or the owner):
  - check_availability: auto
  - book_appointment: requires_approval
  auto = use the tool yourself. requires_approval = ... disabled = ...
  END OF BOOKING TOOLS
  ```
  In the teacher's view this is `ConfigVersionDoc.tools: Record<ToolName, "disabled" | "requires_approval" | "auto">`, with `ToolName = "check_availability" | "book_appointment"`. A config with no block has every tool `disabled`, and the block is not written while every tool is disabled, so a business without a calendar never sees it. The demo seed v1 has `check_availability: auto`, `book_appointment: requires_approval`.
- **Staff names** reach the voice agent through the tool descriptions from `toolDeclarations(workspace)`, not through the config.
- **Turn numbers** are the transcript index plus one.
- **Outcome** is derived from tool results only: `booked` if `book_appointment` returned `booked: true`, else `message_taken` if `take_message` returned `saved: true`, else `failed` if any tool returned `error`, else `answered`. A refusal with a `reason` (for example `slot_taken`) is not an error.
- **Config ids** inside the teacher are `"v<N>"`. `parent_id` comes from `parentVersion`, so only versions the teacher wrote have a parent.
- **"Graded"** means a `grades` document exists for the callSid. The teacher never writes to `calls`.
- There is no workspace: one database is one business.

## 4. Required behavior

### 4.1 `teach(callSid, judge = geminiJudge)`
1. Load the call. Throw if missing or still `active`.
2. Idempotent: if a grade with `_id = callSid` exists, return it with `alreadyGraded: true` and change nothing.
3. Load the ACTIVE config (not the one the call used), so concurrent calls never overwrite each other's rule changes.
4. Call the judge once. Every call gets the full teaching pass, whatever its outcome. The outcome label is only an input to grading.
5. `buildPlan(...)`, then write the grade.
6. Automatic rollback check (section 4.4). If it fires, the plan is built on the parent config so the rolled-back rules are not carried forward. The judge is not called again.
7. Insert the new config version if any (next free version number, retried if the manager saved one at the same moment), write all improvements (including rejected ones, for the audit trail), and move the active pointer.
8. Return `{ grade, improvements, newConfig, alreadyGraded, rolledBack }`. `rolledBack` is `{ from, to, reason }` or null.

### 4.2 Judge (`judge.ts`)
- One Gemini call, `temperature 0.1`, `responseMimeType: "application/json"`, parsed with zod. A bad reply gets one retry after 3 seconds. An overloaded model (503) is retried up to 3 more times with a growing wait. A quota error (429) throws at once.
- The judge input includes the current tool permissions. A booking made before the caller confirmed the date and time in the transcript, or with a different date or time, caps tool_use at 3.
- Scores 0 to 10: accuracy, tool_use, task_completion, tone, brevity. Frustration 0 to 10, estimated from transcript text only (no audio).
- A statement is accurate if the company text or a tool result supports it. Any invented price, time, policy or availability caps accuracy at 3.
- At most 3 improvements. Zero is correct for a good call.

### 4.3 Guardrails (`plan.ts`), all enforced in code, never trusted to the model
- Overall score is computed in code: accuracy 0.35, task_completion 0.25, tool_use 0.15, tone 0.15, brevity 0.10, rounded to one decimal.
- An issue is kept only if its quote (normalized) is a substring of some transcript turn.
- An improvement is rejected unless `evidence_turns` is non-empty and every turn exists.
- `prompt` improvements (rule add / modify / remove) are auto-applied, subject to:
  - max 3 applied per call, max 20 rules total, max 300 characters per rule
  - rule text is collapsed to one line, so it cannot break out of the rules block
  - no near-duplicate of an existing rule (word-set Jaccard >= 0.75)
  - no number in the rule text that is absent from the current config (blocks smuggled prices and hours)
  - `locked` rules cannot be modified or removed
- `context` improvements are never auto-applied. They carry a `question` for the owner and stay `proposed`.
- `tool` and `schema` improvements stay `proposed` (shown, never executed; a `tool` improvement from a `tool_proposal` only mirrors the proposal in the timeline), except a **tool permission change**: a `tool` improvement that carries `{ tool, permission }`. It is applied only when all of these hold, otherwise it stays `proposed` with a `held_reason`:
  - evidence turns exist (as for every improvement; without them it is rejected), and the tool and permission are known values
  - a demotion (towards `disabled`) is always allowed, any number of levels
  - a promotion moves one level at a time and needs at least 3 graded calls (`LIMITS.promotionCleanCalls`) where that tool was used with no tool error and `tool_use >= 8`. The count is passed into `buildPlan` as `toolStats` so it stays pure; `index.ts` counts earlier grades since that tool's permission last changed, and `buildPlan` adds the call being graded if it qualifies
  - a disabled tool cannot be used, so it can never earn a promotion: only the owner can re-enable it (`npm run permission`)
- **Tool proposals** (`validateToolProposal`, `decideToolStatus`, `mergeToolProposal` in `plan.ts`, written by `saveToolProposal` in `index.ts`): at most one per call, only for a proven capability gap, never a built-in tool.
  Code checks: snake_case name 3-40 chars; max 6 params (snake_case, string|number|boolean, description 1-199 chars); description < 300; 2-8 dialogue turns (caller|agent|tool); exampleArgs keys are params; every evidence quote is in the transcript;
  no URLs, credentials, payments, card numbers. Rejections go on the `improvements` doc. Existing `disabled`/`declined` proposals are never touched. Auto-enable (status `enabled`, `enabledBy: "teacher"`) when `TEACHER_AUTO_ENABLE_TOOLS` != `0` and overall < `TOOL_GRADE_THRESHOLD` (default 7); otherwise `proposed` for the owner. Tools are declarative (save fields / list a caller's records), so the validation is the safety gate.
- **Recipes** (optional `recipe` on a tool proposal, stored with `recipeVerified`): `checkRecipeStatic` (shared `validateRecipe` + a boolean param `confirmed` passed through in every call to `schedule_appointment`, `set_order_type` or `create_order`) and `selfCheckRecipe` (runs the recipe on `exampleArgs` against a mock io; `teach` calls `verifyToolRecipe` first and passes the result to `buildPlan` as `extra.recipeCheck`). A recipe without a passing self-check is rejected. `describeRecipe` gives plain-English step lines for `printResult`.
  `src/services/teacher/recipe.ts` is a synced copy of `../src/services/tools/recipe.ts` (no imports, shared with the bridge). Do not edit it here; change the bridge copy and re-copy.
  Known limit: it only accepts snake_case call-arg names, so camelCase built-in args (`orderId`, `customerName`) cannot be passed yet; the judge prompt adapts (see `CAMEL_ARGS_OK` in `judge.ts`).
- **Owner questions** (`context` improvements): max 2 per call, under 160 characters, no repeat of an open or answered question (normalised equality or word Jaccard > 0.8, `extra.existingQuestions`); extra or repeated ones are stored as rejected with a reason. `answerOwnerQuestion` appends `Owner answer: <question> <answer>` (`ownerAnswerLine`).
- **The teacher can never add or change the company text.** Only `answerOwnerQuestion` can.
- The teacher cannot edit its own rubric, weights, or limits. They are constants in code.
- If at least one prompt change or permission change is applied, produce a new immutable config version (`author: "teacher"`, `parentVersion` set, a `note` naming the call). Otherwise `nextConfig` is null.

### 4.4 Other functions
- `answerOwnerQuestion(improvementId, answer)`: only for an open `context` improvement. Appends the question and answer as a line of company text, creates a new config version with `author: "manager"`, marks the improvement `applied`.
- `setToolPermission(tool, permission)` (`npm run permission <tool> <level>`): the owner sets a permission directly, as a new version with `author: "manager"`. Not subject to the clean-call rule.
- `rollback()`: sets the active pointer to the parent version, marks that version's improvements `rolled_back` with `rolled_back_reason: "manual rollback"`. Never deletes versions. Throws if the active version has no recorded parent; use the dashboard's history to activate another version instead.
- Automatic rollback (inside `teach`, decided by the pure function `regression` in `plan.ts`): when a graded call was handled by the active version, and that version was made by the teacher, compare the average `overall` of its last 2 graded calls (`LIMITS.rollbackWindow`) with the average of all graded calls on its parent. If lower, move the pointer to the parent and write the reason to `rolled_back_reason` on that version's improvements. No rollback with fewer than 2 calls on the version or no graded calls on the parent. Versions saved by the manager are never rolled back automatically.
- `scoreTrend()`: grades oldest first, for the dashboard timeline.
- `watch()`: teaches every `completed` call that has a transcript and no grade, oldest first. A call that fails 3 times is skipped until restart.

### 4.5 Calendar gateway (`gateway.ts`)
- `runTool(callSid, tool, args, deps?)` never throws. It returns the call in the tool trace shape `{ name, args, result, error? }`; the bridge sends `result` to Gemini and records the call so the teacher sees it. `result.ok` is always present. `result.reason` is a refusal; `result.error` is a failure.
- Order of checks: args (zod) -> permission from the ACTIVE config -> workspace and staff -> time (`checkSlot`: parseable, not in the past, inside that day's business hours). A refusal at any step calls nothing.
- `disabled` -> `{ ok: false, reason: "tool_disabled" }`.
- `check_availability` runs only on `auto` (there is nothing for an owner to approve) and returns `{ ok, free, busy, next_free? }` for the named staff member.
- `book_appointment` requires `caller_confirmed: true`, else `{ ok: false, reason: "not_confirmed" }`. That flag is the agent's own statement; the teacher checks it against the transcript afterwards and demotes the tool if it was false.
  - `requires_approval` -> saves the appointment as `awaiting_approval`, returns `{ ok: true, queued: true }`. No calendar call.
  - `auto` -> checks availability again, creates the event, saves the appointment as `booked`, returns the confirmation and `event_link`.
- A taken slot returns `{ ok: false, reason: "slot_taken", next_free: [...] }` with up to 3 free start times that day on a 30-minute grid.
- An API failure is saved on the appointment as `status: "failed"` with the `error`, and returned as `{ ok: false, error }`. Nothing is reported as booked without an event id.
- `approveAppointment(id)` checks the time and the slot again before creating the event. `rejectAppointment(id)` marks it `rejected`.
- `toolDeclarations(workspace)` returns the Gemini function declarations for the bridge to register.
- `deps` lets tests pass a fake calendar and a fixed clock. The default is the real Google module.

Bridge wiring (not done, the bridge is Aayush's code): register `toolDeclarations(await getWorkspace())` next to its own tools, and in `executeTool` route the two names to `runTool`. The bridge is CommonJS and this package is ESM; loading the gateway with a dynamic `import()` under `tsx` was tested and works. The bridge's `tsc` build would not include it.

### 4.6 Bridge integration
No code change is needed on the bridge. Both sides point at the same Atlas database (`MONGODB_URI`, `MONGODB_DB`), the bridge runs as usual, and the teacher runs next to it:
```
npm run watch
```
The bridge must run with `MONGODB_URI` set (its default is an in-memory store the teacher cannot see). It already records `configVersion` on each call, which automatic rollback depends on.

## 5. Expected demo result (`npm run demo`)

- `fake_call_1` (agent invents a walk-in policy and a balayage price): accuracy <= 3, low overall, a new rule about unknown facts, and an owner question about walk-ins and/or balayage price.
- `fake_call_2` (caller wants to reschedule, agent loops, caller asks for a person): low task_completion, frustration >= 6, a behavior rule about offering a message or handoff, possibly a `tool` proposal for rescheduling.
- `fake_call_3` (clean call, message taken): overall >= 8, zero or near-zero changes.
- `fake_call_4` (caller books with Maya, agent confirms the time first): the tool result comes from the real gateway, `queued: true`; the appointment shows `awaiting_approval`; then `approveAppointment` calls Google. Without Google credentials the approval is recorded as `failed` with the configuration error, which is the correct behavior.
- Final printed business context contains the new rules, the BOOKING TOOLS block, and no new facts.
- No automatic rollback: all three fake calls were handled by v1.

If the output differs from this, fix the rubric prompt in `judge.ts` first, not the guardrails.

## 6. Not built yet (in priority order)

0. Calendar, remaining: wiring `runTool` and `toolDeclarations` into the bridge; an owner screen or endpoint for `approve` / `reject` (command line only today); counting queued-but-unapproved requests as busy, so two callers cannot queue the same slot (the second one fails at approval today).
1. Dashboard: the bridge's dashboard has an empty Improvements tab. It needs `GET /api/trend`, `GET /api/improvements`, `POST /api/answer`, `POST /api/rollback` reading the `grades` and `improvements` collections. This belongs in the bridge's `src/routes/api.ts` and `web/index.html`.
2. Owner notification (SMS) for open `context` questions, and applying the reply through `answerOwnerQuestion`.
3. Stretch: embed rules with Voyage AI and use Atlas Vector Search for duplicate detection instead of Jaccard.
4. Stretch: eval gate that replays frozen calls against a candidate config before promotion.

## 7. Rules for changing this code

- After every change run `npm run typecheck` and `npm run selftest`. Both must pass.
- Do not weaken a guardrail in section 4.3 to make a demo look better. Add a test to `scripts/selftest.ts` for any new guardrail.
- Keep `plan.ts`, `bridge.ts` and `time.ts` pure (no database, no network) so they stay testable offline.
- Keep the model call inside `geminiJudge` so the model can be swapped in one place.
- Config versions are immutable: always insert a new one, never update in place.
- Never hardcode scores or improvements. If the judge fails, surface the error.
- Verified on 2026-10-11: `npm run demo` with the live Gemini judge (`gemini-3.8-flash`; `gemini-2.5-flash` is closed to new API keys) on a temporary local MongoDB, matching section 5; and the full flow (teach, automatic and manual rollback, owner answer, watch) with a stub judge against the bridge's real `store.ts`, `recorder.ts` and `systemPrompt.ts` on a temporary local MongoDB.
- Calendar, verified on 2026-10-11: the gateway and permission flow with a fake calendar on a temporary local MongoDB (queue, approve, reject, auto booking, slot taken, API failure, disabled, demotion, held promotion, rollback of a permission change); the demo's booking call with the real gateway and a real Gemini judge (`gemini-3.1-flash-lite`).
- Calendar, verified against the **live Google Calendar API** on 2026-10-11 (gateway on a temporary local MongoDB, test events deleted afterwards): `npm run calendar:check`; freebusy by calendar id and by `primary`; queue then approve creates the event with the right start time and time zone; the booked slot then reads busy and `next_free` is offered; a second request for the same slot fails at approval with `slot_taken`; `auto` books directly and adds the attendee; an unknown calendar id comes back as an error.
- Not verified: anything against the real Atlas cluster; a real phone call end to end; whether Google actually emails the invite to an outside attendee (the test attendee was the calendar's own account); `npm run demo` with Google credentials present (its approval step uses the same code path that was tested live).
