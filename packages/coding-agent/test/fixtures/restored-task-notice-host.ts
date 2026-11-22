/**
 * A host that restores a task completion intent while a turn streams, then waits to be killed (#5047). Usage:
 * `<node --import resolve-ts> restored-task-notice-host.ts <root> <sessionDir>`. Prints one JSON line `{ file }` once
 * the restored intent has been flushed while the turn's tool call still runs, then stays alive until killed.
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
// Keep the event loop alive while the blocking tool stays suspended: an unsettled top-level Promise alone
// drains Node's event loop and exits with code 13 instead of waiting to be killed mid-turn.
setInterval(() => {}, 60_000);
process.stdout.write(`${JSON.stringify({ file: manager.getSessionFile() })}\n`);
