import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	StorageConfigError,
	StoragePrefixError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { createSessionManager } from "../../packages/coding-agent/src/main-session.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("CLI SQLite path and prefix override environment and project settings", async () => {
	const root = makeTempDirectory("session-store-cli-");
	const path = join(root, "custom store.sqlite");
	vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", join(root, "env-sessions"));
	const parsed = parseArgs(["--session-store", "custom store.sqlite", "--session-prefix", "chosen_"]);
	const manager = await createSessionManager(
		parsed,
		root,
		undefined,
		SettingsManager.inMemory({ sessions: { storage: { memory: true } } }),
	);
	try {
		assert.equal(manager.getSessionStore().descriptor.adapter, "node-sqlite");
		assert.equal(manager.getSessionStore().descriptor.location, path);
		assert.equal(parsed.unknownFlags.size, 0);
		await manager.appendSessionInfo("CLI selected store");
		assert.equal((await manager.getSessionStore().load(manager.getSessionId())).header.cwd, root);
		const selected = await resolveSessionStore(root, {
			sessionStore: { kind: "sqlite", path, prefix: "chosen_" },
		});
		try {
			assert.equal((await selected.load(manager.getSessionId())).header.cwd, root);
		} finally {
			await selected.close();
		}
	} finally {
		await manager.getSessionStore().close();
		vi.unstubAllEnvs();
		removeTempDirectory(root);
	}
});

test("CLI store conflicts and orphan prefixes raise typed errors naming both selectors", () => {
	for (const other of ["--session-dir", "--no-session"] as const) {
		const otherArgs = other === "--session-dir" ? [other, "sessions"] : [other];
		for (const args of [
			["--session-store", "store.sqlite", ...otherArgs],
			[...otherArgs, "--session-store", "store.sqlite"],
		]) {
			assert.throws(
				() => parseArgs(args),
				(error: Error) => {
					assert.ok(error instanceof StorageConfigError);
					assert.equal(error.source, "cli");
					assert.ok(error.message.includes("--session-store"));
					assert.ok(error.message.includes(other));
					return true;
				},
			);
		}
	}
	assert.throws(
		() => parseArgs(["--session-prefix", "kept_"]),
		(error: Error) => {
			assert.ok(error instanceof StorageConfigError);
			assert.equal(error.source, "cli");
			assert.ok(error.message.includes("--session-store"));
			assert.ok(error.message.includes("--session-prefix"));
			return true;
		},
	);
});

test("CLI SQLite selectors reject missing values and invalid prefixes", () => {
	for (const flag of ["--session-store", "--session-prefix"]) {
		assert.throws(
			() => parseArgs([flag]),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.field, flag);
				return true;
			},
		);
	}
	for (const prefix of ["bad-prefix", "sqlite_reserved"]) {
		assert.throws(
			() => parseArgs(["--session-store", "store.sqlite", "--session-prefix", prefix]),
			StoragePrefixError,
		);
	}
	assert.equal(parseArgs(["--session-store", "store.sqlite", "--session-prefix", ""]).sessionPrefix, "");
});

test("an unopenable CLI SQLite path raises a typed error without using the settings fallback", async () => {
	const root = makeTempDirectory("session-store-cli-unavailable-");
	try {
		await assert.rejects(
			createSessionManager(
				parseArgs(["--session-store", root]),
				root,
				undefined,
				SettingsManager.inMemory({ sessions: { storage: { memory: true } } }),
			),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.location, root);
				return true;
			},
		);
	} finally {
		removeTempDirectory(root);
	}
});
