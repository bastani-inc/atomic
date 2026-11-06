/**
 * Child process for the background-compaction SIGKILL test (#4330).
 *
 * `planning` holds the background planner open and marks `planning`, so the parent kills the process
 * mid-compaction. `ready` lets the planner finish and marks `ready` once the result is stored but
 * before any turn boundary commits it. Both then wait to be killed.
 */
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createHarnessWithExtensions } from "../../packages/coding-agent/test/test-harness.js";

const [mode, directory] = process.argv.slice(2);
if ((mode !== "planning" && mode !== "ready") || !directory) throw new Error("usage: <planning|ready> <directory>");

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");
const sessionManager = await SessionManager.create(directory, join(directory, "sessions"));

async function publishMarker() {
	const sessionFile = sessionManager.getSessionFile();
	assert.ok(sessionFile);
	const marker = join(directory, mode);
	const pendingMarker = `${marker}.tmp`;
	await writeFile(pendingMarker, sessionFile);
	await rename(pendingMarker, marker);
}

const harness = await createHarnessWithExtensions({
	contextWindow: 1_000,
	settings: { compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 } },
	sessionManager,
	responses: [
		{ text: "first answer", usage: { input: 300, output: 10 } },
		{ text: "over the soft threshold", usage: { input: 760, output: 10 } },
	],
	extensionFactories: [
		(pi) => {
			pi.on("session_before_compact", async () => {
				if (mode === "planning") {
					await publishMarker();
					await new Promise<never>(() => setInterval(() => {}, 1_000));
				}
				return { compactedText: "[User]: retained" };
			});
		},
	],
});
await harness.session.bindExtensions({});
harness.agent.convertToLlm = convertToLlm;
await harness.session.prompt(longPrompt);
await harness.session.prompt(`${longPrompt}\nsecond`);
if (mode === "ready") {
	const state = await harness.session.awaitBackgroundCompaction();
	if (state.state !== "ready") throw new Error(`expected a ready result, got ${state.state}`);
	await publishMarker();
}
setInterval(() => {}, 1_000);
