#!/usr/bin/env bun
/** Validate the complete trust boundary for the protected publisher. */

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;

export const EXPECTED_REPOSITORY = "bastani-inc/atomic";
export const EXPECTED_REPOSITORY_ID = "1081638046";
export const SIGNAL_WORKFLOW_ID = "314699971";
export const SIGNAL_WORKFLOW_PATH = ".github/workflows/publish-tag-created.yml";
export const PROTECTED_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-release.yml";
export const RECOVERY_TAG = "0.9.10-alpha.1";
export const RECOVERY_SHA = "88c11adcdddcf5245b7b04dd3d2912c7531906fe";
export const RECOVERY_FAILED_PUBLISHER_RUN_ID = "29694686010";
export const RECOVERY_MARKER_PATH = ".github/recovery/0.9.10-alpha.1.json";
export const RECOVERY_MARKER_CONTENT = `{
  "tag": "${RECOVERY_TAG}",
  "sha": "${RECOVERY_SHA}",
  "failedPublisherRunId": "${RECOVERY_FAILED_PUBLISHER_RUN_ID}",
  "removeAfterPublication": true
}
`;

export interface PublishContext {
  eventName: string | undefined;
  eventAction: string | undefined;
  workflowRef: string | undefined;
  workflowSha: string | undefined;
  repository: string | undefined;
  repositoryId: string | undefined;
  defaultBranch: string | undefined;
  gitRef: string | undefined;
  eventBefore: string | undefined;
  eventSha: string | undefined;
  runAttempt: string | undefined;
  signalEvent: string | undefined;
  signalStatus: string | undefined;
  signalConclusion: string | undefined;
  signalPath: string | undefined;
  signalWorkflowId: string | undefined;
  signalRunId: string | undefined;
  signalRunAttempt: string | undefined;
  signalRepository: string | undefined;
  signalRepositoryId: string | undefined;
  signalHeadRepository: string | undefined;
  signalHeadRepositoryId: string | undefined;
  releaseTag: string | undefined;
  triggerSha: string | undefined;
}

function requireExact(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} must be ${expected}; received: ${actual ?? "missing"}`);
}

function requireSha(value: string | undefined, label: string): string {
  if (!value || !SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase commit SHA; received: ${value ?? "missing"}`);
  return value;
}

function validateProtectedPublisher(context: PublishContext): void {
  requireExact(context.repository, EXPECTED_REPOSITORY, "Publisher repository");
  requireExact(context.repositoryId, EXPECTED_REPOSITORY_ID, "Publisher repository ID");
  if (!context.defaultBranch) throw new Error("Missing default branch context");
  const expectedWorkflowRef = `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@refs/heads/${context.defaultBranch}`;
  requireExact(context.workflowRef, expectedWorkflowRef, "Protected publisher workflow ref");
  requireSha(context.workflowSha, "Protected publisher workflow SHA");
  requireSha(context.triggerSha, "Release SHA");
  if (!context.releaseTag) throw new Error("Missing release tag");
}

function validateSignalContext(context: PublishContext): "signal" {
  requireExact(context.eventAction, "completed", "Publisher event action");
  requireExact(context.signalRepository, EXPECTED_REPOSITORY, "Signal repository");
  requireExact(context.signalRepositoryId, EXPECTED_REPOSITORY_ID, "Signal repository ID");
  requireExact(context.signalHeadRepository, EXPECTED_REPOSITORY, "Signal head repository");
  requireExact(context.signalHeadRepositoryId, EXPECTED_REPOSITORY_ID, "Signal head repository ID");
  requireExact(context.signalEvent, "create", "Signal event");
  requireExact(context.signalStatus, "completed", "Signal status");
  requireExact(context.signalConclusion, "success", "Signal conclusion");
  requireExact(context.signalWorkflowId, SIGNAL_WORKFLOW_ID, "Signal workflow ID");
  requireExact(context.signalPath, SIGNAL_WORKFLOW_PATH, "Signal workflow path");
  if (!context.signalRunId || !POSITIVE_INTEGER_PATTERN.test(context.signalRunId)) {
    throw new Error(`Invalid signal run ID: ${context.signalRunId ?? "missing"}`);
  }
  if (!context.signalRunAttempt || !POSITIVE_INTEGER_PATTERN.test(context.signalRunAttempt)) {
    throw new Error(`Invalid signal run attempt: ${context.signalRunAttempt ?? "missing"}`);
  }
  return "signal";
}

