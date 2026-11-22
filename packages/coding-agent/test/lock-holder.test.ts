import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it } from "vitest";
import { exitedProcess, keptExitedPid } from "../../../test/helpers/exited-process.js";
import {
	clearLockHolder,
	HOLDER_TEMP_STALE_MS,
	lockHolderPath,
	recordLockHolder,
	takeOverDeadHolder,
} from "../src/core/lock-holder.ts";
import { lockHolder } from "../src/core/lock-wait.ts";
import { processStartToken } from "../src/core/process-start-token.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { unreadableTrustSettingsDiagnostics } from "../src/main-stdio.ts";

let directory: string;
let file: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-holder-")));
	file = join(directory, "settings.json");
	lockPath = `${file}.lock`;
	writeFileSync(file, "{}");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A pid that named a process which has exited. */
function exitedPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	return Number(result.stdout);
}

function writeRecord(record: Record<string, unknown>): void {
	writeFileSync(lockHolderPath(lockPath), JSON.stringify(record));
}

describe("taking over the lock of a dead holder (#5161)", () => {
	it("names this process as the holder of the lock it took, and forgets it on release (#5161)", () => {
		mkdirSync(lockPath);
		recordLockHolder(lockPath);
		const record = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as Record<string, unknown>;
		const bigStats = statSync(lockPath, { bigint: true });
		const plainStats = statSync(lockPath);
		const exact = lockHolder(lockPath);
		assert.deepEqual(record, {
			host: hostname(),
			pid: process.pid,
			started: processStartToken(process.pid),
			lock: bigStats.ino <= BigInt(Number.MAX_SAFE_INTEGER) ? `${plainStats.ino}:${plainStats.birthtimeMs}` : exact,
			lockId: exact,
		});
		assert.equal(takeOverDeadHolder(lockPath), false, "a live holder keeps its lock");
		assert.equal(existsSync(lockPath), true);
		clearLockHolder(lockPath);
		assert.equal(existsSync(lockHolderPath(lockPath)), false);
	});

	it("takes over a lock whose holder has exited, at once (#5161)", () => {
		mkdirSync(lockPath);
		writeRecord({ host: hostname(), pid: exitedPid(), started: "000000000000", lock: lockHolder(lockPath) });
		assert.equal(takeOverDeadHolder(lockPath), true);
		assert.equal(existsSync(lockPath), false);
		assert.deepEqual(
			readdirSync(directory).filter((name) => name.includes(".dead")),
			[],
			"the lock moved aside is removed",
		);
	});

	it("takes over a lock whose holder's pid now names a later process (#5161)", (context) => {
		if (processStartToken(process.pid) === undefined) context.skip();
		mkdirSync(lockPath);
		writeRecord({ host: hostname(), pid: process.pid, started: "000000000000", lock: lockHolder(lockPath) });
		assert.equal(takeOverDeadHolder(lockPath), true);
		assert.equal(existsSync(lockPath), false);
	});

	it("keeps a lock whose holder runs on another host, or cannot be judged (#5161)", () => {
		mkdirSync(lockPath);
		const lock = lockHolder(lockPath);
		writeRecord({ host: `${hostname()}-other`, pid: exitedPid(), lock });
		assert.equal(takeOverDeadHolder(lockPath), false);
		writeRecord({ host: hostname(), pid: process.pid, lock });
		assert.equal(takeOverDeadHolder(lockPath), false, "a live pid without a recorded start is a live holder");
		const exited = exitedPid();
		for (const malformed of [
			{ host: hostname(), pid: String(exited), lock },
			{ host: hostname(), pid: exited, started: 1, lock },
			{ host: hostname(), pid: exited },
			{ pid: exited, lock },
		]) {
			writeRecord(malformed);
			assert.equal(takeOverDeadHolder(lockPath), false, JSON.stringify(malformed));
		}
		writeFileSync(lockHolderPath(lockPath), "not json");
		assert.equal(takeOverDeadHolder(lockPath), false);
		rmSync(lockHolderPath(lockPath));
		assert.equal(takeOverDeadHolder(lockPath), false, "a lock without a holder record waits to go stale");
		assert.equal(existsSync(lockPath), true);
	});

	it("takes over a lock whose exited holder recorded no start (#5161)", async () => {
		mkdirSync(lockPath);
		const exited = await keptExitedPid();
		try {
			writeRecord({ host: hostname(), pid: exited.pid, lock: lockHolder(lockPath) });
			assert.equal(takeOverDeadHolder(lockPath), true);
			assert.equal(existsSync(lockPath), false);
		} finally {
			await exited.release();
		}
	});

	it("keeps a lock whose holder this process may not signal, which still runs (#5161)", (context) => {
		if (process.platform === "win32" || process.getuid?.() === 0) context.skip();
		mkdirSync(lockPath);
		writeRecord({ host: hostname(), pid: 1, lock: lockHolder(lockPath) });
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(existsSync(lockPath), true);
	});

	it("leaves no temporary file when the holder cannot be named (#5161)", () => {
		mkdirSync(lockPath);
		mkdirSync(join(lockHolderPath(lockPath), "occupied"), { recursive: true });
		recordLockHolder(lockPath);
		assert.deepEqual(readdirSync(directory).sort(), [
			"settings.json",
			"settings.json.lock",
			"settings.json.lock.holder",
		]);
	});

	it("keeps a lock taken after the dead holder's, which the record does not name (#5161)", () => {
		mkdirSync(lockPath);
		writeRecord({ host: hostname(), pid: exitedPid(), lock: "1:2" });
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(existsSync(lockPath), true);
		rmSync(lockPath, { recursive: true });
		writeRecord({ host: hostname(), pid: exitedPid(), lock: "1:2" });
		assert.equal(takeOverDeadHolder(lockPath), false, "no lock to take over");
	});

	it("removes the temporary files killed writers left, once old, when it takes over (#5161)", () => {
		mkdirSync(lockPath);
		writeRecord({ host: hostname(), ...exitedProcess(), lock: lockHolder(lockPath) });
		const old = `${lockHolderPath(lockPath)}.123.old.tmp`;
		const recent = `${lockHolderPath(lockPath)}.456.recent.tmp`;
		writeFileSync(old, "{");
		writeFileSync(recent, "{");
		const past = new Date(Date.now() - HOLDER_TEMP_STALE_MS - 1_000);
		utimesSync(old, past, past);
		assert.equal(takeOverDeadHolder(lockPath), true);
		assert.equal(existsSync(old), false);
		assert.equal(existsSync(recent), true, "a recent one may still be written");
		assert.equal(existsSync(file), true, "other files stay");
	});

	it("does not name a holder for a lock directory that is not there (#5161)", () => {
		recordLockHolder(lockPath);
		assert.equal(existsSync(lockHolderPath(lockPath)), false);
	});
});

