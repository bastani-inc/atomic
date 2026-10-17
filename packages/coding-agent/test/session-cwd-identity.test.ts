import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createSessionManager } from "../src/main-session.ts";

for (const adapter of ["memory", "jsonl", "sqlite"] as const) {
	test(`${adapter} session lookup treats symlinked project directories as the same project`, async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-session-cwd-")));
		const cwd = join(root, "project");
		const alias = join(root, "alias");
		await mkdir(cwd);
		await symlink(cwd, alias, "junction");
		const store = await resolveSessionStore(cwd, {
			sessionStore:
				adapter === "memory"
					? { kind: "memory" }
					: adapter === "jsonl"
						? { kind: "jsonl", dir: join(root, "sessions") }
						: { kind: "sqlite", path: join(root, "sessions.sqlite") },
		});
		try {
			const saved = await SessionManager.create(store, alias, { id: "saved" });
			await SessionManager.create(store, join(root, "other"), { id: "foreign" });
			assert.equal((await store.readHeader("saved"))?.cwd, alias);
			assert.deepEqual(
				(await SessionManager.list(cwd, store)).map((session) => session.id),
				["saved"],
			);
			assert.equal((await store.findMostRecent({ cwd }))?.id, "saved");
			assert.equal((await SessionManager.continueRecent(store, cwd)).getSessionId(), "saved");
			assert.equal(
				(
					await createSessionManager(
						parseArgs(["--session-id", "saved"]),
						cwd,
						undefined,
						SettingsManager.inMemory(),
						store,
					)
				).getSessionId(),
				saved.getSessionId(),
			);
			// Match in the reverse direction too, including sessions saved before canonical lookup existed.
			await SessionManager.create(store, cwd, { id: "physical" });
			assert.deepEqual((await SessionManager.list(alias, store)).map((session) => session.id).sort(), [
				"physical",
				"saved",
			]);
			// Deleted project directories retain lexical matching and never make listing throw.
			await rm(alias);
			await rm(cwd, { recursive: true });
			assert.deepEqual(
				(await SessionManager.list(cwd, store)).map((session) => session.id),
				["physical"],
			);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("a portable store without a filesystem matcher retains exact cwd matching", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-portable-cwd-")));
	const alias = join(root, "alias");
	await symlink(root, alias, "junction");
	const store = new MemorySessionStore();
	try {
		await store.create({ id: "saved", version: 4, createdAt: "2026-10-16T00:00:00Z", cwd: alias }, []);
		assert.equal(await store.findMostRecent({ cwd: root }), undefined);
		assert.equal((await store.findMostRecent({ cwd: alias }))?.id, "saved");
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});
