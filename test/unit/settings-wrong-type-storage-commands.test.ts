import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { selectTeamProfile } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let agentDir: string;

beforeEach(() => {
	root = makeTempDirectory("settings-wrong-type-storage-");
	agentDir = join(root, "agent");
	mkdirSync(agentDir);
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
	])
		vi.stubEnv(name, "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test("storage status and the team profile read past a wrong-typed setting (#4902)", async () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: "./x.ts", fallbackModels: 3 }));

	const status = await collectStorageStatus({ cwd: root, agentDir, probe: false });
	assert.ok(status);
	assert.ok(selectTeamProfile({ cwd: root, agentDir }));
});

test("storage status still refuses a settings file it cannot parse (#4902)", async () => {
	writeFileSync(join(agentDir, "settings.json"), "{ not json");

	await assert.rejects(collectStorageStatus({ cwd: root, agentDir, probe: false }), /Cannot load settings/);
	assert.throws(() => selectTeamProfile({ cwd: root, agentDir }), /settings/);
});
