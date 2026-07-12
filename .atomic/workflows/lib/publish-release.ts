import { execFileSync } from "node:child_process";
import { createGitEnvironment } from "../../../packages/coding-agent/src/utils/git-env.js";

import type {
  CommandResult,
  JsonValue,
  PullRequestChecksVerification,
  PullRequestMergeVerification,
  PullRequestReferenceVerification,
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
  ValidatedRelease,
} from "./publish-release-types.js";

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
export function runCommand(args: readonly string[]): CommandResult {
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
    const stdout = execFileSync(command, commandArgs, {
      encoding: "utf8",
      env: createGitEnvironment(),
      maxBuffer: 1024 * 1024 * 20,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    return {
      command: args.join(" "),
      exitCode: 0,
      stdout,
      stderr: "",
    };
  } catch (error) {
    const failure = error as {
      readonly status?: number;
      readonly stdout?: Buffer | string;
      readonly stderr?: Buffer | string;
      readonly message?: string;
    };
    const stdout = String(failure.stdout ?? "").trim();
    const stderr = String(failure.stderr ?? failure.message ?? "").trim();

    return {
      command: args.join(" "),
      exitCode: failure.status ?? 1,
      stdout,
      stderr,
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

export function verifyReleasePullRequestReferenceJson(
  value: JsonValue,
  expectedHeadRefName: string,
  expectedBaseRefName = "main",
  expectedHeadRefOid?: string,
  expectedState?: string,
): PullRequestReferenceVerification {
  if (!isJsonObject(value)) {
    return { ok: false, summary: "GitHub PR reference response was not a JSON object." };
  }

  const baseRefName = stringField(value, "baseRefName");
  const headRefName = stringField(value, "headRefName");
  const headRefOid = stringField(value, "headRefOid");
  const prUrl = stringField(value, "url");
  const prNumber = positiveIntegerField(value, "number");
  const state = stringField(value, "state");
  const failures: string[] = [];

  if (prUrl === undefined) failures.push("url was missing");
  if (prNumber === undefined) failures.push("number was missing or invalid");
  if (baseRefName !== expectedBaseRefName) {
    failures.push(`baseRefName was ${baseRefName ?? "missing"}, expected ${expectedBaseRefName}`);
  }
  if (headRefName !== expectedHeadRefName) {
    failures.push(`headRefName was ${headRefName ?? "missing"}, expected ${expectedHeadRefName}`);
  }
  if (expectedHeadRefOid !== undefined && headRefOid !== expectedHeadRefOid) {
    failures.push(`headRefOid was ${headRefOid ?? "missing"}, expected ${expectedHeadRefOid}`);
  }
  if (expectedState !== undefined && state !== expectedState) {
    failures.push(`state was ${state ?? "missing"}, expected ${expectedState}`);
  }

  if (failures.length > 0 || prUrl === undefined || prNumber === undefined) {
    return {
      ok: false,
      summary: ["GitHub PR reference is not verified.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
      prUrl,
      prNumber,
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub PR reference is verified.",
      `number: ${prNumber}`,
      `url: ${prUrl}`,
      `baseRefName: ${baseRefName}`,
      `headRefName: ${headRefName}`,
      headRefOid === undefined ? undefined : `headRefOid: ${headRefOid}`,
      state === undefined ? undefined : `state: ${state}`,
    ].filter((line): line is string => line !== undefined).join("\n"),
    prUrl,
    prNumber,
    headRefOid,
    state,
  };
}

export function verifyPullRequestMergedJson(
  value: JsonValue,
  expectedHeadRefName: string,
  expectedBaseRefName = "main",
  expectedHeadRefOid?: string,
): PullRequestMergeVerification {
  if (!isJsonObject(value)) {
    return { ok: false, summary: "GitHub PR response was not a JSON object." };
  }

  const state = stringField(value, "state");
  const mergedAt = stringField(value, "mergedAt");
  const baseRefName = stringField(value, "baseRefName");
  const headRefName = stringField(value, "headRefName");
  const headRefOid = stringField(value, "headRefOid");
  const prUrl = stringField(value, "url");
  const mergeCommit = value.mergeCommit;
  const mergeCommitOid = isJsonObject(mergeCommit) ? stringField(mergeCommit, "oid") : undefined;
  const failures: string[] = [];

  if (state !== "MERGED") failures.push(`state was ${state ?? "missing"}, expected MERGED`);
  if (mergedAt === undefined) failures.push("mergedAt was missing");
  if (mergeCommitOid === undefined) failures.push("mergeCommit.oid was missing");
  if (baseRefName !== expectedBaseRefName) {
    failures.push(`baseRefName was ${baseRefName ?? "missing"}, expected ${expectedBaseRefName}`);
  }
  if (headRefName !== expectedHeadRefName) {
    failures.push(`headRefName was ${headRefName ?? "missing"}, expected ${expectedHeadRefName}`);
  }
  if (expectedHeadRefOid !== undefined && headRefOid !== expectedHeadRefOid) {
    failures.push(`headRefOid was ${headRefOid ?? "missing"}, expected ${expectedHeadRefOid}`);
  }

  if (failures.length > 0 || mergeCommitOid === undefined) {
    return {
      ok: false,
      summary: ["GitHub PR is not verified as merged.", ...failures.map((failure) => `- ${failure}`)].join("\n"),
      prUrl,
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub PR is verified as merged.",
      `state: ${state}`,
      `mergedAt: ${mergedAt}`,
      `mergeCommit.oid: ${mergeCommitOid}`,
      `baseRefName: ${baseRefName}`,
      `headRefName: ${headRefName}`,
      headRefOid === undefined ? undefined : `headRefOid: ${headRefOid}`,
      prUrl === undefined ? undefined : `url: ${prUrl}`,
    ].filter((line): line is string => line !== undefined).join("\n"),
    mergeCommitOid,
    prUrl,
  };
}

function checkName(value: JsonValue, index: number): string {
  if (!isJsonObject(value)) return `check[${index}]`;
  return stringField(value, "name") ?? stringField(value, "workflow") ?? `check[${index}]`;
}

function checkPassed(value: { readonly [key: string]: JsonValue }): boolean {
  const bucket = stringField(value, "bucket")?.toLowerCase();
  if (bucket !== undefined) return bucket === "pass";

  const state = stringField(value, "state")?.toUpperCase();
  return state === "SUCCESS" || state === "PASSING" || state === "PASSED";
}

function checkPending(value: { readonly [key: string]: JsonValue }): boolean {
  const bucket = stringField(value, "bucket")?.toLowerCase();
  if (bucket !== undefined) return bucket === "pending";

  const state = stringField(value, "state")?.toUpperCase();
  return state === "PENDING" || state === "QUEUED" || state === "IN_PROGRESS" || state === "WAITING" || state === "REQUESTED";
}

export function verifyPullRequestChecksJson(value: JsonValue): PullRequestChecksVerification {
  if (!Array.isArray(value)) {
    return { ok: false, summary: "GitHub PR checks response was not a JSON array." };
  }

  if (value.length === 0) {
    return { ok: false, summary: "GitHub PR checks response contained no required checks." };
  }

  const failures: string[] = [];
  const pending: string[] = [];
  for (const [index, check] of value.entries()) {
    if (!isJsonObject(check)) {
      failures.push(`check[${index}] was not a JSON object`);
      continue;
    }

    if (checkPassed(check)) continue;

    const name = checkName(check, index);
    const bucket = stringField(check, "bucket") ?? "missing";
    const state = stringField(check, "state") ?? "missing";
    const link = stringField(check, "link");
    const line = `${name} bucket=${bucket} state=${state}${link === undefined ? "" : ` link=${link}`}`;
    if (checkPending(check)) {
      pending.push(line);
    } else {
      failures.push(line);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      summary: [
        "GitHub PR required checks are not verified as passing.",
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    };
  }

  if (pending.length > 0) {
    return {
      ok: false,
      pending: true,
      summary: [
        "GitHub PR required checks are still pending.",
        ...pending.map((check) => `- ${check}`),
      ].join("\n"),
    };
  }

  return {
    ok: true,
    summary: [
      "GitHub PR required checks are verified as passing.",
      `checkCount: ${value.length}`,
    ].join("\n"),
    checkCount: value.length,
  };
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

    if (displayTitle !== `Publish ${expectedHeadBranch}` || event !== "workflow_dispatch") {
      mismatches.push(
        `run[${index}] displayTitle=${displayTitle ?? "missing"} event=${event ?? "missing"}`,
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
        "GitHub Actions publish run is selected.",
        `databaseId: ${runId}`,
        `headBranch: ${headBranch}`,
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
      "GitHub Actions publish run was not found for the release tag.",
      `expected headBranch: ${expectedHeadBranch}`,
      `examined runs: ${value.length}`,
      ...mismatches.slice(0, 10).map((mismatch) => `- ${mismatch}`),
    ].join("\n"),
  };
}

export function verifyPublishWorkflowRunJson(
  value: JsonValue,
  expectedHeadBranch: string,
  _expectedHeadSha?: string,
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
  if (event !== "workflow_dispatch") failures.push(`event was ${event ?? "missing"}, expected workflow_dispatch`);
  if (status !== "completed") failures.push(`status was ${status ?? "missing"}, expected completed`);
  if (conclusion !== "success") failures.push(`conclusion was ${conclusion ?? "missing"}, expected success`);
  // workflow_dispatch runs execute the protected default-branch workflow; its
  // headSha is therefore the workflow revision, while the integrity job pins
  // and verifies the release SHA supplied as input.

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
      `headBranch: ${headBranch}`,
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
