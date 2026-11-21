import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

/**
 * A subagent's chat in the engine tells its host which queued messages show in its transcript and have not been seen
 * saved, so a host that loses the engine can list them as unconfirmed.
 */

const TASK = "task-1" as TaskId;
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

/** The user message events a real session sends for a message queued while it works, and for its own prompt. */
async function sessionEvents(): Promise<AgentSessionEvent[]> {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Waits until released",
		parameters: Type.Object({}),
		execute: async () => {
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const h = await createHarness({ tools: [tool] });
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	const events: AgentSessionEvent[] = [];
	h.session.subscribe((event) => {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user")
			events.push(event);
	});
	const run = h.session.prompt("its own prompt");
	await started.promise;
	await h.session.steer("queued while it worked");
	release.resolve();
	await run;
	return events;
}

test("a queued message the subagent's transcript shows is reported unsaved until its save arrives", async () => {
	const events = await sessionEvents();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session: TaskTranscriptSource = {
		getSessionId: () => "child",
		getEntries: () => [],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	initTheme("dark");
	const page = new TaskAgentTranscriptPage(
		transcriptOnlySource({
			readTaskTranscript: () => ({ ok: true, value: { messages: [] } }),
			followTaskTranscript: () => ({ session, historyOnly: false }),
		}),
		TASK,
		taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
		() => {},
	);
	try {
		await page.load();
		const emit = (index: number) => {
			const event = events[index];
			assert.ok(event);
			for (const listener of listeners) listener(event);
		};
		const unsaved = () => page.viewStatus("worker").unsaved;
		// Its own prompt is no queued message.
		emit(0);
		assert.equal(unsaved(), undefined);
		emit(1);
		// The queued one shows, and is not saved yet.
		emit(2);
		assert.deepEqual(unsaved(), ["queued while it worked"]);
		emit(3);
		assert.equal(unsaved(), undefined, "saved");
	} finally {
		page.dispose();
	}
});
