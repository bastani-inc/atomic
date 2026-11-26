import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { shellQuote } from "../src/core/resume/blueprint/envrc.js";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.js";

// Each generated case runs two real shells; the case count, not a slow test, sets this budget.
const PROPERTY_CASES = 160;
const PROPERTY_TIMEOUT_MS = 120_000;

let root = "";
const setupEnvName = process.platform === "darwin" ? "BASH_ENV" : "OLDPWD";
const inheritedSetupEnv = process.env[setupEnvName];

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atomic-bash-cd-parity-")));
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "inside.txt"), "");
	await mkdir(join(root, "my dir"));
	await writeFile(join(root, "my dir", "spaced.txt"), "");
	await writeFile(join(root, "top.txt"), "");
	await writeFile(join(root, "file.txt"), "");
	const oldPwd = join(root, "src");
	if (setupEnvName === "BASH_ENV") {
		const bashEnv = join(root, ".cd-parity-env");
		await writeFile(bashEnv, `OLDPWD=${shellQuote(oldPwd)}\n`);
		process.env.BASH_ENV = bashEnv;
	} else {
		process.env.OLDPWD = oldPwd;
	}
});

afterAll(async () => {
	if (inheritedSetupEnv === undefined) delete process.env[setupEnvName];
	else process.env[setupEnvName] = inheritedSetupEnv;
	await rm(root, { recursive: true, force: true });
});

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Bash's stdout and stderr reach the tool through separate pipes, so only the lines, not their order, are stable. */
function lines(output: string): string[] {
	return output.split("\n").sort();
}

/** The real bash tool, recording the command and cwd it handed to the shell. */
function recordingRealBash() {
	const local = createLocalBashOperations();
	const ran = { command: "", cwd: "" };
	const tool = createBashToolDefinition(root, {
		operations: {
			exec: (command, cwd, options) => {
				ran.command = command;
				ran.cwd = cwd;
				return local.exec(command, cwd, options);
			},
		},
	});
	const run = async (command: string) =>
		text(await tool.execute("bash", { command }, undefined, undefined, {} as ExtensionContext));
	return { ran, run };
}

/** What bash prints for the command as written: an explicit cwd turns the leading-cd shortcut off. */
async function asBash(command: string): Promise<string> {
	const tool = createBashToolDefinition(root);
	return text(await tool.execute("bash", { command, cwd: root }, undefined, undefined, {} as ExtensionContext));
}

async function assertRunsAsWritten(command: string): Promise<string> {
	const { ran, run } = recordingRealBash();
	const output = await run(command);
	assert.equal(ran.command, command);
	assert.equal(ran.cwd, root);
	assert.equal(output, await asBash(command));
	return output;
}

describe("bash leading cd matches bash (#4840)", () => {
	it("runs `cd src 2>/dev/null && ls` in src as bash does (#4840)", async () => {
		assert.equal(await assertRunsAsWritten("cd src 2>/dev/null && ls"), "inside.txt\n");
	});

	it("runs `cd src || exit 1; ls` in src as bash does (#4840)", async () => {
		assert.equal(await assertRunsAsWritten("cd src || exit 1; ls"), "inside.txt\n");
	});

	it("runs `cd my\\ dir && ls` with the escaped space as bash does (#4840)", async () => {
		assert.equal(await assertRunsAsWritten("cd my\\ dir && ls"), "spaced.txt\n");
	});

	it("runs `cd -- src && ls` as bash does (#4840)", async () => {
		assert.equal(await assertRunsAsWritten("cd -- src && ls"), "inside.txt\n");
	});

	it("runs `cd - && ls` as bash does (#4840)", async () => {
		assert.equal(await assertRunsAsWritten("cd - && ls"), `${join(root, "src")}\ninside.txt\n`);
	});

	it("runs `cd src | tee x; ls` in the original directory as bash does (#4840)", async () => {
		const output = await assertRunsAsWritten("cd src | tee x; ls");
		assert.match(output, /top\.txt/);
	});

	it("runs `cd missing; ls` in the original directory as bash does (#4840)", async () => {
		const tool = createBashToolDefinition(root);
		const command = "cd missing; ls";
		const output = text(await tool.execute("bash", { command }, undefined, undefined, {} as ExtensionContext));
		assert.match(output, /top\.txt/);
		assert.deepEqual(lines(output), lines(await asBash(command)));
	});

	it("still runs `cd src && ls` through the shortcut (#4840)", async () => {
		const { ran, run } = recordingRealBash();
		assert.equal(await run("cd src && ls"), "inside.txt\n");
		assert.equal(ran.command, "ls");
		assert.equal(ran.cwd, join(root, "src"));
	});

	it('still runs `cd "src" && ls` through the shortcut (#4840)', async () => {
		const { ran, run } = recordingRealBash();
		assert.equal(await run('cd "src" && ls'), "inside.txt\n");
		assert.equal(ran.command, "ls");
		assert.equal(ran.cwd, join(root, "src"));
	});

	it(
		"prints what bash prints for generated leading cd commands (#4840)",
		async () => {
			// Deterministic LCG so a failure names a reproducible command.
			let seed = 4840;
			const pick = <T>(values: readonly T[]): T => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return values[(seed >>> 16) % values.length];
			};
			const targets = [
				"src",
				"'src'",
				'"src"',
				"./src",
				"src/",
				"my\\ dir",
				"'my dir'",
				'"my dir"',
				"missing",
				"file.txt",
				"-- src",
				"-",
				"-P src",
				".",
				"src/..",
				"src extra",
				"s*c",
				"'$HOME'",
				"$PWD",
			];
			const suffixes = ["", "", "", " 2>/dev/null", " >/dev/null", "  ", " <&-"];
			const separators = ["&&", "&&", ";", ";", "||", "|", " &&", "&&\n", ";;", "&"];
			const rests = ["ls", "pwd", "echo $?", "ls; pwd"];
			const failures: string[] = [];
			for (let i = 0; i < PROPERTY_CASES; i++) {
				const command = `cd ${pick(targets)}${pick(suffixes)}${pick(separators)} ${pick(rests)}`;
				const tool = createBashToolDefinition(root);
				const actual = await tool
					.execute("bash", { command }, undefined, undefined, {} as ExtensionContext)
					.then(text, (error: Error) => `threw: ${error.message}`);
				const expected = await asBash(command).catch((error: Error) => `threw: ${error.message}`);
				if (lines(actual).join("\n") !== lines(expected).join("\n"))
					failures.push(`${JSON.stringify(command)}: ${actual} != ${expected}`);
			}
			assert.deepEqual(failures, []);
		},
		PROPERTY_TIMEOUT_MS,
	);
});
