import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, test, vi } from "vitest";
import { restoreStdout } from "../../packages/coding-agent/src/core/output-guard.js";
import { main } from "../../packages/coding-agent/src/main.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

class ExitCalled extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

const VARIABLES = [
	"ATOMIC_PROFILE",
	"ATOMIC_STORAGE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
const LIBSQL_REMOVED =
	"libSQL support (Turso, sqld and libSQL file: databases) was removed in Atomic 0.10.11. To keep your sessions, export them with Atomic 0.10.11-alpha.2, which reads every libSQL database (npx -y @bastani/atomic@0.10.11-alpha.2 storage export <dir> --storage-file <old-storage.json>), then import them into SQLite or PostgreSQL with this release (atomic storage import <dir>). See https://docs.bastani.ai/storage#moving-off-libsql";
let root: string;

beforeEach(() => {
	root = makeTempDirectory("team-startup-errors-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	for (const name of VARIABLES) vi.stubEnv(name, "");
});

afterEach(() => {
	restoreStdout();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

/** Start the CLI in print mode with `env`, expecting it to stop at the storage check; returns what it printed. */
async function startupErrorLines(env: Record<string, string>): Promise<string[]> {
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	errors.mockClear();
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitCalled(code);
	}) as typeof process.exit);
	await assert.rejects(
		main(["--no-extensions", "-p", "hello"]),
		(error: Error) => error instanceof ExitCalled && error.code === 1,
	);
	return errors.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
}

test("the removed ATOMIC_PROFILE=ci team profile stops startup with one message and exit 1, naming how to move", async () => {
	assert.deepEqual(
		await startupErrorLines({
			ATOMIC_PROFILE: "ci",
			ATOMIC_TEAM_URL: "libsql://team.example.turso.io",
			ATOMIC_TEAM_TOKEN: "team-secret-token",
		}),
		[
			`Error: Invalid storage configuration: ATOMIC_PROFILE, ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN (libsql-removed). ATOMIC_PROFILE, ATOMIC_TEAM_URL, ATOMIC_TEAM_TOKEN are set, but the ATOMIC_PROFILE=ci team profile they select was removed with libSQL support. Unset them and select a PostgreSQL database instead: run atomic storage join postgres://… or set ATOMIC_STORAGE. ${LIBSQL_REMOVED}`,
		],
	);
});

test("a libSQL selection in ATOMIC_STORAGE stops startup with one message and exit 1", async () => {
	assert.deepEqual(
		await startupErrorLines({
			ATOMIC_STORAGE: JSON.stringify({ adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://db" } }),
		}),
		[`Error: Invalid storage configuration: ATOMIC_STORAGE (libsql-removed). ${LIBSQL_REMOVED}`],
	);
});

test("a libSQL selection in the global settings stops startup with one message naming the setting", async () => {
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(
		join(root, "agent", "settings.json"),
		JSON.stringify({ storage: { adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://db" } } }),
	);
	const lines = await startupErrorLines({});
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0]!, /Invalid storage configuration: storage \(libsql-removed\)\. libSQL support/);
	assert.ok(lines[0]!.includes("https://docs.bastani.ai/storage#moving-off-libsql"), lines[0]);
});

test("an invalid ATOMIC_STORAGE at startup prints its message once and exits 1 (#4320)", async () => {
	assert.deepEqual(await startupErrorLines({ ATOMIC_STORAGE: "not json" }), [
		"Error: Invalid storage configuration: ATOMIC_STORAGE (invalid-json)",
	]);
});
