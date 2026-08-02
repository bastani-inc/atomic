import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import {
	createWorkflowArtifactDirectory,
	ENV_WORKFLOW_ARTIFACT_DIR,
	pruneWorkflowArtifactRuns,
	resolveWorkflowArtifactRunState,
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
				assert.match(runDirectory, /workflows\/runs\/durable-resume-run\/artifact-[^/]+$/);
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
			assert.match(await createWorkflowArtifactDirectory("override-run"), /runs\/override-run\/artifact-[^/]+$/);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("artifact directories remain unique and stay under their owning run", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-unique-"));
	try {
		await withEnv({ [ENV_WORKFLOW_ARTIFACT_DIR]: root }, async () => {
			const first = await createWorkflowArtifactDirectory("run-a");
			const second = await createWorkflowArtifactDirectory("run-a");
			const laterRun = await createWorkflowArtifactDirectory("run-b");
			assert.notEqual(first, second);
			assert.match(first, /runs\/run-a\/artifact-[^/]+$/);
			assert.match(second, /runs\/run-a\/artifact-[^/]+$/);
			assert.match(laterRun, /runs\/run-b\/artifact-[^/]+$/);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retention pruning removes stale orphan runs and preserves recent runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-retention-"));
	const stale = join(root, "stale-run");
	const fresh = join(root, "fresh-run");
	const now = Date.now();
	try {
		await mkdir(stale, { recursive: true });
		await mkdir(fresh, { recursive: true });
		const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
		await utimes(stale, staleTime, staleTime);
		await pruneWorkflowArtifactRuns(root, now, () => "orphan");
		await assert.rejects(stat(stale), /ENOENT/);
		await stat(fresh);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retention pruning preserves stale runs when authoritative state is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-retention-safe-"));
	const stale = join(root, "stale-run");
	const now = Date.now();
	try {
		await mkdir(stale, { recursive: true });
		const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
		await utimes(stale, staleTime, staleTime);
		await pruneWorkflowArtifactRuns(root, now);
		await stat(stale);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("state-aware retention prunes terminal history but keeps old resumable, quit, and blocked runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-state-retention-"));
	const now = Date.now();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const terminalId = "terminal-old";
	const pausedId = "paused-old";
	const quitId = "quit-old";
	const blockedId = "blocked-old";
	try {
		backend.registerWorkflow({
			workflowId: terminalId,
			name: terminalId,
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.registerWorkflow({
			workflowId: pausedId,
			name: pausedId,
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			resumable: true,
		});
		backend.registerWorkflow({
			workflowId: quitId,
			name: quitId,
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			resumable: true,
		});
		store.recordRunStart({
			id: quitId,
			name: quitId,
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			resumable: true,
			exitReason: "quit",
		});
		backend.registerWorkflow({
			workflowId: blockedId,
			name: blockedId,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		for (const id of [terminalId, pausedId, quitId, blockedId]) {
			const directory = join(root, id);
			await mkdir(directory, { recursive: true });
			const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
			await utimes(directory, staleTime, staleTime);
		}

		await pruneWorkflowArtifactRuns(root, now, resolveWorkflowArtifactRunState);

		await assert.rejects(stat(join(root, terminalId)), /ENOENT/);
		assert.equal(backend.getLoadableWorkflow(terminalId), undefined);
		for (const id of [pausedId, quitId, blockedId]) await stat(join(root, id));
		assert.notEqual(backend.getLoadableWorkflow(pausedId), undefined);
		assert.notEqual(backend.getLoadableWorkflow(quitId), undefined);
		assert.notEqual(backend.getLoadableWorkflow(blockedId), undefined);
	} finally {
		store.removeRun(quitId);
		setDurableBackend(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

// Regression (greptile P2 on PR #2139): `resumable === true` was treated as
// protection on its own, and `isDurableWorkflowResumable` deliberately accepts
// `failed`. Every failed run was therefore pinned forever, so repeated
// recoverable failures accumulated artifacts the advertised window never
// reclaimed. A failed run is retryable, but the retention window is the grace
// period it gets.
test("a stale failed run is pruned even though it remains resumable", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-failed-retention-"));
	const now = Date.now();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const failedId = "failed-old";
	const runningId = "running-old";
	try {
		backend.registerWorkflow({
			workflowId: failedId,
			name: failedId,
			inputs: {},
			createdAt: 1,
			status: "failed",
			completedCheckpoints: 1,
			resumable: true,
		});
		backend.registerWorkflow({
			workflowId: runningId,
			name: runningId,
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 1,
			resumable: true,
		});
		for (const id of [failedId, runningId]) {
			const directory = join(root, id);
			await mkdir(directory, { recursive: true });
			const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
			await utimes(directory, staleTime, staleTime);
		}

		await pruneWorkflowArtifactRuns(root, now, resolveWorkflowArtifactRunState);

		await assert.rejects(stat(join(root, failedId)), /ENOENT/);
		// Live work stays protected regardless of age.
		await stat(join(root, runningId));
	} finally {
		setDurableBackend(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test("terminal artifact pruning preserves the directory when durable deletion is refused", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-retention-refused-"));
	const now = Date.now();
	const backend = new InMemoryDurableBackend();
	const runId = "terminal-refused";
	setDurableBackend(backend);
	try {
		backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "completed" });
		const directory = join(root, runId);
		await mkdir(directory, { recursive: true });
		const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
		await utimes(directory, staleTime, staleTime);
		backend.deleteWorkflowIfInactive = async () => ({ ok: false, reason: "running" });

		await pruneWorkflowArtifactRuns(root, now, resolveWorkflowArtifactRunState);

		await stat(directory);
		assert.notEqual(backend.getLoadableWorkflow(runId), undefined);
	} finally {
		setDurableBackend(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test("state-aware pruning never leaves a resumable durable entry without its artifact directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-artifact-ordering-"));
	const now = Date.now();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const runId = "resumable-ordering";
	try {
		backend.registerWorkflow({
			workflowId: runId,
			name: runId,
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			resumable: true,
		});
		const directory = join(root, runId);
		await mkdir(directory, { recursive: true });
		const staleTime = new Date(now - WORKFLOW_ARTIFACT_RETENTION_MS - 1);
		await utimes(directory, staleTime, staleTime);

		await pruneWorkflowArtifactRuns(root, now, resolveWorkflowArtifactRunState);

		await stat(directory);
		assert.notEqual(backend.getLoadableWorkflow(runId), undefined);
	} finally {
		setDurableBackend(undefined);
		await rm(root, { recursive: true, force: true });
	}
});
