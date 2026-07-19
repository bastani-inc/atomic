import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_ID,
  LEGACY_WORKFLOW_PATH,
  PROTECTED_PUBLISH_WORKFLOW_PATH,
  RECOVERY_WORKFLOW_ID,
  SIGNAL_WORKFLOW_ID,
  SIGNAL_WORKFLOW_PATH,
  validatePublishContext,
  verifyProtectedWorkflowAncestry,
  type PublishContext,
} from "../../scripts/verify-publish-context.js";

type RecoveryFixture = {
  repository: string;
  normalSignalWorkflowId: string;
  normalSignalWorkflowPath: string;
  repositoryId: string;
  runId: string;
  permittedRunAttempt: string;
  workflowId: string;
  workflowPath: string;
  event: string;
  status: string;
  conclusion: string;
  tag: string;
  sha: string;
  observedWorkflowRef: string;
  historicalWorkflowSha256: string;
  releaseBaseRef: string;
  releaseBaseSha: string;
  changelogSectionSha256: Record<string, string>;
};

const fixture = await Bun.file("test/fixtures/release/0.9.10-alpha.1-recovery.json").json() as RecoveryFixture;
const protectedSha = "0123456789abcdef0123456789abcdef01234567";
const validSignal: PublishContext = {
  eventName: "workflow_run",
  eventAction: "completed",
  workflowRef: `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@refs/heads/main`,
  workflowSha: protectedSha,
  repository: EXPECTED_REPOSITORY,
  repositoryId: EXPECTED_REPOSITORY_ID,
  defaultBranch: "main",
  signalEvent: "create",
  signalStatus: "completed",
  signalConclusion: "success",
  signalPath: fixture.normalSignalWorkflowPath,
  signalWorkflowId: fixture.normalSignalWorkflowId,
  signalRunId: "30000000000",
  signalRunAttempt: "1",
  signalRepository: EXPECTED_REPOSITORY,
  signalRepositoryId: EXPECTED_REPOSITORY_ID,
  signalHeadRepository: EXPECTED_REPOSITORY,
  signalHeadRepositoryId: EXPECTED_REPOSITORY_ID,
  releaseTag: "1.2.3-alpha.1",
  triggerSha: "89abcdef0123456789abcdef0123456789abcdef",
};
const recoverySignal: PublishContext = {
  ...validSignal,
  signalConclusion: fixture.conclusion,
  signalPath: fixture.workflowPath,
  signalWorkflowId: fixture.workflowId,
  signalRunId: fixture.runId,
  signalRunAttempt: fixture.permittedRunAttempt,
  releaseTag: fixture.tag,
  triggerSha: fixture.sha,
};

test("pins the independent historical recovery fixture byte-for-byte", () => {
  assert.equal(fixture.normalSignalWorkflowId, "314699971");
  assert.equal(fixture.normalSignalWorkflowPath, ".github/workflows/publish-tag-created.yml");
  assert.equal(SIGNAL_WORKFLOW_ID, fixture.normalSignalWorkflowId);
  assert.equal(SIGNAL_WORKFLOW_PATH, fixture.normalSignalWorkflowPath);
  assert.deepEqual({
    repository: fixture.repository,
    repositoryId: fixture.repositoryId,
    runId: fixture.runId,
    attempt: fixture.permittedRunAttempt,
    workflowId: fixture.workflowId,
    workflowPath: fixture.workflowPath,
    event: fixture.event,
    status: fixture.status,
    conclusion: fixture.conclusion,
    tag: fixture.tag,
    sha: fixture.sha,
  }, {
    repository: "bastani-inc/atomic",
    repositoryId: "1081638046",
    runId: "29529182569",
    attempt: "2",
    workflowId: "224908587",
    workflowPath: ".github/workflows/publish.yml",
    event: "create",
    status: "completed",
    conclusion: "failure",
    tag: "0.9.10-alpha.1",
    sha: "88c11adcdddcf5245b7b04dd3d2912c7531906fe",
  });
});

test("accepts only the exact successful tag-signal workflow route", () => {
  assert.equal(validatePublishContext(validSignal), "signal");
});

test("accepts only attempt 2 of failed run 29529182569 for recovery", () => {
  assert.equal(validatePublishContext(recoverySignal), "recovery");
  for (const context of [
    { ...recoverySignal, signalRunAttempt: "1" },
    { ...recoverySignal, signalRunAttempt: "3" },
    { ...recoverySignal, signalRunId: "29529182570" },
    { ...recoverySignal, signalWorkflowId: SIGNAL_WORKFLOW_ID },
    { ...recoverySignal, signalPath: SIGNAL_WORKFLOW_PATH },
    { ...recoverySignal, signalConclusion: "success" },
    { ...recoverySignal, releaseTag: `${fixture.tag} ` },
    { ...recoverySignal, triggerSha: protectedSha },
  ]) assert.throws(() => validatePublishContext(context), /Untrusted workflow_run source/u);
});

test("rejects arbitrary workflows, recursion, repositories, events, states, and conclusions", () => {
  for (const context of [
    { ...validSignal, signalWorkflowId: RECOVERY_WORKFLOW_ID },
    { ...validSignal, signalPath: LEGACY_WORKFLOW_PATH },
    { ...validSignal, signalConclusion: "failure" },
    { ...validSignal, signalEvent: "workflow_run" },
    { ...validSignal, signalStatus: "in_progress" },
    { ...validSignal, eventAction: "requested" },
    { ...validSignal, repository: "attacker/atomic" },
    { ...validSignal, repositoryId: "1" },
    { ...validSignal, signalRepository: "attacker/atomic" },
    { ...validSignal, signalRepositoryId: "1" },
    { ...validSignal, signalHeadRepository: "attacker/atomic" },
    { ...validSignal, signalHeadRepositoryId: "1" },
  ]) assert.throws(() => validatePublishContext(context));
});

test("rejects tag-sourced or aliased publisher refs and malformed identity fields", () => {
  for (const context of [
    { ...validSignal, workflowRef: fixture.observedWorkflowRef },
    { ...validSignal, workflowRef: `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@main` },
    { ...validSignal, workflowSha: "not-a-sha" },
    { ...validSignal, triggerSha: "ABCDEF" },
    { ...validSignal, signalRunId: "0" },
    { ...validSignal, signalRunAttempt: "02" },
    { ...validSignal, releaseTag: undefined },
  ]) assert.throws(() => validatePublishContext(context));
});

test("accepts protected ancestors and rejects workflow SHAs outside protected history", () => {
  const revisions = Bun.spawnSync(["git", "rev-parse", "HEAD~1", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(revisions.exitCode, 0, revisions.stderr.toString());
  const [ancestor, tip] = revisions.stdout.toString().trim().split("\n");
  assert.ok(ancestor);
  assert.ok(tip);
  verifyProtectedWorkflowAncestry(ancestor, tip);
  assert.throws(
    () => verifyProtectedWorkflowAncestry("0000000000000000000000000000000000000000", tip),
    /not contained in protected default-branch history/u,
  );
});
