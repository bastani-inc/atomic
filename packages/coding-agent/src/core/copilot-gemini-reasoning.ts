import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { maybeRepairCopilotAnthropicMessagesResponse } from "./copilot-anthropic-sse-repair.ts";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";

/**
 * Round-trips GitHub Copilot Gemini "thought signatures" so multi-turn tool use
 * does not silently die after the first tool call.
 *
 * Why this exists
 * ---------------
 * `github-copilot` Gemini models (e.g. `gemini-3.1-pro-preview`) are served
 * through Copilot's CAPI gateway, which proxies to Google's GenAI API. Gemini
 * is a thinking model: when it emits a function/tool call it also returns an
 * opaque **thought signature** that must be sent back, verbatim, on the next
 * request or Gemini refuses to continue the reasoning chain.
 *
 * CAPI carries that signature in a non-standard OpenAI-completions field named
 * **`reasoning_opaque`** (an encrypted blob) on the assistant message / streamed
 * delta, and on replay it reads the same `reasoning_opaque` back off the
 * assistant message and re-attaches the signature to each Gemini function-call
 * part (keyed by `tool_call.id`). The underlying OpenAI-completions client
 * (`@earendil-works/pi-ai`) does not understand `reasoning_opaque`; it captures
 * thought signatures only from the OpenRouter-style
 * `reasoning_details: [{ type: "reasoning.encrypted", id, data }]` shape, which
 * CAPI never emits. So the real Gemini thought signature was being dropped on
 * the way in and never replayed on the way out.
 *
 * With the signature missing, CAPI substitutes the sentinel
 * `skip_thought_signature_validator` on the first replayed function call, and
 * Gemini responds with an empty candidate / `finish_reason: "stop"` and zero
 * output tokens — the harness sees a degenerate empty completion, retries with
 * the same signature-less history, and eventually gives up: "Gemini just stops
 * responding."
 *
 * What this does
 * --------------
 * Two gated, self-contained transforms bridge CAPI's `reasoning_opaque` to the
 * `reasoning_details` mechanism the client already round-trips:
 *
 *  - **Inbound** ({@link rewriteCopilotGeminiSseData} via
 *    {@link createCopilotGeminiSseStream}): rewrites the CAPI Gemini SSE
 *    stream so each streamed delta that carries both `reasoning_opaque` and a
 *    `tool_calls[].id` gains a
 *    `reasoning_details: [{ type: "reasoning.encrypted", id, data: <opaque> }]`
 *    entry. The client then stores it as the tool call's `thoughtSignature`.
 *    CAPI confirms `reasoning_opaque` rides on the same streamed delta as the
 *    first (id-bearing) tool-call chunk, so the association is exact.
 *  - **Outbound** ({@link restoreCopilotGeminiReasoningOpaque} from the
 *    `onPayload` hook): converts the `reasoning_details` the client re-emits on
 *    replayed assistant messages back into a single `reasoning_opaque` field on
 *    that assistant message, which is the only shape CAPI reads.
 *
 * Both transforms are gated to GitHub Copilot Gemini and are no-ops for every
 * other provider/model (and for Gemini turns that carry no thought signature).
 */

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** OpenRouter-style encrypted reasoning detail the pi-ai client round-trips. */
const REASONING_ENCRYPTED_TYPE = "reasoning.encrypted";

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Inject `reasoning_details` into a parsed CAPI Gemini streaming chunk so the
 * pi-ai OpenAI-completions parser captures the Gemini thought signature.
 *
 * For each `choices[].delta` that carries a non-empty `reasoning_opaque` string
 * and a `tool_calls[]` entry with an `id`, adds a single
 * `reasoning_details: [{ type: "reasoning.encrypted", id, data: <opaque> }]`
 * entry keyed by that tool-call id. Returns whether the chunk was mutated.
 *
 * No-op when the delta already has `reasoning_details`, has no id-bearing tool
 * call (e.g. argument-continuation deltas or pure-text thought chunks), or has
 * no `reasoning_opaque`.
 */
