/** Offline terminal fixture for the actual registered subagent launch/kill/wait tools. */
import type { ExtensionAPI } from "@bastani/atomic";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type JsonObject,
} from "@bastani/atomic-ai/compat";

export default function (atomic: ExtensionAPI): void {
	let taskId: string | undefined;
	atomic.registerProvider("openai", {
		api: "subagent-kill-fixture",
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:1/unused",
		models: [
			{
				id: "kill-fixture",
				name: "Kill fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const text =
				last?.role === "user"
					? typeof last.content === "string"
						? last.content
						: last.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("")
					: "";
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content: [],
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			if (
				text.includes("HOLD_KILL_FIXTURE_CHILD") &&
				getCurrentSystemPrompt(context.messages).includes("You are a child subagent")
			) {
				const abort = () => {
					output.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
				};
				if (options?.signal?.aborted) queueMicrotask(abort);
				else options?.signal?.addEventListener("abort", abort, { once: true });
				return stream;
			}
			if (last?.role === "toolResult") {
				const resultText = last.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const match = /"taskId":"([^"]+)"/.exec(resultText);
				if (match) taskId = match[1];
				output.content = [{ type: "text", text: `Fixture receipt: ${resultText}` }];
			} else {
				const target: JsonObject = taskId === undefined ? {} : { id: taskId };
				const args: JsonObject | undefined =
					text === "launch-child"
						? {
								agent: "worker",
								task: "HOLD_KILL_FIXTURE_CHILD",
								context: "fresh",
								model: "openai/kill-fixture",
								wait: { kind: "background" },
								artifacts: false,
								progress: false,
							}
						: text === "kill-child"
							? { action: "kill", ...target }
							: text === "wait-child"
								? { action: "wait", ...target }
								: text === "status-child"
									? { action: "status", ...target }
									: text === "old-command"
										? { action: "interrupt", ...target }
										: undefined;
				output.content = args
					? [{ type: "toolCall", id: `fixture-${Date.now()}`, name: "subagent", arguments: args }]
					: [{ type: "text", text: "Use launch-child, kill-child, wait-child, status-child, or old-command." }];
				output.stopReason = args ? "toolUse" : "stop";
			}
			queueMicrotask(() => {
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
				stream.end();
			});
			return stream;
		},
	});
}
