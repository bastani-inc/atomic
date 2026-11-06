import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, test } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import {
	installTemporaryAgentDirDefault,
	replaceEnvironmentVariable,
	temporaryAgentDir,
	useTemporaryAgentDir,
} from "../helpers/temporary-agent-dir.js";

const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";

test("temporaryAgentDir creates .atomic/agent under a new agent-home directory inside the run directory", () => {
	const run = makeTempDirectory("atomic-agent-dir-run-");
	try {
		const agentDir = temporaryAgentDir(run);
		const home = dirname(dirname(agentDir));
		assert.equal(dirname(home), run);
		assert.match(basename(home), /^agent-home-.{6}$/u);
		assert.equal(agentDir, join(home, ".atomic", "agent"));
		assert.equal(existsSync(home), true);
	} finally {
		removeTempDirectory(run);
	}
});

test("temporaryAgentDir names the missing run directory instead of creating one elsewhere", () => {
	assert.throws(() => temporaryAgentDir(undefined), /^Error: ATOMIC_WORKFLOW_ARTIFACT_DIR is unset/u);
});

test("replaceEnvironmentVariable puts back a previous value, or the variable's absence", () => {
	const name = "ATOMIC_TEST_REPLACED_VARIABLE";
	delete process.env[name];
	const removeAgain = replaceEnvironmentVariable(name, "first");
	assert.equal(process.env[name], "first");
	const restoreFirst = replaceEnvironmentVariable(name, "second");
	assert.equal(process.env[name], "second");
	restoreFirst();
	assert.equal(process.env[name], "first");
	removeAgain();
	assert.equal(Object.hasOwn(process.env, name), false);
});

describe("installTemporaryAgentDirDefault", () => {
	test("points ATOMIC_CODING_AGENT_DIR at a new agent directory in the run directory, in place of inherited ones", () => {
		const run = makeTempDirectory("atomic-agent-dir-default-");
		try {
			const env: NodeJS.ProcessEnv = {
				ATOMIC_WORKFLOW_ARTIFACT_DIR: run,
				ATOMIC_CODING_AGENT_DIR: "/home/u/.atomic/agent",
				PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
				HOME: "/home/u",
			};
			const agentDir = installTemporaryAgentDirDefault(env);
			assert.match(relative(run, agentDir), /^agent-home-[^/\\]{6}[/\\]\.atomic[/\\]agent$/u);
			assert.deepEqual(env, {
				ATOMIC_WORKFLOW_ARTIFACT_DIR: run,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				HOME: "/home/u",
			});
			assert.notEqual(installTemporaryAgentDirDefault(env), agentDir);
		} finally {
			removeTempDirectory(run);
		}
	});

	test("changes nothing when the run directory is unset", () => {
		const env: NodeJS.ProcessEnv = { ATOMIC_CODING_AGENT_DIR: "/kept", PI_CODING_AGENT_DIR: "/kept-pi" };
		assert.throws(() => installTemporaryAgentDirDefault(env), /^Error: ATOMIC_WORKFLOW_ARTIFACT_DIR is unset/u);
		assert.deepEqual(env, { ATOMIC_CODING_AGENT_DIR: "/kept", PI_CODING_AGENT_DIR: "/kept-pi" });
	});
});

const inherited = process.env[AGENT_DIR_ENV];

test("the shared test setup gave this file an agent directory of its own before it loaded (#4473)", () => {
	const run = process.env.ATOMIC_WORKFLOW_ARTIFACT_DIR ?? "";
	assert.match(relative(run, inherited ?? ""), /^agent-home-[^/\\]{6}[/\\]\.atomic[/\\]agent$/u);
	assert.equal(Object.hasOwn(process.env, "PI_CODING_AGENT_DIR"), false);
});

describe("a test file that uses useTemporaryAgentDir", () => {
	const agentDir = useTemporaryAgentDir();

	test("runs with ATOMIC_CODING_AGENT_DIR pointing at its own agent directory", () => {
		assert.equal(process.env[AGENT_DIR_ENV], agentDir);
		assert.equal(existsSync(dirname(dirname(agentDir))), true);
	});
});

test("ATOMIC_CODING_AGENT_DIR is back to its inherited value after that file's last test", () => {
	assert.equal(process.env[AGENT_DIR_ENV], inherited);
});
