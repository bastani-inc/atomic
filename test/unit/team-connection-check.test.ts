import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	isTeamProfileTimeoutError,
	TeamProfileError,
	type TeamProfileTimeoutError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { LIBSQL_ADAPTER_PACKAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { joinSharedDatabase } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** What the recording adapter saw, shared through `globalThis` because the adapter loads in its own module scope. */
interface AdapterRecord {
	opened: Array<Record<string, string>>;
	queries: string[];
	closed: number;
	fail?: Error;
	answerAfterMs?: number;
}

declare global {
	var __team4320Adapter: AdapterRecord | undefined;
}

const RECORDING_ADAPTER = `
const record = () => globalThis.__team4320Adapter;
export default {
	atomicStorageAdapter: 1,
	async openDatabase(options) {
		record().opened.push({ ...options });
		return {
			async get(sql) {
				record().queries.push(sql);
				const { answerAfterMs, fail } = record();
				if (answerAfterMs !== undefined) await new Promise((done) => setTimeout(done, answerAfterMs));
				if (fail !== undefined) throw fail;
				return { ok: 1 };
			},
			async close() {
				record().closed++;
			},
		};
	},
};
`;

let root: string;
let agentDir: string;
let record: AdapterRecord;

beforeEach(() => {
	root = makeTempDirectory("team-connection-check-");
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	for (const name of ["ATOMIC_STORAGE", "ATOMIC_PROFILE", "ATOMIC_TEAM_URL"]) vi.stubEnv(name, "");
	record = { opened: [], queries: [], closed: 0 };
	globalThis.__team4320Adapter = record;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	globalThis.__team4320Adapter = undefined;
	removeTempDirectory(root);
});

/** Install a package named like the libSQL adapter whose entry point is `source`, as `atomic install <dir>` would. */
function installAdapter(source: string): void {
	const directory = join(root, "adapter");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: LIBSQL_ADAPTER_PACKAGE,
			version: "0.0.0",
			type: "module",
			atomic: { storageAdapters: ["./adapter.js"] },
		}),
	);
	writeFileSync(join(directory, "adapter.js"), source);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [directory] }));
}

function writeToken(token: string): string {
	const path = join(root, "token");
	writeFileSync(path, token);
	return path;
}

const settingsText = (): string => readFileSync(join(agentDir, "settings.json"), "utf8");

function join4320(url: string, tokenFile?: string, timeoutMs?: number) {
	return joinSharedDatabase(
		{ url, agentDir, cwd: root, pinLocalSessions: true, ...(tokenFile === undefined ? {} : { tokenFile }) },
		"sdk",
		timeoutMs,
	);
}

test("the join's connection check opens the database with the token, runs SELECT 1 and closes it (#4320)", async () => {
	installAdapter(RECORDING_ADAPTER);
	const url = "libsql://team.example.turso.io";
	await join4320(url, writeToken("team-token\n"));
	const fileUrl = pathToFileURL(join(root, "team.sqlite")).href;
	await join4320(fileUrl);
	assert.deepEqual(record.opened, [{ url, authToken: "team-token" }, { url: fileUrl }]);
	assert.deepEqual(record.queries, ["SELECT 1 AS ok", "SELECT 1 AS ok"]);
	assert.equal(record.closed, 2);
});

test("a failing SELECT 1 fails the join with connection-failed, closes the database and changes nothing (#4320)", async () => {
	installAdapter(RECORDING_ADAPTER);
	record.fail = new Error("no such namespace");
	const before = settingsText();
	const url = "libsql://team.example.turso.io";
	const failure = await join4320(url, writeToken("team-token")).then(
		() => assert.fail("joined a database whose SELECT 1 failed"),
		(error: Error) => error,
	);
	assert.ok(failure instanceof TeamProfileError);
	assert.deepEqual(
		[failure.code, failure.subject, failure.detail, failure.cause],
		["connection-failed", url, "no such namespace", record.fail],
	);
	assert.equal(record.closed, 1);
	assert.equal(settingsText(), before);
});

test("an installed adapter without openDatabase fails the connection check by name (#4320)", async () => {
	installAdapter("export default { atomicStorageAdapter: 1 };\n");
	const failure = await join4320(pathToFileURL(join(root, "team.sqlite")).href).then(
		() => assert.fail("joined through an adapter that cannot open a database"),
		(error: Error) => error,
	);
	assert.ok(failure instanceof TeamProfileError);
	assert.deepEqual(
		[failure.code, failure.detail],
		["connection-failed", `${LIBSQL_ADAPTER_PACKAGE} has no openDatabase hook`],
	);
});

test("the connection deadline is cleared as soon as the database answers (#4320)", async () => {
	installAdapter(RECORDING_ADAPTER);
	const DEADLINE_MS = 3_600_000;
	const timers = vi.spyOn(globalThis, "setTimeout");
	const cleared = vi.spyOn(globalThis, "clearTimeout");
	await join4320(pathToFileURL(join(root, "team.sqlite")).href, undefined, DEADLINE_MS);
	const deadline = timers.mock.calls.findIndex(([, delay]) => delay === DEADLINE_MS);
	assert.notEqual(deadline, -1, "the join armed its connection deadline");
	assert.ok(cleared.mock.calls.some(([timer]) => timer === timers.mock.results[deadline]?.value));
});

test("a connection check that fails after the deadline is kept as the timeout's cleanupCause (#4320)", async () => {
	installAdapter(RECORDING_ADAPTER);
	record.answerAfterMs = 200;
	record.fail = new Error("connection reset after the deadline");
	const failure = await join4320("libsql://team.example.turso.io", writeToken("team-token"), 20).then(
		() => assert.fail("joined a database that answered after the deadline"),
		(error: Error) => error,
	);
	assert.ok(isTeamProfileTimeoutError(failure));
	await vi.waitFor(() => assert.equal(record.closed, 1), { timeout: 5_000, interval: 10 });
	await vi.waitFor(() => assert.ok(Object.hasOwn(failure, "cleanupCause")), { timeout: 5_000, interval: 10 });
	assert.deepEqual(Object.getOwnPropertyDescriptor(failure as TeamProfileTimeoutError, "cleanupCause"), {
		value: record.fail,
		writable: false,
		enumerable: false,
		configurable: true,
	});
});
