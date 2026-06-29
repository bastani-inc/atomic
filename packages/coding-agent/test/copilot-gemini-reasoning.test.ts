import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  createCopilotGeminiSseStream,
  injectCopilotGeminiReasoningDetails,
  maybeRewriteCopilotGeminiResponse,
  restoreCopilotGeminiReasoningOpaque,
  rewriteCopilotGeminiSseData,
} from "../src/core/copilot-gemini-reasoning.ts";

function geminiModel(id = "gemini-3.1-pro-preview"): Pick<Model<Api>, "provider" | "api" | "id"> {
  return { provider: "github-copilot", api: "openai-completions", id };
}

function nonGeminiModel(): Pick<Model<Api>, "provider" | "api" | "id"> {
  return { provider: "github-copilot", api: "openai-completions", id: "gpt-4o" };
}

const OPAQUE = "enc:abc123==";

/** Run the streaming transform over a sequence of string chunks. */
async function runTransform(chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const reader = createCopilotGeminiSseStream(source).getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function toolCallDelta(): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          reasoning_opaque: OPAQUE,
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "bash", arguments: "" },
            },
          ],
        },
      },
    ],
  };
}

describe("injectCopilotGeminiReasoningDetails", () => {
  it("adds an encrypted reasoning detail keyed by the tool-call id", () => {
    const chunk = toolCallDelta();
    expect(injectCopilotGeminiReasoningDetails(chunk)).toBe(true);
    const delta = (chunk.choices as any[])[0].delta;
    expect(delta.reasoning_details).toEqual([
      { type: "reasoning.encrypted", id: "call_abc", data: OPAQUE },
    ]);
  });

  it("is a no-op when there is no tool call with an id (argument-continuation delta)", () => {
    const chunk = {
      choices: [
        {
          delta: {
            reasoning_opaque: OPAQUE,
            tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
          },
        },
      ],
    };
    expect(injectCopilotGeminiReasoningDetails(chunk)).toBe(false);
    expect((chunk.choices[0].delta as any).reasoning_details).toBeUndefined();
  });

  it("is a no-op when there is no reasoning_opaque", () => {
    const chunk = {
      choices: [{ delta: { tool_calls: [{ id: "call_x", function: { name: "bash" } }] } }],
    };
    expect(injectCopilotGeminiReasoningDetails(chunk)).toBe(false);
  });

  it("does not clobber existing reasoning_details", () => {
    const chunk = {
      choices: [
        {
          delta: {
            reasoning_opaque: OPAQUE,
            reasoning_details: [{ type: "reasoning.encrypted", id: "pre", data: "x" }],
            tool_calls: [{ id: "call_abc", function: { name: "bash" } }],
          },
        },
      ],
    };
    expect(injectCopilotGeminiReasoningDetails(chunk)).toBe(false);
    expect((chunk.choices[0].delta as any).reasoning_details[0].id).toBe("pre");
  });
});

describe("rewriteCopilotGeminiSseData", () => {
  it("rewrites a tool-call chunk that carries reasoning_opaque", () => {
    const input = JSON.stringify(toolCallDelta());
    const output = rewriteCopilotGeminiSseData(input);
    const parsed = JSON.parse(output);
    expect(parsed.choices[0].delta.reasoning_details).toEqual([
      { type: "reasoning.encrypted", id: "call_abc", data: OPAQUE },
    ]);
  });

  it("returns the payload unchanged when it carries no reasoning_opaque", () => {
    const input = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    expect(rewriteCopilotGeminiSseData(input)).toBe(input);
  });

  it("fails open on malformed JSON", () => {
    const input = '{"choices": [ reasoning_opaque broken';
    expect(rewriteCopilotGeminiSseData(input)).toBe(input);
  });
});

