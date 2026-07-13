import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import type {
  WorkflowArtifact,
  WorkflowDirectTaskItem,
  WorkflowTaskResult,
} from "../../shared/types.js";
import { setupGitWorktreeCached, type GitWorktreeSetupCache } from "../shared/worktree.js";
import { resolveContainedRelativePath, resolveWorktreeStageCwd } from "../shared/worktree-cwd.js";
import type { DirectOutputIsolation } from "./executor-direct-helpers.js";
import { resolveWorkflowPath, taskBaseDir } from "./executor-task-prompts.js";

function nonBlankChainDir(chainDir: string | undefined): string | undefined {
  return typeof chainDir === "string" && chainDir.trim().length > 0 ? chainDir : undefined;
}

export async function writeDirectOutput(
  item: Pick<WorkflowDirectTaskItem, "cwd" | "output" | "outputMode" | "gitWorktreeDir" | "baseBranch"> & { readonly chainDir?: string },
  result: WorkflowTaskResult,
  workflowInvocationCwd: string = process.cwd(),
  outputIsolation?: DirectOutputIsolation,
  gitWorktreeSetupCache?: GitWorktreeSetupCache,
): Promise<{ result: WorkflowTaskResult; artifact?: WorkflowArtifact }> {
  if (typeof item.output !== "string") return { result };

  const explicitChainDir = nonBlankChainDir(item.chainDir);
  let outputPath: string;
  let containment: { readonly root: string; readonly baseDir: string; readonly description: string } | undefined;
  if (isAbsolute(item.output)) {
    outputPath = item.output;
  } else if (explicitChainDir !== undefined) {
    outputPath = resolveWorkflowPath(item.output, resolveWorkflowPath(explicitChainDir, process.cwd()));
  } else if (outputIsolation !== undefined) {
    await mkdir(outputIsolation.trustedRoot, { recursive: true });
    const baseRelative = relative(outputIsolation.trustedRoot, outputIsolation.baseDir);
    const baseDir = resolveContainedRelativePath(
      outputIsolation.trustedRoot,
      outputIsolation.trustedRoot,
      baseRelative,
      "runner artifact root",
    );
    await mkdir(baseDir, { recursive: true });
    containment = { root: baseDir, baseDir, description: "runner output root" };
    outputPath = resolveContainedRelativePath(baseDir, baseDir, item.output, containment.description);
  } else if (typeof item.gitWorktreeDir === "string") {
    const setup = setupGitWorktreeCached({
      gitWorktreeDir: item.gitWorktreeDir,
      baseBranch: item.baseBranch,
      cwd: workflowInvocationCwd,
    }, gitWorktreeSetupCache);
    const baseDir = resolveWorktreeStageCwd(item.cwd, setup) ?? setup.cwd;
    containment = { root: setup.worktreeRoot, baseDir, description: "gitWorktreeDir" };
    outputPath = resolveContainedRelativePath(setup.worktreeRoot, baseDir, item.output, containment.description);
  } else {
    outputPath = resolveWorkflowPath(item.output, taskBaseDir(item));
  }

  await mkdir(dirname(outputPath), { recursive: true });
  if (containment !== undefined) {
    outputPath = resolveContainedRelativePath(
      containment.root,
      containment.baseDir,
      item.output,
      containment.description,
    );
  }
  await writeFile(outputPath, result.text, "utf8");

  const visibleResult = item.outputMode === "file-only" ? { ...result, text: "" } : result;
  return {
    result: visibleResult,
    artifact: {
      kind: "output",
      path: outputPath,
      taskName: result.name,
    },
  };
}
