import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { type OpenAICompletionsOptions, stream as streamCompletions } from "../src/api/openai-completions.ts";
import { getModel, getModels, getProviders } from "../src/compat.ts";
import type { Api, Context, Model, Tool } from "../src/types.ts";

/**
 * Forced tool choice on Claude Fable 5.1.
 *
 * "Forced tool use (`tool_choice: {"type": "any"}` or `{"type": "tool", ...}`) is incompatible
 * with manual extended thinking but works with adaptive thinking. The exceptions are Claude
 * Fable 5.1 and Claude Mythos 5.1, which reject forced tool use on every request with a 400
 * error. On those models, use `tool_choice: {"type": "auto"}` with strict tool use or structured
 * outputs instead." — https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * Two properties are pinned here.
 *
 * 1. **The request is rejected, not rewritten.** An earlier revision silently substituted `auto`.
 *    That discarded an explicit caller instruction and made the declared `toolChoice` shape a
 *    lie: asking the model to call a named tool and asking it to decide for itself are different
 *    requests. The library now fails before the round trip, naming the model and the remedy.
 * 2. **The restriction is a model property, not a first-party API property.** Every mirror routes
 *    to the same upstream model and receives the same 400, so the guard is keyed on the API that
 *    can express a forced choice rather than on `provider === "anthropic"`. That is the opposite
 *    of the preserved-thinking flags, which really are Anthropic-endpoint properties.
 */

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const FORCED_TOOL_CHOICE_ERROR = /does not support forced tool choice/;

const testTool: Tool = {
	name: "double_number",
	description: "Doubles a number",
	parameters: { type: "object", properties: { value: { type: "number" } } },
};

function makeContext(tools: Tool[] | undefined = [testTool]): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }], tools };
}

interface ToolChoicePayload {
	tool_choice?: { type: string; name?: string };
}

async function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	toolChoice: AnthropicOptions["toolChoice"],
): Promise<ToolChoicePayload> {
	let capturedPayload: ToolChoicePayload | undefined;

	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
		onPayload: (payload) => {
			capturedPayload = payload as ToolChoicePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

/** Anthropic `stream()` surfaces a build-time throw as an error result rather than rejecting. */
async function anthropicErrorMessage(
	model: Model<"anthropic-messages">,
	toolChoice: AnthropicOptions["toolChoice"],
): Promise<string> {
	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
	});
	const result = await s.result();
	return result.errorMessage ?? "";
}

interface BedrockToolConfigPayload {
	toolConfig?: { toolChoice?: Record<string, unknown> };
}

async function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	toolChoice: BedrockOptions["toolChoice"],
): Promise<BedrockToolConfigPayload> {
	let capturedPayload: BedrockToolConfigPayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		toolChoice,
		onPayload: (payload) => {
			capturedPayload = payload as BedrockToolConfigPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") break;
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}
	return capturedPayload;
}

async function bedrockErrorMessage(
	model: Model<"bedrock-converse-stream">,
	toolChoice: BedrockOptions["toolChoice"],
	tools: Tool[] | undefined = [testTool],
): Promise<string> {
	const s = streamBedrock(model, makeContext(tools), { toolChoice });
	for await (const event of s) {
		if (event.type === "error") break;
	}
	const result = await s.result();
	return result.errorMessage ?? "";
}

interface CompletionsToolChoicePayload {
	tool_choice?: unknown;
}

