# Snoopy teacher agent

Grades every finished receptionist call and rewrites the receptionist's harness (rules) in MongoDB Atlas.
Built during the Harness Engineering & Model Wrangling hackathon, 2026-10-11.
Team status, data shapes for the dashboard, and known issues: [../docs/TEAM_HANDOFF.md](../docs/TEAM_HANDOFF.md).

## Run
```
cd teacher && npm install
# create .env (see below), never commit it
npm run selftest          # offline, no keys needed
npm run demo              # seeds the snoopy_demo database, teaches 3 fake calls, prints the new context
```
`.env` in this `teacher/` folder:
```
MONGODB_URI=mongodb+srv://USER:PASSWORD@YOUR-SANDBOX-CLUSTER.mongodb.net
MONGODB_DB=snoopy
GEMINI_API_KEY=
GEMINI_TEACHER_MODEL=gemini-3.8-flash
```

Other commands: `npm run teach <callId>`, `npm run answer <improvementId> <answer>`,
`npm run rollback`, `npm run trend`, `npm run context`, `npm run watch`.

## Running with the voice bridge
No code change is needed in the bridge (the repo root). Point both at the same
Atlas database (`MONGODB_URI`, `MONGODB_DB`), start the bridge as usual, and run the teacher next to it:
```
npm run watch
```
It grades every finished call that has no grade yet and writes new config versions in the bridge's own format
(author `teacher`), so they show up in the bridge's dashboard history and are loaded on the next call.
The teacher keeps its rules in a `LEARNED RULES` block at the end of the config's context text.

`npm run demo` and `npm run seed` only ever touch the separate database `snoopy_demo`.

## Safety limits (src/services/teacher/plan.ts)
- The rubric lives in code; the teacher cannot edit it. Overall score is computed in code.
- Every issue needs an exact transcript quote; every change needs evidence turns.
- The teacher changes behavior rules only. It can never change the company's own text: missing facts become owner questions.
- A rule containing a number that is not already in the config is rejected.
- At most 3 rule changes per call, 20 rules total, locked rules cannot be touched.
- Config versions are immutable; rollback is one pointer change.

## Tool requests

The teacher can ask for a new tool but never creates one. When a caller needs something no tool can do, the judge
proposes a structured tool (name, description, typed parameters, read/write). It is validated in code (snake_case name,
not a built-in, at most 6 parameters) and stored in `tool_requests` with status `requested`. Repeat asks from other calls
raise `request_count`, which orders the owner's build list.

```
npm run tools [status]                       # list requests, most asked first
npm run tools -- ... or: tsx scripts/cli.ts tool-approve <name>      # worth building
tsx scripts/cli.ts tool-decline <name> [note]
tsx scripts/cli.ts tool-enable <name> <https-endpoint>   # owner built it; live on the next call
tsx scripts/cli.ts tool-disable <name>
```

Only an owner action can enable a tool and set its `endpoint`. The bridge (`src/services/gemini/tools.ts`) loads enabled
tools at call start, declares them to Gemini Live, and POSTs `{ tool, args }` to the endpoint (5 s timeout, declared
arguments only, optional `x-tool-secret` from `CUSTOM_TOOL_SECRET`). Until then the receptionist keeps its fallback
(take a message). Model: set `GEMINI_TEACHER_MODEL` to change the grader.

## Simulated learning journey

`npm run simulate` runs 90 scripted calls through the real guardrails (`buildPlan`, tool validation, the rollback test) with a
scripted judge, and writes `teacher/demo/journey.json` and `docs/teacher-journey.html` (open it in a browser: a map of how the teacher
works, plus a call-by-call replay of what the receptionist is bad at and when each fix landed). It is a simulation: the callers and the
judge are scripted, so it shows the loop's mechanics, not real grading quality. It also compares the rollback test as written (last 2
calls) with a stricter proposal (5 calls and a 0.8 margin); see the findings at the bottom of the page.
