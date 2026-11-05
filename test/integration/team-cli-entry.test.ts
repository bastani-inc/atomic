import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

/** A real CLI process: Bun loads the source entry point. */
const CLI_TIMEOUT_MS = 60_000;
const cli = resolve(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts");
let root: string;

beforeEach(() => {
	root = makeTempDirectory("team-cli-entry-");
	mkdirSync(join(root, "agent"), { recursive: true });
});

afterEach(() => removeTempDirectory(root));

test(
	"the atomic entry point dispatches `team` and its arguments (#4320)",
	() => {
		const run = (...args: string[]) =>
			spawnSyncCollect([bunExecutable(), cli, ...args], {
				cwd: root,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_PROFILE: "",
					ATOMIC_STORAGE: "",
				},
				timeout: CLI_TIMEOUT_MS,
			});
		const help = run("team", "--help");
		assert.equal(help.exitCode, 0, help.stderr.toString());
		assert.match(
			help.stdout.toString(),
			/^Usage:\n {2}atomic team join <url> \[--token-file <path>\] \[--prefix <prefix>\]/,
		);
		const unknown = run("team", "doctor");
		assert.equal(unknown.exitCode, 1);
		assert.match(unknown.stderr.toString(), /^Invalid team command: <command> \(unknown-command\)\./);
	},
	CLI_TIMEOUT_MS * 2,
);

test(
	"an invalid team profile or storage selection at startup prints one error line, no stack trace, and exits 1 (#4320)",
	() => {
		const start = (env: Record<string, string>) =>
			spawnSyncCollect([bunExecutable(), cli, "-p", "hello"], {
				cwd: root,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_PROFILE: "",
					ATOMIC_STORAGE: "",
					ATOMIC_TEAM_URL: "",
					FORCE_COLOR: "0",
					NO_COLOR: "1",
					...env,
				},
				timeout: CLI_TIMEOUT_MS,
			});
		const unknownProfile = start({ ATOMIC_PROFILE: "staging" });
		assert.equal(unknownProfile.exitCode, 1);
		assert.equal(
			unknownProfile.stderr.toString(),
			"Error: Invalid storage configuration: ATOMIC_PROFILE (unknown-profile). Set ATOMIC_PROFILE to ci, or unset it.\n",
		);
		const invalid: Record<string, string>[] = [
			{ ATOMIC_TEAM_URL: "libsql://team.example.turso.io" },
			{ ATOMIC_STORAGE: "not json" },
		];
		for (const env of invalid) {
			const failed = start(env);
			const stderr = failed.stderr.toString();
			assert.equal(failed.exitCode, 1, stderr);
			assert.match(
				stderr,
				/^Error: Invalid storage configuration: ATOMIC_(PROFILE|STORAGE) \((incomplete-profile|invalid-json)\)/,
			);
			assert.equal(stderr.trimEnd().split("\n").length, 1, stderr);
		}
	},
	CLI_TIMEOUT_MS * 3,
);
