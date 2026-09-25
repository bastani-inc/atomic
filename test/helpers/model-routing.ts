import { type ClassifierContext, type Context, getCurrentTools, type JsonObject } from "@bastani/pi-ai";
import { decisionMessage, messageStream } from "./structured-output.js";

/** Router answers used when a test does not care about the task's needs. */
export const DEFAULT_NEEDS: Readonly<Record<string, string>> = {
	work: "coding",
	difficulty: "moderate",
	mistake_cost: "low",
	needs_images: "no",
	long_context: "no",
	latency_sensitive: "no",
};

type ChatRequest = Context;

/** Parsed user payload of a chat routing request: `{ state, questions? }`. */
export function chatPayload(context: ChatRequest): {
	state: Record<string, unknown>;
	questions?: Record<string, unknown>;
} {
	const message = context.messages.find((entry) => entry.role === "user");
	return JSON.parse(String(message?.content));
}

/** The structured-output tool's parameters, whether passed on the context or carried in its messages. */
function toolParameters(context: ChatRequest): { properties?: Record<string, { enum?: string[] }> } | undefined {
	const tool = context.tools?.[0] ?? getCurrentTools(context.messages)[0];
	return tool?.parameters as { properties?: Record<string, { enum?: string[] }> } | undefined;
}

/** The model IDs a chat choice request offers, or undefined for a task-needs request. */
export function offeredModels(context: ChatRequest): string[] | undefined {
	return toolParameters(context)?.properties?.modelId?.enum;
}

/**
 * A chat router for tests: it answers the task-needs request with `needs`
 * (merged over the defaults) and the choice request with `pick(offered)`.
 */
export function chatRouter(
	pick: (offered: string[], context: ChatRequest) => string = (offered) => offered[0]!,
	needs: Readonly<Record<string, string>> = {},
) {
	return (_model: unknown, context: ChatRequest) => {
		const offered = offeredModels(context);
		const args: JsonObject = offered
			? { modelId: pick(offered, context) }
			: (Object.fromEntries(
					Object.keys(toolParameters(context)?.properties ?? {}).map((key) => [
						key,
						needs[key] ?? DEFAULT_NEEDS[key]!,
					]),
				) as JsonObject);
		return messageStream(decisionMessage(args));
	};
}

/** Classifier answer for one question: task-needs defaults, or the first offered model. */
export function defaultClassifierChoice(keys: readonly string[], id: string, _context: ClassifierContext): string {
	if (id === "model") return keys[0]!;
	const preferred = DEFAULT_NEEDS[id];
	return preferred && keys.includes(preferred) ? preferred : keys[0]!;
}

/** Model ID of each option in a classifier choice request, keyed like the criteria (`m0`, `m1`, …). */
export function classifierOptions(context: ClassifierContext): Record<string, string> {
	const question = context.questions.model;
	if (question?.type !== "choice") return {};
	return Object.fromEntries(
		Object.entries(question.criteria).map(([key, value]) => [key, (JSON.parse(value) as { id: string }).id]),
	);
}
