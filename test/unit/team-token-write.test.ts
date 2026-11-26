import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { POSTGRES_ADAPTER_PACKAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { joinSharedDatabase } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const full = vi.hoisted(() => ({ on: false, settingsFail: false, rmFails: false, tokenWrites: [] as unknown[] }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			if (/storage-token\.[\da-f-]+\.\d+\.tmp$/.test(String(args[0]))) full.tokenWrites.push(args[2]);
			if (full.on && /storage-token\.[\da-f-]+\.\d+\.tmp$/.test(String(args[0]))) {
				throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			}
			if (full.settingsFail && /settings\.json\.[^\\/]*\.tmp$/.test(String(args[0]))) {
				throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
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

/** Loading the package adapter through jiti. */
const JOIN_SCENARIO_TIMEOUT_MS = 60_000;
const URL_ = "postgres://atomic@team.example.com/atomic";
let root: string;
let agentDir: string;
let packageRoot: string;
let passwordFile: string;

beforeEach(() => {
	root = makeTempDirectory("team-token-write-");
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// A package installed as the PostgreSQL adapter, whose database answers the join's SELECT 1.
	packageRoot = join(root, "adapter");
	mkdirSync(packageRoot);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: POSTGRES_ADAPTER_PACKAGE, type: "module", atomic: { storageAdapters: ["./adapter.js"] } }),
	);
	writeFileSync(
		join(packageRoot, "adapter.js"),
		"export default { atomicStorageAdapter: 1, async openDatabase() { return { async get() { return { ok: 1 }; }, async close() {} }; } };\n",
	);
	passwordFile = join(root, "password");
	writeFileSync(passwordFile, "t");
});

afterEach(() => {
	full.on = false;
	full.settingsFail = false;
	full.rmFails = false;
	full.tokenWrites = [];
	vi.restoreAllMocks();
	removeTempDirectory(root);
});

test(
	"a disk too full for the password file fails the join with nothing written or left behind (#4320)",
	async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		full.on = true;
		const error = await joinSharedDatabase({ url: URL_, passwordFile, agentDir, cwd: root }, "cli").then(
			() => assert.fail("joined"),
			(caught: Error) => caught,
		);
		assert.ok(isTeamProfileError(error));
		assert.deepEqual(
			[error.code, error.retryable, error.detail],
			["token-write-failed", false, "ENOSPC: no space left on device, write"],
		);
		assert.match(error.subject, /[\\/]agent[\\/]storage-token\.[\da-f-]+$/);
		assert.equal(dirname(error.subject), agentDir);
		assert.equal(
			error.hint,
			"Nothing was changed. Check that the agent directory is writable, then run the command again.",
		);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOSPC");
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
		assert.deepEqual(full.tokenWrites, [{ mode: 0o600 }], "the password file is private from the moment it exists");
	},
	JOIN_SCENARIO_TIMEOUT_MS,
);

test(
	"a password file that cannot be removed after a failed settings write is recorded, not thrown (#4320)",
	async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		full.settingsFail = true;
		full.rmFails = true;
		const error = await joinSharedDatabase({ url: URL_, passwordFile, agentDir, cwd: root }, "cli").then(
			() => assert.fail("joined"),
			(caught: Error) => caught,
		);
		assert.ok(isTeamProfileError(error));
		assert.equal(error.code, "settings-write-failed");
		const cleanup = (error as { cleanupCause?: NodeJS.ErrnoException }).cleanupCause;
		assert.equal(cleanup?.code, "EBUSY");
		assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupCause")?.configurable, true);
	},
	JOIN_SCENARIO_TIMEOUT_MS,
);
