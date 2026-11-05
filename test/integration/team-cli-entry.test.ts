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
