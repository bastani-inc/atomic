import { createGitEnvironment } from "../../../packages/coding-agent/src/utils/git-env.js";

import type {
  CommandResult,
  JsonValue,
  PublishWorkflowRunReference,
  PublishWorkflowRunVerification,
  ReleaseKind,
  ValidatedRelease,
} from "./publish-release-types.js";
export type {
  CommandResult,
  JsonPrimitive,
  JsonValue,
  PullRequestChecksVerification,
  PullRequestMergeVerification,
  PullRequestReferenceVerification,
  PublishReleaseOutput,
  PublishWorkflowRunReference,
  PublishWorkflowRunVerification,
  ReleaseKind,
  ReleaseStatus,
  ReleasePrState,
  ValidatedRelease,
} from "./publish-release-types.js";
export {
  verifyPullRequestChecksForHeadJson,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
} from "./publish-release-pr.js";

export const releaseVersionPattern = /^\d+\.\d+\.\d+$/;
export const prereleaseVersionPattern = /^\d+\.\d+\.\d+-alpha\.[1-9]\d*$/;

export function validateReleaseRequest(kind: ReleaseKind, version: string): ValidatedRelease {
  if (version.startsWith("v")) {
    throw new Error(`target_version must not include a leading "v"; received ${version}`);
  }

  const matches = kind === "release" ? releaseVersionPattern.test(version) : prereleaseVersionPattern.test(version);

  if (!matches) {
    const expected = kind === "release" ? "MAJOR.MINOR.PATCH" : "MAJOR.MINOR.PATCH-alpha.REVISION";
    throw new Error(`target_version ${JSON.stringify(version)} is not valid for ${kind}; expected ${expected}`);
  }

  return {
    kind,
    version,
    branch: `${kind}/${version}`,
  };
}

