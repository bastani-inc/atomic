import { verifyReleaseBaseMetadata } from "../../../scripts/release-base.js";
import {
  commandSummary,
  parseJsonCommand,
  runCommand,
  verifyPullRequestChecksJson,
  verifyPullRequestChecksForHeadJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type PublishWorkflowRunVerification,
  type CommandResult,
  type PullRequestMergeVerification,
  type PullRequestReferenceVerification,
  type ValidatedRelease,
} from "./publish-release.js";
import { verifyPublishRunSucceeded } from "./publish-release-run.js";

export type ReleasePrCheckGateVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly disposition: "merge-required" | "already-merged";
    }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly pending?: boolean;
    };

type CheckGateOptions = {
  readonly runCommand?: (args: readonly string[]) => CommandResult | Promise<CommandResult>;
};


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

export async function captureReleasePrReference(
  release: ValidatedRelease,
  expectedHeadRefOid: string,
  baseRef: string,
): Promise<PullRequestReferenceVerification> {
  const prView = await runCommand([
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
    ["OPEN", "MERGED"],
  );
  if (!referenceVerification.ok) {
    return {
      ok: false,
      prUrl: referenceVerification.prUrl,
      prNumber: referenceVerification.prNumber,
      summary: [referenceVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  const remoteBranch = await runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
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
): Promise<ReleasePrCheckGateVerification> {
  return verifyReleasePrChecksOnce(release, prReference, baseRef, options.runCommand ?? runCommand);
}

async function verifyReleasePrChecksOnce(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
  baseRef: string,
  execute: (args: readonly string[]) => CommandResult | Promise<CommandResult>,
): Promise<ReleasePrCheckGateVerification> {
  const prViewArgs = [
    "gh", "pr", "view", prReference.prUrl, "--json",
    "url,number,state,baseRefName,headRefName,headRefOid,mergedAt,mergeCommit,statusCheckRollup",
  ] as const;
  const preflight = await execute(prViewArgs);
  const parsedPreflight = parseJsonCommand(preflight, "GitHub PR check preflight returned invalid JSON.");
  if (preflight.exitCode !== 0) {
    return { ok: false, summary: ["GitHub PR check preflight command failed.", commandSummary(preflight)].join("\n\n") };
  }
  if (!parsedPreflight.ok) return { ok: false, summary: parsedPreflight.summary };

  const capturedIdentity = { prUrl: prReference.prUrl, prNumber: prReference.prNumber };
  const preflightReference = verifyReleasePullRequestReferenceJson(
    parsedPreflight.value,
    release.branch,
    baseRef,
    prReference.headRefOid,
    ["OPEN", "MERGED"],
    capturedIdentity,
  );
  if (!preflightReference.ok) {
    return { ok: false, summary: [preflightReference.summary, commandSummary(preflight)].join("\n\n") };
  }
  if (prReference.state === "MERGED" && preflightReference.state !== "MERGED") {
    return { ok: false, summary: "GitHub PR state regressed from captured MERGED state before required-check verification." };
  }

  const checks = await execute([
    "gh", "pr", "checks", prReference.prUrl, "--required", "--json",
    "name,state,bucket,link,workflow,description",
  ]);
  const parsedChecks = parseJsonCommand(checks, "GitHub PR required checks returned invalid JSON.");
  if (checks.exitCode === 8) {
    return {
      ok: false,
      pending: true,
      summary: ["GitHub PR required checks are still pending.", commandSummary(checks)].join("\n\n"),
    };
  }
  if (!parsedChecks.ok) {
    return {
      ok: false,
      summary: ["GitHub PR required checks command failed or returned invalid JSON.", parsedChecks.summary].join("\n\n"),
    };
  }

  const checkVerification = verifyPullRequestChecksJson(parsedChecks.value);
  if (!checkVerification.ok) {
    return {
      ok: false,
      pending: checkVerification.pending,
      summary: [checkVerification.summary, commandSummary(preflight), commandSummary(checks)].join("\n\n"),
    };
  }
  if (checks.exitCode !== 0) {
    return { ok: false, summary: ["GitHub PR required checks command failed.", commandSummary(checks)].join("\n\n") };
  }

  const postflight = await execute(prViewArgs);
  if (postflight.exitCode !== 0) {
    return { ok: false, summary: ["GitHub PR check postflight command failed.", commandSummary(postflight)].join("\n\n") };
  }
  const parsedPostflight = parseJsonCommand(postflight, "GitHub PR check postflight returned invalid JSON.");
  if (!parsedPostflight.ok) return { ok: false, summary: parsedPostflight.summary };
  const postflightReference = verifyReleasePullRequestReferenceJson(
    parsedPostflight.value,
    release.branch,
    baseRef,
    prReference.headRefOid,
    ["OPEN", "MERGED"],
    capturedIdentity,
  );
  if (!postflightReference.ok) {
    return { ok: false, summary: [postflightReference.summary, commandSummary(postflight)].join("\n\n") };
  }
  const exactHeadChecks = verifyPullRequestChecksForHeadJson(parsedChecks.value, parsedPostflight.value);
  if (!exactHeadChecks.ok) {
    return { ok: false, summary: [exactHeadChecks.summary, commandSummary(postflight), commandSummary(checks)].join("\n\n") };
  }
  if (preflightReference.state === "MERGED" && postflightReference.state !== "MERGED") {
    return { ok: false, summary: "GitHub PR state regressed from MERGED during required-check verification." };
  }

  const summaries = [
    exactHeadChecks.summary,
    checkVerification.summary,
    preflightReference.summary,
    postflightReference.summary,
    commandSummary(preflight),
    commandSummary(checks),
    commandSummary(postflight),
  ];
  if (postflightReference.state === "OPEN") {
    return { ok: true, disposition: "merge-required", summary: summaries.join("\n\n") };
  }

  const merged = verifyPullRequestMergedJson(
    parsedPostflight.value,
    release.branch,
    baseRef,
    prReference.headRefOid,
    capturedIdentity,
  );
  if (!merged.ok) return { ok: false, summary: [merged.summary, ...summaries].join("\n\n") };

  const branch = await execute(["git", "ls-remote", "--heads", "origin", release.branch]);
  const remoteHeadOid = branch.stdout.split(/\s+/u)[0] ?? "";
  if (branch.exitCode !== 0 || remoteHeadOid !== prReference.headRefOid) {
    return {
      ok: false,
      summary: [
        "Remote release branch retention is not verified at the captured head SHA.",
        `expectedHeadRefOid: ${prReference.headRefOid}`,
        `remoteHeadOid: ${remoteHeadOid || "missing"}`,
        commandSummary(branch),
      ].join("\n\n"),
    };
  }

  return {
    ok: true,
    disposition: "already-merged",
    summary: [merged.summary, "Remote release branch is retained at the captured head SHA.", ...summaries, commandSummary(branch)].join("\n\n"),
  };
}

export async function verifyReleasePrMerged(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
  baseRef: string,
): Promise<PullRequestMergeVerification> {
  const prView = await runCommand([
    "gh",
    "pr",
    "view",
    prReference.prUrl,
    "--json",
    "state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url,number",
  ]);
  if (prView.exitCode !== 0) {
    return {
      ok: false,
      summary: ["GitHub PR merge verification command failed.", commandSummary(prView)].join("\n\n"),
    };
  }

  const parsed = parseJsonCommand(prView, "GitHub PR merge verification returned invalid JSON.");
  if (!parsed.ok) return { ok: false, summary: parsed.summary };

  const mergeVerification = verifyPullRequestMergedJson(
    parsed.value,
    release.branch,
    baseRef,
    prReference.headRefOid,
    { prUrl: prReference.prUrl, prNumber: prReference.prNumber },
  );
  if (!mergeVerification.ok) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [mergeVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  const branchCheck = await runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  const remoteHeadOid = branchCheck.stdout.split(/\s+/u)[0] ?? "";
  if (branchCheck.exitCode !== 0 || remoteHeadOid !== prReference.headRefOid) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [
        "Remote release branch retention verification failed.",
        "The PR is merged, but the release branch was not retained at the captured head SHA.",
        `expectedHeadRefOid: ${prReference.headRefOid}`,
        `remoteHeadOid: ${remoteHeadOid || "missing"}`,
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
      "Remote release branch is retained at the captured head SHA on origin.",
      commandSummary(prView),
      commandSummary(branchCheck),
    ].join("\n\n"),
  };
}

export async function verifyMainReadyForTag(_release: ValidatedRelease, mergeCommitOid: string, baseRef: string): Promise<MainReadyVerification> {
  const branch = await runCommand(["git", "branch", "--show-current"]);
  const head = await runCommand(["git", "rev-parse", "HEAD"]);
  const originMain = await runCommand(["git", "rev-parse", `origin/${baseRef}`]);
  const status = await runCommand(["git", "status", "--short"]);
  const mergeBase = await runCommand(["git", "merge-base", "--is-ancestor", mergeCommitOid, "HEAD"]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== baseRef) failures.push(`current branch was ${branch.stdout || "missing"}, expected ${baseRef}`);
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push(`local ${baseRef} HEAD could not be resolved`);
  if (originMain.exitCode !== 0 || originMain.stdout.length === 0) failures.push(`origin/${baseRef} could not be resolved`);
  if (head.stdout.length > 0 && originMain.stdout.length > 0 && head.stdout !== originMain.stdout) {
    failures.push(`local ${baseRef} HEAD ${head.stdout} did not match origin/${baseRef} ${originMain.stdout}`);
  }
  if (status.exitCode !== 0 || status.stdout.length > 0) failures.push("worktree is not clean before tagging");
  if (mergeBase.exitCode !== 0) failures.push(`merge commit ${mergeCommitOid} is not an ancestor of local ${baseRef} HEAD`);

  const summary = [
    failures.length === 0 ? `${baseRef} is ready for release tag reconciliation.` : `${baseRef} is not ready for release tag reconciliation.`,
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(branch),
    commandSummary(head),
    commandSummary(originMain),
    commandSummary(status),
    commandSummary(mergeBase),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || head.stdout.length === 0) return { ok: false, summary };
  return { ok: true, summary, mainOid: head.stdout };
}

export type TagPublicationOptions = {
  readonly allowIntegratedParent?: boolean;
  readonly requiredAncestorOid?: string;
  readonly expectedBaseRef: string;
  readonly execute?: (args: readonly string[]) => CommandResult | Promise<CommandResult>;
};

export async function verifyReleaseTagPublished(
  release: ValidatedRelease,
  expectedParentOid: string,
  options: TagPublicationOptions,
): Promise<TagPublicationVerification> {
  // cut-release.ts tags a throwaway version-stamped commit. A newly-created
  // tag must parent the verified base tip exactly; recovery may also reuse a
  // prior tag whose parent is already integrated into the now-advanced base.
  const execute = options.execute ?? runCommand;
  const localTag = await execute(["git", "rev-parse", `${release.version}^{commit}`]);
  const releaseCommitOid = localTag.stdout;
  const tagParent = await execute(["git", "rev-parse", `${release.version}^{commit}^`]);
  const integratedParent = options.allowIntegratedParent === true
    ? await execute(["git", "merge-base", "--is-ancestor", tagParent.stdout, expectedParentOid])
    : undefined;
  const containsRequiredAncestor = options.requiredAncestorOid === undefined
    ? undefined
    : await execute(["git", "merge-base", "--is-ancestor", options.requiredAncestorOid, tagParent.stdout]);
  const taggedManifest = await execute(["git", "show", `${release.version}:packages/coding-agent/package.json`]);
  const tagMessage = await execute(["git", "show", "-s", "--format=%B", `${release.version}^{commit}`]);
  const remoteTag = await execute(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  const remoteTagTargetOid = remoteTag.stdout.split(/\s+/u)[0] ?? "";
  const failures: string[] = [];

  if (localTag.exitCode !== 0 || releaseCommitOid.length === 0) {
    failures.push("local release tag commit could not be resolved");
  }
  if (tagParent.exitCode !== 0 || tagParent.stdout.length === 0) {
    failures.push("release commit parent could not be resolved");
  } else if (options.allowIntegratedParent === true && integratedParent?.exitCode !== 0) {
    failures.push(`release commit parent ${tagParent.stdout} is not integrated into verified base ${expectedParentOid}`);
  } else if (options.allowIntegratedParent !== true && tagParent.stdout !== expectedParentOid) {
    failures.push(`release commit parent was ${tagParent.stdout}, expected the verified base commit ${expectedParentOid}`);
  }

  let stampedVersion: string | undefined;
  if (containsRequiredAncestor?.exitCode !== 0) {
    failures.push(`required commit ${options.requiredAncestorOid} is not an ancestor of release parent ${tagParent.stdout || "missing"}`);
  }
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
  if (tagMessage.exitCode !== 0) {
    failures.push("release commit message could not be read");
  } else {
    try {
      verifyReleaseBaseMetadata(tagMessage.stdout, tagParent.stdout, options.expectedBaseRef, tagParent.stdout);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
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
    commandSummary(tagMessage),
    integratedParent === undefined ? undefined : commandSummary(integratedParent),
    containsRequiredAncestor === undefined ? undefined : commandSummary(containsRequiredAncestor),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || releaseCommitOid.length === 0) return { ok: false, summary };
  return { ok: true, summary, tagTargetOid: releaseCommitOid };
}

export function verifyPublishWorkflowSucceeded(
  release: ValidatedRelease,
  expectedHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  return verifyPublishRunSucceeded(release.version, expectedHeadSha);
}

