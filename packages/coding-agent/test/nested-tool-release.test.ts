import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createCodemodeExtension } from "../src/extensions/codemode/index.js";
import { createHarness, getMessageText } from "./suite/harness.js";

async function runAndRelease(store: MemorySessionStore): Promise<void> {
	const h = await createHarness({
		sessionManager: await SessionManager.create(store, process.cwd()),
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["read", "codemode"],
	});
	try {
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.read({path: "."});' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt("List the working directory");
		const receipt = h.session.messages.find((message) => message.role === "toolResult");
		assert.ok(receipt?.role === "toolResult" && !receipt.isError, getMessageText(receipt));
		assert.deepEqual(
			receipt.nestedCalls?.calls.map((call) => [call.name, call.status]),
			[["read", "ok"]],
		);
		await h.session.release();
	} finally {
		await h.cleanup();
	}
}

test("releasing sessions that called tools from codemode leaves no async context store per session", async () => {
	const store = new MemorySessionStore();
	try {
		// Warm the runtime before counting, and sample outside the released session's async context.
		await runAndRelease(store);
		await setImmediate();
		const baseline = queryObjects(AsyncLocalStorage, { format: "count" });
		for (let i = 0; i < 4; i++) await runAndRelease(store);
		await setImmediate();
		const after = queryObjects(AsyncLocalStorage, { format: "count" });
		assert.ok(after <= baseline, `Live async context stores grew from ${baseline} to ${after} after release`);
	} finally {
		await store.close();
	}
});
