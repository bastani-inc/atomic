import { existsSync, writeFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";
import { trackDetachedChildPid } from "../../../packages/coding-agent/src/utils/shell.js";
if (process.env.ATOMIC_BLOCKING_EXTENSION_INIT === "1") {
	const deadline = performance.now() + 1_000;
	while (performance.now() < deadline) {
		// Intentionally block module evaluation in the engine child.
	}
}


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

export default function blockingToolExtension(api: ExtensionAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://isolation.invalid",
		apiKey: "fixture-key",
		models: [{
			id: model,
			name: "Blocking isolation fixture",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		}],
		streamSimple: (_activeModel, context) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const pidFile = process.env.ATOMIC_BLOCKING_TOOL_PID_FILE;
				const alreadyInterrupted = pidFile ? existsSync(pidFile) : false;
				const hasToolResult = context.messages.some((entry) => entry.role === "toolResult");
				const reason = hasToolResult || alreadyInterrupted ? "stop" : "toolUse";
				const finalMessage = hasToolResult || alreadyInterrupted
					? message([{ type: "text", text: "recovered engine is usable" }], reason)
					: message([{ type: "toolCall", id: "busy-call", name: "busy_loop", arguments: {} }], reason);
				stream.push({ type: "start", partial: { ...finalMessage, content: [] } });
				stream.push({ type: "done", reason, message: finalMessage });
			});
			return stream;
		},
	});

	api.registerMessageRenderer("fixture-message", () => {
		const pidFile = process.env.ATOMIC_RENDERER_PID_FILE;
		if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");
		return new Text("custom renderer parity", 0, 0);
	});

	api.on("session_start", async (_event, ctx) => {
		if (process.env.ATOMIC_RENDERER_FIXTURE === "1") {
			ctx.ui.setWidget("fixture-widget", () => {
				const pidFile = process.env.ATOMIC_WIDGET_PID_FILE;
				if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");
				return new Text("factory widget parity", 0, 0);
			}, { placement: "belowEditor" });
		}
		if (process.env.ATOMIC_STARTUP_CUSTOM_UI !== "1") return;
		await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => ({
			render: (width) => [`startup:${width}`],
			handleInput: (data) => { if (data === "\r") done(); },
			invalidate: () => {},
		}));
	});

	if (process.env.ATOMIC_RENDERER_FIXTURE === "1") {
		// Send the display message on the first agent turn instead of a startup
		// timer: a session_start-time send races the host InteractiveMode's agent
		// subscription in isolated mode and is dropped from the chat when the host
		// starts cold (fresh agent dir on CI).
		let fixtureMessageSent = false;
		api.on("agent_start", () => {
			if (fixtureMessageSent) return;
			fixtureMessageSent = true;
			void api.sendMessage({ customType: "fixture-message", content: "fixture", display: true });
		});
	}

	api.registerTool({
		name: "busy_loop",
		label: "Busy loop",
		renderCall: (_args, _theme, context) => {
			const pidFile = process.env.ATOMIC_TOOL_RENDERER_PID_FILE;
			if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");
			return new Text(`child tool renderer:${context.toolCallId}`, 0, 0);
		},
		description: "Synthetic blocking tool for interactive-engine isolation regression coverage",
		parameters: Type.Object({}),
		execute: async () => {
			const pidFile = process.env.ATOMIC_BLOCKING_TOOL_PID_FILE;
			if (!pidFile) throw new Error("ATOMIC_BLOCKING_TOOL_PID_FILE is required");
			writeFileSync(pidFile, String(process.pid), "utf8");
			if (process.env.ATOMIC_NONBLOCKING_TOOL === "1") {
				await Bun.sleep(50);
				return { content: [{ type: "text", text: "finished" }], details: {} };
			}
			const grandchildPidFile = process.env.ATOMIC_BLOCKING_GRANDCHILD_PID_FILE;
			if (grandchildPidFile) {
				const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
					detached: true,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				grandchild.unref();
				trackDetachedChildPid(grandchild.pid);
				writeFileSync(grandchildPidFile, String(grandchild.pid), "utf8");
			}
			const deadline = performance.now() + 5_000;
			while (performance.now() < deadline) {
				// Intentionally never yield.
			}
			return { content: [{ type: "text", text: "finished" }], details: {} };
		},
	});
}
