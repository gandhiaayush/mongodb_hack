import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type LiveServerMessage,
} from "@google/genai";
import { createDataStore, type ConfigVersion, type DataStore, type ToolProposal } from "../data/store";
import type { CallRecorder } from "../calls/recorder";
import { TOOLS, executeTool, executeCustomTool, buildCustomToolDeclarations, BUILTIN_TOOL_NAMES } from "./tools";
import { buildSystemPrompt, type CallerProfile } from "./systemPrompt";
import { twilioToGemini, createGeminiToTwilio } from "../audio/converter";

export const MODEL = "gemini-3.1-flash-live-preview";

let storePromise: Promise<DataStore> | null = null;
export function getStore(): Promise<DataStore> {
  storePromise ??= createDataStore().catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

export interface GeminiSessionOptions {
  /** Called when the caller talks over the agent, so queued speech can be flushed */
  onInterrupted?: () => void;
  callerPhone?: string;
  callSid?: string;
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
  const { onAudio, onError, onClose, onInterrupted, callerPhone, callSid, recorder } = opts;
  const t0 = Date.now();
  const store = await getStore();

  // Config, profile and orders are independent MongoDB reads: fetch them together, not one after another
  const [activeConfig, enabledTools, profile] = await Promise.all([
    store.getActiveConfig() as Promise<ConfigVersion>,
    store.listEnabledTools().catch((err): ToolProposal[] => {
      console.error("[tools] could not load custom tools, continuing without them:", err);
      return [];
    }),
    callerPhone
      ? Promise.all([store.getCustomerByPhone(callerPhone), store.getOrdersByPhone(callerPhone)])
          .then(([customer, orders]): CallerProfile => {
            console.log(
              `[profile] ${callerPhone}: ${customer?.name ?? "unknown caller"}, ${orders.length} order(s), ${customer?.callCount ?? 0} previous call(s)`
            );
            return { customer, orders };
          })
          .catch((err): undefined => {
            console.error("[profile] lookup failed, continuing without it:", err);
            return undefined;
          })
      : Promise.resolve(undefined),
  ]);
  recorder?.setConfigVersion(activeConfig.version);
  const customDecls = buildCustomToolDeclarations(enabledTools);
  const customSpecs = new Map(enabledTools.filter((s) => customDecls.some((d) => d.name === s.name)).map((s) => [s.name, s]));
  if (customSpecs.size) console.log(`[tools] ${customSpecs.size} custom tool(s) enabled: ${[...customSpecs.keys()].join(", ")}`);
  // The call counter is bookkeeping: do not make the caller wait for it
  if (callerPhone) void store.recordCustomerCall(callerPhone).catch((err) => console.error("[profile] call count failed:", err));
  const dbMs = Date.now() - t0;
  const toTwilio = createGeminiToTwilio();
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
      systemInstruction: { parts: [{ text: buildSystemPrompt(today, callerPhone, activeConfig, profile) }] },
      temperature: 0,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        languageCode: "en-US",
      },
      tools: [{ functionDeclarations: [...TOOLS, ...customDecls] }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          silenceDurationMs: Number(process.env.GEMINI_SILENCE_MS) || 500,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onmessage: (msg: LiveServerMessage) => {
        if (msg.data) {
          onAudio(toTwilio(msg.data));
        }
        if (msg.serverContent?.interrupted) onInterrupted?.();

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
                const custom = !BUILTIN_TOOL_NAMES.has(name) ? customSpecs.get(name) : undefined;
                const result = custom
                  ? await executeCustomTool(custom, args, store, { callerPhone, callSid })
                  : await executeTool(name, args, store, { callerPhone });
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
      onclose: (e?: { code?: number; reason?: string }) => {
        console.log(`[gemini] session closed code=${e?.code ?? "?"} reason=${e?.reason || "(none)"}`);
        onClose();
      },
    },
  });

  console.log(`[latency] MongoDB context loaded in ${dbMs}ms, Gemini session ready in ${Date.now() - t0}ms`);

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
