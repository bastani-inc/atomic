import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@bastani/pi-ai";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
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
import type { ExtensionFactory } from "../../../src/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";

function reportedUsage(cacheWrite: number): Usage {
	return {
		input: 100,
		output: 2,
		cacheRead: 0,
		cacheWrite,
		totalTokens: 102 + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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

	it("the isolated TUI host's live notice matches resume after the engine persisted the message (#3261)", async () => {
		initTheme("dark");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-3261-live-notice-"));
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
		const cacheWrites = [30_000, 31_000];
		const providerReportsNoCacheRead: ExtensionFactory = (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				return { message: { ...event.message, usage: reportedUsage(cacheWrites.shift() ?? 0) } };
			});
		};
		const sessionDir = join(cwd, "sessions");
		const engineSessionManager = SessionManager.create(cwd, sessionDir);
		const { session: engine } = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader({
				systemPrompt: "You are a test assistant.",
				extensionsResult: await createTestExtensionsResult([providerReportsNoCacheRead], cwd),
			}),
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: engineSessionManager,
			model: faux.getModel(),
		});
		cleanups.push(() => engine.dispose());
		const relayed: AgentSessionEvent[] = [];
		engine.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant")
				relayed.push(JSON.parse(JSON.stringify(event)) as AgentSessionEvent);
		});
		engine.setActiveToolsByName(["read"]);
		faux.setResponses([
			{ role: "assistant", content: [{ type: "text", text: "one" }] } as never,
			{ role: "assistant", content: [{ type: "text", text: "two" }] } as never,
		]);

		const chatContainer = new Container();
		const host = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			footer: { invalidate: () => {} },
			chatContainer,
			ui: { requestRender: () => {} },
		}) as { runtimeHost: object; handleEvent(event: AgentSessionEvent): Promise<void> };
		const liveNotices = async (event: AgentSessionEvent): Promise<string[]> => {
			chatContainer.clear();
			await host.handleEvent(event);
			return chatContainer.children.map((child) => stripAnsi(child.render(200).join("")).trim());
		};

		await engine.prompt("first turn");
		host.runtimeHost = {
			session: {
				sessionManager: SessionManager.open(engineSessionManager.getSessionFile()!, sessionDir, cwd),
				settingsManager: { getShowCacheMissNotices: () => true },
				modelRuntime,
			},
		};
		assert.deepEqual(await liveNotices(relayed[0]), [], "a first request has no previous prefix to miss");

		engine.setActiveToolsByName([...engine.getActiveToolNames(), "bash"]);
		await engine.prompt("second turn");
		assert.deepEqual(await liveNotices(relayed[1]), [
			"Prompt cache miss (tool list changed: +bash): 30,100 tokens re-billed ($0.000)",
		]);
	});
});
