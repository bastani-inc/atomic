import { execFileSync } from "node:child_process";
import { createGitEnvironment } from "@bastani/atomic";

export type ReleaseKind = "release" | "prerelease";
export type ReleaseStatus = "completed" | "blocked" | "failed";

export type ValidatedRelease = {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
};

export type PublishReleaseOutput = {
  readonly status: ReleaseStatus;
  readonly target_version: string;
  readonly release_kind: ReleaseKind;
  readonly branch: string;
  readonly pr_url?: string;
  readonly tag?: string;
  readonly summary: string;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PullRequestReferenceVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly prUrl: string;
      readonly prNumber: number;
      readonly headRefOid?: string;
      readonly state?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly prUrl?: string;
      readonly prNumber?: number;
    };

export type PullRequestMergeVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly mergeCommitOid: string;
      readonly prUrl?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly prUrl?: string;
    };

export type PullRequestChecksVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly checkCount: number;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

export type PublishWorkflowRunVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly runId: number;
      readonly runUrl?: string;
      readonly status: string;
      readonly conclusion: string;
      readonly headSha?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly runId?: number;
      readonly runUrl?: string;
    };

export type PublishWorkflowRunReference =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly runId: number;
      readonly runUrl?: string;
      readonly status: string;
      readonly conclusion?: string;
      readonly headSha?: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

export const releaseVersionPattern = /^\d+\.\d+\.\d+$/;
export const prereleaseVersionPattern = /^\d+\.\d+\.\d+-alpha\.[1-9]\d*$/;

const statusMarkerPattern = /^([A-Z][A-Z_]*_STATUS): [a-z][a-z0-9_-]*$/u;

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

export function cleanUrl(url: string): string {
  return url.replace(/[),.;]+$/u, "");
}

function urlsIn(text: string): readonly string[] {
  return (text.match(/https?:\/\/\S+/gu) ?? []).map(cleanUrl);
}

export function firstActionsUrl(text: string): string | undefined {
  return urlsIn(text).find((url) => url.includes("/actions/runs/"));
}

export function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

export function hasLeadingStatus(text: string, successMarker: string): boolean {
  return firstNonEmptyLine(text) === successMarker;
}

export function hasStatusMarker(text: string, successMarker: string): boolean {
  const expected = statusMarkerPattern.exec(successMarker);
  if (expected === null) return false;

  const statusKey = expected[1];
  let lastStatusForKey: string | undefined;

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const marker = statusMarkerPattern.exec(trimmed);
    if (marker !== null && marker[1] === statusKey) {
      lastStatusForKey = trimmed;
    }
  }

  return lastStatusForKey === successMarker;
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
  return state === "SUCCESS" || state === "PASSING" || state === "PASSED" || state === "COMPLETED";
}

export function verifyPullRequestChecksJson(value: JsonValue): PullRequestChecksVerification {
  if (!Array.isArray(value)) {
    return { ok: false, summary: "GitHub PR checks response was not a JSON array." };
  }

  if (value.length === 0) {
    return { ok: false, summary: "GitHub PR checks response contained no required checks." };
  }

  const failures: string[] = [];
  for (const [index, check] of value.entries()) {
    if (!isJsonObject(check)) {
      failures.push(`check[${index}] was not a JSON object`);
      continue;
    }

    if (!checkPassed(check)) {
      const name = checkName(check, index);
      const bucket = stringField(check, "bucket") ?? "missing";
      const state = stringField(check, "state") ?? "missing";
      const link = stringField(check, "link");
      failures.push(`${name} bucket=${bucket} state=${state}${link === undefined ? "" : ` link=${link}`}`);
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

    if (headBranch !== expectedHeadBranch || event !== "push") {
      mismatches.push(
        `run[${index}] headBranch=${headBranch ?? "missing"} event=${event ?? "missing"}`,
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
  expectedHeadSha?: string,
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
  const failures: string[] = [];

  if (runId === undefined) failures.push("databaseId was missing or invalid");
  if (headBranch !== expectedHeadBranch) {
    failures.push(`headBranch was ${headBranch ?? "missing"}, expected ${expectedHeadBranch}`);
  }
  if (event !== "push") failures.push(`event was ${event ?? "missing"}, expected push`);
  if (status !== "completed") failures.push(`status was ${status ?? "missing"}, expected completed`);
  if (conclusion !== "success") failures.push(`conclusion was ${conclusion ?? "missing"}, expected success`);
  if (expectedHeadSha !== undefined && headSha !== expectedHeadSha) {
    failures.push(`headSha was ${headSha ?? "missing"}, expected ${expectedHeadSha}`);
  }

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
