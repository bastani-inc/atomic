import {
  commandSummary,
  parseJsonCommand,
  runCommand,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type PublishWorkflowRunVerification,
  type CommandResult,
  type PullRequestMergeVerification,
  type PullRequestReferenceVerification,
  type ValidatedRelease,
} from "./publish-release.js";
import { waitForWorkflowRunSucceeded } from "./publish-release-run-wait.js";
import { defaultSleep } from "./publish-release-helpers.js";

type GateVerification =
  | {
      readonly ok: true;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly pending?: boolean;
    };

type CheckGateOptions = {
  readonly attempts?: number;
  readonly pollIntervalMs?: number;
  readonly runCommand?: (args: readonly string[]) => CommandResult;
  readonly sleep?: (durationMs: number) => Promise<void>;
};

const defaultCheckGateAttempts = 30;
const defaultCheckGatePollIntervalMs = 30_000;


type MainReadyVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly mainOid: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

type TagPublicationVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly tagTargetOid: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

export function captureReleasePrReference(
  release: ValidatedRelease,
  expectedHeadRefOid: string,
  baseRef: string,
): PullRequestReferenceVerification {
  const prView = runCommand([
    "gh",
    "pr",
    "view",
    release.branch,
    "--json",
    "url,number,state,baseRefName,headRefName,headRefOid",
  ]);

  if (prView.exitCode !== 0) {
    return {
      ok: false,
      summary: ["GitHub PR reference capture command failed.", commandSummary(prView)].join("\n\n"),
    };
  }

  const parsed = parseJsonCommand(prView, "GitHub PR reference capture returned invalid JSON.");
  if (!parsed.ok) return { ok: false, summary: parsed.summary };

  const referenceVerification = verifyReleasePullRequestReferenceJson(
    parsed.value,
    release.branch,
    baseRef,
    expectedHeadRefOid,
    "OPEN",
  );
  if (!referenceVerification.ok) {
    return {
      ok: false,
      prUrl: referenceVerification.prUrl,
      prNumber: referenceVerification.prNumber,
      summary: [referenceVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  const remoteBranch = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  const remoteHeadOid = remoteBranch.stdout.split(/\s+/u)[0] ?? "";
  if (remoteBranch.exitCode !== 0 || remoteHeadOid !== expectedHeadRefOid) {
    return {
      ok: false,
      prUrl: referenceVerification.prUrl,
      prNumber: referenceVerification.prNumber,
      summary: [
        "Remote release branch SHA is not verified.",
        `expectedHeadRefOid: ${expectedHeadRefOid}`,
        `remoteHeadOid: ${remoteHeadOid || "missing"}`,
        commandSummary(prView),
        commandSummary(remoteBranch),
      ].join("\n\n"),
    };
  }

  return {
    ok: true,
    prUrl: referenceVerification.prUrl,
    prNumber: referenceVerification.prNumber,
    headRefOid: referenceVerification.headRefOid,
    state: referenceVerification.state,
    summary: [
      referenceVerification.summary,
      "Remote release branch SHA matches the verified release commit.",
      commandSummary(prView),
      commandSummary(remoteBranch),
    ].join("\n\n"),
  };
}

export async function verifyReleasePrChecksPassed(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
  baseRef: string,
  options: CheckGateOptions = {},
): Promise<GateVerification> {
  const attempts = options.attempts ?? defaultCheckGateAttempts;
  const pollIntervalMs = options.pollIntervalMs ?? defaultCheckGatePollIntervalMs;
  const sleep = options.sleep ?? defaultSleep;
  let lastPendingSummary: string | undefined;

  const execute = options.runCommand ?? runCommand;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const verification = verifyReleasePrChecksOnce(release, prReference, baseRef, execute);
    if (verification.ok) return verification;
    if (verification.pending !== true) return verification;

    lastPendingSummary = verification.summary;
    if (attempt < attempts) await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    pending: true,
    summary: [
      "GitHub PR required checks did not finish before the polling timeout.",
      `attempts: ${attempts}`,
      `pollIntervalMs: ${pollIntervalMs}`,
      lastPendingSummary,
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

function verifyReleasePrChecksOnce(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
  baseRef: string,
  execute: (args: readonly string[]) => CommandResult,
): GateVerification {
  const prView = execute([
    "gh",
    "pr",
    "view",
    prReference.prUrl,
    "--json",
    "url,number,state,baseRefName,headRefName,headRefOid",
  ]);

  if (prView.exitCode !== 0) {
    return { ok: false, summary: ["GitHub PR check preflight command failed.", commandSummary(prView)].join("\n\n") };
  }

  const parsedPr = parseJsonCommand(prView, "GitHub PR check preflight returned invalid JSON.");
  if (!parsedPr.ok) return { ok: false, summary: parsedPr.summary };

  const refreshedReference = verifyReleasePullRequestReferenceJson(
    parsedPr.value,
    release.branch,
    baseRef,
    prReference.headRefOid,
    "OPEN",
  );
  if (!refreshedReference.ok) {
    return { ok: false, summary: [refreshedReference.summary, commandSummary(prView)].join("\n\n") };
  }

  const checks = execute([
    "gh",
    "pr",
    "checks",
    prReference.prUrl,
    "--required",
    "--json",
    "name,state,bucket,link,workflow,description",
  ]);

  const parsedChecks = parseJsonCommand(checks, "GitHub PR required checks returned invalid JSON.");
  if (checks.exitCode !== 0 && checks.exitCode !== 8) {
    return { ok: false, summary: ["GitHub PR required checks command failed.", commandSummary(checks)].join("\n\n") };
  }
  if (!parsedChecks.ok) {
    if (checks.exitCode === 8) {
      return {
        ok: false,
        pending: true,
        summary: ["GitHub PR required checks are still pending.", commandSummary(checks)].join("\n\n"),
      };
    }
    return { ok: false, summary: parsedChecks.summary };
  }

  const checkVerification = verifyPullRequestChecksJson(parsedChecks.value);
  if (!checkVerification.ok) {
    return {
      ok: false,
      pending: checkVerification.pending,
      summary: [checkVerification.summary, commandSummary(prView), commandSummary(checks)].join("\n\n"),
    };
  }

  return {
    ok: true,
    summary: [checkVerification.summary, refreshedReference.summary, commandSummary(prView), commandSummary(checks)].join("\n\n"),
  };
}

export function verifyReleasePrMerged(
  release: ValidatedRelease,
  prSelector: string,
  expectedHeadRefOid: string | undefined,
  baseRef: string,
): PullRequestMergeVerification {
  const prView = runCommand([
    "gh",
    "pr",
    "view",
    prSelector,
    "--json",
    "state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url",
  ]);

  if (prView.exitCode !== 0) {
    return {
      ok: false,
      summary: ["GitHub PR merge verification command failed.", commandSummary(prView)].join("\n\n"),
    };
  }

  const parsed = parseJsonCommand(prView, "GitHub PR merge verification returned invalid JSON.");
  if (!parsed.ok) return { ok: false, summary: parsed.summary };

  const mergeVerification = verifyPullRequestMergedJson(parsed.value, release.branch, baseRef, expectedHeadRefOid);
  if (!mergeVerification.ok) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [mergeVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  const branchCheck = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  if (branchCheck.exitCode !== 0 || branchCheck.stdout.length === 0) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [
        "Remote release branch retention verification failed.",
        "The PR is merged, but the release branch was not found on origin.",
        commandSummary(prView),
        commandSummary(branchCheck),
      ].join("\n\n"),
    };
  }

  return {
    ok: true,
    mergeCommitOid: mergeVerification.mergeCommitOid,
    prUrl: mergeVerification.prUrl,
    summary: [
      mergeVerification.summary,
      "Remote release branch is retained on origin.",
      commandSummary(prView),
      commandSummary(branchCheck),
    ].join("\n\n"),
  };
}

export function verifyMainReadyForTag(release: ValidatedRelease, mergeCommitOid: string, baseRef: string): MainReadyVerification {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const originMain = runCommand(["git", "rev-parse", `origin/${baseRef}`]);
  const status = runCommand(["git", "status", "--short"]);
  const mergeBase = runCommand(["git", "merge-base", "--is-ancestor", mergeCommitOid, "HEAD"]);
  const localTag = runCommand(["git", "rev-parse", "--verify", `refs/tags/${release.version}`]);
  const remoteTag = runCommand(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== baseRef) failures.push(`current branch was ${branch.stdout || "missing"}, expected ${baseRef}`);
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push(`local ${baseRef} HEAD could not be resolved`);
  if (originMain.exitCode !== 0 || originMain.stdout.length === 0) failures.push(`origin/${baseRef} could not be resolved`);
  if (head.stdout.length > 0 && originMain.stdout.length > 0 && head.stdout !== originMain.stdout) {
    failures.push(`local ${baseRef} HEAD ${head.stdout} did not match origin/${baseRef} ${originMain.stdout}`);
  }
  if (status.exitCode !== 0 || status.stdout.length > 0) failures.push("worktree is not clean before tagging");
  if (mergeBase.exitCode !== 0) failures.push(`merge commit ${mergeCommitOid} is not an ancestor of local ${baseRef} HEAD`);
  if (localTag.exitCode === 0) failures.push(`local tag ${release.version} already exists`);
  if (remoteTag.exitCode !== 0) failures.push(`remote tag lookup for ${release.version} failed`);
  if (remoteTag.stdout.length > 0) failures.push(`remote tag ${release.version} already exists`);

  const summary = [
    failures.length === 0 ? `${baseRef} is ready for release tagging.` : `${baseRef} is not ready for release tagging.`,
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(branch),
    commandSummary(head),
    commandSummary(originMain),
    commandSummary(status),
    commandSummary(mergeBase),
    commandSummary(localTag),
    commandSummary(remoteTag),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || head.stdout.length === 0) return { ok: false, summary };
  return { ok: true, summary, mainOid: head.stdout };
}

export function verifyReleaseTagPublished(release: ValidatedRelease, expectedParentOid: string): TagPublicationVerification {
  // The tag does not point at a commit on the base branch. cut-release.ts stamps
  // the real version onto a throwaway "Release" commit whose parent is the verified
  // base HEAD, then tags that commit. Verify: (1) local + remote tag resolve to the
  // same release commit, (2) its parent is the verified base commit, and (3) the
  // tagged @bastani/atomic manifest carries the target version (proving the stamp).
  const localTag = runCommand(["git", "rev-parse", `${release.version}^{commit}`]);
  const releaseCommitOid = localTag.stdout;
  const tagParent = runCommand(["git", "rev-parse", `${release.version}^{commit}^`]);
  const taggedManifest = runCommand(["git", "show", `${release.version}:packages/coding-agent/package.json`]);
  const remoteTag = runCommand(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  const remoteTagTargetOid = remoteTag.stdout.split(/\s+/u)[0] ?? "";
  const failures: string[] = [];

  if (localTag.exitCode !== 0 || releaseCommitOid.length === 0) {
    failures.push("local release tag commit could not be resolved");
  }
  if (tagParent.exitCode !== 0 || tagParent.stdout !== expectedParentOid) {
    failures.push(`release commit parent was ${tagParent.stdout || "missing"}, expected the verified base commit ${expectedParentOid}`);
  }

  let stampedVersion: string | undefined;
  if (taggedManifest.exitCode === 0) {
    try {
      stampedVersion = (JSON.parse(taggedManifest.stdout) as { version?: string }).version;
    } catch {
      stampedVersion = undefined;
    }
  }
  if (stampedVersion !== release.version) {
    failures.push(`tagged @bastani/atomic version was ${stampedVersion ?? "unparseable"}, expected ${release.version}`);
  }

  if (remoteTag.exitCode !== 0 || remoteTagTargetOid.length === 0) {
    failures.push(`remote tag ${release.version} was missing on origin`);
  } else if (releaseCommitOid.length > 0 && remoteTagTargetOid !== releaseCommitOid) {
    failures.push(`remote tag target was ${remoteTagTargetOid}, expected the release commit ${releaseCommitOid}`);
  }

  const summary = [
    failures.length === 0 ? "Release tag publication is deterministically verified." : "Release tag publication is not verified.",
    releaseCommitOid.length === 0 ? undefined : `releaseCommitOid: ${releaseCommitOid}`,
    `expectedParentOid: ${expectedParentOid}`,
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(localTag),
    commandSummary(tagParent),
    commandSummary(remoteTag),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || releaseCommitOid.length === 0) return { ok: false, summary };
  return { ok: true, summary, tagTargetOid: releaseCommitOid };
}

export function verifyPublishWorkflowSucceeded(
  release: ValidatedRelease,
  expectedHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  return waitForWorkflowRunSucceeded(expectedHeadSha, {
    workflowFile: "publish.yml",
    expectedHeadBranch: release.version,
  });
}

export function verifyReleaseBranchCiSucceeded(
  release: ValidatedRelease,
  branchHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  return waitForWorkflowRunSucceeded(branchHeadSha, {
    workflowFile: "test.yml",
    expectedHeadBranch: release.branch,
  });
}

