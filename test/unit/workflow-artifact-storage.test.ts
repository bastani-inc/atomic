import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	createWorkflowArtifactDirectory,
	ENV_WORKFLOW_ARTIFACT_DIR,
	pruneWorkflowArtifactRuns,
	WORKFLOW_ARTIFACT_RETENTION_MS,
	workflowArtifactRunsRoot,
} from "../../packages/workflows/src/shared/workflow-artifacts.js";

async function withEnv(values: Readonly<Record<string, string | undefined>>, body: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("durable workflow artifacts default to the configured Atomic config root", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-root-"));
	try {
		await withEnv(
			{ [ENV_WORKFLOW_ARTIFACT_DIR]: undefined, ATOMIC_CODING_AGENT_DIR: join(root, "agent") },
			async () => {
				assert.equal(workflowArtifactRunsRoot(), join(root, "workflows", "runs"));
				const runDirectory = await createWorkflowArtifactDirectory("durable-resume-run");
				assert.equal(runDirectory, join(root, "workflows", "runs", "durable-resume-run"));
				await stat(runDirectory);
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the workflow-artifact directory override redirects the durable root", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-override-"));
	try {
		await withEnv({ [ENV_WORKFLOW_ARTIFACT_DIR]: root }, async () => {
			assert.equal(workflowArtifactRunsRoot(), join(root, "runs"));
			assert.equal(await createWorkflowArtifactDirectory("override-run"), join(root, "runs", "override-run"));
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retention pruning removes stale runs and preserves recent runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-retention-"));
	const stale = join(root, "stale-run");
	const fresh = join(root, "fresh-run");
	const now = Date.now();
	try {
		await mkdir(stale, { recursive: true });
		await mkdir(fresh, { recursive: true });
		const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
		await utimes(stale, staleTime, staleTime);
		await pruneWorkflowArtifactRuns(root, now);
		await assert.rejects(stat(stale), /ENOENT/);
		await stat(fresh);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
