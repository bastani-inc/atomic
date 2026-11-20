import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { buildSessionProjection } from "../src/core/session-manager-history.ts";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "../src/core/session-manager-types.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";

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

test('loadFullHistory() and { history: "full" } still hold every stored entry for a caller that needs them all (#5554)', async () => {
	const runtime = await runtimeWithCompactedSessions(["kept", "switched", "woken"]);
	const manager = runtime.session.sessionManager;
	const store = manager.getSessionStore();
	const full = { history: "full" } as const;
	const holdsEveryEntry = (opened: SessionManager) => {
		assert.equal(opened.hasFullHistory(), true);
		assert.deepEqual(ids(opened.getEntries()).slice(0, history.length), ids(history));
		assert.deepEqual(opened.getEntry("early"), history[0]);
	};

	holdsEveryEntry(await SessionManager.open(store, "kept", undefined, full));
	holdsEveryEntry(await manager.openSessionById("kept", undefined, undefined, full));
	holdsEveryEntry((await runtime.rehydrate("woken", full)).sessionManager);
	await runtime.switchSession("switched", full);
	holdsEveryEntry(runtime.session.sessionManager);

	// A window loads the rest on request, once for concurrent callers, and keeps it.
	const window = await SessionManager.open(store, "kept");
	assert.equal(window.hasFullHistory(), false);
	const loading = window.loadFullHistory();
	assert.equal(window.loadFullHistory(), loading);
	await loading;
	holdsEveryEntry(window);
	assert.equal(window.getLeafId(), "later");

	// A branch copy still takes only "tail".
	await assert.rejects(window.createBranchedSession("later", full as unknown as { readonly history: "tail" }), {
		name: "TypeError",
		message: /accepts only history: "tail"/,
	});
});

test("RPC import_session continues from the imported session's window and returns what the whole session showed (#5554)", async () => {
	const runtime = await runtimeWithCompactedSessions([]);
	const directory = runtime.session.sessionManager.getCwd();
	const file = join(directory, "import.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "imported",
		createdAt: stamp,
		cwd: directory,
	};
	writeFileSync(file, `${[header, ...history].map((line) => JSON.stringify(line)).join("\n")}\n`);
	const handle = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => runtime.session,
		rebindSession: async () => {},
		output: () => {},
	});

	const imported = await handle({ type: "import_session", inputPath: file });
	assert.deepEqual(imported, {
		id: undefined,
		type: "response",
		command: "import_session",
		success: true,
		data: { cancelled: false, notices: [] },
	});
	const manager = runtime.session.sessionManager;
	assert.equal(manager.getSessionId(), "imported");
	// Only the window stays resident; the conversation before the boundary stays in the store.
	assert.equal(manager.hasFullHistory(), false);
	assert.equal(manager.getEntry("early"), undefined);
	assert.deepEqual(await manager.readEntry("early"), history[0]);
	const messages = await handle({ type: "get_messages" });
	assert.ok(messages?.success && messages.command === "get_messages");
	// What a manager holding every imported entry projected for the model.
	assert.deepEqual(messages.data.messages, buildSessionProjection(history, "later", undefined, "imported").messages);
});
