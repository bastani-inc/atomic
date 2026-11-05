import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { GitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";
import {
	isWorkflowGitRequiredError,
	rehydrateWorkflowGitRequiredError,
	type SerializedWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const CHILD = join(moduleDir(import.meta.url), "fixtures", "workflow-git-required-child.ts");
/** Starts a Bun process that loads the workflows and coding-agent sources. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;

test(
	"a worktree run's git-required error crosses a process boundary as the same class with its git cause (#4322)",
	() => {
		const root = makeTempDirectory("atomic-git-required-roundtrip-");
		try {
			const child = spawnSyncCollect([bunExecutable(), CHILD], {
				env: {
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")),
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_OFFLINE: "1",
					PATH: root,
				},
			});
			assert.equal(child.exitCode, 0, child.stderr.toString());
			const wire = JSON.parse(child.stdout.toString()) as SerializedWorkflowGitRequiredError;
			assert.ok(isWorkflowGitRequiredError(wire));

			const restored = rehydrateWorkflowGitRequiredError(wire);
			assert.ok(restored instanceof WorkflowGitRequiredError);
			assert.equal(restored.message, wire.message);
			assert.equal(restored.hint, wire.hint);
			assert.deepEqual(restored.fields, {
				workflow: "goal",
				runId: "child-run",
				source: "input",
				field: "git_worktree_dir",
				gitWorktreeDir: "../wt",
			});
			assert.ok(restored.cause instanceof GitUnavailableError);
			assert.equal(restored.cause.code, "offline");
			assert.equal(restored.cause.hint, wire.cause?.hint);
		} finally {
			removeTempDirectory(root);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS,
);