describe("unreadable settings that decide project trust (#5161)", () => {
	function managerFor(content: string): SettingsManager {
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), content);
		return SettingsManager.create(join(directory, "project"), agentDir, { projectTrusted: false });
	}

	it("warns that trust falls back to ask when the global settings cannot be read (#5161)", () => {
		const manager = managerFor('{ "defaultProjectTrust": "always",');
		const [warning, ...rest] = unreadableTrustSettingsDiagnostics(manager, undefined);
		assert.deepEqual(rest, []);
		assert.equal(warning?.type, "warning");
		assert.match(warning!.message, /Could not read the global settings .*settings\.json \(/);
		assert.match(warning!.message, /"defaultProjectTrust" falls back to "ask"/);
		assert.match(warning!.message, /blueprint builds are skipped/);
		assert.match(warning!.message, /--approve/);
	});

	it("does not warn when the settings were read, or --approve or --deny decides trust (#5161)", () => {
		assert.deepEqual(
			unreadableTrustSettingsDiagnostics(managerFor('{ "defaultProjectTrust": "always" }'), undefined),
			[],
		);
		const unreadable = managerFor("{");
		assert.deepEqual(unreadableTrustSettingsDiagnostics(unreadable, true), []);
		assert.deepEqual(unreadableTrustSettingsDiagnostics(unreadable, false), []);
	});

	it("reports a settings file that does not parse, not the lock, while another holder saves (#5161)", () => {
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{");
		const release = lockfile.lockSync(settingsPath, { realpath: false });
		try {
			const manager = SettingsManager.create(join(directory, "project"), agentDir, { projectTrusted: false });
			const error = manager.getGlobalSettingsLoadError();
			assert.ok(error);
			assert.doesNotMatch(error.message, /already being held/);
			assert.equal((error as Error & { path?: string }).path, settingsPath);
		} finally {
			release();
		}
	});
});
