import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { getMissingSessionCwdIssue, type MissingSessionCwdChoice } from "../src/core/session-cwd.ts";
import { ownedSessionManagerStores } from "../src/core/session-lifecycle-work.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { createSessionManager, openSessionInCurrentCwdOrExit } from "../src/main-session.ts";

const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) await store.close().catch(() => undefined);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({})) ids.push(summary.id);
	return ids.sort();
}

/** A session recorded in a project that was renamed away, opened the way `--session <id>` opens it from the new cwd. */
async function openRenamedAwaySession() {
	const root = mkdtempSync(join(tmpdir(), "atomic-startup-missing-cwd-"));
	roots.push(root);
	const cwd = join(root, "renamed-to");
	const missingCwd = join(root, "renamed-from");
	mkdirSync(cwd, { recursive: true });
	const directory = join(root, "sessions");
	const original = await SessionManager.create(missingCwd, directory);
	await original.appendMessage({ role: "user", content: "written before the rename", timestamp: 1 });
	await original.getSessionStore().close();

	const opened = await createSessionManager(
		parseArgs(["--session", original.getSessionId()]),
		cwd,
		directory,
		SettingsManager.inMemory(),
	);
	stores.push(opened.getSessionStore());
	const issue = getMissingSessionCwdIssue(opened, cwd);
	assert(issue, "the renamed-away session reports a missing cwd");
	return {
		cwd,
		missingCwd,
		opened,
		issue,
		originalId: original.getSessionId(),
		originalEntries: original.getEntries(),
	};
}

test("forking a session whose cwd is missing copies it into the current cwd and keeps the original (earendil-works/pi#11060)", async () => {
	const { cwd, missingCwd, opened, issue, originalId, originalEntries } = await openRenamedAwaySession();
	const store = opened.getSessionStore();

	const forked = await openSessionInCurrentCwdOrExit(opened, issue, "fork");

	assert(forked);
	assert.notEqual(forked.getSessionId(), originalId);
	assert.equal(forked.getCwd(), cwd);
	assert.equal(forked.getSessionStore(), store);
	assert.deepEqual(forked.getEntries(), originalEntries);
	assert.equal((await store.load(forked.getSessionId())).header.parentSessionId, originalId);
	const original = await store.load(originalId);
	assert.equal(original.header.cwd, missingCwd);
	assert.deepEqual(original.entries, originalEntries);
	assert.deepEqual(await listIds(store), [originalId, forked.getSessionId()].sort());
	assert.equal(getMissingSessionCwdIssue(forked, cwd), undefined);
});

test("the fork inherits the store ownership of the session it replaces, and claims none otherwise", async () => {
	const { opened, issue } = await openRenamedAwaySession();
	const store = opened.getSessionStore();
	assert.equal(ownedSessionManagerStores.get(opened), store, "the CLI owns the store it opened the session from");

	const owned = await openSessionInCurrentCwdOrExit(opened, issue, "fork");
	assert(owned);
	assert.equal(ownedSessionManagerStores.get(owned), store);

	ownedSessionManagerStores.delete(opened);
	const unowned = await openSessionInCurrentCwdOrExit(opened, issue, "fork");
	assert(unowned);
	assert.equal(ownedSessionManagerStores.get(unowned), undefined);
});

test("continuing reopens the same session in the current cwd without writing a copy (earendil-works/pi#11060)", async () => {
	const { cwd, opened, issue, originalId, originalEntries } = await openRenamedAwaySession();

	const continued = await openSessionInCurrentCwdOrExit(opened, issue, "continue");

	assert(continued);
	assert.equal(continued.getSessionId(), originalId);
	assert.equal(continued.getCwd(), cwd);
	assert.deepEqual(continued.getEntries(), originalEntries);
	assert.deepEqual(await listIds(opened.getSessionStore()), [originalId]);
	if (continued.getSessionStore() !== opened.getSessionStore()) stores.push(continued.getSessionStore());
});

test("cancelling the prompt exits with status 0 and writes nothing (earendil-works/pi#11060)", async () => {
	const { opened, issue, originalId } = await openRenamedAwaySession();
	const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit(${code})`);
	});
	const cancel: MissingSessionCwdChoice | undefined = undefined;

	await assert.rejects(openSessionInCurrentCwdOrExit(opened, issue, cancel), /process\.exit\(0\)/);

	assert.deepEqual(exit.mock.calls, [[0]]);
	assert.deepEqual(await listIds(opened.getSessionStore()), [originalId]);
});
