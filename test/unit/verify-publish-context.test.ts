import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_ID,
  PROTECTED_PUBLISH_WORKFLOW_PATH,
  SIGNAL_WORKFLOW_ID,
  SIGNAL_WORKFLOW_PATH,
  validatePublishContext,
  verifyProtectedWorkflowAncestry,
  type PublishContext,
} from "../../scripts/verify-publish-context.js";

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
  signalEvent: "create",
  signalStatus: "completed",
  signalConclusion: "success",
  signalPath: SIGNAL_WORKFLOW_PATH,
  signalWorkflowId: SIGNAL_WORKFLOW_ID,
  signalRunId: "30000000000",
  signalRunAttempt: "1",
  signalRepository: EXPECTED_REPOSITORY,
  signalRepositoryId: EXPECTED_REPOSITORY_ID,
  signalHeadRepository: EXPECTED_REPOSITORY,
  signalHeadRepositoryId: EXPECTED_REPOSITORY_ID,
  releaseTag: "1.2.3-alpha.1",
  triggerSha: "89abcdef0123456789abcdef0123456789abcdef",
};

function rejected(contexts: PublishContext[]): void {
  for (const context of contexts) assert.throws(() => validatePublishContext(context));
}


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
test("rejects arbitrary workflows, repositories, refs, and malformed identities", () => {
  rejected([
    { ...validSignal, eventName: "workflow_dispatch" },
    { ...validSignal, repository: "attacker/atomic" },
    { ...validSignal, repositoryId: "1" },
    { ...validSignal, signalRepository: "attacker/atomic" },
    { ...validSignal, signalRepositoryId: "1" },
    { ...validSignal, signalHeadRepository: "attacker/atomic" },
    { ...validSignal, signalHeadRepositoryId: "1" },
    { ...validSignal, workflowRef: `${EXPECTED_REPOSITORY}/.github/workflows/untrusted.yml@refs/tags/1.2.3` },
    { ...validSignal, workflowRef: `${EXPECTED_REPOSITORY}/${PROTECTED_PUBLISH_WORKFLOW_PATH}@main` },
    { ...validSignal, workflowSha: "not-a-sha" },
    { ...validSignal, triggerSha: "ABCDEF" },
    { ...validSignal, signalRunId: "0" },
    { ...validSignal, signalRunAttempt: "02" },
    { ...validSignal, releaseTag: undefined },
  ]);
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
