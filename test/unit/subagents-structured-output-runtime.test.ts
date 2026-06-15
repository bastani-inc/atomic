import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSubagentPromptRuntime, { rewriteSubagentPrompt } from "../../packages/subagents/src/runs/shared/subagent-prompt-runtime.js";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  STRUCTURED_OUTPUT_MISSING_ERROR,
  cleanupStructuredOutputRuntime,
  createStructuredOutputRuntime,
  formatStructuredOutputCorrectionPrompt,
  readStructuredOutput,
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

function withRuntime<T>(schema: Record<string, unknown>, fn: (runtime: ReturnType<typeof createStructuredOutputRuntime>, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-readback-"));
  let runtime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
  try {
    runtime = createStructuredOutputRuntime(schema, dir);
    return fn(runtime, dir);
  } finally {
    cleanupStructuredOutputRuntime(runtime);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("subagent structured output parent runtime", () => {
  test("accepts any JSON Schema object and creates private runtime files", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-parent-"));
    let runtime: ReturnType<typeof createStructuredOutputRuntime> | undefined;
    try {
      const arraySchema = {
        type: "array",
        items: { type: "string" },
      };

      runtime = createStructuredOutputRuntime(arraySchema, dir);

      assert.deepEqual(runtime.schema, arraySchema);
      assert.equal(existsSync(runtime.schemaPath), true);
      assert.equal(existsSync(runtime.outputPath), false);
      assert.deepEqual(JSON.parse(readFileSync(runtime.schemaPath, "utf-8")), arraySchema);
      assertPrivateFileModeIfSupported(runtime.schemaPath);
      assert.equal(readdirSync(dir).length, 1);
    } finally {
      cleanupStructuredOutputRuntime(runtime);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads the captured output JSON after schema validation", () => {
    withRuntime(objectSchema, (runtime) => {
      writeFileSync(runtime.outputPath, JSON.stringify(payload), { mode: 0o600 });

      const readback = readStructuredOutput(runtime);

      assert.equal(readback.error, undefined);
      assert.deepEqual(readback.value, payload);
    });
  });

  test("reports missing structured_output with the contract error", () => {
    withRuntime(objectSchema, (runtime) => {
      const readback = readStructuredOutput(runtime);

      assert.equal(readback.value, undefined);
      assert.equal(readback.error, STRUCTURED_OUTPUT_MISSING_ERROR);
    });
  });

  test("rejects captured JSON that does not match outputSchema", () => {
    withRuntime(objectSchema, (runtime) => {
      writeFileSync(runtime.outputPath, JSON.stringify({ answer: 123 }), { mode: 0o600 });

      const readback = readStructuredOutput(runtime);

      assert.equal(readback.value, undefined);
      assert.match(readback.error ?? "", /Structured output validation failed:/);
      assert.match(readback.error ?? "", /answer/);
    });
  });

  test("formats corrective prompts with the actual structured-output error", () => {
    const prompt = formatStructuredOutputCorrectionPrompt({
      originalTask: "Review the patch",
      error: "Validation failed for tool structured_output: answer is required",
      attempt: 2,
    });

    assert.match(prompt, /Corrective attempt 2\/3/);
    assert.match(prompt, /structured_output/);
    assert.match(prompt, /answer is required/);
    assert.match(prompt, /Original task:\nReview the patch/);
  });
});

describe("subagent structured_output prompt runtime", () => {
  test("does not add extra structured_output prompt guidance when rewriting child prompts", () => {
    const previous = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = "/tmp/output.json";
    try {
      const rewritten = rewriteSubagentPrompt("Base prompt", {
        inheritProjectContext: true,
        inheritSkills: true,
      });

      assert.doesNotMatch(rewritten, /Final output contract/);
      assert.doesNotMatch(rewritten, /final answer channel/);
      assert.doesNotMatch(rewritten, /schema fields directly/);
    } finally {
      if (previous === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
      else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = previous;
    }
  });

  test("registers the shared structured_output tool and writes only output JSON", async () => {
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

        const promptPayload = { files: ["README.md"], risks: ["none"] };
        const result = await registeredTool!.execute("good", promptPayload, undefined, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);

        assert.equal(result.terminate, true);
        assert.deepEqual(result.details, promptPayload);
        assert.deepEqual(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""), promptPayload);
        assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), promptPayload);
        assertPrivateFileModeIfSupported(outputPath);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
