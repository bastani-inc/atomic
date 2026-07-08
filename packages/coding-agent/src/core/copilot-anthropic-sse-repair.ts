/**
 * Narrow repair for GitHub Copilot Anthropic Messages SSE streams that carry a
 * complete Anthropic turn but omit the required terminal `message_stop` event.
 *
 * The wrapper is deliberately conservative: it is only installed for Copilot
 * `/v1/messages` event streams, passes original SSE frames through unchanged,
 * and appends/inserts a single synthetic `message_stop` only after observing the
 * same terminal evidence Anthropic's parser requires for a complete message.
 */

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

type SseObservation = "data" | "done" | "empty";

interface RepairState {
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  sawTerminalStopReason: boolean;
  sawErrorEvent: boolean;
  malformedOrUncertain: boolean;
  sawDoneSentinel: boolean;
  insertedSyntheticStop: boolean;
  openContentBlockIndexes: Set<number>;
}

export const COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT =
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const COPILOT_ANTHROPIC_MESSAGES_PATH = "/v1/messages";
const KNOWN_ANTHROPIC_SSE_EVENT_NAMES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error",
]);

function createRepairState(): RepairState {
  return {
    sawMessageStart: false,
    sawMessageStop: false,
    sawTerminalStopReason: false,
    sawErrorEvent: false,
    malformedOrUncertain: false,
    sawDoneSentinel: false,
    insertedSyntheticStop: false,
    openContentBlockIndexes: new Set<number>(),
  };
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function markMalformed(state: RepairState): void {
  state.malformedOrUncertain = true;
}

function shouldSynthesizeMessageStop(state: RepairState): boolean {
  return (
    state.sawMessageStart &&
    !state.sawMessageStop &&
    state.sawTerminalStopReason &&
    !state.sawErrorEvent &&
    !state.malformedOrUncertain &&
    !state.sawDoneSentinel &&
    !state.insertedSyntheticStop &&
    state.openContentBlockIndexes.size === 0
  );
}

function findSseEventBoundary(buffer: string): number {
  const candidates = ["\r\n\r\n", "\n\n", "\r\r"];
  let bestIndex = -1;
  let bestLength = 0;
  for (const candidate of candidates) {
    const index = buffer.indexOf(candidate);
    if (index === -1) continue;
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index;
      bestLength = candidate.length;
    }
  }
  return bestIndex === -1 ? -1 : bestIndex + bestLength;
}

function stripEventSeparator(frame: string): string {
  if (frame.endsWith("\r\n\r\n")) return frame.slice(0, -4);
  if (frame.endsWith("\n\n")) return frame.slice(0, -2);
  if (frame.endsWith("\r\r")) return frame.slice(0, -2);
  return frame;
}

function hasKnownAnthropicEventName(eventName: string | undefined): eventName is string {
  return eventName !== undefined && KNOWN_ANTHROPIC_SSE_EVENT_NAMES.has(eventName);
}

function canObserveOpenMessageLifecycle(state: RepairState): boolean {
  if (!state.sawMessageStart || state.sawMessageStop || state.sawTerminalStopReason) {
    markMalformed(state);
    return false;
  }
  return true;
}

function observeContentBlockStart(payload: JsonObject, state: RepairState): void {
  if (!canObserveOpenMessageLifecycle(state)) return;
  const index = payload.index;
  if (!isNonNegativeInteger(index) || state.openContentBlockIndexes.has(index)) {
    markMalformed(state);
    return;
  }
  state.openContentBlockIndexes.add(index);
}

function observeContentBlockDelta(payload: JsonObject, state: RepairState): void {
  if (!canObserveOpenMessageLifecycle(state)) return;
  const index = payload.index;
  if (!isNonNegativeInteger(index) || !state.openContentBlockIndexes.has(index)) {
    markMalformed(state);
  }
}

function observeContentBlockStop(payload: JsonObject, state: RepairState): void {
  if (!canObserveOpenMessageLifecycle(state)) return;
  const index = payload.index;
  if (!isNonNegativeInteger(index) || !state.openContentBlockIndexes.delete(index)) {
    markMalformed(state);
  }
}

function observeMessageDelta(payload: JsonObject, state: RepairState): void {
  if (!canObserveOpenMessageLifecycle(state)) return;
  const delta = payload.delta;
  if (!isPlainObject(delta)) return;
  const stopReason = delta.stop_reason;
  if (typeof stopReason === "string" && stopReason.length > 0) {
    state.sawTerminalStopReason = true;
  }
}

