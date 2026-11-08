import type { JsonObject, TranscriptContext } from "@bastani/pi-ai";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/context-types.js";
import {
	decisionChatModel,
	decisionMessage,
	inferenceUserContent,
	messageStream,
} from "../helpers/structured-output.js";
import { toolContext } from "../helpers/tool-context.js";
import type { AgentSession, StageSessionRuntime } from "./stage-runner-helpers.js";
import { assistantMessageWithUsage } from "./stage-runner-helpers.js";

export const FINAL_TEXT = "The change is correct and the focused tests pass.";
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

export type Behavior = "answer" | "provider-failure" | "invalid-answer";

export interface InferenceRequest {
	readonly systemPrompt: string;
	readonly state: {
		readonly stageTask: string;
		readonly finalAssistantText: string;
		readonly recentTranscript: ReadonlyArray<{ readonly role: string; readonly text: string }>;
	};
}

/** What the session's tool context offers the runtime's inference, counting what it is asked to do. */
export class InferenceRig {
	readonly requests: InferenceRequest[] = [];
	readonly contextRequests: string[] = [];
	readonly models: string[] = [];

	constructor(private readonly behavior: (call: number) => Behavior | "abort" = () => "answer") {}

	onAbort: (() => void) | undefined;
	contextFailure: Error | undefined;

	readonly context = {
		model: decisionChatModel,
		modelRegistry: {
			getAll: () => [decisionChatModel],
			streamSimple: (model: typeof decisionChatModel, context: TranscriptContext) => {
				const call = this.requests.length + 1;
				const content = inferenceUserContent(context);
				if (typeof content !== "string") throw new Error("the inference must send JSON state");
				const { state } = JSON.parse(content) as { state: InferenceRequest["state"] };
				this.requests.push({
					systemPrompt: (context as { readonly systemPrompt?: string }).systemPrompt ?? "",
					state,
				});
				this.models.push(`${model.provider}/${model.id}`);
				const behavior = this.behavior(call);
				if (behavior === "provider-failure") throw new Error("decision provider unavailable");
				if (behavior === "abort") {
					this.onAbort?.();
					throw new Error("decision provider interrupted");
				}
				return messageStream(
					decisionMessage(
						behavior === "invalid-answer"
							? ({ approved: "yes" } as unknown as JsonObject)
							: { approved: true, summary: state.finalAssistantText },
					),
				);
			},
		},
	} as unknown as ExtensionContext;

	attachTo(session: StageSessionRuntime): StageSessionRuntime {
		return Object.assign(session, {
			extensionRunner: {
				createToolContext: (toolCallId: string) => {
					this.contextRequests.push(toolCallId);
					if (this.contextFailure !== undefined) throw this.contextFailure;
					return toolContext(this.context);
				},
			},
		});
	}
}

export function userTurn(messages: AgentSession["messages"], text: string): void {
	messages.push({ role: "user", content: text, timestamp: 0 } as AgentSession["messages"][number]);
}

export function proseTurn(messages: AgentSession["messages"], text: string): void {
	messages.push(assistantMessageWithUsage(text, NO_USAGE));
}
