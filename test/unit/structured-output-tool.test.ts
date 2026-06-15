import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

function textContent(result: Awaited<ReturnType<ReturnType<typeof createStructuredOutputTool>["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("structured_output factory tool", () => {
  test("uses the supplied schema directly and exposes pi-dynamic-workflows prompt metadata", () => {
    const schema = Type.Object({
      headline: Type.String(),
      approved: Type.Boolean(),
    }, { additionalProperties: false });
    const tool = createStructuredOutputTool({ schema });

    assert.equal(STRUCTURED_OUTPUT_TOOL_NAME, "structured_output");
    assert.equal(tool.name, STRUCTURED_OUTPUT_TOOL_NAME);
    assert.equal(tool.parameters, schema);
    assert.equal(tool.maxResultSizeChars, Infinity);
    assert.equal(tool.description, "Return the final machine-readable result for this subagent task.");
    assert.equal(tool.promptSnippet, "Return final machine-readable output");
    assert.deepEqual(tool.promptGuidelines, [
      "structured_output is the final answer channel for this task; call structured_output exactly once when done.",
      "Do not write a prose final answer after calling structured_output.",
    ]);
  });

  test("interpolates custom tool names into prompt metadata", () => {
    const schema = Type.Object({
      approved: Type.Boolean(),
      findings: Type.Array(Type.String()),
    }, { additionalProperties: false });

    const tool = createStructuredOutputTool({ name: "final_decision", schema });
    const promptText = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

    assert.equal(tool.name, "final_decision");
    assert.equal(tool.promptSnippet, "Return final machine-readable output");
    assert.match(promptText, /final_decision/);
    assert.doesNotMatch(promptText, /call\s+structured_output/i);
    assert.doesNotMatch(promptText, /calling\s+structured_output/i);
  });

  test("factory captures tool arguments without manual validation", async () => {
    const schema = Type.Object({}, { additionalProperties: Type.Unknown() });
    const tool = createStructuredOutputTool({ schema });
    const payload = {
      headline: "done",
      nested: { ok: true, count: 2 },
      items: ["a", null, 3],
    };

    const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, payload);
    assert.equal(textContent(result), "Structured output received.");

    const arrayResult = await tool.execute("call-2", ["not", "an", "object"] as unknown as Parameters<typeof tool.execute>[1], undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
    assert.deepEqual(arrayResult.details, ["not", "an", "object"]);
  });

  test("captures params, returns them as details, and terminates", async () => {
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
    assert.equal(textContent(result), "Structured output received.");
    assert.equal(capture.called, true);
    assert.deepEqual(capture.value, payload);
  });

  test("writes only the flat file capture and allows later calls to replace it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-"));
    try {
      const outputPath = join(dir, "output.json");
      const schema = Type.Object({
        files: Type.Array(Type.String()),
      }, { additionalProperties: false });
      const tool = createStructuredOutputTool({ schema, output: { outputPath } });
      const firstPayload = { files: ["README.md"] };
      const secondPayload = { files: ["AGENTS.md"] };

      const first = await tool.execute("call-1", firstPayload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
      assert.equal(first.terminate, true);
      assert.deepEqual(first.details, firstPayload);
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), firstPayload);
      assertPrivateFileModeIfSupported(outputPath);

      const second = await tool.execute("call-2", secondPayload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
      assert.equal(second.terminate, true);
      assert.deepEqual(second.details, secondPayload);
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), secondPayload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not reject non-object schemas at factory construction", async () => {
    const arraySchema = Type.Array(Type.String());
    const tool = createStructuredOutputTool({ schema: arraySchema });
    const payload = ["a", "b"];

    const result = await tool.execute("call-1", payload, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

    assert.equal(tool.parameters, arraySchema);
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details, payload);
  });

  test("keeps structured output tool results from oversized persistence", async () => {
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
      assert.equal(textContent(result), "Structured output received.");
      assert.deepEqual(result.details, payload);

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

    const optInTool = createStructuredOutputTool({ schema: Type.Object({}, { additionalProperties: Type.Unknown() }) });
    const optInPrompt = buildSystemPrompt({
      cwd: process.cwd(),
      selectedTools: [optInTool.name],
      toolSnippets: { [optInTool.name]: optInTool.promptSnippet ?? "" },
    });
    assert.match(optInPrompt, /structured_output/);
  });
});
