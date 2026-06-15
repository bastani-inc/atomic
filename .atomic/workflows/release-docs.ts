import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow, Type } from "@bastani/workflows";
import deepResearchCodebase from "@bastani/workflows/builtin/deep-research-codebase";
import {
  currentBranchName,
  DEFAULT_RELEASE_DOCS_BASE_BRANCH,
  extractJsonArray,
  findMissingOrEmptyUpdateArtifacts,
  mergeStaleDocTasksByOwnerDocs,
  nextDocsValidationPhase,
  releaseDocsUpdateTaskKey,
  requireNonBaseBranch,
  requireResearchDocPath,
  runDocsChecks,
  runGit,
  sanitizeSegment,
  verifyReleaseDocsPr,
} from "./lib/release-docs.js";

const staleDocTaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  owner_docs: Type.Array(Type.String()),
  reason: Type.String(),
  source_refs: Type.Array(Type.String()),
  update_instructions: Type.String(),
  acceptance_criteria: Type.Array(Type.String()),
});

const ensureCleanWorkingTree = (): void => {
  const status = runGit(["status", "--porcelain=v1"]);
  if (status.length > 0) {
    throw new Error(
      [
        "release-docs refuses to start on a dirty working tree because it edits docs, commits, and pushes on the current branch.",
        "Commit, stash, or discard existing changes first.",
        "Current status:",
        status,
      ].join("\n"),
    );
  }
};

