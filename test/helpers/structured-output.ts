import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	JsonObject,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@bastani/pi-ai";
import { createAssistantMessageEventStream, getCurrentTools } from "@bastani/pi-ai";
import { Type } from "typebox";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type {
	RouterDecisionRequest,
	StructuredOutputRequest,
} from "../../packages/coding-agent/src/core/structured-output/index.js";

/** 0.86 folds systemPrompt/tools into a leading system message before provider streamSimple. */
export function inferenceUserContent(context: { messages: Array<{ role: string; content?: unknown }> }): unknown {
	return context.messages.find((message) => message.role === "user")?.content;
}

export function parseInferenceUserPayload(context: { messages: Array<{ role: string; content?: unknown }> }): {
	state?: { task?: string; candidates?: unknown };
	questions?: Record<string, { criteria?: Record<string, unknown> }>;
} {
	const content = inferenceUserContent(context);
	if (typeof content !== "string") throw new Error("structured-output user payload must be JSON text");
	return JSON.parse(content) as ReturnType<typeof parseInferenceUserPayload>;
}

export function inferenceRequestTools(context: {
	messages: Array<{ role: string }>;
	tools?: Array<{ name: string }>;
}): Array<{ name: string }> {
	return context.tools ?? getCurrentTools(context.messages);
}

export const decisionModel: Model<Api> = {
	provider: "decision-test",
	id: "chat",
	name: "Test chat",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
	maxTokens: 4096,
};

export const decisionClassifier: ClassifierModel<ClassifierApi> = {
	provider: "decision-test",
	id: "classifier",
	name: "Test classifier",
	api: "typesafe-system-one",
	type: "classifier",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
	baseUrl: "https://example.invalid",
};

export function classifierResult(
	choices: Record<string, string> = { route: "review", budget: "exact" },
): ClassifierResult {
	return {
		api: decisionClassifier.api,
		provider: decisionClassifier.provider,
		model: decisionClassifier.id,
		answers: Object.fromEntries(
			Object.entries(choices).map(([key, choice]) => [
				key,
				{ type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
			]),
		),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
export const decisionSchema = Type.Object(
	{
		route: Type.Union([Type.Literal("none"), Type.Literal("review")]),
		limit: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export function decisionRequest(): RouterDecisionRequest<typeof decisionSchema> {
	return {
		settings: SettingsManager.inMemory({ routerModel: "decision-test/chat" }),
		modelRegistry: {
			getAll: () => [decisionModel],
			streamSimple: () => {
				throw new Error("Unexpected chat inference");
			},
		},
		currentModel: decisionModel,
		state: {
			task: "Review the patch",
			conversation: [{ role: "user", text: "Review only; do not execute." }],
			constraints: { authorization: "decision only", maxCost: 1.23456789 },
			docs: { source: "reference.md", text: "Review compares the patch to requirements." },
			candidates: [
				{ name: "none", description: "No match" },
				{ name: "review", description: "Review without implementing" },
			],
		},
		instructions: "Select a matching route or none. Preserve the exact cost limit if selecting review.",
		schema: decisionSchema,
		classifier: {
			questions: {
				route: {
					instructions: "Which route matches the actual task? Choose none when no route fits.",
					criteria: { none: "No route fits", review: "Review the patch without implementing" },
				},
				budget: {
					instructions:
						"Assuming review is selected, choose the exact applicable cost limit or inherit existing limits.",
					criteria: { inherit: "Inherit configured limit", exact: "Preserve explicit cost limit of 1.23456789" },
				},
			},
			decode: (choices) => ({
				route: choices.route as "none" | "review",
				...(choices.budget === "exact" ? { limit: 1.23456789 } : {}),
			}),
		},
	};
}
export const choiceDecisionSchema = Type.Object(
	{ route: Type.Union([Type.Literal("none"), Type.Literal("review")]) },
	{ additionalProperties: false },
);
export function structuredOutputRequest(): StructuredOutputRequest<typeof choiceDecisionSchema> {
	const { modelRegistry, currentModel, state, instructions } = decisionRequest();
	return { modelRegistry, currentModel, state, instructions, schema: choiceDecisionSchema };
}
export function decisionMessage(args: JsonObject = { route: "review", limit: 1.23456789 }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "result", name: "structured_output", arguments: args }],
		api: decisionModel.api,
		provider: decisionModel.provider,
		model: decisionModel.id,
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
export function messageStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push(
		message.stopReason === "error" || message.stopReason === "aborted"
			? { type: "error", reason: message.stopReason, error: message }
			: { type: "done", reason: message.stopReason as "toolUse" | "stop" | "length", message },
	);
	return stream;
}
export async function registeredDecisionRuntime(
	streamSimple: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => ReturnType<typeof createAssistantMessageEventStream>,
) {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		credentials: AuthStorage.inMemory(),
		refreshOnCreate: false,
	});
	runtime.registerProvider(decisionModel.provider, {
		api: decisionModel.api,
		baseUrl: decisionModel.baseUrl,
		apiKey: "mock-chat-secret",
		models: [decisionModel],
		streamSimple,
	});
	return { runtime, registry: new ModelRegistry(runtime) };
}
