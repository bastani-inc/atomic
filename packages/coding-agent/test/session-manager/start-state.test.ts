import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";

const directories: string[] = [];
/** Ids `randomUUID` returns next, before it returns random ones again. */
const queuedUuids = vi.hoisted((): string[] => []);

vi.mock("node:crypto", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:crypto")>();
	return {
		...original,
		randomUUID: () => (queuedUuids.shift() ?? original.randomUUID()) as ReturnType<typeof original.randomUUID>,
	};
});

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function countedSession() {
	const directory = mkdtempSync(join(tmpdir(), "session-start-state-"));
	directories.push(directory);
	const manager = await SessionManager.create("/project", directory);
	const store = manager.getSessionStore();
	const appends: number[] = [];
	const append = store.append.bind(store);
	store.append = (sessionId, entries, options) => {
		appends.push(entries.length);
		return append(sessionId, entries, options);
	};
	return { manager, appends, directory };
}

async function reloaded(directory: string, sessionId: string) {
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
	try {
		return await store.load(sessionId);
	} finally {
		await store.close();
	}
}

describe("SessionManager.appendStartState (#4319)", () => {
	it("records the model and then the thinking level a new session starts on, in one store write", async () => {
		const { manager, appends, directory } = await countedSession();
		await manager.appendStartState({ provider: "anthropic", modelId: "claude" }, "high");

		assert.deepEqual(appends, [2]);
		const [model, thinking] = manager.getEntries();
		assert.equal(manager.getEntries().length, 2);
		assert.equal(model?.type, "model_change");
		assert.equal(model.type === "model_change" && model.provider, "anthropic");
		assert.equal(model.type === "model_change" && model.modelId, "claude");
		assert.equal(model.parentId, null);
		assert.equal(thinking?.type, "thinking_level_change");
		assert.equal(thinking.type === "thinking_level_change" && thinking.thinkingLevel, "high");
		assert.equal(thinking.parentId, model.id);
		assert.notEqual(thinking.id, model.id);
		assert.equal(manager.getLeafId(), thinking.id);
		assert.equal(manager.getEntry(model.id), model);
		assert.equal(manager.getEntry(thinking.id), thinking);

		const snapshot = await reloaded(directory, manager.getSessionId());
		assert.deepEqual(snapshot.entries, [model, thinking]);
		assert.equal(snapshot.lastSeq, 2);
	});

	it("records only the thinking level when the session starts on no model", async () => {
		const { manager, appends, directory } = await countedSession();
		await manager.appendStartState(undefined, "off");

		assert.deepEqual(appends, [1]);
		const entries = manager.getEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.type, "thinking_level_change");
		assert.equal(entries[0].parentId, null);
		assert.equal(manager.getLeafId(), entries[0].id);
		assert.deepEqual((await reloaded(directory, manager.getSessionId())).entries, entries);
	});

	it("continues the session's chain and its sequence after the start state", async () => {
		const { manager, appends, directory } = await countedSession();
		await manager.appendStartState({ provider: "anthropic", modelId: "claude" }, "low");
		const messageId = await manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		assert.deepEqual(appends, [2, 1]);
		const entries = manager.getEntries();
		assert.equal(entries[2]?.id, messageId);
		assert.equal(entries[2].parentId, entries[1]?.id);
		const snapshot = await reloaded(directory, manager.getSessionId());
		assert.equal(snapshot.lastSeq, 3);
		assert.deepEqual(snapshot.entries, entries);
	});

	it("never gives its two entries the same id", async () => {
		const { manager } = await countedSession();
		queuedUuids.push(
			"11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		);
		await manager.appendStartState({ provider: "anthropic", modelId: "claude" }, "low");
		const [model, thinking] = manager.getEntries();
		assert.equal(model?.id, "11111111");
		assert.equal(thinking?.id, "22222222");
	});
});
