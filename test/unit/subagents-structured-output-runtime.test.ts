import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import registerSubagentPromptRuntime from "../../packages/subagents/src/runs/shared/subagent-prompt-runtime.js";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  cleanupStructuredOutputRuntime,
  createStructuredOutputRuntime,
  readStructuredOutput,
  type StructuredOutputTranscriptMessage,
} from "../../packages/subagents/src/runs/shared/structured-output.js";
import type { ExtensionAPI, ToolDefinition } from "../../packages/coding-agent/src/index.js";

const objectSchema = {
  type: "object",
  required: ["answer"],
  properties: {
    answer: { type: "string" },
  },
  additionalProperties: false,
};
const payload = { answer: "ready" };

function assertPrivateFileModeIfSupported(filePath: string): void {
  if (process.platform === "win32") return;
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
}

function withStructuredOutputEnv<T>(schemaPath: string, outputPath: string, fn: () => Promise<T>): Promise<T> {
  const previousSchema = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  const previousCapture = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
  process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
  return fn().finally(() => {
    if (previousSchema === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
    else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = previousSchema;
    if (previousCapture === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
    else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = previousCapture;
  });
}

function assistantToolCall(
  toolCallId = "call-1",
  toolName = "structured_output",
  sibling = false,
): StructuredOutputTranscriptMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id: toolCallId, name: toolName },
      ...(sibling ? [{ type: "toolCall", id: "sibling-1", name: "read" }] : []),
    ],
  };
}

function assistantText(): StructuredOutputTranscriptMessage {
  return { role: "assistant", content: [{ type: "text" }] };
}

function toolResult(
  toolCallId = "call-1",
  toolName = "structured_output",
  isError = false,
): StructuredOutputTranscriptMessage {
  return { role: "toolResult", toolCallId, toolName, isError };
}

function customMessage(): StructuredOutputTranscriptMessage {
  return { role: "custom", content: "later custom message" };
}

function writePayloadAndMetadata(
  runtime: ReturnType<typeof createStructuredOutputRuntime>,
  metadataOverrides: Record<string, boolean | number | string | typeof payload | undefined> = {},
): void {
  writeFileSync(runtime.outputPath, JSON.stringify(payload), { mode: 0o600 });
  writeFileSync(runtime.metadataPath, JSON.stringify({
    toolName: "structured_output",
    toolCallId: "call-1",
    success: true,
    terminate: true,
    capturedAt: "2026-06-12T00:00:00.000Z",
    ...metadataOverrides,
  }), { mode: 0o600 });
}