export function injectCopilotGeminiReasoningDetails(chunk: JsonValue): boolean {
  if (!isPlainObject(chunk)) return false;
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return false;

  let mutated = false;
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    const delta = choice.delta;
    if (!isPlainObject(delta)) continue;

    const opaque = delta.reasoning_opaque;
    if (typeof opaque !== "string" || opaque.length === 0) continue;

    // Already carries the encrypted detail (don't double-inject / clobber).
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
      continue;
    }

    const toolCalls = delta.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    const idBearing = toolCalls.find(
      (call): call is JsonObject =>
        isPlainObject(call) && typeof call.id === "string" && call.id.length > 0,
    );
    if (!idBearing) continue;

    delta.reasoning_details = [
      { type: REASONING_ENCRYPTED_TYPE, id: idBearing.id as string, data: opaque },
    ];
    mutated = true;
  }
  return mutated;
}

/**
 * Rewrite the JSON payload of a single SSE `data:` line. Returns the original
 * string unchanged when it is not a Gemini chunk that needs a thought signature
 * bridged, or when parsing fails (fail-open: never corrupt the stream).
 */
export function rewriteCopilotGeminiSseData(dataPayload: string): string {
  // Cheap gate: only chunks that actually carry a thought signature are touched.
  if (!dataPayload.includes("reasoning_opaque")) return dataPayload;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(dataPayload) as JsonValue;
  } catch {
    return dataPayload;
  }
  if (!injectCopilotGeminiReasoningDetails(parsed)) return dataPayload;
  return JSON.stringify(parsed);
}

/** Rewrite one SSE line, preserving a trailing carriage return when present. */
function rewriteSseLine(line: string): string {
  const hasCr = line.endsWith("\r");
  const core = hasCr ? line.slice(0, -1) : line;
  if (!core.startsWith("data:")) return line;
  const payload = core.slice("data:".length).trimStart();
  if (payload.length === 0 || payload === "[DONE]") return line;
  const rewritten = rewriteCopilotGeminiSseData(payload);
  if (rewritten === payload) return line;
  const rebuilt = `data: ${rewritten}`;
  return hasCr ? `${rebuilt}\r` : rebuilt;
}

/**
 * Wrap a CAPI Gemini SSE byte stream so `reasoning_opaque` is bridged into
 * `reasoning_details`. Buffers across chunk boundaries and rewrites whole lines
 * only; bytes that are not affected pass through unchanged.
 *
 * Implemented as a `ReadableStream` over the source reader (rather than a
 * `TransformStream` piped via `pipeThrough`) so the transform pulls lazily and
 * propagates cancellation to the upstream body.
 */
export function createCopilotGeminiSseStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until we emit at least one chunk or close, so a read that yields no
      // complete line still makes progress without relying on the runtime to
      // re-invoke pull after a no-enqueue return.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(rewriteSseLine(buffer)));
            buffer = "";
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        let out = "";
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          out += `${rewriteSseLine(line)}\n`;
          newlineIndex = buffer.indexOf("\n");
        }
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Convert the `reasoning_details` the pi-ai client re-emits on replayed
 * assistant messages back into the single `reasoning_opaque` field CAPI reads.
 *
 * For GitHub Copilot Gemini payloads, each assistant message that carries a
 * `reasoning_details` entry of `type: "reasoning.encrypted"` has its `data`
 * (the original CAPI thought-signature blob) promoted to `reasoning_opaque`,
 * and the now-redundant `reasoning_details` removed. No-op for every other
 * provider/model and for payloads without such messages.
 */
