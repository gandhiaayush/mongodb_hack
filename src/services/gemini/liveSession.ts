import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type LiveServerMessage,
} from "@google/genai";
import { createDataStore, type ConfigVersion, type DataStore } from "../data/store";
import type { CallRecorder } from "../calls/recorder";
import { TOOLS, customDeclarations, executeCustomTool, executeTool, usableCustomTools } from "./tools";
import { buildSystemPrompt } from "./systemPrompt";
import { twilioToGemini, geminiToTwilio } from "../audio/converter";

const MODEL = "gemini-3.1-flash-live-preview";

let storePromise: Promise<DataStore> | null = null;
export function getStore(): Promise<DataStore> {
  storePromise ??= createDataStore().catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

export interface GeminiSessionOptions {
  callerPhone?: string;
  recorder?: CallRecorder;
  onAudio: (base64Mulaw: string) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface GeminiSessionHandle {
  sendAudio(base64Mulaw: string): void;
  close(): void;
  configVersion: number;
}

export async function openGeminiSession(opts: GeminiSessionOptions): Promise<GeminiSessionHandle> {
  const { onAudio, onError, onClose, callerPhone, recorder } = opts;
  const store = await getStore();
  const activeConfig: ConfigVersion = await store.getActiveConfig();
  recorder?.setConfigVersion(activeConfig.version);
  // Owner-enabled custom tools; a lookup failure must never block the call.
  const customTools = usableCustomTools(await store.getEnabledTools().catch((err) => {
    console.error("[tools] could not load custom tools:", err);
    return [];
  }));
  const customByName = new Map(customTools.map((t) => [t.name, t]));
  if (customTools.length) console.log(`[tools] custom tools enabled: ${customTools.map((t) => t.name).join(", ")}`);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let liveSession!: Awaited<ReturnType<typeof ai.live.connect>>;

  liveSession = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: buildSystemPrompt(today, callerPhone, activeConfig) }] },
      temperature: 0,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        languageCode: "en-US",
      },
      tools: [{ functionDeclarations: [...TOOLS, ...customDeclarations(customTools)] }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          silenceDurationMs: 700,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onmessage: (msg: LiveServerMessage) => {
        if (msg.data) {
          onAudio(geminiToTwilio(msg.data));
        }

        const inText = msg.serverContent?.inputTranscription?.text;
        if (inText) {
          console.log(`[caller] ${inText}`);
          recorder?.addTranscript("caller", inText);
        }
        const outText = msg.serverContent?.outputTranscription?.text;
        if (outText) {
          console.log(`[agent] ${outText}`);
          recorder?.addTranscript("agent", outText);
        }

        const functionCalls = msg.toolCall?.functionCalls;
        if (functionCalls?.length) {
          void (async () => {
            const responses = [];
            for (const fc of functionCalls) {
              const name = fc.name ?? "";
              const args = (fc.args as Record<string, unknown>) ?? {};
              try {
                const custom = customByName.get(name);
                const result = custom ? await executeCustomTool(custom, args) : await executeTool(name, args, store);
                const short = JSON.stringify(result).slice(0, 200);
                console.log(`[tool] ${name} ${JSON.stringify(args)} -> ${short}`);
                recorder?.addToolCall(name, args, result);
                responses.push({ id: fc.id, name, response: result });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.log(`[tool] ${name} ${JSON.stringify(args)} -> error: ${message}`);
                recorder?.addToolCall(name, args, { error: message });
                responses.push({ id: fc.id, name, response: { error: message } });
              }
            }
            liveSession.sendToolResponse({ functionResponses: responses });
          })();
        }
      },
      onerror: (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))),
      onclose: () => onClose(),
    },
  });

  liveSession.sendRealtimeInput({
    text: `Say exactly: "${activeConfig.greeting.replace(/"/g, "'")}" Then wait for the caller.`,
  });

  return {
    configVersion: activeConfig.version,
    sendAudio: (base64Mulaw: string) => {
      liveSession.sendRealtimeInput({
        audio: { data: twilioToGemini(base64Mulaw), mimeType: "audio/pcm;rate=16000" },
      });
    },
    close: () => {
      try {
        liveSession.close();
      } catch (_) {}
    },
  };
}
