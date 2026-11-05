import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { main } from "../../packages/coding-agent/src/main.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

class ExitCalled extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

let root: string;
let exitCode: typeof process.exitCode;

beforeEach(() => {
	root = makeTempDirectory("team-main-dispatch-");
	exitCode = process.exitCode;
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	for (const name of ["ATOMIC_PROFILE", "ATOMIC_STORAGE", "ATOMIC_TEAM_URL", "ATOMIC_INTERCOM_GROUP"])
		vi.stubEnv(name, "");
	vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

/** Run `atomic <argv>` in this process; returns its exit code and what it printed. */
async function atomic(...argv: string[]): Promise<{ code: number | undefined; out: string[]; err: string[] }> {
	const out = vi.spyOn(console, "log").mockImplementation(() => {});
	const err = vi.spyOn(console, "error").mockImplementation(() => {});
	out.mockClear();
	err.mockClear();
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitCalled(code);
	}) as typeof process.exit);
	let code: number | undefined;
	await assert.rejects(main(argv), (error: Error) => {
		assert.ok(error instanceof ExitCalled, error.stack);
		code = error.code;
		return true;
	});
	return {
		code,
		out: out.mock.calls.map(([line]) => String(line)),
		err: err.mock.calls.map(([line]) => String(line)),
	};
}

test("atomic team runs the team command with its own arguments, cwd and agent directory, and exits with its code (#4320)", async () => {
	const help = await atomic("team", "--help");
	assert.equal(help.code, 0);
	assert.match(help.out[0] ?? "", /^Usage:\n {2}atomic team join <url> \[--token-file <path>\] \[--prefix <prefix>\]/);

	const unknown = await atomic("team", "doctor");
	assert.equal(unknown.code, 1);
	assert.match(unknown.err[0] ?? "", /^Invalid team command: <command> \(unknown-command\)\./);

	const status = await atomic("team", "status", "--json");
	assert.equal(status.code, 0, status.err.join("\n"));
	const report = JSON.parse(status.out.join("\n")) as { agentDir: string; cwd: string; profile: { profile: string } };
	assert.deepEqual([report.agentDir, report.cwd, report.profile.profile], [join(root, "agent"), root, "individual"]);
});