export function restoreCopilotGeminiReasoningOpaque(
  payload: unknown,
  model: Pick<Model<Api>, "provider" | "api" | "id">,
): unknown {
  if (!isCopilotGeminiModel(model)) return payload;
  if (!isPlainObject(payload as JsonValue)) return payload;
  const payloadObject = payload as JsonObject;
  const messages = payloadObject.messages;
  if (!Array.isArray(messages)) return payload;

  let mutated = false;
  const nextMessages = messages.map((message) => {
    if (!isPlainObject(message) || message.role !== "assistant") return message;
    const details = message.reasoning_details;
    if (!Array.isArray(details) || details.length === 0) return message;
    const encrypted = details.find(
      (detail): detail is JsonObject =>
        isPlainObject(detail) &&
        detail.type === REASONING_ENCRYPTED_TYPE &&
        typeof detail.data === "string" &&
        detail.data.length > 0,
    );
    if (!encrypted) return message;
    mutated = true;
    const { reasoning_details: _omitted, ...rest } = message;
    return { ...rest, reasoning_opaque: encrypted.data as string };
  });

  if (!mutated) return payload;
  return { ...payloadObject, messages: nextMessages };
}

/** Whether the URL targets Copilot's CAPI gateway (`*.githubcopilot.com`). */
function isCopilotApiHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Exact host or a real subdomain only — never a look-alike suffix such as
    // `notgithubcopilot.com` (CodeQL: incomplete URL substring sanitization).
    return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
  } catch {
    return false;
  }
}

/** Resolve the request URL string from a `fetch` input argument. */
function resolveRequestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = (input as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

/**
 * Rewrite a streaming CAPI Gemini response so its SSE body bridges
 * `reasoning_opaque` into `reasoning_details`. Returns the original response
 * untouched for non-Copilot hosts, non-event-stream responses, or bodyless
 * responses, keeping the blast radius to streaming CAPI Gemini turns only.
 */
export function maybeRewriteCopilotGeminiResponse(
  url: string | undefined,
  response: Response,
): Response {
  if (!url || !isCopilotApiHost(url)) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return response;
  if (!response.body) return response;
  const transformed = createCopilotGeminiSseStream(response.body);
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Apply Copilot response-body transforms before pi-ai parses streamed provider
 * output. Anthropic Messages repair gets first refusal for `/v1/messages`
 * streams; other Copilot event streams keep the existing Gemini reasoning bridge.
 */
export function maybeRewriteCopilotProviderResponse(
  url: string | undefined,
  response: Response,
): Response {
  const anthropicRepaired = maybeRepairCopilotAnthropicMessagesResponse(url, response);
  if (anthropicRepaired !== response) return anthropicRepaired;
  return maybeRewriteCopilotGeminiResponse(url, response);
}

let originalFetch: typeof fetch | undefined;

/**
 * Install a `globalThis.fetch` wrapper that applies Copilot-only stream
 * compatibility shims before pi-ai parses provider output. Currently this
 * includes the Gemini `reasoning_opaque` bridge and the Anthropic Messages
 * terminal `message_stop` repair. Idempotent.
 *
 * SDK clients resolve `globalThis.fetch` at client-construction time, and a new
 * client is built per request, so wrapping the global before the first request
 * is reliably picked up. Non-Copilot hosts and non-event-stream responses are
 * returned untouched by the underlying shims.
 */
export function installCopilotResponseInterceptor(): void {
  if (originalFetch) return;
  if (typeof globalThis.fetch !== "function") return;
  const base = globalThis.fetch;
  originalFetch = base;
  const boundFetch = base.bind(globalThis);

  const wrapped = (async (input, init) => {
    const response = await boundFetch(input, init);
    try {
      return maybeRewriteCopilotProviderResponse(resolveRequestUrl(input), response);
    } catch {
      return response;
    }
  }) as typeof fetch;

  // Preserve `fetch.preconnect` so the wrapper remains a drop-in replacement.
  const preconnect = (base as { preconnect?: unknown }).preconnect;
  if (typeof preconnect === "function") {
    (wrapped as { preconnect?: unknown }).preconnect = preconnect.bind(globalThis);
  }

  globalThis.fetch = wrapped;
}

/** Backward-compatible name for the original Gemini-only interceptor export. */
export function installCopilotGeminiReasoningInterceptor(): void {
  installCopilotResponseInterceptor();
}
