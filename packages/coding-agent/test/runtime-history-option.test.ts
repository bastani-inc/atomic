import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionHistoryNotLoadedError, SessionManager } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";

useTemporaryAgentDir();

const stamp = "2026-11-16T00:00:00.000Z";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function user(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: id, timestamp: 1 } };
}

const history: SessionEntry[] = [
	user("early", null),
	user("kept", "early"),
	{
		type: "compaction",
		id: "boundary",
		parentId: "kept",
		timestamp: stamp,
		summary: "summary",
		tokensBefore: 10,
		firstKeptEntryId: "kept",
		details: { strategy: "verbatim-lines" },
	},
	user("later", "boundary"),
];

async function runtimeWithCompactedSessions(ids: readonly string[]) {
	const dir = mkdtempSync(join(tmpdir(), "runtime-history-"));
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	const store = new MemorySessionStore();
	for (const id of ids) await store.create({ id, version: 4, createdAt: stamp, cwd: dir }, history);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services =
			options.services ??
			(await createAgentSessionServices({
				cwd: options.cwd,
				agentDir: dir,
				modelRuntime,
				resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noPromptTemplates: true, noThemes: true },
			}));
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model: faux.getModel(),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: await SessionManager.create(store, dir),
	});
	cleanups.push(async () => {
		await runtime.dispose();
		await store.close();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});
	return runtime;
}

const ids = (entries: readonly SessionEntry[]) => entries.map((entry) => entry.id);

test("runtime.switchSession and rehydrate always keep the window, with history available on demand (#5554)", async () => {
	const runtime = await runtimeWithCompactedSessions(["switched", "tail-switched", "woken", "tail-woken"]);

	const woken = await runtime.rehydrate("woken");
	assert.equal(woken.sessionManager.hasFullHistory(), false);
	assert.equal(woken.sessionManager.getEntry("early"), undefined);
	assert.deepEqual(await woken.sessionManager.readEntry("early"), history[0]);

	const tailWoken = await runtime.rehydrate("tail-woken", { history: "tail" });
	assert.equal(tailWoken.sessionManager.hasFullHistory(), false);
	assert.throws(() => tailWoken.getUserMessagesForForking(), SessionHistoryNotLoadedError);
	const stored: SessionEntry[] = [];
	for await (const { items } of tailWoken.sessionManager.readHistory({ toSeq: history.length })) {
		for (const item of items) if ("entry" in item) stored.push(item.entry);
	}
	assert.deepEqual(ids(stored), ids(history));
	assert.equal(tailWoken.sessionManager.getEntry("early"), undefined);

	await runtime.switchSession("switched");
	assert.equal(runtime.session.sessionManager.hasFullHistory(), false);
	assert.equal(runtime.session.sessionManager.getEntry("early"), undefined);
	assert.deepEqual(await runtime.session.sessionManager.readEntry("early"), history[0]);

	await runtime.switchSession("tail-switched", { history: "tail" });
	const manager = runtime.session.sessionManager;
	assert.equal(manager.hasFullHistory(), false);
	assert.ok(manager.getEntries().length < manager.getLastSeq());
	assert.equal(manager.getEntry("early"), undefined);
});

test('{ history: "full" } is refused before any session opens, switches or wakes, instead of yielding the window (#5554)', async () => {
	const runtime = await runtimeWithCompactedSessions(["kept", "other"]);
	const manager = runtime.session.sessionManager;
	const store = manager.getSessionStore();
	// A JavaScript caller, or a cast, still reaches the removed value at runtime.
	const full = { history: "full" } as unknown as { readonly history: "tail" };
	const removed = { name: "TypeError", message: /"full" has been removed.*readHistory\(\)/ };

	await assert.rejects(SessionManager.open(store, "kept", undefined, full), removed);
	await assert.rejects(manager.openSessionById("kept", undefined, undefined, full), removed);
	await assert.rejects(SessionManager.continueRecent(store, manager.getCwd(), full), removed);
	await assert.rejects(manager.createBranchedSession(manager.getLeafId() ?? "", full), removed);

	const before = runtime.session.sessionId;
	await assert.rejects(runtime.switchSession("other", full), removed);
	assert.equal(runtime.session.sessionId, before);
	await assert.rejects(runtime.rehydrate("other", full), removed);
	assert.equal(runtime.rehydratedSessionCount, 0);

	// The method itself is gone, so a call fails instead of returning with only the window.
	assert.equal("loadFullHistory" in manager, false);
	const opened = await SessionManager.open(store, "kept");
	assert.equal(opened.hasFullHistory(), false);
	assert.throws(() => (opened as unknown as { loadFullHistory(): Promise<void> }).loadFullHistory(), TypeError);
});
