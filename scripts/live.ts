// One-command local launch: ngrok tunnel -> PUBLIC_HOST -> Twilio webhook -> voice server.
import { spawn } from "child_process";
import { existsSync } from "fs";
import readline from "readline";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function waitForTunnel(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      const body = (await res.json()) as { tunnels?: { public_url: string }[] };
      const https = body.tunnels?.find((t) => t.public_url.startsWith("https://"));
      if (https) return https.public_url;
    } catch {
      // ngrok's local API is not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail("ngrok did not start. Is it installed and authenticated? (brew install ngrok; ngrok config add-authtoken <token>)");
}

async function pointTwilioAt(host: string): Promise<void> {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.log("! TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER not all set.");
    console.log(`  Set your number's voice webhook manually: POST https://${host}/voice`);
    return;
  }
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: TWILIO_PHONE_NUMBER, limit: 1 });
  if (numbers.length === 0) fail(`No Twilio number ${TWILIO_PHONE_NUMBER} found on this account.`);
  await client.incomingPhoneNumbers(numbers[0].sid).update({
    voiceUrl: `https://${host}/voice`,
    voiceMethod: "POST",
  });
  console.log(`✓ Twilio ${TWILIO_PHONE_NUMBER} now points at https://${host}/voice`);
}

// The teaching agent grades every finished call and can create new tools. It runs beside the server.
function startTeacher(): void {
  if (process.env.TEACHER === "off") return console.log("! Teacher disabled (TEACHER=off).");
  if (!process.env.MONGODB_URI) {
    return console.log("! Teacher not started: it reads calls from MongoDB, so set MONGODB_URI in .env.");
  }
  if (!existsSync("teacher/node_modules")) {
    return console.log("! Teacher not started: run `npm run setup` once to install it, then restart.");
  }
  const child = spawn("npm", ["--prefix", "teacher", "run", "watch"], {
    env: { ...process.env, MONGODB_DB: process.env.MONGODB_DB ?? "snoopy" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => console.log(`[teacher] ${line}`));
  }
  child.on("exit", (code) => console.log(`[teacher] stopped (exit ${code})`));
  process.on("exit", () => child.kill());
  console.log("✓ Teacher started: every finished call will be graded automatically.");
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) fail("GEMINI_API_KEY is not set in .env");

  const ngrok = spawn("ngrok", ["http", String(PORT), "--log=stdout"], { stdio: "ignore" });
  ngrok.on("error", () => fail("Could not run ngrok. Install it: brew install ngrok"));
  process.on("exit", () => ngrok.kill());
  process.on("SIGINT", () => process.exit(0));

  const url = await waitForTunnel();
  const host = new URL(url).host;
  process.env.PUBLIC_HOST = host;
  console.log(`✓ Tunnel up: ${url}`);

  await pointTwilioAt(host);

  // config.ts reads process.env at import time, so start the server only now
  await import("../src/server");
  startTeacher();
  console.log(`\n✓ Ready. Call ${process.env.TWILIO_PHONE_NUMBER ?? "your Twilio number"} from a verified phone.`);
  const dashboard = process.env.DASHBOARD_URL ?? "http://localhost:8080";
  console.log(`  Dashboard API:  ${url}${process.env.DASHBOARD_TOKEN ? "   (token: your DASHBOARD_TOKEN)" : ""}`);
  console.log(`  Open dashboard: ${dashboard}/?api=${url}\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
