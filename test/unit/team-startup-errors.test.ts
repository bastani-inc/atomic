import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, test, vi } from "vitest";
import { restoreStdout } from "../../packages/coding-agent/src/core/output-guard.js";
import { TeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { main } from "../../packages/coding-agent/src/main.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const adapterCheck = vi.hoisted(() => vi.fn<(agentDir: string) => Promise<void>>());
vi.mock("../../packages/coding-agent/src/core/storage/team.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/team.js")>()),
	assertTeamAdapterInstalled: adapterCheck,
}));

class ExitCalled extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

const TEAM_VARIABLES = [
	"ATOMIC_PROFILE",
	"ATOMIC_STORAGE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
let root: string;

beforeEach(() => {
	root = makeTempDirectory("team-startup-errors-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	for (const name of TEAM_VARIABLES) vi.stubEnv(name, "");
	adapterCheck.mockReset();
	adapterCheck.mockResolvedValue(undefined);
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

test("an invalid team profile at startup prints its message once and exits 1, before the adapter check (#4320)", async () => {
	assert.deepEqual(await startupErrorLines({ ATOMIC_PROFILE: "staging" }), [
		"Error: Invalid storage configuration: ATOMIC_PROFILE (unknown-profile). Set ATOMIC_PROFILE to ci, or unset it.",
	]);
	const incomplete = await startupErrorLines({
		ATOMIC_PROFILE: "",
		ATOMIC_TEAM_URL: "libsql://team.example.turso.io",
	});
	assert.equal(incomplete.length, 1);
	assert.match(incomplete[0]!, /^Error: Invalid storage configuration: ATOMIC_PROFILE \(incomplete-profile\)\. /);
	assert.equal(adapterCheck.mock.calls.length, 0);
});

test("an invalid ATOMIC_STORAGE at startup prints its message once and exits 1 (#4320)", async () => {
	assert.deepEqual(await startupErrorLines({ ATOMIC_STORAGE: "not json" }), [
		"Error: Invalid storage configuration: ATOMIC_STORAGE (invalid-json)",
	]);
});

test("a missing libSQL adapter for the CI profile prints the team error once and exits 1 (#4320)", async () => {
	const missing = new TeamProfileError("adapter-not-installed", {
		subject: "@bastani/atomic-storage-libsql",
		hint: "Install it, then run again: atomic install npm:@bastani/atomic-storage-libsql",
	});
	adapterCheck.mockRejectedValue(missing);
	const lines = await startupErrorLines({
		ATOMIC_PROFILE: "ci",
		ATOMIC_TEAM_URL: `file://${join(root, "team.sqlite")}`,
	});
	assert.deepEqual(lines, [`Error: ${missing.message}`]);
	assert.deepEqual(adapterCheck.mock.calls, [[join(root, "agent")]]);
});

test("an unrelated startup failure in the storage check is not reported as a storage error (#4320)", async () => {
	const failure = new Error("unrelated");
	adapterCheck.mockRejectedValue(failure);
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitCalled(code);
	}) as typeof process.exit);
	await assert.rejects(main(["--no-extensions", "-p", "hello"]), (error: Error) => error === failure);
	assert.equal(exit.mock.calls.length, 0);
	assert.equal(errors.mock.calls.length, 0);
});