function observeAnthropicPayload(eventName: string | undefined, payload: JsonObject, state: RepairState): void {
  if (!hasKnownAnthropicEventName(eventName)) {
    markMalformed(state);
    return;
  }

  const type = payload.type;
  if (typeof type !== "string" || eventName !== type) {
    markMalformed(state);
    return;
  }

  switch (type) {
    case "message_start":
      if (state.sawMessageStart || state.sawMessageStop || state.sawTerminalStopReason) markMalformed(state);
      state.sawMessageStart = true;
      break;
    case "content_block_start":
      observeContentBlockStart(payload, state);
      break;
    case "content_block_delta":
      observeContentBlockDelta(payload, state);
      break;
    case "content_block_stop":
      observeContentBlockStop(payload, state);
      break;
    case "message_delta":
      observeMessageDelta(payload, state);
      break;
    case "message_stop":
      if (!state.sawMessageStart || state.sawMessageStop || state.openContentBlockIndexes.size > 0) {
        markMalformed(state);
      }
      state.sawMessageStop = true;
      break;
    case "ping":
      break;
    case "error":
      state.sawErrorEvent = true;
      break;
  }
}

function observeSseFrame(frame: string, state: RepairState): SseObservation {
  if (state.sawDoneSentinel) {
    markMalformed(state);
  }

  const core = stripEventSeparator(frame);
  if (core.length === 0) return "empty";

  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of core.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    if (eventName === "error") state.sawErrorEvent = true;
    return "empty";
  }

  const dataPayload = dataLines.join("\n");
  if (dataPayload.trim() === "[DONE]") {
    return "done";
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(dataPayload) as JsonValue;
  } catch {
    markMalformed(state);
    return "data";
  }

  if (!isPlainObject(parsed)) {
    markMalformed(state);
    return "data";
  }

  observeAnthropicPayload(eventName, parsed, state);
  return "data";
}

function drainCompleteFrames(buffer: string, state: RepairState): { output: string; rest: string } {
  let rest = buffer;
  let output = "";
  for (;;) {
    const boundaryEnd = findSseEventBoundary(rest);
    if (boundaryEnd === -1) break;

    const frame = rest.slice(0, boundaryEnd);
    rest = rest.slice(boundaryEnd);
    const observation = observeSseFrame(frame, state);
    if (observation === "done") {
      if (shouldSynthesizeMessageStop(state)) {
        output += COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT;
        state.insertedSyntheticStop = true;
        state.sawMessageStop = true;
      }
      state.sawDoneSentinel = true;
    }
    output += frame;
  }
  return { output, rest };
}

/**
 * Wrap a Copilot Anthropic Messages SSE byte stream and repair one narrow class
 * of provider truncation: missing `message_stop` after a fully closed message.
 * Original SSE frames are emitted unchanged; the only possible mutation is one
 * synthetic terminal event at clean EOF or immediately before `[DONE]`.
 */
export function createCopilotAnthropicMessagesSseRepairStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = createRepairState();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const drained = drainCompleteFrames(buffer, state);
          buffer = drained.rest;
          let output = drained.output;

          if (buffer.length > 0) {
            markMalformed(state);
            output += buffer;
            buffer = "";
          }

          if (shouldSynthesizeMessageStop(state)) {
            output += COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT;
            state.insertedSyntheticStop = true;
            state.sawMessageStop = true;
          }

          if (output.length > 0) {
            controller.enqueue(encoder.encode(output));
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const drained = drainCompleteFrames(buffer, state);
        buffer = drained.rest;
        if (drained.output.length > 0) {
          controller.enqueue(encoder.encode(drained.output));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Whether the URL targets Copilot's CAPI gateway (`*.githubcopilot.com`). */
function isCopilotApiHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  // Exact host or a real subdomain only — never a look-alike suffix such as
  // `notgithubcopilot.com` (CodeQL: incomplete URL substring sanitization).
  return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
}

function isCopilotAnthropicMessagesUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return isCopilotApiHost(parsed) && parsed.pathname === COPILOT_ANTHROPIC_MESSAGES_PATH;
  } catch {
    return false;
  }
}

function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Scope the Anthropic SSE repair to GitHub Copilot `/v1/messages` event streams
 * with a body. All other responses are returned as the original instance.
 */
export function maybeRepairCopilotAnthropicMessagesResponse(
  url: string | undefined,
  response: Response,
): Response {
  if (!isCopilotAnthropicMessagesUrl(url)) return response;
  if (!isEventStreamResponse(response)) return response;
  if (!response.body) return response;

  const transformed = createCopilotAnthropicMessagesSseRepairStream(response.body);
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
