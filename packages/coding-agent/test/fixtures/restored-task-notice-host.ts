/**
 * A host that restores a task completion intent while a turn streams, then waits to be killed (#5047). Usage:
 * `<jiti> restored-task-notice-host.ts <root> <sessionDir>`. Prints one JSON line `{ file }` once the restored intent
 * has been flushed while the turn's tool call still runs, then waits forever.
 */
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import type { AgentSessionInternalSurface } from "../../src/core/agent-session-methods.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const [root, sessionDir] = process.argv.slice(2) as [string, string];
const manager = await SessionManager.create(root, sessionDir);
await manager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
await manager.appendCustomEntry("task-completion-intent", {
	completionId: "completion-from-earlier-process",
	ownerId: "owner-9-9",
	taskId: "task-9-9-0",
	terminalSequence: "7",
	result: { kind: "failed", code: "fixture", message: "done" },
	display: false,
	taskKind: "agent",
});
const entered = Promise.withResolvers<void>();
const harness = await createHarness({
	sessionManager: manager,
	customTools: [
		{
			name: "block",
			label: "block",
			description: "a tool that never returns",
			parameters: Type.Object({}),
			async execute() {
				entered.resolve();
				await new Promise(() => {});
				return { content: [], details: {} };
			},
		} as never,
	],
});
harness.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
const session = harness.session as unknown as AgentSessionInternalSurface;
void harness.session.prompt("go");
await entered.promise;
session.getAgentTaskHost();
await session._taskCompletionOutbox!.flushRestored();
process.stdout.write(`${JSON.stringify({ file: manager.getSessionFile() })}\n`);
await new Promise(() => {});