describe("createCopilotGeminiSseStream", () => {
  it("rewrites the data line in an SSE event and preserves framing", async () => {
    const event = `data: ${JSON.stringify(toolCallDelta())}\n\n`;
    const out = await runTransform([event]);
    expect(out.endsWith("\n\n")).toBe(true);
    const dataLine = out.split("\n").find((l) => l.startsWith("data:"))!;
    const parsed = JSON.parse(dataLine.slice("data:".length).trim());
    expect(parsed.choices[0].delta.reasoning_details[0].data).toBe(OPAQUE);
  });

  it("handles data split across chunk boundaries", async () => {
    const event = `data: ${JSON.stringify(toolCallDelta())}\n\n`;
    const mid = Math.floor(event.length / 2);
    const out = await runTransform([event.slice(0, mid), event.slice(mid)]);
    const dataLine = out.split("\n").find((l) => l.startsWith("data:"))!;
    const parsed = JSON.parse(dataLine.slice("data:".length).trim());
    expect(parsed.choices[0].delta.reasoning_details[0].id).toBe("call_abc");
  });

  it("passes through [DONE] and unrelated lines unchanged", async () => {
    const input = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n`;
    const out = await runTransform([input]);
    expect(out).toBe(input);
  });
});

describe("restoreCopilotGeminiReasoningOpaque", () => {
  it("promotes an encrypted reasoning detail to reasoning_opaque on the assistant message", () => {
    const payload = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_abc", type: "function", function: { name: "bash", arguments: "{}" } }],
          reasoning_details: [{ type: "reasoning.encrypted", id: "call_abc", data: OPAQUE }],
        },
        { role: "tool", tool_call_id: "call_abc", content: "ok" },
      ],
    };
    const out = restoreCopilotGeminiReasoningOpaque(payload, geminiModel()) as any;
    const assistant = out.messages[1];
    expect(assistant.reasoning_opaque).toBe(OPAQUE);
    expect(assistant.reasoning_details).toBeUndefined();
    expect(assistant.tool_calls[0].id).toBe("call_abc");
  });

  it("is a no-op for non-Gemini Copilot models", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          reasoning_details: [{ type: "reasoning.encrypted", id: "c", data: OPAQUE }],
        },
      ],
    };
    expect(restoreCopilotGeminiReasoningOpaque(payload, nonGeminiModel())).toBe(payload);
  });

  it("leaves assistant messages without encrypted details untouched", () => {
    const payload = {
      messages: [{ role: "assistant", content: "done", reasoning_details: [{ type: "reasoning.text", text: "x" }] }],
    };
    expect(restoreCopilotGeminiReasoningOpaque(payload, geminiModel())).toBe(payload);
  });
});

describe("maybeRewriteCopilotGeminiResponse", () => {
  const sseResponse = () =>
    new Response(`data: ${JSON.stringify(toolCallDelta())}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  async function bodyText(response: Response): Promise<string> {
    return await response.text();
  }

  it("rewrites a CAPI Gemini event-stream response", async () => {
    const out = maybeRewriteCopilotGeminiResponse(
      "https://api.individual.githubcopilot.com/chat/completions",
      sseResponse(),
    );
    const text = await bodyText(out);
    expect(text).toContain('"reasoning.encrypted"');
    expect(text).toContain('"call_abc"');
  });

  it("returns non-Copilot hosts untouched (same Response instance)", () => {
    const response = sseResponse();
    expect(maybeRewriteCopilotGeminiResponse("https://api.openai.com/v1/chat/completions", response)).toBe(
      response,
    );
  });

  it("returns non-event-stream Copilot responses untouched", () => {
    const response = new Response('{"error":"x"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    expect(
      maybeRewriteCopilotGeminiResponse("https://api.githubcopilot.com/chat/completions", response),
    ).toBe(response);
  });
});

describe("end-to-end reasoning_opaque round-trip", () => {
  it("captured inbound detail survives to an outbound reasoning_opaque", () => {
    // 1. Inbound: SSE chunk gains reasoning_details.
    const chunk = toolCallDelta();
    injectCopilotGeminiReasoningDetails(chunk);
    const detail = (chunk.choices as any[])[0].delta.reasoning_details[0];

    // 2. The pi-ai client stores `JSON.stringify(detail)` as the tool call's
    //    thoughtSignature and re-emits it as reasoning_details on replay.
    const thoughtSignature = JSON.stringify(detail);
    const replayPayload = {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_abc", type: "function", function: { name: "bash", arguments: "{}" } }],
          reasoning_details: [JSON.parse(thoughtSignature)],
        },
      ],
    };

    // 3. Outbound: restored to the field CAPI reads.
    const out = restoreCopilotGeminiReasoningOpaque(replayPayload, geminiModel()) as any;
    expect(out.messages[0].reasoning_opaque).toBe(OPAQUE);
  });
});
