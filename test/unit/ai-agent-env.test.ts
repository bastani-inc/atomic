import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createChildProcessEnvironment,
	spawnProcess,
	spawnProcessSync,
} from "../../packages/coding-agent/src/utils/child-process.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { runLocalCommand } from "../../packages/workflows/src/durable/local-command.js";

test("Atomic child environment overrides attribution without mutating its base", () => {
	const parentEnv: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: "caller" };
	const childEnv = createChildProcessEnvironment({ AI_AGENT: "explicit-caller" }, parentEnv);
	assert.equal(childEnv.AI_AGENT, "atomic");
	assert.equal(parentEnv.AI_AGENT, "caller");
});

test("spawnProcessSync preserves an explicitly scrubbed environment", () => {
	const explicitEnv: NodeJS.ProcessEnv = {
		...process.env,
		AI_AGENT: "caller",
		GIT_DIR: "/tmp/not-this-repository.git",
	};
	const gitEnv = createGitEnvironment(undefined, explicitEnv);
	assert.equal(gitEnv.GIT_DIR, undefined);
	const result = spawnProcessSync(
		process.execPath,
		["-e", "process.stdout.write((process.env.GIT_DIR ?? '') + '|' + (process.env.AI_AGENT ?? ''))"],
		{ env: gitEnv, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "|atomic");
	assert.equal(explicitEnv.AI_AGENT, "caller");
});

test("spawnProcess forces attribution without mutating an explicit environment", async () => {
	const callerEnv: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: "caller" };
	const child = spawnProcess(process.execPath, ["-e", "process.stdout.write(process.env.AI_AGENT ?? '')"], {
		env: callerEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	const status = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	assert.equal(status, 0);
	assert.equal(stdout, "atomic");
	assert.equal(callerEnv.AI_AGENT, "caller");
});

test("worktree child environments use shared Atomic attribution without mutating the parent", () => {
	const parentEnv: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: "caller" };
	const childEnv = createChildProcessEnvironment(undefined, parentEnv);
	const gitEnv = createGitEnvironment({}, childEnv);
	assert.equal(gitEnv.AI_AGENT, "atomic");
	assert.equal(parentEnv.AI_AGENT, "caller");
});

test("workflow local-command children identify Atomic and preserve caller environment objects", async () => {
	const parentEnv: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: "caller" };
	const childEnv = createChildProcessEnvironment({ AI_AGENT: "explicit-caller" }, parentEnv);
	assert.equal(childEnv.AI_AGENT, "atomic");
	assert.equal(parentEnv.AI_AGENT, "caller");

	const result = await runLocalCommand(process.execPath, ["-e", "process.stdout.write(process.env.AI_AGENT ?? '')"], {
		env: { AI_AGENT: "explicit-caller" },
	});
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(result.stdout, "atomic");
});
