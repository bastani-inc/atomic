/**
 * Interactive mode runs its session in an engine process and mirrors it in the host. `/reload` resynchronizes the
 * host from the engine, which still holds the whole conversation, so the transcript view and the `/session` stats must
 * survive it whether or not the session is saved (#4703).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getApiProvider, registerApiProvider } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getEngineSessionStats } from "../src/modes/interactive-engine/engine-session-stats.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { getMessageText } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

let pair: EngineHostPair | undefined;
let sessionDir: string | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
	if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
	sessionDir = undefined;
});

/** An engine resource loader that, like the real one, loads a fresh extension runtime on each reload. */
function reloadableResourceLoader(): ResourceLoader {
	let extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		...createTestResourceLoader(),
		getExtensions: () => extensions,
		reload: async () => {
			extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		},
	};
}

/** What the host shows: the transcript `/reload` rebuilds from the host session's entries, as role/text pairs. */
function transcript(session: AgentSession): string[] {
	return session.sessionManager
		.buildContextEntries()
		.flatMap((entry) =>
			entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
				? [`${entry.message.role}: ${getMessageText(entry.message)}`]
				: [],
		);
}

async function sendTurn(current: EngineHostPair, text: string): Promise<void> {
	await current.runtime.session.prompt(text);
	await vi.waitFor(() => assert.equal(current.engine.session.isStreaming, false));
	await current.drain();
}

async function startTwoTurnSession(current: EngineHostPair): Promise<void> {
	current.engine.setResponses([fauxAssistantMessage("alpha"), fauxAssistantMessage("beta")]);
	await current.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await current.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await current.runtime.initializeFromEngine();
	await sendTurn(current, "Reply with exactly: alpha");
	await sendTurn(current, "Reply with exactly: beta");
}

const TWO_TURNS = [
	"user: Reply with exactly: alpha",
	"assistant: alpha",
	"user: Reply with exactly: beta",
	"assistant: beta",
];

test("/reload keeps the transcript and /session stats of a --no-session session (#4703)", async () => {
	pair = await createEngineHostPair({ resourceLoader: reloadableResourceLoader() });
	await startTwoTurnSession(pair);
	const host = pair.runtime.session;
	assert.equal(host.sessionManager.isPersisted(), false);

	await host.reload();
	await pair.drain();

	assert.deepEqual(transcript(host), TWO_TURNS);
	assert.equal(host.sessionManager.getSessionId(), pair.engine.session.sessionId);
	assert.deepEqual(
		host.messages.flatMap((message) =>
			message.role === "user" || message.role === "assistant" ? [`${message.role}: ${getMessageText(message)}`] : [],
		),
		TWO_TURNS,
	);
	const stats = getEngineSessionStats(host);
	assert.ok(stats, "the engine's session stats are fetched again right after the reload");
	assert.equal(stats.userMessages, 2);
	assert.equal(stats.assistantMessages, 2);
	assert.deepEqual(stats, JSON.parse(JSON.stringify(pair.engine.session.getSessionStats())));
	assert.ok((stats.contextUsage?.tokens ?? 0) > 0, "the context indicator reflects the conversation");
});

test("a turn after /reload of a --no-session session shows the full history once (#4703)", async () => {
	pair = await createEngineHostPair({ resourceLoader: reloadableResourceLoader() });
	await startTwoTurnSession(pair);
	const host = pair.runtime.session;
	const fauxProvider = getApiProvider(pair.engine.faux.api);
	assert.ok(fauxProvider);
	await host.reload();
	await pair.drain();
	// A reload resets the API providers; the test's faux provider is not an extension that registers itself again.
	registerApiProvider(fauxProvider);

	pair.engine.appendResponses([fauxAssistantMessage("beta again")]);
	await sendTurn(pair, "What was the second word?");

	assert.deepEqual(transcript(host), [...TWO_TURNS, "user: What was the second word?", "assistant: beta again"]);
	assert.equal(host.messages.length, pair.engine.session.messages.length);
	await vi.waitFor(() => assert.equal(getEngineSessionStats(host)?.userMessages, 3));
});

test("/reload keeps the transcript of a saved session (#4703)", async () => {
	sessionDir = mkdtempSync(join(tmpdir(), "atomic-4703-"));
	const engineManager = await SessionManager.create(sessionDir, sessionDir);
	pair = await createEngineHostPair({
		sessionManager: engineManager,
		resourceLoader: reloadableResourceLoader(),
		hostSessionManager: await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId()),
	});
	await startTwoTurnSession(pair);
	const host = pair.runtime.session;
	assert.equal(host.sessionManager.isPersisted(), true);

	await host.reload();
	await pair.drain();

	assert.deepEqual(transcript(host), TWO_TURNS);
	assert.equal(host.sessionManager.getSessionId(), engineManager.getSessionId());
	assert.equal(getEngineSessionStats(host)?.userMessages, 2);
});
