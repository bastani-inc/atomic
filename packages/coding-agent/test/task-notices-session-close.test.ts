import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import { createHarness, type Harness } from "./suite/harness.js";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;

const harnesses: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

async function openHarness(store: MemorySessionStore, sessionId?: string): Promise<Harness> {
	const manager =
		sessionId === undefined
			? await SessionManager.create(store, process.cwd())
			: await SessionManager.open(store, sessionId);
	const harness = await createHarness({
		sessionManager: manager,
	});
	harnesses.push(harness);
	return harness;
}

const backgroundBash = (command: string, id: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, wait: { kind: "background" } }, { id })], {
		stopReason: "toolUse",
	});

function notices(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE
				? [String(entry.content)]
				: [],
		);
}

test("a shell that a session's close cancels shows one notice naming the close when the session next opens (#5079)", async () => {
	const store = new MemorySessionStore();
	const first = await openHarness(store);
	first.setResponses([backgroundBash("sleep 30", "bash-1"), fauxAssistantMessage("started it")]);
	await first.session.prompt("start the build");
	const sessionId = first.sessionManager.getSessionId();
	const host = first.session.getAgentTaskHost();
	const watchOwnerTasks = host.watchOwnerTasks.bind(host);
	const watches = { opened: 0, disposed: 0 };
	vi.spyOn(host, "watchOwnerTasks").mockImplementation((...args) => {
		const watched = watchOwnerTasks(...args);
		if (watched.ok) {
			watches.opened++;
			const dispose = watched.value.dispose.bind(watched.value);
			watched.value.dispose = () => {
				watches.disposed++;
				dispose();
			};
		}
		return watched;
	});
	await first.session.dispose();
	assert.ok(watches.opened > 0, "the close read the kinds of the tasks it stops");
	assert.equal(watches.disposed, watches.opened, "the close leaves no watch of its tasks open");

	const reopened = await openHarness(store, sessionId);
	reopened.setResponses([fauxAssistantMessage("must not run")]);
	await reopened.session.startPendingRecovery("resume");
	await vi.waitFor(() => assert.equal(notices(reopened).length, 1), {
		timeout: WAIT_TIMEOUT_MS,
		interval: POLL_INTERVAL_MS,
	});
	assert.match(notices(reopened)[0]!, /Background shell stopped \(session closed\)/);

	await reopened.session.dispose();
	const again = await openHarness(store, sessionId);
	await again.session.startPendingRecovery("resume");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(notices(again).length, 1);
});
