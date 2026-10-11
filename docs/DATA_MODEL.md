# Data model and voice tools (MongoDB Atlas)

Database `snoopy` by default (`MONGODB_DB`). Without `MONGODB_URI` the same shapes run in memory.
The dashboard's Data tab shows live counts and a sample document per collection (`GET /api/atlas`).

## Principles
- **One document per real-world thing, history embedded.** An order carries its garments (`items[]`) and `stageHistory[]`, so a call answers any status question with one read. Things that grow without bound (calls, grades) are their own collections.
- **Reference by stable business keys, not ObjectIds:** customers by normalized phone, orders by `ORD-nnnn`, calls by Twilio `callSid`. These are what a caller says, so tools never need a join.
- **Config is immutable and versioned.** `config_versions` rows are never edited; `config_state` points at the live one. Rollback is a pointer move.
- **Each collection has one writer:** the bridge (shop data and calls), the owner (hours, tool decisions, answers), or the teacher (grades, improvements, tool requests). The teacher can never enable a tool or change business facts.

## Collections
| Collection | Key | Shape (essentials) | Indexes |
|---|---|---|---|
| `customers` | `phone` | `name`, `email?`, `preferences {starch, hangers, notes}`, `orderCount`, `lastOrderId` | `phone` unique |
| `orders` | `orderId` | `customerName`, `phone`, `garment` (summary), `items[{item, quantity, unitPrice, lineTotal, notes}]`, `stage`, `stageHistory[{stage, at}]`, `orderType` (Regular/Expedited), `price`, `payment`, `notes`, `expectedDate`, `createdAt`, `source` | `orderId` unique; `phone + createdAt` |
| `pricing` | `item` | `category`, `regularPrice`, `expeditedPrice`, `aliases[]`, `turnaroundDays {regular, expedited}`, `notes` | `item` unique |
| `store_hours` | `_id: "main"` | `timezone`, `address`, `phone`, `weekly[{day, open, close, closed}]`, `exceptions[{date, closed, reason}]` | none needed |
| `appointments` | `appointmentId` | `type` pickup/delivery, `orderId`, `phone`, `date`, `window` morning/afternoon/evening, `address?`, `status` | `orderId + status`; `date + window` |
| `claims` | `claimId` | reserved for the `create_claim` tool once approved: `orderId`, `type`, `description`, `status`, `callSid` | `status + createdAt` |
| `messages` | | `name`, `phone`, `message`, `createdAt` | |
| `calls` | `callSid` | transcript, `toolCalls`, `configVersion`, timing, status | `callSid` unique; `startedAt` |
| `config_versions`, `config_state` | `version`, `_id: "active"` | company name, greeting, context text, author (manager/teacher/system) | `version` unique |
| `grades`, `improvements`, `tool_requests` | callSid / `<callSid>_impN` / tool name | see `teacher/src/services/mongo/types.ts` | `status`, `request_count` |

Orders created before this change only have the flat fields; `items` and `stageHistory` are optional.

## Voice agent tools
Built in (`src/services/gemini/tools.ts`):
| Tool | Reads/writes | What it does |
|---|---|---|
| `get_order`, `lookup_price`, `list_prices` | read | Order status; price for one item (names and aliases); full list |
| `get_hours` | read | Open now / hours for a date / next open day / address. Computed from `store_hours` in the shop's timezone |
| `quote_estimate` | read | Several garments, speed, total and ready date; unknown items are returned in `notFound` |
| `check_turnaround` | read | Business days and ready date for a garment and speed, skipping closed days |
| `get_customer` | read | Name, preferences, recent orders, balance due |
| `create_order` | **write** | Intake for a drop-off. Prices every item server-side (the model never supplies a price); fails if any item is unknown; assigns `ORD-nnnn`; upserts the customer |
| `schedule_pickup` | **write** | Pickup or delivery for an existing order on an open day; delivery needs an address; one booking per order and type |
| `add_order_note`, `take_message` | **write** | Special handling; staff callback |

Safety rules in code, not in the prompt: the model cannot set prices or totals, cannot book on closed or past days, and cannot double-book. The prompt requires a read-back and a "yes" before `create_order`.

Not built in on purpose (the teacher asks, the owner decides): `reschedule_pickup`, `create_claim`, `send_payment_link`, `send_ready_text`. See `teacher/README.md#tool-requests`.

## Atlas features worth using next
- **Atlas Search** on `pricing.item + aliases` for fuzzy garment matching ("blaser" -> "Suit jacket").
- **Change streams** on `calls` (`status` -> completed) so the teacher grades instantly instead of polling.
- **Vector Search** over FAQs/policies if the business info outgrows the prompt.
- **TTL index** on `calls.transcript` if recordings must expire.
