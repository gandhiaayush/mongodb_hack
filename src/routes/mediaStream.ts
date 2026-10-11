import WebSocket from "ws";
import { openGeminiSession, getStore } from "../services/gemini/liveSession";
import { CallRecorder } from "../services/calls/recorder";

interface TwilioFrame {
  event: string;
  start?: { callSid: string; streamSid: string; customParameters?: { from?: string } };
  media?: { payload: string };
}

type GeminiHandle = Awaited<ReturnType<typeof openGeminiSession>>;

export function handleMediaStream(ws: WebSocket): void {
  let callSid: string | null = null;
  let streamSid: string | null = null;
  let gemini: GeminiHandle | null = null;
  let recorder: CallRecorder | null = null;
  let closed = false;
  // Caller audio that arrives while Gemini is still connecting (capped at ~10s of 20ms frames)
  const pending: string[] = [];
  const MAX_PENDING_FRAMES = 500;

  function teardown(): void {
    if (closed) return;
    closed = true;
    const handle = gemini;
    gemini = null;
    handle?.close();
    void recorder?.end();
  }

  ws.on("message", async (raw: WebSocket.RawData) => {
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (frame.event) {
      case "start": {
        if (!frame.start) return;
        callSid = frame.start.callSid;
        streamSid = frame.start.streamSid;
        console.log(`[${callSid}] media stream started`);

        const callerPhone = frame.start.customParameters?.from;
        const startedRecorder = await getStore()
          .then((store) => new CallRecorder(store, callSid!, callerPhone))
          .catch((err) => {
            console.error(`[${callSid}] Call recording unavailable:`, err);
            return null;
          });
        if (startedRecorder) {
          recorder = startedRecorder;
          if (closed) void startedRecorder.end();
          else void startedRecorder.start().catch((err) => console.error(`[${callSid}] recorder start failed:`, err));
        }

        const handle = await openGeminiSession({
          callerPhone,
          callSid: callSid ?? undefined,
          recorder: recorder ?? undefined,
          onAudio: (base64Mulaw: string) => {
            if (ws.readyState === WebSocket.OPEN && streamSid) {
              ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mulaw } }));
            }
          },
          onInterrupted: () => {
            // Caller spoke over the agent: tell Twilio to drop any audio it has queued
            if (ws.readyState === WebSocket.OPEN && streamSid) {
              ws.send(JSON.stringify({ event: "clear", streamSid }));
            }
          },
          onError: (err) => {
            console.error(`[${callSid}] Gemini error:`, err);
            ws.close();
          },
          onClose: () => ws.close(),
        }).catch((err) => {
          console.error(`[${callSid}] Failed to open Gemini session:`, err);
          ws.close();
          return null;
        });

        if (!handle) return;
        if (closed) {
          handle.close();
          return;
        }
        gemini = handle;
        for (const payload of pending.splice(0)) handle.sendAudio(payload);
        return;
      }

      case "media":
        if (!frame.media) return;
        if (gemini) gemini.sendAudio(frame.media.payload);
        else if (pending.length < MAX_PENDING_FRAMES) pending.push(frame.media.payload);
        return;

      case "stop":
        console.log(`[${callSid}] media stream stopped`);
        teardown();
        ws.close();
        return;

      default:
        // "connected", "mark" and "clear" need no action
        return;
    }
  });

  ws.on("close", () => teardown());

  ws.on("error", (err) => {
    console.error("MediaStream WS error:", err.message);
    teardown();
  });
}