function validateRecoveryContext(context: PublishContext): "recovery" {
  requireExact(context.defaultBranch, "main", "Recovery default branch");
  requireExact(context.gitRef, "refs/heads/main", "Recovery ref");
  requireSha(context.eventBefore, "Recovery before SHA");
  requireExact(context.eventSha, context.workflowSha ?? "missing", "Recovery event/workflow SHA");
  requireExact(context.runAttempt, "1", "Recovery run attempt");
  requireExact(context.releaseTag, RECOVERY_TAG, "Recovery tag");
  requireExact(context.triggerSha, RECOVERY_SHA, "Recovery release SHA");
  return "recovery";
}

export function validatePublishContext(context: PublishContext): "signal" | "recovery" {
  validateProtectedPublisher(context);
  if (context.eventName === "workflow_run") return validateSignalContext(context);
  if (context.eventName === "push") return validateRecoveryContext(context);
  throw new Error(`Publisher event must be workflow_run or the exact recovery push; received: ${context.eventName ?? "missing"}`);
}

export function verifyProtectedWorkflowAncestry(
  workflowSha: string | undefined,
  protectedRef: string | undefined,
  cwd: string = process.cwd(),
): void {
  if (!workflowSha || !SHA_PATTERN.test(workflowSha)) {
    throw new Error(`Invalid protected publisher workflow SHA: ${workflowSha ?? "missing"}`);
  }
  if (!protectedRef) throw new Error("Missing protected default ref");
  const result = Bun.spawnSync(["git", "merge-base", "--is-ancestor", workflowSha, protectedRef], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Workflow SHA ${workflowSha} is not contained in protected default-branch history`);
  }
}

function git(revisionArgs: string[], cwd: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["git", ...revisionArgs], { cwd, stdout: "pipe", stderr: "pipe" });
}

export function verifyRecoveryMarker(beforeSha: string | undefined, eventSha: string | undefined, cwd: string = process.cwd()): void {
  const parent = requireSha(beforeSha, "Recovery marker parent");
  const commit = requireSha(eventSha, "Recovery event SHA");
  if (git(["cat-file", "-e", `${parent}^{commit}`], cwd).exitCode !== 0) {
    throw new Error("Recovery marker parent commit is unavailable");
  }
  if (git(["cat-file", "-e", `${commit}^{commit}`], cwd).exitCode !== 0) {
    throw new Error("Recovery event commit is unavailable");
  }
  if (git(["merge-base", "--is-ancestor", parent, commit], cwd).exitCode !== 0) {
    throw new Error("Recovery marker parent is not an ancestor of the recovery event commit");
  }
  if (git(["cat-file", "-e", `${parent}:${RECOVERY_MARKER_PATH}`], cwd).exitCode === 0) {
    throw new Error("Recovery marker already existed before this protected-main push");
  }
  const marker = git(["show", `${commit}:${RECOVERY_MARKER_PATH}`], cwd);
  if (marker.exitCode !== 0) throw new Error("Recovery marker is missing from this protected-main push");
  requireExact(marker.stdout?.toString(), RECOVERY_MARKER_CONTENT, "Recovery marker content");
}

if (import.meta.main) {
  const context: PublishContext = {
    eventName: process.env.PUBLISH_EVENT,
    eventAction: process.env.PUBLISH_ACTION,
    workflowRef: process.env.WORKFLOW_REF,
    workflowSha: process.env.WORKFLOW_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.REPOSITORY_ID,
    defaultBranch: process.env.DEFAULT_BRANCH,
    gitRef: process.env.PUBLISH_REF,
    eventBefore: process.env.EVENT_BEFORE,
    eventSha: process.env.EVENT_SHA,
    runAttempt: process.env.PUBLISH_RUN_ATTEMPT,
    signalEvent: process.env.SIGNAL_EVENT,
    signalStatus: process.env.SIGNAL_STATUS,
    signalConclusion: process.env.SIGNAL_CONCLUSION,
    signalPath: process.env.SIGNAL_PATH,
    signalWorkflowId: process.env.SIGNAL_WORKFLOW_ID,
    signalRunId: process.env.SIGNAL_RUN_ID,
    signalRunAttempt: process.env.SIGNAL_RUN_ATTEMPT,
    signalRepository: process.env.SIGNAL_REPOSITORY,
    signalRepositoryId: process.env.SIGNAL_REPOSITORY_ID,
    signalHeadRepository: process.env.SIGNAL_HEAD_REPOSITORY,
    signalHeadRepositoryId: process.env.SIGNAL_HEAD_REPOSITORY_ID,
    releaseTag: process.env.RELEASE_TAG,
    triggerSha: process.env.TRIGGER_SHA,
  };
  const route = validatePublishContext(context);
  verifyProtectedWorkflowAncestry(context.workflowSha, process.env.PROTECTED_DEFAULT_REF);
  if (route === "recovery") verifyRecoveryMarker(context.eventBefore, context.eventSha);
  console.log(`Accepted protected publisher ${route} handoff for ${context.releaseTag} at ${context.triggerSha}.`);
}
