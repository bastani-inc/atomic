import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { joinSharedDatabase } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const full = vi.hoisted(() => ({ on: false, rmFails: false }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			if (full.on && /storage-token\.[\da-f-]+\.\d+\.tmp$/.test(String(args[0]))) {
				throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			}
			return fs.writeFileSync(...args);
		},
		rmSync: (...args: Parameters<typeof fs.rmSync>) => {
			if (full.rmFails && /storage-token\.[\da-f-]+$/.test(String(args[0]))) {
				throw Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" });
			}
			return fs.rmSync(...args);
		},
	};
});

/** Loading the libSQL package adapter through jiti and opening a `file:` database. */
const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;
const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
let root: string;
let agentDir: string;
let databaseDirectory: string;

beforeEach(() => {
	root = makeTempDirectory("team-token-write-");
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	databaseDirectory = makeLibsqlDirectory();
});

afterEach(async () => {
	full.on = false;
	full.rmFails = false;
	vi.restoreAllMocks();
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

test(
	"a disk too full for the token file fails the join with nothing written or left behind (#4320)",
	async () => {
		const path = join(databaseDirectory, "team.sqlite");
		await (await openNodeSqliteDatabase(path)).close();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		full.on = true;
		const error = await joinSharedDatabase(
			{ url: pathToFileURL(path).href, token: "t", agentDir, cwd: root, pinLocalSessions: true },
			"sdk",
		).then(
			() => assert.fail("joined"),
			(caught: Error) => caught,
		);
		assert.ok(isTeamProfileError(error));
		assert.deepEqual(
			[error.code, error.retryable, error.detail],
			["token-write-failed", false, "ENOSPC: no space left on device, write"],
		);
		assert.match(error.subject, /\/agent\/storage-token\.[\da-f-]+$/);
		assert.equal(
			error.hint,
			"Nothing was changed. Check that the agent directory is writable, then run the command again.",
		);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOSPC");
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
	},
	LIBSQL_SCENARIO_TIMEOUT_MS,
);

test(
	"a token file that cannot be removed after a failed settings write is recorded, not thrown (#4320)",
	async () => {
		const path = join(databaseDirectory, "team.sqlite");
		await (await openNodeSqliteDatabase(path)).close();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(() => {
			throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
		});
		full.rmFails = true;
		const error = await joinSharedDatabase(
			{ url: pathToFileURL(path).href, token: "t", agentDir, cwd: root, pinLocalSessions: true },
			"sdk",
		).then(
			() => assert.fail("joined"),
			(caught: Error) => caught,
		);
		assert.ok(isTeamProfileError(error));
		assert.equal(error.code, "settings-write-failed");
		const cleanup = (error as { cleanupCause?: NodeJS.ErrnoException }).cleanupCause;
		assert.equal(cleanup?.code, "EBUSY");
		assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupCause")?.configurable, true);
	},
	LIBSQL_SCENARIO_TIMEOUT_MS,
);
