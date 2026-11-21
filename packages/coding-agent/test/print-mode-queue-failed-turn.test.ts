/** `atomic -p` delivers what is queued after a turn fails before it starts, and exits as it always did. */
import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("a steer and a follow-up queued while a tool runs are both answered after the next turn's preparation fails once", async () => {
	let harness: Harness | undefined;
	// What an extension does at the end of the tool: it queues a steer and a follow-up.
	const tool: AgentTool = {
		name: "work",
		label: "Work",
		description: "Works",
		parameters: Type.Object({}),
		execute: async () => {
			await harness?.session.steer("ext steer");
			await harness?.session.followUp("ext fu");
			return { content: [{ type: "text", text: "worked" }], details: {} };
		},
	};
	harness = await createHarness({ tools: [tool] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("work", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("answered the steer"),
		fauxAssistantMessage("answered the follow-up"),
	]);
	// The turn after the tool fails before its request once, as a cancelled compaction before it fails it.
	const agent = harness.session.agent;
	const prepare = agent.prepareNextTurnWithContext;
	let failed = false;
	agent.prepareNextTurnWithContext = async (context, signal) => {
		if (!failed) {
			failed = true;
			throw new Error("compaction cancelled before the next request");
		}
		return prepare?.(context, signal);
	};
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
	vi.spyOn(console, "error").mockImplementation(() => {});
	const runtime = {
		session: harness.session,
		setRebindSession: () => {},
		dispose: () => harness?.session.dispose(),
	} as unknown as AgentSessionRuntime;

	const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "go" });

	assert.ok(failed);
	assert.equal(exitCode, 0);
	assert.equal(stdout.join(""), "answered the follow-up\n");
	assert.deepEqual(getUserTexts(harness), ["go", "ext steer", "ext fu"]);
});
