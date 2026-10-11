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
- Where this spec and the bridge's `docs/PLAN.md` disagree, this spec wins for the teacher: the judge is Gemini (not Claude), every call gets the full teaching pass (not only successful ones), and the teacher never writes business facts (PLAN auto-applied `context` changes).

## 2. Files

| File | Purpose |
|---|---|
| `src/services/mongo/types.ts` | `Bridge*` shapes (the bridge's documents, copied from its `store.ts`) and the teacher's own shapes. Do not change a `Bridge*` shape without telling the partner. |
| `src/services/mongo/bridge.ts` | Pure conversion between the two: `toCall`, `toConfig`, `fromConfig`, `splitContext`, `renderContext`, `deriveOutcome`. No database. |
| `src/services/mongo/client.ts` | `getDb`, `cols`, `closeDb`, `getActiveConfig()`, `getConfig(version)` |
| `src/services/teacher/judge.ts` | Rubric prompt, `JudgeOutput` zod schema, `geminiJudge` (the only model call), `buildJudgeInput` |
| `src/services/teacher/plan.ts` | Pure functions `buildPlan` (validation and guardrails) and `regression` (automatic rollback test). No database, no model. |
| `src/services/teacher/index.ts` | `teach`, `answerOwnerQuestion`, `rollback`, `scoreTrend`, `watch`, `printResult`, `activeContext` |
| `fixtures/seed.ts` | Demo data in the bridge's shapes: a salon config v1 and fake calls 1-5 (4 and 5 are dry cleaner calls; 5 asks for a rush plus pickup and a hem price) |
| `scripts/cli.ts` | `seed`, `demo`, `teach`, `answer`, `rollback`, `trend`, `context`, `watch` |
| `scripts/selftest.ts` | Offline assertions for `buildPlan`, `regression` and the bridge conversion. Must keep passing. |

Commands: `npm run tools` (list tool proposals), `npm run typecheck`, `npm run selftest`, `npm run demo`, `npm run watch`.
Environment: `MONGODB_URI`, `MONGODB_DB` (default `snoopy`, must be the same database the bridge uses), `GEMINI_API_KEY`, `GEMINI_TEACHER_MODEL` (default `gemini-3.8-flash`).

`npm run seed` and `npm run demo` always use the database `snoopy_demo`, and `seed` refuses any database whose name does not end in `_demo`, because it wipes the collections. To run other commands on the demo data: `MONGODB_DB=snoopy_demo npm run answer ...`.

## 3. Collections

Owned by the bridge (shapes in its `src/services/data/store.ts`):
- `calls` (teacher only reads): `{ callSid, from?, startedAt, endedAt?, durationSec?, transcript: [{role: caller|agent, text, ts}], toolCalls: [{name, args, result, ts}], status: active|completed, configVersion? }`. No turn numbers and no outcome label.
- `config_versions` (immutable, unique `version`; teacher adds versions): `{ version, companyName, greeting, context, author: manager|teacher|system, note?, createdAt }`. The teacher also writes `parentVersion` and `sourceCallSid`, which the bridge ignores.
- `config_state`: `{ _id: "active", version }`, the active pointer.

Owned by the teacher (string `_id`):
- `grades`: `{ _id = callSid, call_id, config_version_id: "v<N>"|null, outcome, scores{accuracy, tool_use, task_completion, tone, brevity}, overall, frustration, rationale, issues[{type, turn, quote, explanation}], model, created_at }`
- `tool_proposals`: `_id` = tool name; `ToolProposal` in `types.ts` (name, description, params, write, why, mockup, status proposed|enabled|disabled|declined, requestCount, sourceCallSids, evidence, createdAt, updatedAt, enabledAt?, enabledBy? teacher|owner). Read by the bridge/dashboard.
- `improvements`: `{ _id: "<callSid>_imp<N>", source_call_ids[], type: prompt|context|tool|schema, status: proposed|applied|rejected|rolled_back, payload{op?, rule_id?, rule_kind?, text?, question?, answer?}, evidence_turns[], reason, rejected_reason?, rolled_back_reason?, applied_in_config_id?, created_at }`

How the teacher's model maps onto the bridge's documents (`bridge.ts`):
- **Rules live inside `context`.** The bridge's config has one free-text field and no place for rules, so rules are a marked block at the end of `context`:
  ```
  LEARNED RULES (added by the teaching agent after reviewing calls; follow every one):
  - (r1, guardrail, locked) ...
  - (r2, behavior) ...
  END OF LEARNED RULES
  ```
  The bridge already injects `context` into the system prompt and shows it in the dashboard editor, so rules reach the receptionist, survive manager edits, and work with the dashboard's history, diff and re-activate, with no change on the bridge side. Everything outside the block is the company's own text; the teacher never changes it. A manager can lock a rule by typing `, locked` after its kind.
- **Turn numbers** are the transcript index plus one.
- **Outcome** is derived from tool results only: `message_taken` if `take_message` returned `saved: true`, else `failed` if any tool returned `error`, else `answered`.
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
- One Gemini call, `temperature 0.1`, `responseMimeType: "application/json"`, parsed with zod, one retry after 3 seconds, then throw.
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
- `tool` and `schema` improvements stay `proposed` (shown, never executed). A `tool` improvement from a `tool_proposal` only mirrors the proposal in the timeline.
- **Tool proposals** (`validateToolProposal`, `decideToolStatus`, `mergeToolProposal` in `plan.ts`, written by `saveToolProposal` in `index.ts`): at most one per call, only for a proven capability gap, never a built-in tool.
  Code checks: snake_case name 3-40 chars; max 6 params (snake_case, string|number|boolean, description 1-199 chars); description < 300; 2-8 dialogue turns (caller|agent|tool); exampleArgs keys are params; every evidence quote is in the transcript;
  no URLs, credentials, payments, card numbers. Rejections go on the `improvements` doc. Existing `disabled`/`declined` proposals are never touched. Auto-enable (status `enabled`, `enabledBy: "teacher"`) when `TEACHER_AUTO_ENABLE_TOOLS` != `0` and overall < `TOOL_GRADE_THRESHOLD` (default 7); otherwise `proposed` for the owner. Tools are declarative (save fields / list a caller's records), so the validation is the safety gate.
- **Recipes** (optional `recipe` on a tool proposal, stored with `recipeVerified`): `checkRecipeStatic` (shared `validateRecipe` + a boolean param `confirmed` passed through in every call to `schedule_appointment`, `set_order_type` or `create_order`) and `selfCheckRecipe` (runs the recipe on `exampleArgs` against a mock io; `teach` calls `verifyToolRecipe` first and passes the result to `buildPlan` as `extra.recipeCheck`). A recipe without a passing self-check is rejected. `describeRecipe` gives plain-English step lines for `printResult`.
  `src/services/teacher/recipe.ts` is a synced copy of `../src/services/tools/recipe.ts` (no imports, shared with the bridge). Do not edit it here; change the bridge copy and re-copy.
  Known limit: it only accepts snake_case call-arg names, so camelCase built-in args (`orderId`, `customerName`) cannot be passed yet; the judge prompt adapts (see `CAMEL_ARGS_OK` in `judge.ts`).
- **Owner questions** (`context` improvements): max 2 per call, under 160 characters, no repeat of an open or answered question (normalised equality or word Jaccard > 0.8, `extra.existingQuestions`); extra or repeated ones are stored as rejected with a reason. `answerOwnerQuestion` appends `Owner answer: <question> <answer>` (`ownerAnswerLine`).
- **The teacher can never add or change the company text.** Only `answerOwnerQuestion` can.
- The teacher cannot edit its own rubric, weights, or limits. They are constants in code.
- If at least one prompt change is applied, produce a new immutable config version (`author: "teacher"`, `parentVersion` set, a `note` naming the call). Otherwise `nextConfig` is null.

### 4.4 Other functions
- `answerOwnerQuestion(improvementId, answer)`: only for an open `context` improvement. Appends the question and answer as a line of company text, creates a new config version with `author: "manager"`, marks the improvement `applied`.
- `rollback()`: sets the active pointer to the parent version, marks that version's improvements `rolled_back` with `rolled_back_reason: "manual rollback"`. Never deletes versions. Throws if the active version has no recorded parent; use the dashboard's history to activate another version instead.
- Automatic rollback (inside `teach`, decided by the pure function `regression` in `plan.ts`): when a graded call was handled by the active version, and that version was made by the teacher, compare the average `overall` of its last 2 graded calls (`LIMITS.rollbackWindow`) with the average of all graded calls on its parent. If lower, move the pointer to the parent and write the reason to `rolled_back_reason` on that version's improvements. No rollback with fewer than 2 calls on the version or no graded calls on the parent. Versions saved by the manager are never rolled back automatically.
- `scoreTrend()`: grades oldest first, for the dashboard timeline.
- `watch()`: teaches every `completed` call that has a transcript and no grade, oldest first. A call that fails 3 times is skipped until restart.

### 4.5 Bridge integration
No code change is needed on the bridge. Both sides point at the same Atlas database (`MONGODB_URI`, `MONGODB_DB`), the bridge runs as usual, and the teacher runs next to it:
```
npm run watch
```
The bridge must run with `MONGODB_URI` set (its default is an in-memory store the teacher cannot see). It already records `configVersion` on each call, which automatic rollback depends on.

## 5. Expected demo result (`npm run demo`)

- `fake_call_1` (agent invents a walk-in policy and a balayage price): accuracy <= 3, low overall, a new rule about unknown facts, and an owner question about walk-ins and/or balayage price.
- `fake_call_2` (caller wants to reschedule, agent loops, caller asks for a person): low task_completion, frustration >= 6, a behavior rule about offering a message or handoff, possibly a `tool` proposal for rescheduling.
- `fake_call_3` (clean call, message taken): overall >= 8, zero or near-zero changes.
- Final printed business context contains the new rules and no new facts.
- No automatic rollback: all three fake calls were handled by v1.

If the output differs from this, fix the rubric prompt in `judge.ts` first, not the guardrails.

## 6. Not built yet (in priority order)

1. Dashboard: the bridge's dashboard has an empty Improvements tab. It needs `GET /api/trend`, `GET /api/improvements`, `POST /api/answer`, `POST /api/rollback` reading the `grades` and `improvements` collections. This belongs in the bridge's `src/routes/api.ts` and `web/index.html`.
2. Owner notification (SMS) for open `context` questions, and applying the reply through `answerOwnerQuestion`.
3. Stretch: embed rules with Voyage AI and use Atlas Vector Search for duplicate detection instead of Jaccard.
4. Stretch: eval gate that replays frozen calls against a candidate config before promotion.

## 7. Rules for changing this code

- After every change run `npm run typecheck` and `npm run selftest`. Both must pass.
- Do not weaken a guardrail in section 4.3 to make a demo look better. Add a test to `scripts/selftest.ts` for any new guardrail.
- Keep `plan.ts` and `bridge.ts` pure (no database, no network) so they stay testable offline.
- Keep the model call inside `geminiJudge` so the model can be swapped in one place.
- Config versions are immutable: always insert a new one, never update in place.
- Never hardcode scores or improvements. If the judge fails, surface the error.
- Verified on 2026-10-11: `npm run demo` with the live Gemini judge (`gemini-3.8-flash`; `gemini-2.5-flash` is closed to new API keys) on a temporary local MongoDB, matching section 5; and the full flow (teach, automatic and manual rollback, owner answer, watch) with a stub judge against the bridge's real `store.ts`, `recorder.ts` and `systemPrompt.ts` on a temporary local MongoDB.
- Not verified: anything against the real Atlas cluster, and a real phone call end to end.
