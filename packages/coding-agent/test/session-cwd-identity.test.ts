import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { findMostRecentSession, SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createSessionManager } from "../src/main-session.ts";

for (const input of ["home shorthand", "file URL"] as const) {
	for (const operation of ["findById", "list", "startup", "findMostRecentSession"] as const) {
		test(`session manager ${operation} retrieves sessions created with ${input} (#3710)`, async () => {
			const root = await mkdtemp(join(tmpdir(), "atomic-session-input-"));
			const previousHome = process.env.HOME;
			const previousUserProfile = process.env.USERPROFILE;
			try {
				process.env.HOME = root;
				process.env.USERPROFILE = root;
				const project = join(root, "project");
				await mkdir(project);
				const cwd = input === "home shorthand" ? "~/project" : pathToFileURL(project).href;
				const directory = join(root, "sessions");
				const manager = await SessionManager.create(cwd, directory, { id: "saved" });
				await manager.getSessionStore().close();
				if (operation === "findById") {
					const expected = await SessionManager.findById(project, "saved", directory);
					assert.ok(expected);
					assert.equal(await SessionManager.findById(cwd, "saved", directory), expected);
				} else if (operation === "findMostRecentSession") {
					const expected = findMostRecentSession(directory, project);
					assert.ok(expected);
					assert.equal(findMostRecentSession(directory, cwd), expected);
				} else if (operation === "startup") {
					const resumed = await createSessionManager(
						parseArgs(["--session-id", "saved"]),
						cwd,
						directory,
						SettingsManager.inMemory(),
					);
					try {
						assert.equal(resumed.getSessionId(), "saved");
					} finally {
						await resumed.getSessionStore().close();
					}
				} else {
					assert.deepEqual(
						(await SessionManager.list(project, directory)).map((session) => session.id),
						["saved"],
					);
					assert.deepEqual(
						(await SessionManager.list(cwd, directory)).map((session) => session.id),
						["saved"],
					);
				}
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
				await rm(root, { recursive: true, force: true });
			}
		});
	}
}

for (const adapter of ["memory", "jsonl", "sqlite"] as const) {
	test(`${adapter} session lookup treats symlinked project directories as the same project`, async () => {
		let store: SessionStore | undefined;
		let root = await mkdtemp(join(tmpdir(), "atomic-session-cwd-"));
		try {
			root = await realpath(root);
			const cwd = join(root, "project");
			const alias = join(root, "alias");
			await mkdir(cwd);
			await symlink(cwd, alias, "junction");
			store = await resolveSessionStore(cwd, {
				sessionStore:
					adapter === "memory"
						? { kind: "memory" }
						: adapter === "jsonl"
							? { kind: "jsonl", dir: join(root, "sessions") }
							: { kind: "sqlite", path: join(root, "sessions.sqlite") },
			});
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
			try {
				await store?.close();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});
}

test("a portable store without a filesystem matcher retains exact cwd matching", async () => {
	let store: SessionStore | undefined;
	let root = await mkdtemp(join(tmpdir(), "atomic-portable-cwd-"));
	try {
		root = await realpath(root);
		const alias = join(root, "alias");
		await symlink(root, alias, "junction");
		store = new MemorySessionStore();
		await store.create({ id: "saved", version: 4, createdAt: "2026-10-16T00:00:00Z", cwd: alias }, []);
		assert.equal(await store.findMostRecent({ cwd: root }), undefined);
		assert.equal((await store.findMostRecent({ cwd: alias }))?.id, "saved");
	} finally {
		try {
			await store?.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});
