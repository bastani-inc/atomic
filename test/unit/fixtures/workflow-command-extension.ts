import { appendFileSync, writeFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";

// Regression fixture for the isolated-interactive autocomplete fix. Mirrors the
// real workflows extension surface just enough to prove that when the host loads
// no extensions (isolateInteractiveHost), the engine child still exposes its
// `/workflow` command plus its `/workflows` alias to host autocomplete, and that
// invoking them executes the handler in the child (never on the host).

const provider = "isolation-fixture";
const model = "blocking-model";

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function recordInvocation(name: string, args: string): void {
	const logFile = process.env.ATOMIC_WORKFLOW_COMMAND_LOG;
	if (!logFile) return;
	appendFileSync(logFile, `${JSON.stringify({ name, args, pid: process.pid })}\n`, "utf8");
}

export default function workflowCommandExtension(api: ExtensionAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://isolation.invalid",
		apiKey: "fixture-key",
		models: [{
			id: model,
			name: "Isolation fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		}],
		streamSimple: (_activeModel, context) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				// Emit the blocking tool on the first turn so the test can force an
				// engine restart (escape → abortAndRecover), then stop once recovered.
				const hasToolResult = context.messages.some((entry) => entry.role === "toolResult");
				const reason = hasToolResult ? "stop" : "toolUse";
				const finalMessage = hasToolResult
					? message([{ type: "text", text: "recovered" }], reason)
					: message([{ type: "toolCall", id: "busy-call", name: "busy_loop", arguments: {} }], reason);
				stream.push({ type: "start", partial: { ...finalMessage, content: [] } });
				stream.push({ type: "done", reason, message: finalMessage });
			});
			return stream;
		},
	});

	api.registerTool({
		name: "busy_loop",
		label: "Busy loop",
		description: "Synthetic blocking tool used to force an engine restart in isolation coverage",
		parameters: Type.Object({}),
		execute: async () => {
			const pidFile = process.env.ATOMIC_WORKFLOW_TOOL_PID_FILE;
			if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");
			const deadline = performance.now() + 5_000;
			while (performance.now() < deadline) {
				// Intentionally never yield so the host must restart the engine.
			}
			return { content: [{ type: "text", text: "finished" }], details: {} };
		},
	});

	api.registerCommand("workflow", {
		description: "Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status]",
		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			return [
				{ value: "list ", label: "list", description: "List registered workflows" },
				{ value: "status ", label: "status", description: "List retained runs" },
			].filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			recordInvocation("workflow", args);
			ctx.ui.notify?.(`workflow handled in child: ${args}`, "info");
		},
	});

	api.registerCommand("workflows", {
		description: "List retained workflow runs or open one by id. Usage: /workflows [run-id]",
		handler: async (args, ctx) => {
			recordInvocation("workflows", args);
			ctx.ui.notify?.(`workflows handled in child: ${args}`, "info");
		},
	});
}
