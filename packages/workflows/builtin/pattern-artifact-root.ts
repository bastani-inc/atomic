import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunContext } from "../src/shared/types.js";

/**
 * Durable per-run artifact root under `<cwd>/.atomic/workflows/runs`.
 *
 * The random directory name is generated exactly once through `ctx.tool`, so
 * a durable resume replays the original path instead of computing a fresh
 * per-process root. Replayed stages therefore keep reading artifacts written
 * before the interruption. The `mkdir` stays outside the durable checkpoint
 * and is idempotent, so both fresh runs and resumes converge on an existing
 * directory.
 */
export async function stableArtifactRoot(
  ctx: Pick<WorkflowRunContext, "cwd" | "tool">,
  workflowName: string,
): Promise<string> {
  const cwd = ctx.cwd ?? process.cwd();
  const artifactDir = await ctx.tool(
    "artifact-root",
    { workflow: workflowName },
    async () => join(cwd, ".atomic", "workflows", "runs", `${workflowName}-${randomUUID()}`),
  );
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
}