// Sanitize repository-local Git environment variables so release subprocesses
// always target this checkout rather than an inherited hook/worktree context.
//
// Async on purpose: this runs inside `ctx.tool` bodies on the TUI event loop.
// A synchronous exec here (e.g. a full `bun run typecheck` + `test:unit`)
// froze the entire TUI for the duration of the command.
export async function runCommand(args: readonly string[]): Promise<CommandResult> {
  const [command, ...commandArgs] = args;
  if (command === undefined) {
    return {
      command: "",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot run an empty command.",
    };
  }

  try {
    const proc = Bun.spawn([command, ...commandArgs], {
      env: createGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      command: args.join(" "),
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      command: args.join(" "),
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export function commandSummary(result: CommandResult): string {
  return [
    `$ ${result.command}`,
    `exitCode: ${result.exitCode}`,
    result.stdout.length === 0 ? undefined : `stdout:\n${result.stdout}`,
    result.stderr.length === 0 ? undefined : `stderr:\n${result.stderr}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function parseJsonCommand(
  result: CommandResult,
  failurePrefix: string,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly summary: string } {
  try {
    return { ok: true, value: JSON.parse(result.stdout) as JsonValue };
  } catch {
    return { ok: false, summary: [failurePrefix, commandSummary(result)].join("\n\n") };
  }
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(object: { readonly [key: string]: JsonValue }, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerField(object: { readonly [key: string]: JsonValue }, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nullableStringField(object: { readonly [key: string]: JsonValue }, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}



export function selectPublishWorkflowRunJson(
  value: JsonValue,
  expectedHeadBranch: string,
): PublishWorkflowRunReference {
  if (!Array.isArray(value)) {
    return { ok: false, summary: "GitHub Actions run list response was not a JSON array." };
  }

  const mismatches: string[] = [];

  for (const [index, candidate] of value.entries()) {
    if (!isJsonObject(candidate)) {
      mismatches.push(`run[${index}] was not a JSON object`);
      continue;
    }

    const headBranch = stringField(candidate, "headBranch");
    const event = stringField(candidate, "event");
    const runId = positiveIntegerField(candidate, "databaseId");
    const status = stringField(candidate, "status");
    const conclusion = nullableStringField(candidate, "conclusion");
    const runUrl = stringField(candidate, "url");
    const headSha = stringField(candidate, "headSha");
    const displayTitle = stringField(candidate, "displayTitle");
    const workflowName = stringField(candidate, "workflowName");

    if (displayTitle !== `Publish ${expectedHeadBranch}` || event !== "create" || headBranch !== expectedHeadBranch || workflowName !== "Publish") {
      mismatches.push(
        `run[${index}] displayTitle=${displayTitle ?? "missing"} event=${event ?? "missing"} headBranch=${headBranch ?? "missing"} workflowName=${workflowName ?? "missing"}`,
      );
      continue;
    }

    const failures: string[] = [];
    if (runId === undefined) failures.push("databaseId was missing or invalid");
    if (status === undefined) failures.push("status was missing");

    if (failures.length > 0 || runId === undefined || status === undefined) {
      return {
        ok: false,
        summary: [
          "GitHub Actions publish run is not selectable.",
          ...failures.map((failure) => `- ${failure}`),
        ].join("\n"),
      };
    }

    return {
      ok: true,
      summary: [
        "GitHub Actions tag-triggered publish run is selected.",
        `databaseId: ${runId}`,
        `releaseTag: ${expectedHeadBranch}`,
        `event: ${event}`,
        `status: ${status}`,
        conclusion === undefined ? undefined : `conclusion: ${conclusion}`,
        headSha === undefined ? undefined : `headSha: ${headSha}`,
        runUrl === undefined ? undefined : `url: ${runUrl}`,
      ].filter((line): line is string => line !== undefined).join("\n"),
      runId,
      runUrl,
      status,
      conclusion,
      headSha,
    };
  }

  return {
    ok: false,
    summary: [
      "GitHub Actions tag-triggered publish run was not found for the release tag.",
      `expected release: ${expectedHeadBranch} on protected main workflow Publish`,
      `examined runs: ${value.length}`,
      ...mismatches.slice(0, 10).map((mismatch) => `- ${mismatch}`),
    ].join("\n"),
  };
}

export function verifyPublishWorkflowRunJson(
  value: JsonValue,
  expectedHeadBranch: string,
): PublishWorkflowRunVerification {
  if (!isJsonObject(value)) {
    return { ok: false, summary: "GitHub Actions run response was not a JSON object." };
  }

  const headBranch = stringField(value, "headBranch");
  const event = stringField(value, "event");
  const runId = positiveIntegerField(value, "databaseId");
  const status = stringField(value, "status");
  const conclusion = nullableStringField(value, "conclusion");
  const runUrl = stringField(value, "url");
  const workflowName = stringField(value, "workflowName");
  const headSha = stringField(value, "headSha");
  const displayTitle = stringField(value, "displayTitle");
  const failures: string[] = [];

  if (runId === undefined) failures.push("databaseId was missing or invalid");
  if (displayTitle !== `Publish ${expectedHeadBranch}`) {
    failures.push(`displayTitle was ${displayTitle ?? "missing"}, expected Publish ${expectedHeadBranch}`);
  }
  if (headBranch !== expectedHeadBranch) failures.push(`headBranch was ${headBranch ?? "missing"}, expected ${expectedHeadBranch}`);
  if (workflowName !== "Publish") failures.push(`workflowName was ${workflowName ?? "missing"}, expected Publish`);
  if (event !== "create") failures.push(`event was ${event ?? "missing"}, expected create`);
  if (status !== "completed") failures.push(`status was ${status ?? "missing"}, expected completed`);
  if (conclusion !== "success") failures.push(`conclusion was ${conclusion ?? "missing"}, expected success`);
  // The create event loads the workflow from the default branch while github.sha
  // and the run head identify the newly-created tag commit.

  if (failures.length > 0 || runId === undefined || status === undefined || conclusion === undefined) {
    return {
      ok: false,
      summary: [
        "GitHub Actions publish run is not verified as successful.",
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
      runId,
      runUrl,
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub Actions publish run is verified as successful.",
      `databaseId: ${runId}`,
      workflowName === undefined ? undefined : `workflowName: ${workflowName}`,
      `releaseTag: ${expectedHeadBranch}`,
      `event: ${event}`,
      `status: ${status}`,
      `conclusion: ${conclusion}`,
      headSha === undefined ? undefined : `headSha: ${headSha}`,
      runUrl === undefined ? undefined : `url: ${runUrl}`,
    ].filter((line): line is string => line !== undefined).join("\n"),
    runId,
    runUrl,
    status,
    conclusion,
    headSha,
  };
}
