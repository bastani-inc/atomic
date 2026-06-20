import {
  commandSummary,
  parseJsonCommand,
  runCommand,
  selectPublishWorkflowRunJson,
  verifyPublishWorkflowRunJson,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type CommandResult,
  type PublishWorkflowRunVerification,
  type PullRequestMergeVerification,
  type PullRequestReferenceVerification,
  type ValidatedRelease,
} from "./publish-release.js";

type GateVerification =
  | {
      readonly ok: true;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
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

export function captureReleasePrReference(
  release: ValidatedRelease,
  expectedHeadRefOid: string,
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
    "main",
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

export function verifyReleasePrChecksPassed(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
): GateVerification {
  const prView = runCommand([
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
    "main",
    prReference.headRefOid,
    "OPEN",
  );
  if (!refreshedReference.ok) {
    return { ok: false, summary: [refreshedReference.summary, commandSummary(prView)].join("\n\n") };
  }

  const checks = runCommand([
    "gh",
    "pr",
    "checks",
    prReference.prUrl,
    "--required",
    "--json",
    "name,state,bucket,link,workflow,description",
  ]);

  if (checks.exitCode !== 0) {
    return { ok: false, summary: ["GitHub PR required checks command failed.", commandSummary(checks)].join("\n\n") };
  }

  const parsedChecks = parseJsonCommand(checks, "GitHub PR required checks returned invalid JSON.");
  if (!parsedChecks.ok) return { ok: false, summary: parsedChecks.summary };

  const checkVerification = verifyPullRequestChecksJson(parsedChecks.value);
  if (!checkVerification.ok) {
    return { ok: false, summary: [checkVerification.summary, commandSummary(prView), commandSummary(checks)].join("\n\n") };
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

  const mergeVerification = verifyPullRequestMergedJson(parsed.value, release.branch, "main", expectedHeadRefOid);
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

export function verifyMainReadyForTag(release: ValidatedRelease, mergeCommitOid: string): MainReadyVerification {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const originMain = runCommand(["git", "rev-parse", "origin/main"]);
  const status = runCommand(["git", "status", "--short"]);
  const mergeBase = runCommand(["git", "merge-base", "--is-ancestor", mergeCommitOid, "HEAD"]);
  const localTag = runCommand(["git", "rev-parse", "--verify", `refs/tags/${release.version}`]);
  const remoteTag = runCommand(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== "main") failures.push(`current branch was ${branch.stdout || "missing"}, expected main`);
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push("local main HEAD could not be resolved");
  if (originMain.exitCode !== 0 || originMain.stdout.length === 0) failures.push("origin/main could not be resolved");
  if (head.stdout.length > 0 && originMain.stdout.length > 0 && head.stdout !== originMain.stdout) {
    failures.push(`local main HEAD ${head.stdout} did not match origin/main ${originMain.stdout}`);
  }
  if (status.exitCode !== 0 || status.stdout.length > 0) failures.push("worktree is not clean before tagging");
  if (mergeBase.exitCode !== 0) failures.push(`merge commit ${mergeCommitOid} is not an ancestor of local main HEAD`);
  if (localTag.exitCode === 0) failures.push(`local tag ${release.version} already exists`);
  if (remoteTag.exitCode !== 0) failures.push(`remote tag lookup for ${release.version} failed`);
  if (remoteTag.stdout.length > 0) failures.push(`remote tag ${release.version} already exists`);

  const summary = [
    failures.length === 0 ? "Main is ready for release tagging." : "Main is not ready for release tagging.",
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

export function verifyReleaseTagPublished(release: ValidatedRelease, expectedTagTargetOid: string): TagPublicationVerification {
  const localTag = runCommand(["git", "rev-parse", `${release.version}^{}`]);
  const remoteTag = runCommand(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  const remoteTagTargetOid = remoteTag.stdout.split(/\s+/u)[0] ?? "";
  const failures: string[] = [];

  if (localTag.exitCode !== 0 || localTag.stdout !== expectedTagTargetOid) {
    failures.push(`local tag target was ${localTag.stdout || "missing"}, expected ${expectedTagTargetOid}`);
  }
  if (remoteTag.exitCode !== 0 || remoteTagTargetOid !== expectedTagTargetOid) {
    failures.push(`remote tag target was ${remoteTagTargetOid || "missing"}, expected ${expectedTagTargetOid}`);
  }

  const summary = [
    failures.length === 0 ? "Release tag publication is deterministically verified." : "Release tag publication is not verified.",
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(localTag),
    commandSummary(remoteTag),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0) return { ok: false, summary };
  return { ok: true, summary, tagTargetOid: expectedTagTargetOid };
}

export async function verifyPublishWorkflowSucceeded(
  release: ValidatedRelease,
  expectedHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  let runList: CommandResult | undefined;
  let selectedRun: ReturnType<typeof selectPublishWorkflowRunJson> | undefined;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    runList = runCommand([
      "gh",
      "run",
      "list",
      "--workflow",
      "publish.yml",
      "--event",
      "push",
      "--json",
      "databaseId,status,conclusion,url,headBranch,event,workflowName,createdAt,headSha",
      "--limit",
      "50",
    ]);

    if (runList.exitCode !== 0) {
      return {
        ok: false,
        summary: ["GitHub Actions publish run lookup command failed.", commandSummary(runList)].join("\n\n"),
      };
    }

    const parsedList = parseJsonCommand(runList, "GitHub Actions publish run lookup returned invalid JSON.");
    if (!parsedList.ok) return { ok: false, summary: parsedList.summary };

    selectedRun = selectPublishWorkflowRunJson(parsedList.value, release.version);
    if (selectedRun.ok) break;
    if (attempt < 6) await Bun.sleep(10_000);
  }

  if (runList === undefined || selectedRun === undefined || !selectedRun.ok) {
    return {
      ok: false,
      summary: [
        selectedRun?.summary ?? "GitHub Actions publish run lookup did not execute.",
        runList === undefined ? undefined : commandSummary(runList),
      ].filter((line): line is string => line !== undefined).join("\n\n"),
    };
  }

  const watch = selectedRun.status === "completed"
    ? undefined
    : runCommand(["gh", "run", "watch", String(selectedRun.runId), "--exit-status"]);

  if (watch !== undefined && watch.exitCode !== 0) {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: [
        "GitHub Actions publish run did not complete successfully while watching.",
        selectedRun.summary,
        commandSummary(runList),
        commandSummary(watch),
      ].join("\n\n"),
    };
  }

  const runView = runCommand([
    "gh",
    "run",
    "view",
    String(selectedRun.runId),
    "--json",
    "databaseId,status,conclusion,url,headBranch,event,workflowName,createdAt,headSha",
  ]);

  if (runView.exitCode !== 0) {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: ["GitHub Actions publish run verification command failed.", commandSummary(runView)].join("\n\n"),
    };
  }

  const parsedView = parseJsonCommand(runView, "GitHub Actions publish run verification returned invalid JSON.");
  if (!parsedView.ok) {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: parsedView.summary,
    };
  }

  const publishVerification = verifyPublishWorkflowRunJson(parsedView.value, release.version, expectedHeadSha);
  if (!publishVerification.ok) {
    return {
      ok: false,
      runId: publishVerification.runId ?? selectedRun.runId,
      runUrl: publishVerification.runUrl ?? selectedRun.runUrl,
      summary: [publishVerification.summary, commandSummary(runList), commandSummary(runView)].join("\n\n"),
    };
  }

  return {
    ok: true,
    runId: publishVerification.runId,
    runUrl: publishVerification.runUrl,
    status: publishVerification.status,
    conclusion: publishVerification.conclusion,
    headSha: publishVerification.headSha,
    summary: [
      publishVerification.summary,
      commandSummary(runList),
      watch === undefined ? undefined : commandSummary(watch),
      commandSummary(runView),
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

