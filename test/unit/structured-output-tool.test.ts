import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { beforeEach, describe, test, vi } from "vitest";
import type { StructuredOutputRequest } from "../../packages/coding-agent/src/core/structured-output/types.js";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.js";
import {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createStructuredOutputTool,
	getDefaultToolNames,
	STRUCTURED_OUTPUT_TOOL_NAME,
	type StructuredOutputCapture,
} from "../../packages/coding-agent/src/core/tools/index.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.js";
import {
	DEFAULT_MAX_RESULT_SIZE_CHARS,
	PERSISTED_OUTPUT_TAG,
} from "../../packages/coding-agent/src/core/tools/tool-limits.js";
import {
	createStructuredOutputTool as createStructuredOutputToolFromEntrypoint,
	STRUCTURED_OUTPUT_TOOL_NAME as STRUCTURED_OUTPUT_TOOL_NAME_FROM_ENTRYPOINT,
} from "../../packages/coding-agent/src/index.js";

type InferenceRequest = StructuredOutputRequest<ReturnType<typeof Type.Object>>;

const inference = vi.hoisted(() => ({
	requests: [] as InferenceRequest[],
	value: undefined as unknown,
	error: undefined as Error | undefined,
}));

vi.mock("../../packages/coding-agent/src/core/structured-output/index.js", async (importOriginal) => {
	const original = await importOriginal<object>();
	return {
		...original,
		inferStructuredOutput: async (request: InferenceRequest) => {
			inference.requests.push(request);
			if (inference.error) throw inference.error;
			return {
				value: inference.value,
				model: "test/model",
				responseModel: "test/model",
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		},
	};
});

type Tool = ReturnType<typeof createStructuredOutputTool>;
type ToolContext = Parameters<Tool["execute"]>[4];

const currentModel = { provider: "anthropic", id: "claude-opus-5-5" };
const modelRegistry = { name: "registry" };
const context = { model: currentModel, modelRegistry } as unknown as ToolContext;

function args(extra: Record<string, unknown> = {}): Parameters<Tool["execute"]>[1] {
	return { instructions: "Summarize the review.", state: { review: "Looks good." }, ...extra } as Parameters<
		Tool["execute"]
	>[1];
}

function assertPrivateFileModeIfSupported(filePath: string): void {
	if (process.platform === "win32") return;
	assert.equal(statSync(filePath).mode & 0o777, 0o600);
}

function textContent(result: Awaited<ReturnType<Tool["execute"]>>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

beforeEach(() => {
	inference.requests.length = 0;
	inference.value = undefined;
	inference.error = undefined;
});

describe("structured_output inference tool", () => {
	test("exposes inference arguments, not the result schema, as parameters", () => {
		const schema = Type.Object({ approved: Type.Boolean() }, { additionalProperties: false });
		const tool = createStructuredOutputTool({ schema });

		assert.equal(STRUCTURED_OUTPUT_TOOL_NAME, "structured_output");
		assert.equal(tool.name, STRUCTURED_OUTPUT_TOOL_NAME);
		assert.notEqual(tool.parameters, schema);
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
			"fallbackModels",
			"instructions",
			"model",
			"state",
		]);
		assert.deepEqual(tool.parameters.required?.slice().sort(), ["instructions", "state"]);
		assert.equal("patternProperties" in tool.parameters.properties.state, false);
		assert.equal("additionalProperties" in tool.parameters.properties.state, true);
		assert.equal(tool.maxResultSizeChars, Infinity);
		assert.equal(tool.promptSnippet, "Return final machine-readable output");
		assert.doesNotMatch(
			[tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n"),
			/subagent/i,
		);
	});

	test("interpolates custom tool names into prompt metadata", () => {
		const tool = createStructuredOutputTool({ name: "final_decision", schema: Type.Object({}) });
		const promptText = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

		assert.equal(tool.name, "final_decision");
		assert.match(promptText, /final_decision/);
		assert.doesNotMatch(promptText, /call\s+structured_output/i);
	});

	test("an omitted model infers with the current chat model and registry", async () => {
		const schema = Type.Object({ approved: Type.Boolean() }, { additionalProperties: false });
		const tool = createStructuredOutputTool({ schema });
		inference.value = { approved: true };

		await tool.execute("call-1", args(), undefined, undefined, context);

		assert.equal(inference.requests.length, 1);
		const request = inference.requests[0];
		assert.equal(request?.schema, schema);
		assert.equal(request?.instructions, "Summarize the review.");
		assert.deepEqual(request?.state, { review: "Looks good." });
		assert.equal(request?.model, undefined);
		assert.equal(request?.fallbackModels, undefined);
		assert.equal(request?.currentModel, currentModel);
		assert.equal(request?.modelRegistry, modelRegistry);
	});

	test("an explicit model and fallback chain are forwarded with the abort signal", async () => {
		const tool = createStructuredOutputTool({ schema: Type.Object({ route: Type.String() }) });
		inference.value = { route: "review" };
		const controller = new AbortController();

		await tool.execute(
			"call-1",
			args({ model: "typesafe/jev-latest", fallbackModels: ["openai-codex/gpt-6-sol-fast"] }),
			controller.signal,
			undefined,
			context,
		);

		const request = inference.requests[0];
		assert.equal(request?.model, "typesafe/jev-latest");
		assert.deepEqual(request?.fallbackModels, ["openai-codex/gpt-6-sol-fast"]);
		assert.equal(request?.currentModel, currentModel);
		assert.equal(request?.signal, controller.signal);
	});

	test("captures and returns the inferred value, never the input arguments, and terminates", async () => {
		type Output = { ok: boolean; message: string };
		const capture: StructuredOutputCapture<Output> = { called: false, value: undefined };
		const tool = createStructuredOutputTool({
			schema: Type.Object({ ok: Type.Boolean(), message: Type.String() }, { additionalProperties: false }),
			capture,
		});
		const inferred = { ok: true, message: "ready" };
		inference.value = inferred;

		const result = await tool.execute("call-1", args(), undefined, undefined, context);

		assert.equal(result.terminate, true);
		assert.deepEqual(result.details, inferred);
		assert.deepEqual(JSON.parse(textContent(result)), inferred);
		assert.equal(capture.called, true);
		assert.deepEqual(capture.value, inferred);
	});

	test("does not capture when inference fails", async () => {
		const capture: StructuredOutputCapture<{ ok: boolean }> = { called: false, value: undefined };
		const tool = createStructuredOutputTool({ schema: Type.Object({ ok: Type.Boolean() }), capture });
		inference.error = new Error("every candidate failed");

		await assert.rejects(tool.execute("call-1", args(), undefined, undefined, context), /every candidate failed/);
		assert.equal(capture.called, false);
		assert.equal(capture.value, undefined);
	});

	test("writes the inferred value to the private file capture and allows later calls to replace it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-"));
		try {
			const outputPath = join(dir, "output.json");
			const tool = createStructuredOutputTool({
				schema: Type.Object({ files: Type.Array(Type.String()) }, { additionalProperties: false }),
				output: { outputPath },
			});

			inference.value = { files: ["README.md"] };
			await tool.execute("call-1", args(), undefined, undefined, context);
			assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), { files: ["README.md"] });
			assertPrivateFileModeIfSupported(outputPath);

			inference.value = { files: ["AGENTS.md"] };
			await tool.execute("call-2", args(), undefined, undefined, context);
			assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf-8")), { files: ["AGENTS.md"] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("supports non-object result schemas", async () => {
		const tool = createStructuredOutputTool({ schema: Type.Array(Type.String()) });
		inference.value = ["a", "b"];

		const result = await tool.execute("call-1", args(), undefined, undefined, context);

		assert.equal(result.terminate, true);
		assert.deepEqual(result.details, ["a", "b"]);
	});

	test("keeps structured output tool results from oversized persistence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-structured-output-oversized-"));
		try {
			const largeText = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
			const tool = createStructuredOutputTool({ schema: Type.Object({ answer: Type.String() }) });
			inference.value = { answer: largeText };
			const result = await tool.execute("structured-large", args(), undefined, undefined, context);

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
			assert.deepEqual(result.details, { answer: largeText });

			const ordinaryReplacement = await redirectOversizedToolResult({
				toolName: "ordinary_tool",
				toolCallId: "ordinary-large",
				result: { content: [{ type: "text", text: largeText }], details: { kind: "ordinary" } },
				isError: false,
				sessionId: "unit-session",
				sessionDir: dir,
			});
			assert.notEqual(ordinaryReplacement, undefined);
			const replacementText = ordinaryReplacement?.content[0]?.text ?? "";
			assert.match(replacementText, new RegExp(`^${PERSISTED_OUTPUT_TAG}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is exported as an opt-in factory but not registered as a builtin", () => {
		assert.equal(allToolNames.has("structured_output" as never), false);
		assert.equal(getDefaultToolNames().includes("structured_output" as never), false);
		assert.equal(typeof createStructuredOutputToolFromEntrypoint, "function");
		assert.equal(STRUCTURED_OUTPUT_TOOL_NAME_FROM_ENTRYPOINT, STRUCTURED_OUTPUT_TOOL_NAME);

		const defs = createAllToolDefinitions(process.cwd());
		assert.equal("structured_output" in defs, false);
		assert.equal("structured_output" in createAllTools(process.cwd()), false);

		const snippets = Object.fromEntries(
			Object.values(defs).flatMap((definition) =>
				definition.promptSnippet ? [[definition.name, definition.promptSnippet] as const] : [],
			),
		);
		assert.doesNotMatch(buildSystemPrompt({ cwd: process.cwd(), toolSnippets: snippets }), /structured_output/);

		const optInTool = createStructuredOutputTool({ schema: Type.Object({}) });
		const optInPrompt = buildSystemPrompt({
			cwd: process.cwd(),
			selectedTools: [optInTool.name],
			toolSnippets: { [optInTool.name]: optInTool.promptSnippet ?? "" },
		});
		assert.match(optInPrompt, /structured_output/);
	});
});