async function captureCompletionsPayload(
	model: Model<"openai-completions">,
	toolChoice: OpenAICompletionsOptions["toolChoice"],
): Promise<CompletionsToolChoicePayload> {
	let capturedPayload: CompletionsToolChoicePayload | undefined;

	const s = streamCompletions({ ...model, baseUrl: "http://127.0.0.1:9/v1" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
		onPayload: (payload) => {
			capturedPayload = payload as CompletionsToolChoicePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected completions payload to be captured before request failure");
	}
	return capturedPayload;
}

async function completionsErrorMessage(
	model: Model<"openai-completions">,
	toolChoice: OpenAICompletionsOptions["toolChoice"],
): Promise<string> {
	const s = streamCompletions({ ...model, baseUrl: "http://127.0.0.1:9/v1" }, makeContext(), {
		apiKey: "fake-key",
		toolChoice,
	});
	const result = await s.result();
	return result.errorMessage ?? "";
}

/**
 * Every generated `anthropic-messages` mirror of Claude Fable 5.1, discovered from the catalog
 * rather than hard-coded.
 *
 * Third-party mirrors come and go: opencode zen carried `claude-fable-5-1` earlier in this
 * branch's life and had dropped it by the time this was written. Pinning a provider list here
 * would make these tests fail on someone else's catalog change rather than on a real regression.
 * The first-party Anthropic entry is asserted separately, since that one is the objective's
 * actual subject and must always be present.
 */
function anthropicMessagesFable51Mirrors(): Array<{ label: string; model: Model<"anthropic-messages"> }> {
	return getProviders()
		.flatMap((provider) => getModels(provider) as Model<Api>[])
		.filter(
			(model): model is Model<"anthropic-messages"> =>
				model.api === "anthropic-messages" && /claude-fable-5[-.]1/.test(model.id),
		)
		.map((model) => ({ label: `${model.provider}/${model.id}`, model }));
}

describe("forced tool choice is rejected on Claude Fable 5.1", () => {
	// Every mirror that can express a forced choice must carry the flag: the model returns the
	// same 400 whichever platform serves it.
	it("marks every anthropic-messages mirror as rejecting forced tool choice", () => {
		const mirrors = anthropicMessagesFable51Mirrors();

		// The first-party entry is the objective's subject and must always be generated.
		expect(mirrors.map((m) => m.label)).toContain("anthropic/claude-fable-5-1");
		for (const { label, model } of mirrors) {
			expect(model.compat?.supportsForcedToolChoice, label).toBe(false);
		}
	});

	it.each([
		"anthropic.claude-fable-5-1",
		"global.anthropic.claude-fable-5-1",
		"us.anthropic.claude-fable-5-1",
	] as const)("marks Bedrock %s as rejecting forced tool choice", (modelId) => {
		expect(getModel("amazon-bedrock", modelId).compat?.supportsForcedToolChoice).toBe(false);
	});

	it("rejects tool_choice any on every mirror instead of rewriting it", async () => {
		for (const { label, model } of anthropicMessagesFable51Mirrors()) {
			const message = await anthropicErrorMessage(model, "any");

			expect(message, label).toMatch(FORCED_TOOL_CHOICE_ERROR);
			expect(message, label).toContain(model.id);
		}
	});

	it("rejects a named forced tool and names the remedy", async () => {
		const message = await anthropicErrorMessage(getModel("anthropic", "claude-fable-5-1"), {
			type: "tool",
			name: "double_number",
		});

		expect(message).toMatch(FORCED_TOOL_CHOICE_ERROR);
		expect(message).toContain("double_number");
		// The remedy Anthropic documents, so the caller can act without reading the docs first.
		expect(message).toContain("auto");
	});

	it("rejects forced tool choice on the Bedrock profiles too", async () => {
		const message = await bedrockErrorMessage(getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1"), "any");

		expect(message).toMatch(FORCED_TOOL_CHOICE_ERROR);
	});

	// The rejection must not depend on the shape of the tool list. `convertToolConfig` returns
	// early when there are no tools, and the guard originally sat below that return — so a forced
	// choice with an empty or absent tool list was discarded in silence, which is the exact defect
	// the guard exists to prevent. Both empty and undefined are covered by one `!tools?.length`.
	it.each([
		["an empty tool list", [] as Tool[]],
		["no tool list", undefined],
	] as const)("rejects forced tool choice on Bedrock with %s", async (_label, tools) => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");

		expect(await bedrockErrorMessage(model, "any", tools)).toMatch(FORCED_TOOL_CHOICE_ERROR);
		expect(await bedrockErrorMessage(model, { type: "tool", name: "double_number" }, tools)).toMatch(
			FORCED_TOOL_CHOICE_ERROR,
		);
	});

	// Negative control for the hoist: `none` is never forced, so moving the guard above the early
	// returns must not start rejecting it, with or without tools.
	it.each([
		["an empty tool list", [] as Tool[]],
		["no tool list", undefined],
	] as const)("still accepts toolChoice none on Bedrock with %s", async (_label, tools) => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");

		expect(await bedrockErrorMessage(model, "none", tools)).not.toMatch(FORCED_TOOL_CHOICE_ERROR);
	});

	it.each(["auto", "none"] as const)("passes %s through unchanged", async (toolChoice) => {
		const payload = await captureAnthropicPayload(getModel("anthropic", "claude-fable-5-1"), toolChoice);

		expect(payload.tool_choice).toEqual({ type: toolChoice });
	});

	it("omits tool_choice entirely when none is requested", async () => {
		const payload = await captureAnthropicPayload(getModel("anthropic", "claude-fable-5-1"), undefined);

		expect(payload.tool_choice).toBeUndefined();
	});
});

describe("forced tool choice on models that accept it", () => {
	// The guard is keyed on generated capability metadata, not applied to Claude broadly. Every
	// other model must still be able to force a tool when the caller asks.
	it.each(["claude-fable-5", "claude-opus-5", "claude-sonnet-4-5"] as const)(
		"passes forced tool choice through unchanged for %s",
		async (modelId) => {
			const model = getModel("anthropic", modelId);
			expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

			expect(await captureAnthropicPayload(model, "any")).toMatchObject({ tool_choice: { type: "any" } });
			expect(await captureAnthropicPayload(model, { type: "tool", name: "double_number" })).toMatchObject({
				tool_choice: { type: "tool", name: "double_number" },
			});
		},
	);

	it("passes forced tool choice through unchanged for Bedrock Claude Fable 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");
		expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

		const payload = await captureBedrockPayload(model, "any");

		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});
});