const writeJson = (path: string, value: object): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export default defineWorkflow("release-docs")
  .description("Prepare Atomic release docs updates from the current branch, validate Mintlify docs, and open a PR.")
  .output("result", Type.String({ description: "Human-readable release docs workflow summary." }))
  .output(
    "status",
    Type.Union([Type.Literal("pr_created"), Type.Literal("no_changes"), Type.Literal("needs_investigation")], {
      description: "Final workflow status.",
    }),
  )
  .output("current_branch", Type.String({ description: "Current git branch the workflow ran on." }))
  .output("artifact_root", Type.String({ description: "Workflow artifact directory for this run." }))
  .output("research_doc_path", Type.String({ description: "Research artifact path from the codebase research child workflow." }))
  .output("stale_doc_task_count", Type.Number({ description: "Number of grouped stale-doc update tasks found." }))
  .output("stale_doc_tasks", Type.Array(staleDocTaskSchema, { description: "Grouped stale-doc update tasks." }))
  .output("validation_report_path", Type.String({ description: "Validation report artifact path." }))
  .output("pr_summary", Type.Optional(Type.String({ description: "PR creation summary or no-op explanation." })))
  .run(async (ctx) => {
    ensureCleanWorkingTree();
    const prBase = DEFAULT_RELEASE_DOCS_BASE_BRANCH;
    const currentBranch = requireNonBaseBranch(currentBranchName(), prBase);
    const artifactKey = sanitizeSegment(currentBranch);
    const artifactRoot = join(".atomic", "workflows", "runs", "release-docs", artifactKey);
    const updatesRoot = join(artifactRoot, "updates");
    mkdirSync(updatesRoot, { recursive: true });

    const metadataPath = join(artifactRoot, "release-metadata.json");
    const staleTasksPath = join(artifactRoot, "stale-doc-tasks.json");
    const validationPath = join(artifactRoot, "validation.md");
    const repairPath = join(artifactRoot, "validation-repair.md");
    const prPath = join(artifactRoot, "pr.md");

    writeJson(metadataPath, {
      current_branch: currentBranch,
      docs_root: "packages/coding-agent/docs",
      pr_base: prBase,
      mode: "current-branch-docs-refresh",
    });

    await ctx.stage("prepare-release-docs-current-branch", { noTools: "all" }).prompt(
      [
        "Release docs current-branch preparation is complete.",
        `Current branch: ${currentBranch}`,
        `Metadata artifact: ${metadataPath}`,
        "The workflow will compare the current codebase behavior against the current docs tree.",
        "Reply exactly: RELEASE_DOCS_CURRENT_BRANCH_READY",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    const research = await ctx.workflow(deepResearchCodebase, {
      stageName: "research-current-code-docs-gaps",
      inputs: {
        prompt: [
          "Research Atomic documentation gaps for the current branch.",
          "Compare the current codebase behavior against docs under packages/coding-agent/docs.",
          "Do not use release target refs, baseline tags, or git comparison ranges for this analysis.",
          "Focus on developer-facing and user-facing behavior that should be reflected in the hosted docs.",
          "Document concrete file paths, symbols, CLI/workflow/settings behavior, and docs implications.",
          "Do not edit files; this stage is research only.",
        ].join("\n"),
        max_partitions: 100,
        max_concurrency: 8,
      },
    });

    const researchDocPath = requireResearchDocPath(research.outputs.research_doc_path);

    await ctx.task("identify-stale-docs", {
      prompt: [
        "Identify stale Atomic docs entries for the current branch.",
        `Release docs metadata artifact: ${metadataPath}`,
        `Research artifact: ${researchDocPath}`,
        "Read the metadata and research artifacts before inspecting docs.",
        "Docs scope is strictly packages/coding-agent/docs.",
        "Inspect the current docs against the current codebase research and emit grouped, non-overlapping update tasks.",
        "Group stale entries by owning docs files so parallel update workers do not edit the same file concurrently.",
        "If multiple stale entries touch the same docs file, put them in the same task.",
        "If no stale docs are found, write exactly [].",
        "Write ONLY a JSON array to the output file. Do not wrap it in prose unless JSON fences are unavoidable.",
        "Each array item must have this shape:",
        "{",
        "  \"id\": \"short-kebab-id\",",
        "  \"title\": \"short human title\",",
        "  \"owner_docs\": [\"packages/coding-agent/docs/path.mdx\"],",
        "  \"reason\": \"why the current docs are stale\",",
        "  \"source_refs\": [\"code or research references\"],",
        "  \"update_instructions\": \"specific docs update instructions\",",
        "  \"acceptance_criteria\": [\"observable criteria for this docs task\"]",
        "}",
      ].join("\n"),
      reads: [metadataPath, researchDocPath],
      output: staleTasksPath,
      outputMode: "file-only",
      context: "fresh",
    });

    const modelStaleTasks = extractJsonArray(readFileSync(staleTasksPath, "utf8"));
    const staleTasks = mergeStaleDocTasksByOwnerDocs(modelStaleTasks);
    writeJson(staleTasksPath, staleTasks);

    if (staleTasks.length === 0) {
      const result = [
        `No stale docs entries were found for current branch ${currentBranch}.`,
        "No docs changes were made, so no PR was opened.",
        `Research artifact: ${researchDocPath}`,
        `Stale-doc task artifact: ${staleTasksPath}`,
      ].join("\n");
      writeFileSync(validationPath, "Validation skipped because no stale docs tasks were found.\n");
      return {
        result,
        status: "no_changes" as const,
        current_branch: currentBranch,
        artifact_root: artifactRoot,
        research_doc_path: researchDocPath,
        stale_doc_task_count: 0,
        stale_doc_tasks: staleTasks,
        validation_report_path: validationPath,
        pr_summary: "No docs changes; PR skipped.",
      };
    }

    const updateTaskKeys = staleTasks.map(releaseDocsUpdateTaskKey);
    const updateArtifacts = updateTaskKeys.map((key) => join(updatesRoot, `${key}.md`));
    await ctx.parallel(
      staleTasks.map((task, index) => ({
        name: `update-docs-${updateTaskKeys[index]}`,
        prompt: [
          "Update Atomic release docs for one grouped stale-doc task.",
          `Release docs metadata artifact: ${metadataPath}`,
          `Research artifact: ${researchDocPath}`,
          `Full stale-doc task list: ${staleTasksPath}`,
          "Assigned stale-doc task JSON:",
          JSON.stringify(task, null, 2),
          "Read the listed artifacts and then edit only the owner_docs files.",
          "Leave shared nav, index, and cross-link repairs to the serial validation/repair stage if needed.",
          "Do not edit code, changelogs, package manifests, or docs outside packages/coding-agent/docs.",
          "Do not commit, push, or create a PR.",
          "When finished, summarize changed files, evidence used, and residual risks.",
        ].join("\n"),
        reads: [metadataPath, researchDocPath, staleTasksPath, ...task.owner_docs.filter((path) => existsSync(path))],
        output: updateArtifacts[index],
        outputMode: "file-only" as const,
        context: "fresh" as const,
      })),
      { concurrency: Math.min(4, staleTasks.length), failFast: false },
    );

    const updateArtifactStatuses = updateArtifacts.map((path) => {
      const exists = existsSync(path);
      return {
        path,
        exists,
        empty: !exists || readFileSync(path, "utf8").trim().length === 0,
      };
    });
    const missingOrEmptyUpdateArtifacts = findMissingOrEmptyUpdateArtifacts(updateArtifactStatuses);
    if (missingOrEmptyUpdateArtifacts.length > 0) {
      const result = [
        `Docs update workers did not produce all required update artifacts for current branch ${currentBranch}.`,
        "The workflow stopped before validation, commit, push, and PR creation. Investigation is required.",
        "Missing or empty update artifacts:",
        ...missingOrEmptyUpdateArtifacts.map((artifact) =>
          `- ${artifact.path}: ${artifact.exists ? "empty" : "missing"}`,
        ),
      ].join("\n");
      writeFileSync(validationPath, `${result}\n`);
      return {
        result,
        status: "needs_investigation" as const,
        current_branch: currentBranch,
        artifact_root: artifactRoot,
        research_doc_path: researchDocPath,
        stale_doc_task_count: staleTasks.length,
        stale_doc_tasks: staleTasks,
        validation_report_path: validationPath,
        pr_summary: "Update worker artifacts missing or empty; PR skipped.",
      };
    }

    let validation = runDocsChecks();
    writeFileSync(validationPath, ["# Initial deterministic validation", "", validation.markdown].join("\n"));

    if (nextDocsValidationPhase(validation.ok) === "repair_then_revalidate") {
      await ctx.task("validate-and-repair-release-docs", {
        prompt: [
          "Repair docs-only validation failures found by deterministic release docs validation.",
          `Release docs metadata artifact: ${metadataPath}`,
          `Research artifact: ${researchDocPath}`,
          `Stale-doc task artifact: ${staleTasksPath}`,
          `Initial validation report: ${validationPath}`,
          "Initial deterministic validation failed. Read the validation report before repairing.",
          "Use the validation report to fix docs issues under packages/coding-agent/docs.",
          "You may rerun focused docs checks while repairing, but the workflow will perform the final validation gate deterministically.",
          "Do not commit, push, or create a PR.",
          "If failures appear unrelated to docs-only repairs, write INVESTIGATION REQUIRED with the exact failing command and output.",
          "When finished, summarize changed files, evidence used, commands you ran, and residual risks.",
        ].join("\n"),
        reads: [metadataPath, researchDocPath, staleTasksPath, validationPath, ...updateArtifacts],
        output: repairPath,
        outputMode: "file-only",
        context: "fork",
      });

      validation = runDocsChecks();
      writeFileSync(
        validationPath,
        [
          readFileSync(validationPath, "utf8"),
          "\n\n# Model repair summary\n\n",
          readFileSync(repairPath, "utf8"),
          "\n\n# Post-repair deterministic validation\n\n",
          validation.markdown,
        ].join(""),
      );
    }

    if (!validation.ok) {
      const result = [
        `Docs validation still fails for current branch ${currentBranch}.`,
        "The workflow stopped before commit, push, and PR creation. Investigation is required.",
        `Validation report: ${validationPath}`,
      ].join("\n");
      return {
        result,
        status: "needs_investigation" as const,
        current_branch: currentBranch,
        artifact_root: artifactRoot,
        research_doc_path: researchDocPath,
        stale_doc_task_count: staleTasks.length,
        stale_doc_tasks: staleTasks,
        validation_report_path: validationPath,
        pr_summary: "Validation failed; PR skipped.",
      };
    }

    const docsStatusAfterValidation = runGit(["status", "--porcelain=v1", "packages/coding-agent/docs"]);
    if (docsStatusAfterValidation.length === 0) {
      const result = [
        `No docs changes remained after validation for current branch ${currentBranch}.`,
        "No release docs PR was opened because the docs tree is clean.",
        `Research artifact: ${researchDocPath}`,
        `Stale-doc task artifact: ${staleTasksPath}`,
        `Validation report: ${validationPath}`,
      ].join("\n");
      return {
        result,
        status: "no_changes" as const,
        current_branch: currentBranch,
        artifact_root: artifactRoot,
        research_doc_path: researchDocPath,
        stale_doc_task_count: staleTasks.length,
        stale_doc_tasks: staleTasks,
        validation_report_path: validationPath,
        pr_summary: "No docs changes after validation; PR skipped.",
      };
    }

    const pr = await ctx.task("commit-push-open-release-docs-pr", {
      prompt: [
        "Create the release docs PR now that deterministic validation passed.",
        `Current branch: ${currentBranch}`,
        `PR base: ${prBase}`,
        `Research artifact: ${researchDocPath}`,
        `Validation report: ${validationPath}`,
        "Start by inspecting git status --short.",
        "If there are no changes, do not commit, push, or create a PR; summarize the no-op result.",
        "If there are changes, stage only intentional documentation changes under packages/coding-agent/docs, commit with message:",
        "docs: update release docs",
        "Do not stage .atomic/, .atomic/workflows/runs/, workflow artifacts, release metadata, stale-doc task files, validation reports, PR summaries, update artifacts, research artifacts, or files outside packages/coding-agent/docs.",
        `Push the current branch to origin and create or update a GitHub PR targeting ${prBase} using gh.`,
        "Use this PR title:",
        "docs: update release docs",
        "Include current branch, research artifact, stale-doc task count, and validation commands in the PR body.",
        "Do not tag or publish a release.",
      ].join("\n"),
      reads: [metadataPath, researchDocPath, staleTasksPath, validationPath, ...updateArtifacts],
      output: prPath,
      outputMode: "file-only",
      context: "fork",
    });

    const prSummary = readFileSync(prPath, "utf8").trim() || pr.text;
    const prVerification = verifyReleaseDocsPr(currentBranch, prBase);
    const status = runGit(["status", "--porcelain=v1", "packages/coding-agent/docs"]);
    const finalStatus = status.length > 0 || !prVerification.ok ? "needs_investigation" : "pr_created";
    const combinedPrSummary = [
      prSummary,
      "",
      "# Deterministic PR verification",
      "",
      prVerification.summary,
    ].join("\n");
    const result = [
      finalStatus === "pr_created"
        ? `Release docs PR verified for current branch ${currentBranch}.`
        : `Release docs PR stage could not be fully verified for current branch ${currentBranch}; investigation is required.`,
      `Current branch: ${currentBranch}`,
      `PR base: ${prBase}`,
      `Research artifact: ${researchDocPath}`,
      `Validation report: ${validationPath}`,
      `PR summary artifact: ${prPath}`,
      `PR verification: ${prVerification.summary}`,
    ].join("\n");

    return {
      result,
      status: finalStatus,
      current_branch: currentBranch,
      artifact_root: artifactRoot,
      research_doc_path: researchDocPath,
      stale_doc_task_count: staleTasks.length,
      stale_doc_tasks: staleTasks,
      validation_report_path: validationPath,
      pr_summary: combinedPrSummary,
    };
  })
  .compile();