function withRuntime<T>(fn: (runtime: ReturnType<typeof createStructuredOutputRuntime>, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-readback-"));
  let runtime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
  try {
    runtime = createStructuredOutputRuntime(objectSchema, dir);
    return fn(runtime, dir);
  } finally {
    cleanupStructuredOutputRuntime(runtime);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("subagent structured output parent runtime", () => {
  test("rejects top-level non-object outputSchema before creating runtime files", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-parent-"));
    try {
      const arraySchema = {
        type: "array",
        items: { type: "string" },
      };

      assert.throws(
        () => createStructuredOutputRuntime(arraySchema, dir),
        /top-level object/i,
      );
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts top-level object outputSchema and creates private runtime files", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-parent-"));
    let runtime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
    try {
      const schema = {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      };

      runtime = createStructuredOutputRuntime(schema, dir);

      assert.deepEqual(runtime.schema, schema);
      assert.equal(existsSync(runtime.schemaPath), true);
      assert.equal(existsSync(runtime.outputPath), false);
      assert.equal(existsSync(runtime.metadataPath), false);
      assert.equal(runtime.metadataPath, join(dirname(runtime.schemaPath), "output.meta.json"));
      assert.deepEqual(JSON.parse(readFileSync(runtime.schemaPath, "utf-8")), schema);
      assertPrivateFileModeIfSupported(runtime.schemaPath);
    } finally {
      cleanupStructuredOutputRuntime(runtime);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts final matching structured_output capture and returns the flat payload", () => {
    withRuntime((runtime) => {
      writePayloadAndMetadata(runtime);

      const readWithTranscript = readStructuredOutput(runtime, {
        messages: [assistantToolCall(), toolResult()],
      });
      const readWithoutTranscript = readStructuredOutput(runtime);

      assert.equal(readWithTranscript.error, undefined);
      assert.deepEqual(readWithTranscript.value, payload);
      assert.equal(readWithoutTranscript.error, undefined);
      assert.deepEqual(readWithoutTranscript.value, payload);
    });
  });

  test("accepts benign custom transcript messages around the final structured_output result", () => {
    withRuntime((runtime) => {
      writePayloadAndMetadata(runtime);

      const readback = readStructuredOutput(runtime, {
        messages: [assistantToolCall(), customMessage(), toolResult(), customMessage()],
      });

      assert.equal(readback.error, undefined);
      assert.deepEqual(readback.value, payload);
    });
  });

  test("rejects stale captures followed by later assistant or tool-result messages", () => {
    const cases: Array<{ label: string; later: StructuredOutputTranscriptMessage; pattern: RegExp }> = [
      { label: "assistant", later: assistantText(), pattern: /later assistant/i },
      { label: "tool result", later: toolResult("other-call", "read"), pattern: /later toolResult/i },
    ];

    for (const testCase of cases) {
      withRuntime((runtime) => {
        writePayloadAndMetadata(runtime);
        const readback = readStructuredOutput(runtime, {
          messages: [assistantToolCall(), toolResult(), testCase.later],
        });

        assert.match(readback.error ?? "", testCase.pattern, testCase.label);
        assert.equal(readback.value, undefined);
      });
    }
  });

  test("rejects structured_output calls with sibling tool calls in the same assistant batch", () => {
    withRuntime((runtime) => {
      writePayloadAndMetadata(runtime);

      const readback = readStructuredOutput(runtime, {
        messages: [assistantToolCall("call-1", "structured_output", true), toolResult()],
      });

      assert.match(readback.error ?? "", /sibling tool calls/i);
      assert.equal(readback.value, undefined);
    });
  });

  test("rejects another structured_output tool call elsewhere in the transcript", () => {
    withRuntime((runtime) => {
      writePayloadAndMetadata(runtime);

      const readback = readStructuredOutput(runtime, {
        messages: [
          assistantToolCall("call-0"),
          toolResult("call-0"),
          assistantToolCall("call-1"),
          toolResult("call-1"),
        ],
      });

      assert.match(readback.error ?? "", /another structured_output tool call/i);
      assert.equal(readback.value, undefined);
    });
  });

  test("rejects error, mismatched, or missing structured_output transcript metadata", () => {
    const cases: Array<{ label: string; messages: StructuredOutputTranscriptMessage[]; pattern: RegExp }> = [
      {
        label: "error tool result",
        messages: [assistantToolCall(), toolResult("call-1", "structured_output", true)],
        pattern: /error/i,
      },
      {
        label: "mismatched tool result name",
        messages: [assistantToolCall(), toolResult("call-1", "final_decision")],
        pattern: /tool result.*final_decision/i,
      },
      {
        label: "missing tool result",
        messages: [assistantToolCall()],
        pattern: /No tool result matched/i,
      },
      {
        label: "mismatched assistant tool name",
        messages: [assistantToolCall("call-1", "final_decision"), toolResult()],
        pattern: /used tool name.*final_decision/i,
      },
      {
        label: "missing assistant tool call",
        messages: [assistantText(), toolResult()],
        pattern: /No assistant tool call matched/i,
      },
    ];

    for (const testCase of cases) {
      withRuntime((runtime) => {
        writePayloadAndMetadata(runtime);
        const readback = readStructuredOutput(runtime, { messages: testCase.messages });

        assert.match(readback.error ?? "", testCase.pattern, testCase.label);
        assert.equal(readback.value, undefined);
      });
    }
  });

  test("rejects missing or invalid metadata sidecars", () => {
    withRuntime((runtime) => {
      writeFileSync(runtime.outputPath, JSON.stringify(payload), { mode: 0o600 });
      const readback = readStructuredOutput(runtime, {
        messages: [assistantToolCall(), toolResult()],
      });

      assert.match(readback.error ?? "", /metadata/i);
      assert.equal(readback.value, undefined);
    });

    const cases: Array<{ label: string; metadata: Record<string, boolean | number | string | undefined>; pattern: RegExp }> = [
      {
        label: "missing toolCallId",
        metadata: {
          toolName: "structured_output",
          success: true,
          terminate: true,
        },
        pattern: /missing toolName or toolCallId/i,
      },
      {
        label: "unsuccessful marker",
        metadata: {
          toolName: "structured_output",
          toolCallId: "call-1",
          success: false,
          terminate: true,
        },
        pattern: /not marked successful/i,
      },
      {
        label: "non-terminating marker",
        metadata: {
          toolName: "structured_output",
          toolCallId: "call-1",
          success: true,
          terminate: false,
        },
        pattern: /not marked as a terminating action/i,
      },
    ];

    for (const testCase of cases) {
      withRuntime((runtime) => {
        writeFileSync(runtime.outputPath, JSON.stringify(payload), { mode: 0o600 });
        writeFileSync(runtime.metadataPath, JSON.stringify(testCase.metadata), { mode: 0o600 });
        const readback = readStructuredOutput(runtime, {
          messages: [assistantToolCall(), toolResult()],
        });

        assert.match(readback.error ?? "", testCase.pattern, testCase.label);
        assert.equal(readback.value, undefined);
      });
    }
  });
});

describe("subagent structured_output prompt runtime", () => {
  test("registers the shared flat structured_output tool and writes metadata capture JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-"));
    try {
      const schemaPath = join(dir, "schema.json");
      const outputPath = join(dir, "output.json");
      const schema = {
        type: "object",
        required: ["files", "risks"],
        properties: {
          files: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      };
      writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });

      await withStructuredOutputEnv(schemaPath, outputPath, async () => {
        let registeredTool: ToolDefinition | undefined;
        const pi = {
          registerTool(tool: ToolDefinition): void {
            registeredTool = tool;
          },
          on(): void {},
        } as Partial<ExtensionAPI> as ExtensionAPI;

        registerSubagentPromptRuntime(pi);

        assert.notEqual(registeredTool, undefined);
        assert.equal(registeredTool?.name, "structured_output");
        assert.deepEqual(registeredTool?.parameters, schema);
        assert.equal("value" in ((registeredTool?.parameters as { properties?: Record<string, object> }).properties ?? {}), false);

        await assert.rejects(
          () => registeredTool!.execute("bad", { files: ["README.md"] } as Parameters<ToolDefinition["execute"]>[1], undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4]),
          /Structured output validation failed/,
        );
        const metadataPath = join(dir, "output.meta.json");
        assert.equal(existsSync(outputPath), false);
        assert.equal(existsSync(metadataPath), false);

        const promptPayload = { files: ["README.md"], risks: ["none"] };
        const result = await registeredTool!.execute("good", promptPayload, undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);

        assert.equal(result.terminate, true);
        assert.deepEqual(result.details, promptPayload);
        assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), promptPayload);
        const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
        assert.equal(metadata.toolName, "structured_output");
        assert.equal(metadata.toolCallId, "good");
        assert.equal(metadata.success, true);
        assert.equal(metadata.terminate, true);
        assert.equal(typeof metadata.capturedAt, "string");
        assertPrivateFileModeIfSupported(outputPath);
        assertPrivateFileModeIfSupported(metadataPath);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
