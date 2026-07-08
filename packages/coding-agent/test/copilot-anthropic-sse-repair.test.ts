import { describe, expect, it } from "vitest";
import {
  COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT,
  createCopilotAnthropicMessagesSseRepairStream,
  maybeRepairCopilotAnthropicMessagesResponse,
} from "../src/core/copilot-anthropic-sse-repair.ts";
import { maybeRewriteCopilotProviderResponse } from "../src/core/copilot-gemini-reasoning.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const COPILOT_MESSAGES_URL = "https://api.individual.githubcopilot.com/v1/messages";

function sseEvent(eventName: string, data: JsonObject | string): string {
  const dataPayload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${eventName}\ndata: ${dataPayload}\n\n`;
}

function dataOnlySseFrame(data: JsonObject | string): string {
  const dataPayload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${dataPayload}\n\n`;
}

function messageStartEvent(): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_placeholder",
      type: "message",
      role: "assistant",
      model: "claude-placeholder",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
}

function contentBlockStartEvent(index = 0): string {
  return sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

function contentBlockDeltaEvent(index = 0): string {
  return sseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: "placeholder" },
  });
}

function contentBlockStopEvent(index = 0): string {
  return sseEvent("content_block_stop", { type: "content_block_stop", index });
}

function terminalMessageDeltaEvent(): string {
  return sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
}

function nonTerminalMessageDeltaEvent(): string {
  return sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_sequence: null },
    usage: { output_tokens: 2 },
  });
}

function messageStopEvent(): string {
  return sseEvent("message_stop", { type: "message_stop" });
}

function doneSentinelEvent(): string {
  return "data: [DONE]\n\n";
}

function repairableAnthropicStream(): string {
  return [
    messageStartEvent(),
    contentBlockStartEvent(),
    contentBlockDeltaEvent(),
    contentBlockStopEvent(),
    terminalMessageDeltaEvent(),
  ].join("");
}

