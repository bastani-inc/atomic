import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_ID,
  PROTECTED_PUBLISH_WORKFLOW_PATH,
  RECOVERY_FAILED_PUBLISHER_RUN_ID,
  RECOVERY_MARKER_CONTENT,
  RECOVERY_MARKER_PATH,
  RECOVERY_SHA,
  RECOVERY_TAG,
  SIGNAL_WORKFLOW_ID,
  SIGNAL_WORKFLOW_PATH,
  validatePublishContext,
  verifyProtectedWorkflowAncestry,
  verifyRecoveryMarker,
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
const protectedWorkflowRef = `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@refs/heads/main`;
const validSignal: PublishContext = {
  eventName: "workflow_run",
  eventAction: "completed",
  workflowRef: protectedWorkflowRef,
  workflowSha: protectedSha,
  repository: EXPECTED_REPOSITORY,
  repositoryId: EXPECTED_REPOSITORY_ID,
  defaultBranch: "main",
  gitRef: "refs/heads/main",
  eventBefore: undefined,
  eventSha: undefined,
  runAttempt: "1",
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
const recoveryPush: PublishContext = {
  ...validSignal,
  eventName: "push",
  eventAction: undefined,
  workflowSha: protectedSha,
  gitRef: "refs/heads/main",
  eventBefore: "1111111111111111111111111111111111111111",
  eventSha: protectedSha,
  runAttempt: "1",
  signalEvent: undefined,
  signalStatus: undefined,
  signalConclusion: undefined,
  signalPath: undefined,
  signalWorkflowId: undefined,
  signalRunId: undefined,
  signalRunAttempt: undefined,
  signalRepository: undefined,
  signalRepositoryId: undefined,
  signalHeadRepository: undefined,
  signalHeadRepositoryId: undefined,
  releaseTag: RECOVERY_TAG,
  triggerSha: RECOVERY_SHA,
};

function rejected(contexts: PublishContext[]): void {
  for (const context of contexts) assert.throws(() => validatePublishContext(context));
}

test("pins the completed incident and one-time recovery constants byte-for-byte", () => {
  assert.equal(fixture.normalSignalWorkflowId, SIGNAL_WORKFLOW_ID);
  assert.equal(fixture.normalSignalWorkflowPath, SIGNAL_WORKFLOW_PATH);
  assert.equal(fixture.runId, "29529182569");
  assert.equal(fixture.permittedRunAttempt, "2");
  assert.equal(fixture.tag, RECOVERY_TAG);
  assert.equal(fixture.sha, RECOVERY_SHA);
  assert.equal(RECOVERY_FAILED_PUBLISHER_RUN_ID, "29694686010");
  assert.equal(RECOVERY_MARKER_PATH, ".github/recovery/0.9.10-alpha.1.json");
  assert.equal(RECOVERY_MARKER_CONTENT, `{
  "tag": "0.9.10-alpha.1",
  "sha": "88c11adcdddcf5245b7b04dd3d2912c7531906fe",
  "failedPublisherRunId": "29694686010",
  "removeAfterPublication": true
}
`);
});

test("accepts only the exact successful tag-signal workflow route", () => {
  assert.equal(validatePublishContext(validSignal), "signal");
  rejected([
    { ...validSignal, signalWorkflowId: fixture.workflowId },
    { ...validSignal, signalPath: fixture.workflowPath },
    { ...validSignal, signalConclusion: "failure" },
    { ...validSignal, signalEvent: "workflow_run" },
    { ...validSignal, signalStatus: "in_progress" },
    { ...validSignal, eventAction: "requested" },
  ]);
});

test("accepts only the first exact protected-main recovery push", () => {
  assert.equal(validatePublishContext(recoveryPush), "recovery");
  rejected([
    { ...recoveryPush, eventBefore: "not-a-sha" },
    { ...recoveryPush, eventSha: RECOVERY_SHA },
    { ...recoveryPush, runAttempt: "2" },
    { ...recoveryPush, gitRef: "refs/heads/recovery" },
    { ...recoveryPush, defaultBranch: "trunk" },
    { ...recoveryPush, releaseTag: `${RECOVERY_TAG} ` },
    { ...recoveryPush, triggerSha: protectedSha },
  ]);
});

test("rejects historical attempt 3, arbitrary workflows, repositories, refs, and malformed identities", () => {
  rejected([
    { ...validSignal, signalWorkflowId: fixture.workflowId, signalPath: fixture.workflowPath, signalRunId: fixture.runId, signalRunAttempt: "3", signalConclusion: "failure", releaseTag: fixture.tag, triggerSha: fixture.sha },
    { ...validSignal, eventName: "workflow_dispatch" },
    { ...validSignal, repository: "attacker/atomic" },
    { ...validSignal, repositoryId: "1" },
    { ...validSignal, signalRepository: "attacker/atomic" },
    { ...validSignal, signalRepositoryId: "1" },
    { ...validSignal, signalHeadRepository: "attacker/atomic" },
    { ...validSignal, signalHeadRepositoryId: "1" },
    { ...validSignal, workflowRef: fixture.observedWorkflowRef },
    { ...validSignal, workflowRef: `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@main` },
    { ...validSignal, workflowSha: "not-a-sha" },
    { ...validSignal, triggerSha: "ABCDEF" },
    { ...validSignal, signalRunId: "0" },
    { ...validSignal, signalRunAttempt: "02" },
    { ...validSignal, releaseTag: undefined },
  ]);
});


test("recovery marker must be newly added with exact raw bytes", async () => {
  const repository = mkdtempSync(join(tmpdir(), "atomic-recovery-marker-"));
  try {
    await $`git init -q`.cwd(repository);
    await $`git config user.name contract-test`.cwd(repository);
    await $`git config user.email contract@example.com`.cwd(repository);
    await $`git commit --allow-empty -m parent -q`.cwd(repository);
    const parent = (await $`git rev-parse HEAD`.cwd(repository).text()).trim();
    const marker = join(repository, RECOVERY_MARKER_PATH);
    mkdirSync(join(repository, ".github/recovery"), { recursive: true });
    writeFileSync(marker, RECOVERY_MARKER_CONTENT);
    await $`git add ${RECOVERY_MARKER_PATH}`.cwd(repository);
    await $`git commit -m recovery -q`.cwd(repository);
    const recovery = (await $`git rev-parse HEAD`.cwd(repository).text()).trim();
    verifyRecoveryMarker(parent, recovery, repository);
    assert.throws(
      () => verifyRecoveryMarker("2222222222222222222222222222222222222222", recovery, repository),
      /parent commit is unavailable/u,
    );
    assert.throws(
      () => verifyRecoveryMarker(parent, "3333333333333333333333333333333333333333", repository),
      /event commit is unavailable/u,
    );
    const parentTree = (await $`git show -s --format=%T ${parent}`.cwd(repository).text()).trim();
    const divergent = (await $`printf 'divergent\n' | git commit-tree ${parentTree}`.cwd(repository).text()).trim();
    assert.throws(() => verifyRecoveryMarker(divergent, recovery, repository), /not an ancestor/u);
    assert.throws(() => verifyRecoveryMarker(recovery, recovery, repository), /already existed/u);

    await $`git reset --hard ${parent}`.cwd(repository).quiet();
    mkdirSync(join(repository, ".github/recovery"), { recursive: true });
    writeFileSync(marker, `${RECOVERY_MARKER_CONTENT} `);
    await $`git add ${RECOVERY_MARKER_PATH}`.cwd(repository);
    await $`git commit -m malformed -q`.cwd(repository);
    const malformed = (await $`git rev-parse HEAD`.cwd(repository).text()).trim();
    assert.throws(() => verifyRecoveryMarker(parent, malformed, repository), /marker content/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
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
