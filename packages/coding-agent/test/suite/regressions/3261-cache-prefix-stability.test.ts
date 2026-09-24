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
} from "../../../src/core/cache-prefix-fingerprint.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";

async function buildSession(options: { forceSystemPrompt?: boolean }) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-3261-cache-prefix-"));
	const faux = registerFauxProvider();
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
	const sessionManager = SessionManager.inMemory(cwd);
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
		...(options.forceSystemPrompt ? { systemPromptTransform: () => "Forced system prompt." } : {}),
	});
	session.setActiveToolsByName(["read"]);
	faux.setResponses([
		{ role: "assistant", content: [{ type: "text", text: "one" }] } as never,
		{ role: "assistant", content: [{ type: "text", text: "two" }] } as never,
		{ role: "assistant", content: [{ type: "text", text: "three" }] } as never,
	]);
	return {
		session,
		sessionManager,
		cleanup: async () => {
			await session.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function cachePrefixFingerprints(sessionManager: SessionManager): CachePrefixFingerprint[] {
	return sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === CACHE_PREFIX_CUSTOM_TYPE)
		.map((entry) => (entry as { data?: unknown }).data)
		.filter(isCachePrefixFingerprint);
}

describe("issue #3261: request prefix stability across turns", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keeps the request prefix stable across ordinary append-only turns", async () => {
		const { session, sessionManager, cleanup } = await buildSession({});
		cleanups.push(cleanup);

		await session.prompt("first turn");
		await session.prompt("second turn");

		const fingerprints = cachePrefixFingerprints(sessionManager);
		assert.ok(fingerprints.length >= 2, "expected a persisted cache_prefix entry for each request");
		assert.equal(describeCachePrefixDifference(fingerprints[0], fingerprints[1]), "prefix unchanged");
	});

	it("attributes a mid-run tool addition to the tool list, not the system prompt, in a normal session", async () => {
		const { session, sessionManager, cleanup } = await buildSession({});
		cleanups.push(cleanup);

		await session.prompt("first turn");
		session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
		await session.prompt("second turn");

		const fingerprints = cachePrefixFingerprints(sessionManager);
		assert.ok(fingerprints.length >= 2);
		const attribution = describeCachePrefixDifference(fingerprints[0], fingerprints[fingerprints.length - 1]);
		assert.equal(attribution, "tool list changed: +bash");
	});

	it("keeps the tool-addition attribution stable in a forced-system-prompt session (#3261 cause 2)", async () => {
		const { session, sessionManager, cleanup } = await buildSession({ forceSystemPrompt: true });
		cleanups.push(cleanup);

		await session.prompt("first turn");
		session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
		await session.prompt("second turn");

		const fingerprints = cachePrefixFingerprints(sessionManager);
		assert.ok(fingerprints.length >= 2);
		const attribution = describeCachePrefixDifference(fingerprints[0], fingerprints[fingerprints.length - 1]);
		assert.equal(
			attribution,
			"tool list changed: +bash",
			"forced-prompt tool changes must not rewrite the request prefix as a system-prompt change",
		);
	});
});