/**
 * The OpenAI-completions mirror. `OpenAICompletionsOptions.toolChoice` is OpenAI's
 * `ChatCompletionToolChoiceOption`, which expresses a forced choice as `"required"` or
 * `{ type: "function", function: { name } }`, and the adapter forwarded it unconditionally.
 *
 * The failure mode here is worse than the 400 on the Anthropic path: OpenRouter drops parameters
 * a model does not support, so the forced choice would vanish and the caller would get a
 * plausible answer that quietly ignored the instruction.
 */
describe("forced tool choice on the OpenAI-completions mirror", () => {
	it("marks openrouter/anthropic/claude-fable-5.1 as rejecting forced tool choice", () => {
		expect(getModel("openrouter", "anthropic/claude-fable-5.1").compat?.supportsForcedToolChoice).toBe(false);
	});

	/**
	 * OpenAI's `ChatCompletionToolChoiceOption` is strictly wider than Anthropic's four-member
	 * union, and four of its members force a tool call. `allowed_tools` is the one that depends on
	 * a nested field: the SDK documents `mode: "auto"` as allowing the model "to pick from among
	 * the allowed tools and generate a message", which constrains the candidate set rather than
	 * forcing a call.
	 */
	const forcingShapes = [
		["required", "required", "required"],
		["function", { type: "function", function: { name: "double_number" } }, 'tool "double_number"'],
		["custom", { type: "custom", custom: { name: "run_shell" } }, 'custom tool "run_shell"'],
		[
			"allowed_tools mode required",
			{
				type: "allowed_tools",
				allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "double_number" } }] },
			},
			'allowed_tools (mode "required")',
		],
	] as const;

	it.each(forcingShapes)("rejects a %s tool choice and names it", async (_label, toolChoice, expectedLabel) => {
		const model = getModel("openrouter", "anthropic/claude-fable-5.1");

		const message = await completionsErrorMessage(model, toolChoice as OpenAICompletionsOptions["toolChoice"]);

		expect(message).toMatch(FORCED_TOOL_CHOICE_ERROR);
		expect(message).toContain(expectedLabel);
		expect(message).toContain("auto");
	});

	it.each(["auto", "none"] as const)("passes %s through unchanged", async (toolChoice) => {
		const model = getModel("openrouter", "anthropic/claude-fable-5.1");

		const payload = await captureCompletionsPayload(model, toolChoice);

		expect(payload.tool_choice).toBe(toolChoice);
	});

	// The case that pins the `mode` distinction and would catch an over-broad fix: narrowing the
	// candidate set is not forcing, so this shape must still reach the wire untouched.
	it("passes allowed_tools with mode auto through unchanged", async () => {
		const model = getModel("openrouter", "anthropic/claude-fable-5.1");
		const toolChoice: OpenAICompletionsOptions["toolChoice"] = {
			type: "allowed_tools",
			allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "double_number" } }] },
		};

		const payload = await captureCompletionsPayload(model, toolChoice);

		expect(payload.tool_choice).toEqual(toolChoice);
	});

	// The scoping asymmetry that makes this rule different from the temperature one. Anthropic
	// names Fable 5.1 and Mythos 5.1 as *exceptions* to forced tool use working, and OpenRouter's
	// own `supported_parameters` agrees: `claude-fable-5` lists `tool_choice`, `claude-fable-5.1`
	// does not. A Fable-family match — correct for temperature — would be wrong here.
	it.each(forcingShapes)("leaves Claude Fable 5 able to force a tool (%s)", async (_label, toolChoice) => {
		const model = getModel("openrouter", "anthropic/claude-fable-5");
		expect(model.compat?.supportsForcedToolChoice).toBeUndefined();

		const payload = await captureCompletionsPayload(model, toolChoice as OpenAICompletionsOptions["toolChoice"]);

		expect(payload.tool_choice).toEqual(toolChoice);
	});

	// The `latest` alias names no version, so no id rule can keep a claim about its target true.
	// Leaving it unguarded is deliberate and documented, and is the opposite trade from
	// temperature, where the family match was widened specifically to reach it.
	it("deliberately leaves the unversioned latest alias unguarded", () => {
		expect(getModel("openrouter", "~anthropic/claude-fable-latest").compat?.supportsForcedToolChoice).toBeUndefined();
	});
});

describe("preserved-thinking flags keep their first-party provider scope", () => {
	// Extracting the forced-tool rule out of the preserved-thinking function must not widen the
	// two binding flags, which really are Anthropic-endpoint properties rather than model ones.
	it("does not leak the binding flags to non-Anthropic mirrors", () => {
		for (const { label, model } of anthropicMessagesFable51Mirrors()) {
			if (model.provider === "anthropic") {
				expect(model.compat?.enforcesPreservedThinkingBinding, label).toBe(true);
				expect(model.compat?.delegatesThinkingModelBinding, label).toBe(true);
				continue;
			}
			expect(model.compat?.enforcesPreservedThinkingBinding, label).toBeUndefined();
			expect(model.compat?.delegatesThinkingModelBinding, label).toBeUndefined();
		}
	});
});
