import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { openCliSession, sessionStored } from "../src/main-session.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A store whose `create` waits until `release()`, then succeeds, or fails with `failure` when one is given. */
function gatedStore(failure?: Error) {
	const store = new MemorySessionStore();
	const create = store.create.bind(store);
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let created = false;
	store.create = (async (...args: Parameters<SessionStore["create"]>) => {
		await released;
		if (failure !== undefined) throw failure;
		const result = await create(...args);
		created = true;
		return result;
	}) as SessionStore["create"];
	return { store, release, created: () => created };
}

test("a session whose create was started is returned before the store holds it, and its writes wait for the create", async () => {
	const { store, release, created } = gatedStore();
	const { manager, stored } = SessionManager.startCreate(store, "/project");
	assert.equal(created(), false);
	assert.equal(manager.startedSession(), false, "started once the store holds it");
	assert.deepEqual(manager.getEntries(), []);
	const appended = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	let settled = false;
	void stored.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(settled, false);
	release();
	await stored;
	assert.equal(created(), true);
	assert.equal(manager.startedSession(), true);
	await appended;
	const loaded = await store.load(manager.getSessionId());
	assert.deepEqual(
		loaded.entries.map((entry) =>
			entry.type === "message" && "content" in entry.message ? entry.message.content : "",
		),
		["first"],
	);
});

test("a started create that fails rejects its stored promise and every write, and writes nothing", async () => {
	const failure = new Error("store refused the session");
	const { store, release } = gatedStore(failure);
	const { manager, stored } = SessionManager.startCreate(store, "/project");
	const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	release();
	await assert.rejects(stored, failure);
	await assert.rejects(first, failure);
	await assert.rejects(manager.appendMessage({ role: "user", content: "second", timestamp: 2 }), failure);
	assert.equal(await store.readHeader(manager.getSessionId()), undefined);
});

test("openCliSession starts a new session's create only when asked, and sessionStored settles with it", async () => {
	const root = mkdtempSync(join(tmpdir(), "start-create-"));
	roots.push(root);
	const settingsManager = SettingsManager.inMemory();
	for (const startCreate of [false, true]) {
		const { store, release, created } = gatedStore();
		const opening = openCliSession(parseArgs([]), root, settingsManager, {
			agentDir: join(root, "agent"),
			sessionStorage: store,
			trusted: () => true,
			blueprints: "skip",
			startCreate,
		});
		if (startCreate) {
			const opened = await opening;
			assert.ok(opened !== "cancelled");
			assert.equal(created(), false, "returned while the create is under way");
			const stored = sessionStored(opened.sessionManager);
			release();
			await stored;
			assert.equal(created(), true);
		} else {
			let returned = false;
			void opening.then(() => {
				returned = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(returned, false, "waits for the create");
			release();
			const opened = await opening;
			assert.ok(opened !== "cancelled");
			assert.equal(created(), true);
			await sessionStored(opened.sessionManager);
		}
	}
});
