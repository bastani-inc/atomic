/**
 * After each turn the engine stores a background session summary together with the usage of the request that wrote
 * it. The host's footer, context indicator and `/session` show the engine's stats, so they must include that usage as
 * soon as the summary lands, not after a later turn or `/reload` (#4726). An unsaved session has no `/resume` entry to
 * describe, so it must not pay for a summary request at all.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { getEngineSessionStats } from "../src/modes/interactive-engine/engine-session-stats.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";

/** Long enough for a summary request that was going to start to have been sent. */
const SUMMARY_SETTLE_MS = 250;

let pair: EngineHostPair | undefined;
let sessionDir: string | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
	if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
	sessionDir = undefined;
});

async function sendTurn(current: EngineHostPair, text: string): Promise<void> {
	await current.runtime.session.prompt(text);
	await vi.waitFor(() => assert.equal(current.engine.session.isStreaming, false));
	await current.drain();
}

async function startSession(current: EngineHostPair): Promise<void> {
	await current.engine.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await current.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await current.runtime.initializeFromEngine();
}

function summaryCount(current: EngineHostPair): number {
	return current.engine.sessionManager.getEntries().filter((entry) => entry.type === "session_summary").length;
}

test("the host's session stats include a session summary's usage as soon as it is saved (#4726)", async () => {
	sessionDir = mkdtempSync(join(tmpdir(), "atomic-4726-"));
	const engineManager = await SessionManager.create(sessionDir, sessionDir);
	pair = await createEngineHostPair({
		sessionManager: engineManager,
		hostSessionManager: await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId()),
	});
	pair.engine.setResponses([
		fauxAssistantMessage("alpha"),
		fauxAssistantMessage("beta"),
		fauxAssistantMessage("Two words were exchanged"),
	]);
	await startSession(pair);
	await sendTurn(pair, "Reply with exactly: alpha");
	await sendTurn(pair, "Reply with exactly: beta");

	await vi.waitFor(() => assert.equal(summaryCount(pair!), 1));
	const summary = pair.engine.sessionManager.getEntries().find((entry) => entry.type === "session_summary");
	assert.ok(summary?.type === "session_summary" && (summary.usage?.input ?? 0) > 0, "the summary records its usage");
	await pair.drain();

	const host = pair.runtime.session;
	const engineStats = JSON.parse(JSON.stringify(pair.engine.session.getSessionStats()));
	await vi.waitFor(() => assert.deepEqual(getEngineSessionStats(host), engineStats));
});

test("a --no-session session sends no session summary request (#4726)", async () => {
	pair = await createEngineHostPair({});
	pair.engine.setResponses([
		fauxAssistantMessage("alpha"),
		fauxAssistantMessage("beta"),
		fauxAssistantMessage("Unwanted summary"),
	]);
	await startSession(pair);
	assert.equal(pair.engine.sessionManager.isPersisted(), false);
	await sendTurn(pair, "Reply with exactly: alpha");
	await sendTurn(pair, "Reply with exactly: beta");
	await new Promise((resolve) => setTimeout(resolve, SUMMARY_SETTLE_MS));

	assert.equal(pair.engine.getPendingResponseCount(), 1, "the summary response is never requested");
	assert.equal(summaryCount(pair), 0);
});
