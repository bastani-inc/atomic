import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { store } from "../../packages/workflows/src/shared/store.js";
import {
	ENV_WORKFLOW_ARTIFACT_DIR,
	refreshWorkflowArtifactPresence,
	workflowRunArtifactsIntact,
} from "../../packages/workflows/src/shared/workflow-artifacts.js";

const slowFirstCheck = vi.hoisted(() => ({ release: undefined as Promise<void> | undefined, used: false }));

vi.mock("../../packages/workflows/src/shared/path-exists.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/shared/path-exists.js")>();
	return {
		pathExists: async (path: string) => {
			const present = await actual.pathExists(path);
			if (!slowFirstCheck.used && slowFirstCheck.release !== undefined) {
				slowFirstCheck.used = true;
				await slowFirstCheck.release;
			}
			return present;
		},
	};
});

test("a refresh reads an artifact directory created after a background read of it began", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-refresh-"));
	const previous = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
	const originId = "refresh-origin";
	try {
		store.recordRunStart({
			id: originId,
			name: "goal",
			inputs: {},
			status: "failed",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		const continuation = {
			id: "refresh-latest",
			resumedFromRunId: originId,
			result: { receipt: join(root, "runs", originId, "artifact-1", "receipt.md") },
			stages: [],
		};
		await refreshWorkflowArtifactPresence([continuation]);
		assert.equal(workflowRunArtifactsIntact(continuation), false);

		const released = Promise.withResolvers<void>();
		slowFirstCheck.release = released.promise;
		assert.equal(workflowRunArtifactsIntact(continuation), false);
		await mkdir(join(root, "runs", originId), { recursive: true });
		const refreshed = refreshWorkflowArtifactPresence([continuation]);
		released.resolve();
		await refreshed;
		assert.equal(workflowRunArtifactsIntact(continuation), true);
	} finally {
		if (previous === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previous;
		store.removeRun(originId);
		await rm(root, { recursive: true, force: true });
	}
});
