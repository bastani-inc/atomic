#!/usr/bin/env bun
/** Validate the complete trust boundary for the protected publisher. */

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;

export const EXPECTED_REPOSITORY = "bastani-inc/atomic";
export const EXPECTED_REPOSITORY_ID = "1081638046";
export const SIGNAL_WORKFLOW_ID = "314699971";
export const SIGNAL_WORKFLOW_PATH = ".github/workflows/publish-tag-created.yml";
export const PROTECTED_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-release.yml";

export interface PublishContext {
  eventName: string | undefined;
  eventAction: string | undefined;
  workflowRef: string | undefined;
  workflowSha: string | undefined;
  repository: string | undefined;
  repositoryId: string | undefined;
  defaultBranch: string | undefined;
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


export function validatePublishContext(context: PublishContext): "signal" {
  validateProtectedPublisher(context);
  requireExact(context.eventName, "workflow_run", "Publisher event");
  return validateSignalContext(context);
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


if (import.meta.main) {
  const context: PublishContext = {
    eventName: process.env.PUBLISH_EVENT,
    eventAction: process.env.PUBLISH_ACTION,
    workflowRef: process.env.WORKFLOW_REF,
    workflowSha: process.env.WORKFLOW_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.REPOSITORY_ID,
    defaultBranch: process.env.DEFAULT_BRANCH,
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
  validatePublishContext(context);
  verifyProtectedWorkflowAncestry(context.workflowSha, process.env.PROTECTED_DEFAULT_REF);
  console.log(`Accepted protected publisher signal handoff for ${context.releaseTag} at ${context.triggerSha}.`);
}
