import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, getEnvValue } from "@bastani/atomic";

/** Maximum age of durable workflow run artifacts before the next workflow write prunes them. */
export const WORKFLOW_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Overrides the durable workflow-artifact root, mirroring the agent-directory override convention. */
export const ENV_WORKFLOW_ARTIFACT_DIR = "ATOMIC_WORKFLOW_ARTIFACT_DIR";

function workflowArtifactRoot(): string {
	const override = getEnvValue(ENV_WORKFLOW_ARTIFACT_DIR);
	if (override !== undefined && override.length > 0) return override;
	return join(dirname(getAgentDir()), "workflows");
}

export function workflowArtifactRunsRoot(): string {
	return join(workflowArtifactRoot(), "runs");
}

function safeRunId(runId: string): string {
	const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
	return safe.length > 0 ? safe : "run";
}

export function workflowArtifactRunPath(runId: string): string {
	return join(workflowArtifactRunsRoot(), safeRunId(runId));
}

/** Remove run directories older than WORKFLOW_ARTIFACT_RETENTION_MS. */
export async function pruneWorkflowArtifactRuns(root = workflowArtifactRunsRoot(), now = Date.now()): Promise<void> {
	try {
		const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const entryPath = join(root, entry.name);
			let metadata: Awaited<ReturnType<typeof stat>>;
			try {
				metadata = await stat(entryPath);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			if (now - metadata.mtimeMs > WORKFLOW_ARTIFACT_RETENTION_MS) {
				await rm(entryPath, { recursive: true, force: true });
			}
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

/** Create a durable, uniquely named run directory and prune expired sibling runs. */
export async function createWorkflowArtifactDirectory(runId?: string): Promise<string> {
	await pruneWorkflowArtifactRuns();
	const directory = workflowArtifactRunPath(runId ?? randomUUID());
	await mkdir(directory, { recursive: true });
	return directory;
}
