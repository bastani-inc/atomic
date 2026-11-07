/**
 * Offline model for the issue #4521 terminal scenario (scripts/e2e/issue-4521-evidence.sh).
 *
 * Copied into an isolated agent directory's `extensions/`, it registers the provider every surface of the
 * scenario talks to, and answers from what the conversation already holds, so each surface gets the same
 * shape of content: a thinking block, a tool call with sixty lines of output, and a long reply.
 *
 * - main chat, "main-long": thinking, `seq` of MAIN-TOOL lines, then MAIN-LINE-001..150
 * - main chat, "launch-child": a background `worker` subagent on this model, then "MAIN-LAUNCHED"
 * - the child: thinking, CHILD-LINE-001..120 and a `seq` of CHILD-TOOL lines, then a `true` tool call every few
 *   seconds until a message containing E2E-PING-4521 reaches it, which it answers with "CHILD-ACK E2E-PING-4521"
 * - the workflow stage (prompt STAGE_TASK_4521): thinking, `seq` of STAGE-TOOL lines, STAGE-LINE-001..150, then a
 *   `true` tool call every few seconds, so the stage stays live and keeps adding output while it is inspected
 *
 * Holding a turn open with the model's own delay, rather than a long shell command, keeps the turn in the
 * foreground: a shell past its wait budget would background and release the session.
 */
import type { ExtensionAPI } from "@bastani/atomic";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type JsonObject,
} from "@bastani/pi-ai/compat";

const PING = "E2E-PING-4521";
/** How long a held turn waits before its next `true` tool call. */
const HOLD_MS = 3_000;

type Content = AssistantMessage["content"];

function textOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
}

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`).join("\n\n");
}

function bash(command: string): Content[number] {
	return {
		type: "toolCall",
		id: `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		name: "bash",
		arguments: { command },
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("e2e4521", {
		api: "issue-4521-fixture",
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:1/unused",
		models: [
			{
				id: "transcript-model",
				name: "Transcript model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 4000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const messages = context.messages;
			const all = messages.map((message) => textOf(message as { content?: unknown })).join("\n");
			const last = messages.at(-1);
			const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
			const lastCall =
				lastAssistant?.role === "assistant"
					? lastAssistant.content.find((part) => part.type === "toolCall")
					: undefined;
			const child = getCurrentSystemPrompt(messages).includes("You are a child subagent");
			const answered = messages.filter((message) => message.role === "assistant").length;
			let content: Content;
			let delayMs = 0;
			if (child) {
				if (all.includes(PING) && !all.includes(`CHILD-ACK ${PING}`))
					content = [{ type: "text", text: `CHILD-ACK ${PING}` }];
				else if (answered === 0)
					content = [
						{ type: "thinking", thinking: "CHILD-THINKING planning the long answer" },
						{ type: "text", text: lines("CHILD-LINE", 120) },
						bash('seq -f "CHILD-TOOL-%03g" 1 60'),
					];
				else {
					delayMs = HOLD_MS;
					content = [bash("true")];
				}
			} else if (all.includes("STAGE_TASK_4521")) {
				if (answered === 0)
					content = [
						{ type: "thinking", thinking: "STAGE-THINKING planning the stage" },
						bash('seq -f "STAGE-TOOL-%03g" 1 60'),
					];
				else if (answered === 1) content = [{ type: "text", text: lines("STAGE-LINE", 150) }, bash("true")];
				else {
					delayMs = HOLD_MS;
					content = [bash("true")];
				}
			} else if (last?.role === "toolResult") {
				const launched = lastCall?.type === "toolCall" && lastCall.name === "subagent";
				content = [{ type: "text", text: launched ? "MAIN-LAUNCHED" : lines("MAIN-LINE", 150) }];
			} else if (textOf(last as { content?: unknown }).trim() === "launch-child") {
				const args: JsonObject = {
					agent: "worker",
					task: "CHILD_TASK_4521",
					context: "fresh",
					model: "e2e4521/transcript-model",
					wait: { kind: "background" },
					artifacts: false,
					progress: false,
				};
				content = [{ type: "toolCall", id: `fixture-launch-${Date.now()}`, name: "subagent", arguments: args }];
			} else {
				content = [
					{ type: "thinking", thinking: "MAIN-THINKING planning the main answer" },
					bash('seq -f "MAIN-TOOL-%03g" 1 60'),
				];
			}
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content,
				stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const abort = () => {
				clearTimeout(timer);
				output.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
			};
			const timer = setTimeout(() => {
				options?.signal?.removeEventListener("abort", abort);
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
				stream.end();
			}, delayMs);
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
			return stream;
		},
	});
}