async function runRepair(chunks: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const reader = createCopilotAnthropicMessagesSseRepairStream(source).getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("createCopilotAnthropicMessagesSseRepairStream", () => {
  it("appends a synthetic message_stop after a clean Copilot Anthropic stream with terminal evidence", async () => {
    const input = repairableAnthropicStream();
    const mid = Math.floor(input.length / 2);

    const out = await runRepair([input.slice(0, mid), input.slice(mid)]);

    expect(out).toBe(`${input}${COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT}`);
    expect(countOccurrences(out, "event: message_stop")).toBe(1);
  });

  it("leaves an already well-formed stream byte-for-byte unchanged", async () => {
    const input = `${repairableAnthropicStream()}${messageStopEvent()}`;

    const out = await runRepair([input]);

    expect(out).toBe(input);
    expect(countOccurrences(out, "event: message_stop")).toBe(1);
  });

  it("does not synthesize content_block_stop or message_stop while a content block is open", async () => {
    const input = [
      messageStartEvent(),
      contentBlockStartEvent(),
      contentBlockDeltaEvent(),
      terminalMessageDeltaEvent(),
    ].join("");

    const out = await runRepair([input]);

    expect(out).toBe(input);
    expect(countOccurrences(out, "event: content_block_stop")).toBe(0);
    expect(countOccurrences(out, "event: message_stop")).toBe(0);
  });

  it("does not repair a stream that is missing terminal stop_reason evidence", async () => {
    const input = [
      messageStartEvent(),
      contentBlockStartEvent(),
      contentBlockDeltaEvent(),
      contentBlockStopEvent(),
      nonTerminalMessageDeltaEvent(),
    ].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });

  it("does not repair a stream that contains an SSE error event", async () => {
    const input = [
      messageStartEvent(),
      contentBlockStartEvent(),
      contentBlockStopEvent(),
      sseEvent("error", {
        type: "error",
        error: { type: "placeholder_error", message: "placeholder" },
      }),
      terminalMessageDeltaEvent(),
    ].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });

  it("does not repair a stream with malformed SSE JSON even if later terminal evidence appears", async () => {
    const input = [
      messageStartEvent(),
      sseEvent("ping", '{"type":"ping"'),
      contentBlockStartEvent(),
      contentBlockStopEvent(),
      terminalMessageDeltaEvent(),
    ].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });

  it("inserts the synthetic message_stop before a terminal [DONE] sentinel and preserves [DONE]", async () => {
    const input = `${repairableAnthropicStream()}${doneSentinelEvent()}`;
    const expected = `${repairableAnthropicStream()}${COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT}${doneSentinelEvent()}`;

    await expect(runRepair([input])).resolves.toBe(expected);
  });

  it("does not repair eventless data-only Anthropic-shaped frames", async () => {
    const input = [
      dataOnlySseFrame({
        type: "message_start",
        message: {
          id: "msg_placeholder",
          type: "message",
          role: "assistant",
          model: "claude-placeholder",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      dataOnlySseFrame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      dataOnlySseFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "placeholder" },
      }),
      dataOnlySseFrame({ type: "content_block_stop", index: 0 }),
      dataOnlySseFrame({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      }),
    ].join("");

    const out = await runRepair([input]);

    expect(out).toBe(input);
    expect(countOccurrences(out, "event: message_stop")).toBe(0);
  });

  it("does not repair when a content block starts before message_start", async () => {
    const input = [
      contentBlockStartEvent(),
      messageStartEvent(),
      contentBlockDeltaEvent(),
      contentBlockStopEvent(),
      terminalMessageDeltaEvent(),
    ].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });

  it("does not repair when terminal message_delta arrives before message_start", async () => {
    const input = [terminalMessageDeltaEvent(), messageStartEvent()].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });

  it("does not repair when content-block lifecycle continues after terminal stop_reason", async () => {
    const input = [
      messageStartEvent(),
      contentBlockStartEvent(),
      contentBlockDeltaEvent(),
      terminalMessageDeltaEvent(),
      contentBlockStopEvent(),
    ].join("");

    await expect(runRepair([input])).resolves.toBe(input);
  });
});

describe("maybeRepairCopilotAnthropicMessagesResponse", () => {
  async function bodyText(response: Response): Promise<string> {
    return await response.text();
  }

  function sseResponse(body = repairableAnthropicStream()): Response {
    return new Response(body, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }

  it("repairs only Copilot /v1/messages event-stream responses with a body", async () => {
    const response = sseResponse();
    const out = maybeRepairCopilotAnthropicMessagesResponse(COPILOT_MESSAGES_URL, response);

    expect(out).not.toBe(response);
    await expect(bodyText(out)).resolves.toBe(
      `${repairableAnthropicStream()}${COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT}`,
    );
  });

  it("repairs documented Copilot CAPI host variants", async () => {
    for (const url of [
      "https://githubcopilot.com/v1/messages",
      "https://api.individual.githubcopilot.com/v1/messages",
      "https://api.githubcopilot.com/v1/messages",
      "https://api.enterprise.githubcopilot.com/v1/messages",
      "https://copilot-api.company.ghe.com/v1/messages",
    ]) {
      const response = sseResponse();
      const out = maybeRepairCopilotAnthropicMessagesResponse(url, response);

      expect(out).not.toBe(response);
      await expect(bodyText(out)).resolves.toBe(
        `${repairableAnthropicStream()}${COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT}`,
      );
    }
  });

  it("rejects githubcopilot.com public-host look-alikes", () => {
    const publicLookalike = sseResponse();

    expect(
      maybeRepairCopilotAnthropicMessagesResponse(
        "https://githubcopilot.com.evil.test/v1/messages",
        publicLookalike,
      ),
    ).toBe(publicLookalike);
  });

  it("returns non-Copilot, non-/v1/messages, and non-SSE responses untouched", () => {
    const nonCopilot = sseResponse();
    expect(maybeRepairCopilotAnthropicMessagesResponse("https://api.anthropic.com/v1/messages", nonCopilot)).toBe(
      nonCopilot,
    );

    const gheLookalike = sseResponse();
    expect(
      maybeRepairCopilotAnthropicMessagesResponse(
        "https://copilot-api.company.ghe.com.evil.test/v1/messages",
        gheLookalike,
      ),
    ).toBe(gheLookalike);

    const nonMessagesEndpoint = sseResponse();
    expect(
      maybeRepairCopilotAnthropicMessagesResponse(
        "https://api.individual.githubcopilot.com/chat/completions",
        nonMessagesEndpoint,
      ),
    ).toBe(nonMessagesEndpoint);

    const nonSse = new Response(repairableAnthropicStream(), {
      headers: { "content-type": "application/json" },
    });
    expect(maybeRepairCopilotAnthropicMessagesResponse(COPILOT_MESSAGES_URL, nonSse)).toBe(nonSse);
  });
});

describe("maybeRewriteCopilotProviderResponse", () => {
  it("runs the Anthropic repair through the composed Copilot response rewrite path", async () => {
    const response = new Response(repairableAnthropicStream(), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const out = maybeRewriteCopilotProviderResponse(COPILOT_MESSAGES_URL, response);

    expect(out).not.toBe(response);
    await expect(out.text()).resolves.toBe(
      `${repairableAnthropicStream()}${COPILOT_ANTHROPIC_SYNTHETIC_MESSAGE_STOP_EVENT}`,
    );
  });
});
