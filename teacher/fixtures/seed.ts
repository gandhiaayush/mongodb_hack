// Demo data in the bridge's document shapes. Only ever written to a database whose name ends in "_demo".
import { renderContext } from "../src/services/mongo/bridge.js";
import type { BridgeCall, BridgeConfig } from "../src/services/mongo/types.js";

export const demoConfig: BridgeConfig = {
  version: 1,
  companyName: "Luna Hair Studio",
  greeting: "Hi, this is Luna Hair Studio.",
  context: renderContext({
    context: [
      "Opening hours: Tuesday to Saturday, 9 AM to 6 PM. Closed Sunday and Monday.",
      "Prices: women's cut $65, men's cut $40.",
      "Location: 214 Valencia Street, San Francisco.",
    ].join("\n"),
    rules: [
      { id: "r1", kind: "guardrail", locked: true, text: "Only state facts that appear in the business information." },
      { id: "r2", kind: "behavior", text: "If the caller asks for a person, offer to take a message." },
    ],
  }),
  author: "system",
  note: "Demo seed",
  createdAt: new Date().toISOString(),
};

const call = (callSid: string, lines: [("caller" | "agent"), string][],
  toolCalls: Pick<BridgeCall["toolCalls"][number], "name" | "args" | "result">[] = []): BridgeCall => {
  const ts = new Date().toISOString();
  return {
    callSid, from: "+14155550134", startedAt: ts, endedAt: ts, durationSec: 40,
    transcript: lines.map(([role, text]) => ({ role, text, ts })),
    toolCalls: toolCalls.map((t) => ({ ...t, ts })),
    status: "completed", configVersion: demoConfig.version,
  };
};

export const demoCalls: BridgeCall[] = [
  // 1. Invented facts + missed question -> should score low and produce a guardrail + owner question.
  call("fake_call_1", [
    ["caller", "Hi, do you take walk-ins?"],
    ["agent", "Yes, walk-ins are welcome any time!"],
    ["caller", "Great. And how much is a balayage?"],
    ["agent", "A balayage is $120."],
    ["caller", "Okay, thanks."],
  ]),
  // 2. Frustrated caller, agent loops and never offers a message.
  call("fake_call_2", [
    ["caller", "I need to move my appointment on Thursday."],
    ["agent", "I can tell you our opening hours. We are open Tuesday to Saturday, 9 AM to 6 PM."],
    ["caller", "No, I need to reschedule. Can you do that?"],
    ["agent", "We are open Tuesday to Saturday, 9 AM to 6 PM. Is there anything else?"],
    ["caller", "This isn't working. Can I talk to a person?"],
    ["agent", "I am sorry, I cannot help with that. Goodbye."],
  ]),
  // 3. Clean call -> should score high with few or no changes.
  call("fake_call_3", [
    ["caller", "Hi, what time do you close on Saturday?"],
    ["agent", "We close at 6 PM on Saturday."],
    ["caller", "Can you ask Maya to call me back about color? It's Priya, 415-555-0134."],
    ["agent", "Of course. I have a message for Maya from Priya at 415-555-0134 about color. She will call you back."],
    ["caller", "Perfect, thanks."],
  ], [{
    name: "take_message", args: { name: "Priya", phone: "415-555-0134", message: "Call back about color, for Maya" },
    result: { saved: true, message: { name: "Priya", phone: "+14155550134", message: "Call back about color, for Maya" } },
  }]),
  // 4. Dry cleaner: capability gap. The caller wants delivery instructions saved, no tool exists, the agent only takes a message.
  //    (The demo config above is still the salon's; the transcript names the dry cleaner. Should produce a tool proposal.)
  call("fake_call_4", [
    ["caller", "Hi, this is Dana. You're delivering my suits on Thursday and I won't be home."],
    ["agent", "Hi Dana, thanks for calling CJ's Cleaning Company. How can I help?"],
    ["caller", "Can you save my gate code for deliveries? It's 4471, and the driver should leave the bag with the doorman."],
    ["agent", "I'm sorry, I can't save delivery instructions on your account. I can take a message for the team instead."],
    ["caller", "Okay, please do that."],
    ["agent", "Done. I've left a message with your gate code and the doorman note for the team. Anything else?"],
    ["caller", "No, that's all. Thank you!"],
    ["agent", "You're welcome, Dana. Have a great day!"],
  ], [{
    name: "take_message", args: { name: "Dana", phone: "415-555-0134", message: "Delivery Thursday: gate code 4471, leave the bag with the doorman" },
    result: { saved: true, message: { name: "Dana", phone: "+14155550134", message: "Delivery Thursday: gate code 4471, leave the bag with the doorman" } },
  }]),
  // 5. Dry cleaner: the caller wants to rush an order AND book a pickup in one go. The agent cannot do both in one step,
  //    asks for the phone number twice (frustration) and does not know the price of a hem. Should give an owner question
  //    about hemming prices and a tool proposal with a recipe (rush + pickup booking).
  call("fake_call_5", [
    ["caller", "Hi, it's Marcus. I need to rush order ORD-0042 and also book a pickup for it."],
    ["agent", "Hi Marcus. Sure, can I get your phone number first?"],
    ["caller", "It's 415-555-0188. Can you rush the order and book the pickup for when it's ready?"],
    ["agent", "I can look at the order, but I can only do one thing at a time. What is your phone number?"],
    ["caller", "I just gave it to you, 415-555-0188. Why do I have to repeat myself?"],
    ["agent", "I'm sorry about that. I can mark the order as rush, but I can't book the pickup in the same step."],
    ["caller", "Fine. Also, how much to hem a pair of pants?"],
    ["agent", "I don't have the price for hemming on file. I can take a message for the team."],
    ["caller", "Yes, please. Tell them to rush ORD-0042, pick it up when ready, and call me with the hem price."],
    ["agent", "Done. I've left a message for the team about the rush, the pickup and the hem price."],
  ], [{
    name: "take_message", args: { name: "Marcus", phone: "415-555-0188", message: "Rush ORD-0042, book pickup when ready, call with the price to hem pants" },
    result: { saved: true, message: { name: "Marcus", phone: "+14155550188", message: "Rush ORD-0042, book pickup when ready, call with the price to hem pants" } },
  }]),
];
