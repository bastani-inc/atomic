import assert from "node:assert/strict";
import { test } from "vitest";
import { createGitEnvironment, GIT_LOCAL_ENV_VARS } from "../../packages/coding-agent/src/utils/git-env.js";

test("createGitEnvironment removes Git-local env while preserving unrelated entries", () => {
	const baseEnv: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		GIT_DIR: "/tmp/wrong/.git",
		GIT_WORK_TREE: "/tmp/wrong",
		GIT_INDEX_FILE: "/tmp/wrong/.git/index",
		GIT_OPTIONAL_LOCKS: "1",
	};

	const env = createGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }, baseEnv);

	for (const key of GIT_LOCAL_ENV_VARS) assert.equal(env[key], undefined, `${key} should be removed`);
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.GIT_OPTIONAL_LOCKS, "1");
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(baseEnv.GIT_DIR, "/tmp/wrong/.git");
});
