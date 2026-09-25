import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	CACHE_PREFIX_CUSTOM_TYPE,
	type CachePrefixFingerprint,
	describeCachePrefixDifference,
	isCachePrefixFingerprint,
	reconstructMessageHashes,
} from "../../../src/core/cache-prefix-fingerprint.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";

function cachePrefixEntryCount(sessionManager: Pick<SessionManager, "getEntries">): number {
	return sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === CACHE_PREFIX_CUSTOM_TYPE).length;
}

function cachePrefixFingerprints(entries: ReturnType<SessionManager["getEntries"]>): CachePrefixFingerprint[] {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === CACHE_PREFIX_CUSTOM_TYPE)
		.map((entry) => (entry as { data?: unknown }).data)
		.filter(isCachePrefixFingerprint);
}

describe("issue #3261: a stale host-side session snapshot must not hide cache-prefix attribution", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("getFreshEntries sees the cache_prefix entry a stale snapshot was opened before", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-3261-live-attribution-"));
		cleanups.push(async () => rmSync(cwd, { recursive: true, force: true }));
		const faux = registerFauxProvider();
		cleanups.push(async () => faux.unregister());
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		modelRuntime.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const settingsManager = SettingsManager.inMemory();
		const sessionDir = join(cwd, "sessions");
		// A persisted session, matching the interactive TUI host's on-disk session
		// file rather than the in-memory sessions most other #3261 tests use.
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const resourceLoader = createTestResourceLoader({ systemPrompt: "You are a test assistant." });
		faux.setResponses([{ role: "assistant", content: [{ type: "text", text: "ok" }] } as never]);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader,
			modelRuntime,
			settingsManager,
			sessionManager,
			model: faux.getModel(),
		});
		cleanups.push(() => session.dispose());
		session.setActiveToolsByName(["read"]);
		faux.setResponses([
			{ role: "assistant", content: [{ type: "text", text: "one" }] } as never,
			{ role: "assistant", content: [{ type: "text", text: "two" }] } as never,
		]);

		await session.prompt("first turn");
		// A second SessionManager over the same file, opened once and never
		// re-synced except through getFreshEntries(): the same timing gap
		// IsolatedInteractiveRuntime.refreshSessionView leaves between message_end
		// (live notice) and agent_end (its next resync).
		const hostView = SessionManager.open(sessionManager.getSessionFile()!, sessionDir, cwd);
		assert.equal(cachePrefixEntryCount(hostView), 1, "the host snapshot sees the first request's cache_prefix entry");

		session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
		await session.prompt("second turn");

		assert.equal(
			cachePrefixEntryCount(hostView),
			1,
			"a stale snapshot's own cached entries never grow: it does not see the second request's cache_prefix entry",
		);
		assert.equal(
			cachePrefixEntryCount({ getEntries: () => hostView.getFreshEntries() }),
			2,
			"a fresh read at message_end sees the entry the engine appended for the second request",
		);

		const freshFingerprints = cachePrefixFingerprints(hostView.getFreshEntries());
		assert.equal(freshFingerprints.length, 2);
		assert.equal(
			describeCachePrefixDifference(
				freshFingerprints[0],
				reconstructMessageHashes(freshFingerprints[0], []),
				freshFingerprints[1],
			),
			"tool list changed: +bash",
			"a fresh read must show the real attribution, matching what resume shows later",
		);
	});
});
