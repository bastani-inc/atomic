import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
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
  normalSignalWorkflowId: string;
  normalSignalWorkflowPath: string;
  tag: string;
  sha: string;
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

test("pins the one-time recovery constants byte-for-byte", () => {
  assert.equal(fixture.normalSignalWorkflowId, SIGNAL_WORKFLOW_ID);
  assert.equal(fixture.normalSignalWorkflowPath, SIGNAL_WORKFLOW_PATH);
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
    { ...validSignal, signalWorkflowId: "999999999" },
    { ...validSignal, signalPath: ".github/workflows/not-a-publisher.yml" },
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

test("rejects arbitrary workflows, repositories, refs, and malformed identities", () => {
  rejected([
    { ...validSignal, eventName: "workflow_dispatch" },
    { ...validSignal, repository: "attacker/atomic" },
    { ...validSignal, repositoryId: "1" },
    { ...validSignal, signalRepository: "attacker/atomic" },
    { ...validSignal, signalRepositoryId: "1" },
    { ...validSignal, signalHeadRepository: "attacker/atomic" },
    { ...validSignal, signalHeadRepositoryId: "1" },
    { ...validSignal, workflowRef: `${EXPECTED_REPOSITORY}/.github/workflows/untrusted.yml@refs/tags/${RECOVERY_TAG}` },
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
  const identityEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "contract-test",
    GIT_AUTHOR_EMAIL: "contract@example.com",
    GIT_COMMITTER_NAME: "contract-test",
    GIT_COMMITTER_EMAIL: "contract@example.com",
  };
  try {
    await $`git init -q`.cwd(repository);
    const emptyTree = (await $`printf '' | git mktree`.cwd(repository).text()).trim();
    const parent = (await $`printf 'parent\n' | git commit-tree ${emptyTree}`.cwd(repository).env(identityEnv).text()).trim();
    const index = join(repository, "recovery-index");
    const markerCommit = async (content: string, message: string): Promise<string> => {
      rmSync(index, { force: true });
      const indexEnv = { ...identityEnv, GIT_INDEX_FILE: index };
      const blob = (await $`printf %s ${content} | git hash-object -w --stdin`.cwd(repository).text()).trim();
      await $`git read-tree --empty`.cwd(repository).env(indexEnv).quiet();
      await $`git update-index --add --cacheinfo ${`100644,${blob},${RECOVERY_MARKER_PATH}`}`.cwd(repository).env(indexEnv).quiet();
      const tree = (await $`git write-tree`.cwd(repository).env(indexEnv).text()).trim();
      return (await $`printf '%s\n' ${message} | git commit-tree ${tree} -p ${parent}`.cwd(repository).env(identityEnv).text()).trim();
    };

    const recovery = await markerCommit(RECOVERY_MARKER_CONTENT, "recovery");
    verifyRecoveryMarker(parent, recovery, repository);
    assert.throws(
      () => verifyRecoveryMarker("2222222222222222222222222222222222222222", recovery, repository),
      /parent commit is unavailable/u,
    );
    assert.throws(
      () => verifyRecoveryMarker(parent, "3333333333333333333333333333333333333333", repository),
      /event commit is unavailable/u,
    );
    const divergent = (await $`printf 'divergent\n' | git commit-tree ${emptyTree}`.cwd(repository).env(identityEnv).text()).trim();
    assert.throws(() => verifyRecoveryMarker(divergent, recovery, repository), /not an ancestor/u);
    assert.throws(() => verifyRecoveryMarker(recovery, recovery, repository), /already existed/u);

    const malformed = await markerCommit(`${RECOVERY_MARKER_CONTENT} `, "malformed");
    assert.throws(() => verifyRecoveryMarker(parent, malformed, repository), /marker content/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}, 15_000);
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
