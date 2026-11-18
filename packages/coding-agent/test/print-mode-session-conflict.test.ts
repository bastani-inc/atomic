/** `atomic -p` reports a run that another process's write to its session stopped once, as a conflict (#5135). */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("a run that another process's write stopped is reported once, as a conflict, and exits 1 (#5135)", async () => {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, sessionId) });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("never requested")]);
	const otherProcess = await SessionManager.open(store, sessionId);
	await otherProcess.appendMessage({ role: "user", content: "the other process's prompt", timestamp: Date.now() });
	const runtimeHost = {
		session: harness.session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const stdout: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			stdout.push(String(chunk));
			if (typeof encodingOrCallback === "function") encodingOrCallback();
			else callback?.();
			return true;
		},
	);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	const exitCode = await runPrintMode(runtimeHost, { mode: "text", initialMessage: "continue" });

	assert.equal(exitCode, 1);
	assert.equal(stdout.join(""), "");
	assert.deepEqual(errorSpy.mock.calls, [
		[
			`Error: Another process wrote to session ${sessionId} while this one was writing to it (expected 1 entries, found 2), so this run stopped. Resume the session again to continue from what was saved.`,
		],
	]);
});
