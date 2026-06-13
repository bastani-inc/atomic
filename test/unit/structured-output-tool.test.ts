import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, PERSISTED_OUTPUT_TAG } from "../../packages/coding-agent/src/core/tools/tool-limits.js";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  allToolNames,
  createAllToolDefinitions,
  createAllTools,
  createStructuredOutputTool,
  defaultToolNames,
  type StructuredOutputCapture,
} from "../../packages/coding-agent/src/core/tools/index.js";
import {
  STRUCTURED_OUTPUT_TOOL_NAME as STRUCTURED_OUTPUT_TOOL_NAME_FROM_ENTRYPOINT,
  createStructuredOutputTool as createStructuredOutputToolFromEntrypoint,
} from "../../packages/coding-agent/src/index.js";

function assertPrivateFileModeIfSupported(filePath: string): void {
  if (process.platform === "win32") return;
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
}

describe("structured_output factory tool", () => {
  test("uses the supplied schema directly and exposes final-answer prompt metadata", () => {
    const schema = Type.Object({
      headline: Type.String(),
      approved: Type.Boolean(),
    }, { additionalProperties: false });
    const tool = createStructuredOutputTool({ schema });

    assert.equal(STRUCTURED_OUTPUT_TOOL_NAME, "structured_output");
    assert.equal(tool.name, STRUCTURED_OUTPUT_TOOL_NAME);
    assert.equal(tool.parameters, schema);
    assert.equal(tool.maxResultSizeChars, Infinity);
    assert.equal("value" in schema.properties, false);
    assert.match(tool.promptSnippet ?? "", /final machine-readable/i);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /exactly once/i);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /no.*prose/i);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /value/i);
  });

  test("interpolates custom tool names into prompt metadata", () => {
    const schema = Type.Object({
      approved: Type.Boolean(),
      findings: Type.Array(Type.String()),
    }, { additionalProperties: false });

    const tool = createStructuredOutputTool({ name: "final_decision", schema });
    const promptText = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

    assert.equal(tool.name, "final_decision");
    assert.match(tool.promptSnippet ?? "", /final_decision/);
    assert.match(promptText, /final_decision/);
    assert.doesNotMatch(promptText, /call\s+structured_output/i);
    assert.doesNotMatch(promptText, /calling\s+structured_output/i);
  });

  test("generic factory accepts arbitrary top-level JSON objects without a value wrapper", async () => {
    const tool = createStructuredOutputTool();
    const payload = {
      headline: "done",
      nested: { ok: true, count: 2 },
      items: ["a", null, 3],
    };

    const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, payload);
    assert.deepEqual(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""), payload);
    await assert.rejects(
      () => tool.execute("call-2", ["not", "an", "object"] as unknown as Parameters<typeof tool.execute>[1], undefined, undefined, {} as Parameters<typeof tool.execute>[4]),
      /Structured output validation failed/,
    );
  });

  test("captures valid params, returns them as details, and terminates", async () => {
    const schema = Type.Object({
      ok: Type.Boolean(),
      message: Type.String(),
    }, { additionalProperties: false });
    type Output = { ok: boolean; message: string };
    const capture: StructuredOutputCapture<Output> = { called: false, value: undefined };
    const tool = createStructuredOutputTool({ schema, capture });
    const payload = { ok: true, message: "ready" };

    const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, payload);
    assert.deepEqual(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""), payload);
    assert.equal(capture.called, true);
    assert.deepEqual(capture.value, payload);
  });

  test("rejects invalid params before mutating capture or writing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-"));
    try {
      const outputPath = join(dir, "output.json");
      const schema = Type.Object({
        ok: Type.Boolean(),
      }, { additionalProperties: false });
      const capture: StructuredOutputCapture<{ ok: boolean }> = { called: false, value: undefined };
      const tool = createStructuredOutputTool({ schema, capture, output: { outputPath } });

      await assert.rejects(
        () => tool.execute("call-1", { ok: "yes" } as unknown as Parameters<typeof tool.execute>[1], undefined, undefined, {} as Parameters<typeof tool.execute>[4]),
        /Structured output validation failed/,
      );

      assert.equal(capture.called, false);
      assert.equal(capture.value, undefined);
      assert.equal(existsSync(outputPath), false);
      assert.equal(existsSync(join(dir, "output.meta.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes flat file capture plus metadata sidecar with 0600 mode and rejects duplicate capture calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-"));
    try {
      const outputPath = join(dir, "output.json");
      const metadataPath = join(dir, "output.meta.json");
      const schema = Type.Object({
        files: Type.Array(Type.String()),
      }, { additionalProperties: false });
      const tool = createStructuredOutputTool({ schema, output: { outputPath } });
      const payload = { files: ["README.md"] };

      const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

      assert.equal(result.terminate, true);
      assert.deepEqual(result.details, payload);
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), payload);
      assertPrivateFileModeIfSupported(outputPath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
      assert.equal(metadata.toolName, "structured_output");
      assert.equal(metadata.toolCallId, "call-1");
      assert.equal(metadata.success, true);
      assert.equal(metadata.terminate, true);
      assert.equal(typeof metadata.capturedAt, "string");
      assertPrivateFileModeIfSupported(metadataPath);
      await assert.rejects(
        () => tool.execute("call-2", { files: ["AGENTS.md"] }, undefined, undefined, {} as Parameters<typeof tool.execute>[4]),
        /already called/,
      );
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), payload);
      assert.equal((JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>).toolCallId, "call-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts object schemas that wrap array outputs in a field", async () => {
    const schema = Type.Object({
      items: Type.Array(Type.String()),
    }, { additionalProperties: false });
    const tool = createStructuredOutputTool({ schema });
    const payload = { items: ["a", "b"] };

    const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

    assert.equal(tool.parameters, schema);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, payload);
  });

  test("rejects non-object schemas at factory construction", () => {
    const cases: Array<{ label: string; schema: never }> = [
      { label: "missing", schema: null as never },
      { label: "TypeBox array", schema: Type.Array(Type.String()) as never },
      { label: "TypeBox string", schema: Type.String() as never },
      { label: "TypeBox number", schema: Type.Number() as never },
      { label: "TypeBox boolean", schema: Type.Boolean() as never },
      { label: "plain JSON array", schema: { type: "array", items: { type: "string" } } as never },
      { label: "plain JSON string", schema: { type: "string" } as never },
      { label: "top-level anyOf", schema: { anyOf: [Type.Object({ ok: Type.Boolean() }), Type.Object({ error: Type.String() })] } as never },
      { label: "top-level oneOf", schema: { oneOf: [Type.Object({ ok: Type.Boolean() }), Type.Object({ error: Type.String() })] } as never },
      { label: "top-level non-object allOf", schema: { allOf: [Type.Array(Type.String())] } as never },
    ];

    for (const testCase of cases) {
      assert.throws(
        () => createStructuredOutputTool({ schema: testCase.schema }),
        /top-level object/i,
        testCase.label,
      );
    }
  });

  test("preserves oversized structured output inline while ordinary tool results redirect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-oversized-"));
    try {
      const largeText = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
      const payload = { answer: largeText };
      const schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
      const tool = createStructuredOutputTool({ schema });
      const result = await tool.execute("structured-large", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

      assert.equal(tool.maxResultSizeChars, Infinity);
      const structuredReplacement = await redirectOversizedToolResult({
        toolName: tool.name,
        toolCallId: "structured-large",
        result,
        isError: false,
        sessionId: "unit-session",
        sessionDir: dir,
        maxResultSizeChars: tool.maxResultSizeChars,
      });
      assert.equal(structuredReplacement, undefined);
      assert.deepEqual(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""), payload);

      const ordinaryReplacement = await redirectOversizedToolResult({
        toolName: "ordinary_tool",
        toolCallId: "ordinary-large",
        result: {
          content: [{ type: "text", text: largeText }],
          details: { kind: "ordinary" },
        },
        isError: false,
        sessionId: "unit-session",
        sessionDir: dir,
      });

      assert.notEqual(ordinaryReplacement, undefined);
      assert.deepEqual(ordinaryReplacement?.details, { kind: "ordinary" });
      const replacementText = ordinaryReplacement?.content[0]?.text ?? "";
      assert.match(replacementText, new RegExp(`^${PERSISTED_OUTPUT_TAG}`));
      assert.notEqual(replacementText, largeText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is exported as an opt-in factory but not registered as a builtin", () => {
    assert.equal(allToolNames.has("structured_output" as never), false);
    assert.equal(defaultToolNames.includes("structured_output" as never), false);
    assert.equal(typeof createStructuredOutputToolFromEntrypoint, "function");
    assert.equal(STRUCTURED_OUTPUT_TOOL_NAME_FROM_ENTRYPOINT, STRUCTURED_OUTPUT_TOOL_NAME);

    const defs = createAllToolDefinitions(process.cwd());
    assert.equal("structured_output" in defs, false);
    assert.equal("structured_output" in createAllTools(process.cwd()), false);

    const snippets = Object.fromEntries(
      Object.values(defs).flatMap((definition) => (
        definition.promptSnippet ? [[definition.name, definition.promptSnippet] as const] : []
      )),
    );
    const defaultPrompt = buildSystemPrompt({ cwd: process.cwd(), toolSnippets: snippets });
    assert.doesNotMatch(defaultPrompt, /structured_output/);

    const optInTool = createStructuredOutputTool();
    const optInPrompt = buildSystemPrompt({
      cwd: process.cwd(),
      selectedTools: [optInTool.name],
      toolSnippets: { [optInTool.name]: optInTool.promptSnippet ?? "" },
    });
    assert.match(optInPrompt, /structured_output/);
  });
});
