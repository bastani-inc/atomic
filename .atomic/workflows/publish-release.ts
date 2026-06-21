import { existsSync, readdirSync } from "node:fs";
import { defineWorkflow, Type } from "@bastani/workflows";
import {
  commandSummary,
  parseJsonCommand,
  runCommand,
  selectPublishWorkflowRunJson,
  validateReleaseRequest,
  verifyPublishWorkflowRunJson,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type CommandResult,
  type JsonValue,
  type PublishReleaseOutput,
  type PublishWorkflowRunVerification,
  type PullRequestMergeVerification,
  type PullRequestReferenceVerification,
  type ReleaseStatus,
  type ValidatedRelease,
} from "./lib/publish-release.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const statusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]);

function excerpt(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function blockedOutput(
  release: ValidatedRelease,
  stage: string,
  expectedResult: string,
  text: string,
  status: ReleaseStatus = "blocked",
): PublishReleaseOutput {
  return {
    status,
    target_version: release.version,
    release_kind: release.kind,
    branch: release.branch,
    summary: [
      `publish-release stopped during ${stage} for ${release.kind} ${release.version}.`,
      `Expected result: ${expectedResult}`,
      "",
      "Stage output:",
      excerpt(text, 2_000),
    ].join("\n"),
  };
}

type GateVerification =
  | {
      readonly ok: true;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly summary: string;
    };

type PreparationVerification =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly releaseCommitOid: string;
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

type PackageManifest = {
  readonly name?: JsonValue;
  readonly version?: JsonValue;
  readonly private?: JsonValue;
};

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const value = await Bun.file(path).json() as JsonValue;
  if (!isJsonObject(value)) {
    throw new Error(`${path} did not contain a JSON object`);
  }
  return value;
}

function packageManifestPaths(): readonly string[] {
  const paths = existsSync("package.json") ? ["package.json"] : [];
  if (!existsSync("packages")) return paths;

  paths.push(
    ...readdirSync("packages", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((path) => existsSync(path))
      .sort(),
  );

  return paths;
}

// main is versionless: it carries this placeholder and the real version is
// stamped only onto an off-main tag by scripts/cut-release.ts. The release-notes
// PR this workflow opens against main must therefore touch CHANGELOGs only —
// never package manifests, lockfiles, or generated version files.
const PLACEHOLDER_VERSION = "0.0.0";

function releaseChangedFileAllowed(path: string): boolean {
  return path === "CHANGELOG.md"
    || /^packages\/[^/]+\/CHANGELOG\.md$/u.test(path);
}

async function verifyReleasePreparation(
  release: ValidatedRelease,
  sourceHeadOid: string,
  checkManifestVersions = true,
): Promise<PreparationVerification> {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const status = runCommand(["git", "status", "--short"]);
  const changedFiles = runCommand(["git", "diff", "--name-only", `${sourceHeadOid}..HEAD`]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== release.branch) {
    failures.push(`current branch was ${branch.stdout || "missing"}, expected ${release.branch}`);
  }
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push("release commit HEAD could not be resolved");
  if (status.exitCode !== 0 || status.stdout.length > 0) {
    failures.push("worktree is not clean after release preparation");
  }

  const files = changedFiles.stdout.length === 0 ? [] : changedFiles.stdout.split(/\r?\n/u);
  const disallowed = files.filter((file) => !releaseChangedFileAllowed(file));
  if (changedFiles.exitCode !== 0) {
    failures.push("changed files could not be compared against the recorded source HEAD");
  }
  if (disallowed.length > 0) {
    failures.push(`release branch changed files outside the release allowlist: ${disallowed.join(", ")}`);
  }

  for (const manifestPath of packageManifestPaths()) {
    let manifest: PackageManifest;
    try {
      manifest = await readPackageManifest(manifestPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      continue;
    }

    if (checkManifestVersions && typeof manifest.version === "string" && manifest.version !== PLACEHOLDER_VERSION) {
      failures.push(
        `${manifestPath} version was ${manifest.version}, expected the ${PLACEHOLDER_VERSION} placeholder. main is versionless; do not run bump-version in this flow (the release version is stamped onto the tag by scripts/cut-release.ts).`,
      );
    }

    if (manifestPath === "packages/coding-agent/package.json" && manifest.name !== "@bastani/atomic") {
      failures.push(`${manifestPath} name was ${String(manifest.name)}, expected @bastani/atomic`);
    }

    if (manifestPath === "packages/natives/package.json") {
      if (manifest.name !== "@bastani/atomic-natives") {
        failures.push(`${manifestPath} name was ${String(manifest.name)}, expected @bastani/atomic-natives`);
      }
      if (manifest.private === true) {
        failures.push(`${manifestPath} must remain publishable because @bastani/atomic depends on it at runtime`);
      }
    } else if (manifestPath !== "packages/coding-agent/package.json"
      && manifestPath.startsWith("packages/")
      && manifest.private !== true) {
      failures.push(`${manifestPath} must remain private because it is bundled into @bastani/atomic`);
    }
  }

  const summary = [
    failures.length === 0 ? "Release preparation is deterministically verified." : "Release preparation is not verified.",
    `sourceHeadOid: ${sourceHeadOid}`,
    head.stdout.length === 0 ? undefined : `releaseCommitOid: ${head.stdout}`,
    files.length === 0 ? "changedFiles: none" : `changedFiles:\n${files.map((file) => `- ${file}`).join("\n")}`,
    failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
    commandSummary(branch),
    commandSummary(head),
    commandSummary(status),
    commandSummary(changedFiles),
  ].filter((line): line is string => line !== undefined).join("\n\n");

  if (failures.length > 0 || head.stdout.length === 0) return { ok: false, summary };
  return { ok: true, summary, releaseCommitOid: head.stdout };
}

function runLocalReleaseChecks(release: ValidatedRelease): GateVerification {
  const branch = runCommand(["git", "branch", "--show-current"]);
  const head = runCommand(["git", "rev-parse", "HEAD"]);
  const statusBefore = runCommand(["git", "status", "--short"]);
  const typecheck = runCommand(["bun", "run", "typecheck"]);
  const unitTests = typecheck.exitCode === 0 ? runCommand(["bun", "run", "test:unit"]) : undefined;
  const statusAfter = runCommand(["git", "status", "--short"]);
  const failures: string[] = [];

  if (branch.exitCode !== 0 || branch.stdout !== release.branch) {
    failures.push(`current branch was ${branch.stdout || "missing"}, expected ${release.branch}`);
  }
  if (head.exitCode !== 0 || head.stdout.length === 0) failures.push("release commit HEAD could not be resolved");
  if (statusBefore.exitCode !== 0 || statusBefore.stdout.length > 0) failures.push("worktree was not clean before local checks");
  if (typecheck.exitCode !== 0) failures.push("bun run typecheck failed");
  if (unitTests === undefined) failures.push("bun run test:unit was skipped because typecheck failed");
  if (unitTests !== undefined && unitTests.exitCode !== 0) failures.push("bun run test:unit failed");
  if (statusAfter.exitCode !== 0 || statusAfter.stdout.length > 0) failures.push("worktree was not clean after local checks");

  return {
    ok: failures.length === 0,
    summary: [
      failures.length === 0 ? "Local release checks passed deterministically." : "Local release checks failed.",
      failures.length === 0 ? undefined : failures.map((failure) => `- ${failure}`).join("\n"),
      commandSummary(branch),
      commandSummary(head),
      commandSummary(statusBefore),
      commandSummary(typecheck),
      unitTests === undefined ? undefined : commandSummary(unitTests),
      commandSummary(statusAfter),
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

function captureReleasePrReference(
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

function verifyReleasePrChecksPassed(
  release: ValidatedRelease,
  prReference: Extract<PullRequestReferenceVerification, { readonly ok: true }>,
  baseRef: string,
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
    baseRef,
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

function verifyReleasePrMerged(
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

function verifyMainReadyForTag(release: ValidatedRelease, mergeCommitOid: string, baseRef: string): MainReadyVerification {
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

function verifyReleaseTagPublished(release: ValidatedRelease, expectedParentOid: string): TagPublicationVerification {
  // The tag does not point at a commit on main. cut-release.ts stamps the real
  // version onto a throwaway "Release" commit whose parent is the merged main
  // HEAD, then tags that commit. Verify: (1) local + remote tag resolve to the
  // same release commit, (2) its parent is the verified main commit, and (3) the
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
    failures.push(`release commit parent was ${tagParent.stdout || "missing"}, expected the verified main commit ${expectedParentOid}`);
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

async function verifyWorkflowRunSucceeded(
  expectedHeadSha: string,
  options: { readonly workflowFile: string; readonly expectedHeadBranch: string },
): Promise<PublishWorkflowRunVerification> {
  const { workflowFile, expectedHeadBranch } = options;
  let runList: CommandResult | undefined;
  let selectedRun: ReturnType<typeof selectPublishWorkflowRunJson> | undefined;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    runList = runCommand([
      "gh",
      "run",
      "list",
      "--workflow",
      workflowFile,
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

    selectedRun = selectPublishWorkflowRunJson(parsedList.value, expectedHeadBranch);
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

  const publishVerification = verifyPublishWorkflowRunJson(parsedView.value, expectedHeadBranch, expectedHeadSha);
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

function verifyPublishWorkflowSucceeded(
  release: ValidatedRelease,
  expectedHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  return verifyWorkflowRunSucceeded(expectedHeadSha, {
    workflowFile: "publish.yml",
    expectedHeadBranch: release.version,
  });
}

function verifyReleaseBranchCiSucceeded(
  release: ValidatedRelease,
  branchHeadSha: string,
): Promise<PublishWorkflowRunVerification> {
  return verifyWorkflowRunSucceeded(branchHeadSha, {
    workflowFile: "test.yml",
    expectedHeadBranch: release.branch,
  });
}

function releaseInstructions(release: ValidatedRelease, baseRef: string): string {
  return [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Base branch (release-notes PR target and tag base): ${baseRef}`,
    `Release-notes branch to create from current HEAD: ${release.branch}`,
    "Repository rules:",
    "- Use Bun commands, not npm/yarn/pnpm/npx, for local development steps.",
    "- Never include a leading v in the version or tag.",
    `- ${baseRef} is versionless: every packages/*/package.json stays at the 0.0.0 placeholder. Do NOT run scripts/bump-version.ts and do NOT change any package version in this flow.`,
    `- The real version is materialized only on a throwaway off-${baseRef} tag commit produced by \`scripts/cut-release.ts\`; it is never merged into ${baseRef}.`,
    "- Do not modify already released changelog sections; add entries only under each package CHANGELOG.md `## [Unreleased]` section.",
    "- If credentials, git state, CI, or publish checks block safe progress, report the blocker clearly and stop rather than fabricating success.",
  ].join("\n");
}

export default defineWorkflow("publish-release")
  .description("Automate Atomic versionless-main release: open a release-notes PR to main, then stamp and tag the release off-main with cut-release.ts, and monitor publishing.")
  .input("target_version", Type.String({ description: "Version to publish, without a leading v." }))
  .input("release_kind", Type.Union([Type.Literal("release"), Type.Literal("prerelease")], {
    description: "Release type; release requires MAJOR.MINOR.PATCH and prerelease requires MAJOR.MINOR.PATCH-alpha.REVISION.",
  }))
  .input(
    "base_ref",
    Type.String({
      default: "main",
      description:
        "Branch to release from: the release-notes PR merges into it and the tag is cut from it. Defaults to main. Set this to release from a maintenance/integration branch instead of main.",
    }),
  )
  .input(
    "base_ref",
    Type.String({
      default: "main",
      description:
        "Branch to release from: the release-notes PR merges into it and the tag is cut from it. Defaults to main. Set this to release from a maintenance/integration branch instead of main.",
    }),
  )
  .input(
    "from_ref",
    Type.Optional(
      Type.String({
        description:
          "Optional: cut an ephemeral release from any commit/tag/branch. The workflow auto-creates release/<version> (or prerelease/<version>) from this ref, commits the CHANGELOG entry on it, gates on that branch's CI, cuts and publishes the tag, then deletes the branch. The changelog lives on the tag only and main is untouched. When set, base_ref is ignored.",
      }),
    ),
  )
  .output("status", statusSchema)
  .output("target_version", Type.String({ description: "Validated version supplied to the release workflow." }))
  .output("release_kind", releaseKindSchema)
  .output("branch", Type.String({ description: "Release branch created by the workflow." }))
  .output("pr_url", Type.Optional(Type.String({ description: "Best-effort PR URL detected from the PR stage output." })))
  .output("tag", Type.Optional(Type.String({ description: "Version tag pushed to trigger publishing." })))
  .output("summary", Type.String({ description: "Compact release execution summary." }))
  .run(async (ctx) => {
    const release = validateReleaseRequest(ctx.inputs.release_kind, ctx.inputs.target_version);
    const baseRef = ctx.inputs.base_ref.trim() || "main";
    const baseInstructions = releaseInstructions(release, baseRef);
    const sourceHead = runCommand(["git", "rev-parse", "HEAD"]);

    if (sourceHead.exitCode !== 0 || sourceHead.stdout.length === 0) {
      return blockedOutput(
        release,
        "capture-source-head",
        "git rev-parse HEAD resolves the source commit before release preparation",
        commandSummary(sourceHead),
      );
    }

    const fromRef = ctx.inputs.from_ref?.trim();
    if (fromRef) {
      // Ephemeral release from an arbitrary ref: auto-create release/<version> from
      // from_ref, put the changelog on it, gate on that branch's CI, cut+publish the
      // tag off it, then delete the branch. The changelog lives only on the tag and
      // base_ref/main is never touched.
      runCommand(["git", "fetch", "--quiet", "--tags", "origin"]);
      const fromRefCommit = runCommand(["git", "rev-parse", "--verify", `${fromRef}^{commit}`]);
      if (fromRefCommit.exitCode !== 0 || fromRefCommit.stdout.length === 0) {
        return blockedOutput(
          release,
          "resolve-from-ref",
          `git rev-parse resolves from_ref ${fromRef} to a commit before creating the ephemeral release branch`,
          commandSummary(fromRefCommit),
        );
      }
      const fromRefOid = fromRefCommit.stdout;
      const ephemeralInstructions = [
        `Release kind: ${release.kind}`,
        `Target version: ${release.version}`,
        `Ephemeral release branch (auto-created from from_ref, deleted after publish): ${release.branch}`,
        `Source ref: ${fromRef} (${fromRefOid})`,
        "Repository rules:",
        "- Use Bun commands, not npm/yarn/pnpm/npx, for local steps.",
        "- Never include a leading v in the version or tag.",
        "- Do NOT run scripts/bump-version.ts and do NOT change any package version; cut-release.ts stamps the version onto the tag commit.",
        "- The changelog lives only on the release tag; main/base_ref is never touched.",
        "- If credentials, git state, or CI block safe progress, report the blocker and stop rather than fabricating success.",
      ].join("\n");

      const prepare = await ctx.task("create-ephemeral-release-branch", {
        prompt: [
          "Create the ephemeral release branch from the source ref and put the changelog on it.",
          "",
          ephemeralInstructions,
          "",
          "Required actions:",
          `1. Ensure ${fromRef} is available locally (\`git fetch origin\` as needed), then create and switch to branch \`${release.branch}\` at commit \`${fromRefOid}\` (e.g. \`git switch -c ${release.branch} ${fromRefOid}\`). If the branch already exists, stop and report BLOCKED.`,
          `2. Read package changelogs, especially \`packages/*/CHANGELOG.md\`, and move the \`## [Unreleased]\` entries into a new \`## [${release.version}]\` section dated today, per AGENTS.md Changelog guidance. Do NOT change any package version.`,
          "3. Inspect the diff and ensure it contains only CHANGELOG.md changes.",
          `4. Commit on \`${release.branch}\` with a message such as \`docs: release notes for ${release.version}\`, then push with \`git push -u origin ${release.branch}\`.`,
          "",
          "Final response format:",
          "- Include the created branch, its HEAD commit, `git status --short`, changed files, the push result, and any blockers.",
          "- The workflow body verifies the branch, its CI, the tag, and cleanup deterministically after each stage.",
        ].join("\n"),
      });

      const preparationVerification = await verifyReleasePreparation(release, fromRefOid, false);
      if (!preparationVerification.ok) {
        return blockedOutput(
          release,
          "verify-ephemeral-release-branch",
          `current branch is ${release.branch}, the worktree is clean, and only CHANGELOG files changed vs ${fromRef}`,
          [preparationVerification.summary, "", "Create-branch stage output:", excerpt(prepare.text, 2_000)].join("\n"),
        );
      }

      const remoteBranch = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
      const remoteHeadOid = remoteBranch.stdout.split(/\s+/u)[0] ?? "";
      if (remoteBranch.exitCode !== 0 || remoteHeadOid !== preparationVerification.releaseCommitOid) {
        return blockedOutput(
          release,
          "verify-ephemeral-branch-pushed",
          `origin/${release.branch} exists and points at the release-notes commit ${preparationVerification.releaseCommitOid}`,
          [
            `remote ${release.branch} head: ${remoteHeadOid || "missing"}`,
            `expected: ${preparationVerification.releaseCommitOid}`,
            commandSummary(remoteBranch),
            "",
            "Create-branch stage output:",
            excerpt(prepare.text, 2_000),
          ].join("\n"),
        );
      }

      const ciWait = await ctx.task("wait-for-release-branch-ci", {
        prompt: [
          `Wait for required CI checks on branch \`${release.branch}\` (commit \`${preparationVerification.releaseCommitOid}\`). Do not cut a tag yet.`,
          "",
          ephemeralInstructions,
          "",
          "Required actions:",
          `1. Wait for the Tests workflow on \`${release.branch}\` to finish, e.g. \`gh run list --branch ${release.branch} --workflow test.yml\` then \`gh run watch <run-id> --exit-status\` for the run whose headSha is \`${preparationVerification.releaseCommitOid}\`.`,
          "2. If required checks fail, report the failing check names and URLs. Do not cut a tag.",
          "3. If checks pass, summarize the evidence and stop.",
          "",
          "Final response format:",
          "- Include the run id/URL, status, conclusion, headSha, commands run, and any blockers.",
          "- The workflow body performs the deterministic branch-CI gate after this stage.",
        ].join("\n"),
      });

      const branchCi = await verifyReleaseBranchCiSucceeded(release, preparationVerification.releaseCommitOid);
      if (!branchCi.ok) {
        return blockedOutput(
          release,
          "verify-release-branch-ci",
          `the Tests workflow run for ${release.branch} has headSha ${preparationVerification.releaseCommitOid}, status completed, and conclusion success`,
          [branchCi.summary, "", "CI wait stage output:", excerpt(ciWait.text, 2_000)].join("\n"),
          "failed",
        );
      }

      const pushTag = await ctx.task("cut-release-tag", {
        prompt: [
          `Cut the release tag off \`${release.branch}\`. This is the sole publish trigger stage.`,
          "",
          ephemeralInstructions,
          "",
          "Deterministic branch-CI gate:",
          excerpt(branchCi.summary),
          "",
          "Required actions:",
          `1. Verify you are on clean local \`${release.branch}\` at commit \`${preparationVerification.releaseCommitOid}\`.`,
          `2. Run \`bun run scripts/cut-release.ts ${release.version} --base ${release.branch} --push --yes\`. This stamps the real version onto a throwaway off-branch "Release ${release.version}" commit (parent = ${release.branch} HEAD), tags it, and pushes ONLY the tag.`,
          `3. Do not push ${release.branch}. Do not force-push or overwrite an existing tag. Do not run scripts/bump-version.ts.`,
          "",
          "Final response format:",
          `- Include the pushed tag, the release commit SHA and its parent (must equal ${release.branch} HEAD), local/remote tag evidence, the publish run URL if available, and any blockers.`,
        ].join("\n"),
      });

      const tagVerification = verifyReleaseTagPublished(release, preparationVerification.releaseCommitOid);
      if (!tagVerification.ok) {
        return blockedOutput(
          release,
          "verify-release-tag-published",
          `local and remote release tag exist, the release commit parent is the ${release.branch} commit, and the tagged @bastani/atomic manifest carries the target version`,
          [tagVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
          "failed",
        );
      }

      const publishVerification = await verifyPublishWorkflowSucceeded(release, tagVerification.tagTargetOid);
      if (!publishVerification.ok) {
        return blockedOutput(
          release,
          "verify-publish-workflow-succeeded",
          "GitHub Actions Publish run for the release tag has matching headSha, status completed, and conclusion success",
          [publishVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
          "failed",
        );
      }

      const cleanup = await ctx.task("delete-ephemeral-release-branch", {
        prompt: [
          `The release is published. Delete the now-unneeded branch \`${release.branch}\`; the tag \`${release.version}\` keeps its commits alive.`,
          "",
          "Required actions:",
          `1. Run \`git push origin --delete ${release.branch}\` to delete the remote branch.`,
          `2. Optionally delete the local branch (\`git branch -D ${release.branch}\` after switching away). Do NOT delete the tag.`,
          "",
          "Final response format:",
          "- Include the delete command result and confirmation that the tag still exists.",
        ].join("\n"),
      });

      const remoteBranchAfter = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
      const branchDeleted = remoteBranchAfter.exitCode === 0 && remoteBranchAfter.stdout.trim().length === 0;
      const cleanupNote = branchDeleted
        ? `Ephemeral branch ${release.branch} deleted from origin.`
        : `WARNING: ephemeral branch ${release.branch} may still exist on origin; delete it manually with \`git push origin --delete ${release.branch}\` (the release itself is already published).`;

      const ephemeralSummary = [
        `publish-release (ephemeral) completed for ${release.kind} ${release.version}.`,
        `Source ref: ${fromRef} (${fromRefOid})`,
        `Release branch: ${release.branch} (auto-created, ${branchDeleted ? "deleted" : "NOT deleted"})`,
        `Tag: ${release.version} -> release commit ${tagVerification.tagTargetOid}`,
        publishVerification.runUrl === undefined ? "Publish run: see cut-release stage output" : `Publish run: ${publishVerification.runUrl}`,
        cleanupNote,
        "",
        "Stage summaries:",
        "## deterministic-branch-ci",
        excerpt(branchCi.summary, 800),
        "## deterministic-release-tag",
        excerpt(tagVerification.summary, 800),
        "## deterministic-publish-run",
        excerpt(publishVerification.summary, 800),
        "## delete-ephemeral-release-branch",
        excerpt(cleanup.text, 800),
      ].join("\n");

      return {
        status: "completed",
        target_version: release.version,
        release_kind: release.kind,
        branch: release.branch,
        tag: release.version,
        summary: ephemeralSummary,
      };
    }

    const prepare = await ctx.task("prepare-release-branch-and-metadata", {
      prompt: [
        "Prepare the release branch and metadata changes for this Atomic repository.",
        "",
        baseInstructions,
        "",
        "Required actions:",
        "1. Inspect `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git log -1 --oneline`, and `git remote -v` to record the source branch and exact source commit.",
        "2. Ensure you are starting from a safe state for a release. If unrelated uncommitted changes already exist before your release edits, stop and report BLOCKED with the exact files.",
        `3. Create and switch to branch \`${release.branch}\` from the recorded source commit \`${sourceHead.stdout}\` if it does not already exist; if it exists, verify it is the intended same-version release-notes branch before continuing.`,
        `4. Read package changelogs, especially \`packages/*/CHANGELOG.md\`, and move the \`## [Unreleased]\` entries into a new \`## [${release.version}]\` section dated today, per AGENTS.md Changelog guidance.`,
        "5. Do NOT bump versions: main is versionless and every package manifest must stay at the 0.0.0 placeholder. Do not run scripts/bump-version.ts and do not touch package.json, bun.lock, Cargo.*, or generated version files.",
        "6. Inspect the resulting diff and ensure it contains only CHANGELOG.md changes.",
        `7. Commit the changelog changes on \`${release.branch}\` with a concise conventional message such as \`docs: release notes for ${release.version}\`.`,
        "",
        "Final response format:",
        "- Summarize source branch, source HEAD, created/current release branch, release commit hash, `git status --short`, changed files, commands run, and any blockers.",
        "- Do not claim the workflow is ready based on prose alone; the workflow body performs deterministic release-preparation verification after this stage.",
      ].join("\n"),
    });

    const preparationVerification = await verifyReleasePreparation(release, sourceHead.stdout);
    if (!preparationVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-preparation",
        "release branch, clean worktree, allowed release files, and package metadata are deterministically verified",
        [preparationVerification.summary, "", "Prepare stage output:", excerpt(prepare.text, 2_000)].join("\n"),
      );
    }

    const localChecks = runLocalReleaseChecks(release);
    if (!localChecks.ok) {
      return blockedOutput(
        release,
        "run-local-release-checks",
        "bun run typecheck and bun run test:unit exit successfully on a clean release branch",
        localChecks.summary,
        "failed",
      );
    }

    const pr = await ctx.task("open-release-pr", {
      prompt: [
        "Push the release branch and open the release PR with GitHub CLI.",
        "",
        baseInstructions,
        "",
        "Deterministic preparation and local checks:",
        excerpt([preparationVerification.summary, localChecks.summary].join("\n\n")),
        "",
        "Required actions:",
        `1. Use \`git branch --show-current\` plus \`git rev-parse HEAD\` to verify the current branch is \`${release.branch}\` at commit \`${preparationVerification.releaseCommitOid}\`.`,
        `2. Push branch with \`git push -u origin ${release.branch}\`.`,
        "3. Use `gh auth status` and `gh repo view` or equivalent non-destructive checks to confirm GitHub access.",
        `4. Create a PR from \`${release.branch}\` to \`${baseRef}\` with title \`Release ${release.version}\` if one does not already exist. If a PR already exists for the branch, reuse it.`,
        "5. Include release kind, version, changelog/version bump summary, and validation commands in the PR body.",
        "",
        "Final response format:",
        "- Include the PR URL on its own line if available.",
        "- Include PR base, head branch, head SHA, commands run, and any blockers.",
        "- Do not use a PR_STATUS marker; the workflow body captures and verifies the PR identity deterministically after this stage.",
      ].join("\n"),
    });

    const prReference = captureReleasePrReference(release, preparationVerification.releaseCommitOid, baseRef);
    if (!prReference.ok) {
      return blockedOutput(
        release,
        "capture-release-pr-reference",
        "GitHub PR has OPEN state, matching base/head refs, and head SHA equal to the release commit",
        [prReference.summary, "", "PR stage output:", excerpt(pr.text, 2_000)].join("\n"),
      );
    }

    const ciWait = await ctx.task("wait-for-release-ci", {
      prompt: [
        "Wait for required CI checks on the release PR, but do not merge it.",
        "",
        baseInstructions,
        "",
        "Deterministic PR reference captured from GitHub:",
        excerpt(prReference.summary),
        "",
        "Required actions:",
        `1. Identify the PR using this deterministic selector: ${prReference.prUrl}`,
        "2. Wait for required checks using `gh pr checks --watch --required` or an equivalent `gh` workflow that returns a non-zero status on failures.",
        "3. If any required check fails, report the failed check names and URLs/log hints. Do not merge.",
        "4. If checks appear to pass, stop after summarizing the check evidence. Do not merge.",
        "",
        "Final response format:",
        "- Include commands run, check names/states, URLs/log hints for failures, and any blockers.",
        "- The workflow body performs the deterministic required-check gate after this stage.",
      ].join("\n"),
    });

    const ciVerification = verifyReleasePrChecksPassed(release, prReference, baseRef);
    if (!ciVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-pr-checks-passed",
        "GitHub PR required checks are passing for the exact captured PR head SHA before merge",
        [ciVerification.summary, "", "CI wait stage output:", excerpt(ciWait.text, 2_000)].join("\n"),
        "failed",
      );
    }

    const merge = await ctx.task("merge-verified-release-pr", {
      prompt: [
        "Merge the release PR after deterministic CI verification.",
        "",
        baseInstructions,
        "",
        "Deterministic CI gate:",
        excerpt(ciVerification.summary),
        "",
        "Required actions:",
        `1. Identify the PR using this deterministic selector: ${prReference.prUrl}`,
        `2. Merge only the captured head commit \`${prReference.headRefOid ?? preparationVerification.releaseCommitOid}\`; if using \`gh pr merge\`, prefer a method that includes a head-SHA guard such as \`--match-head-commit\` when available.`,
        "3. Use the repository-supported merge method. Do not delete the release branch after merge.",
        "4. Summarize the merge attempt, commands run, merged commit/ref evidence if available, branch-retention evidence if available, and any blockers.",
        "",
        "Final response format:",
        "- Do not rely on an exact merge status marker; the workflow body verifies GitHub PR merge state, head SHA, and branch retention directly after this stage.",
      ].join("\n"),
    });

    const mergeVerification = verifyReleasePrMerged(release, prReference.prUrl, prReference.headRefOid, baseRef);
    if (!mergeVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-pr-merged",
        "GitHub PR state MERGED with mergedAt, mergeCommit.oid, matching base/head refs, matching captured head SHA, and retained remote release branch",
        [mergeVerification.summary, "", "Merge stage output:", excerpt(merge.text, 2_000)].join("\n"),
      );
    }

    const syncMain = await ctx.task("sync-main-after-merge", {
      prompt: [
        `Sync local ${baseRef} after the release PR merge. Do not create or push a tag.`,
        "",
        baseInstructions,
        "",
        "Deterministic merge verification:",
        excerpt(mergeVerification.summary),
        "",
        "Required actions:",
        `1. Switch to \`${baseRef}\` and run \`git pull origin ${baseRef}\`.`,
        `2. Confirm the merged release commit for ${release.version} is present on local ${baseRef} with command-backed evidence such as \`git rev-parse HEAD\` and \`git merge-base --is-ancestor ${mergeVerification.mergeCommitOid} HEAD\`.`,
        `3. Confirm tag \`${release.version}\` does not already exist locally or on origin. Do not create the tag in this stage.`,
        "",
        "Final response format:",
        `- Include local ${baseRef} HEAD, origin/${baseRef} evidence, worktree status, tag existence checks, commands run, and any blockers.`,
        "- The workflow body performs a deterministic base-branch/tag-readiness gate after this stage.",
      ].join("\n"),
    });

    const mainReady = verifyMainReadyForTag(release, mergeVerification.mergeCommitOid, baseRef);
    if (!mainReady.ok) {
      return blockedOutput(
        release,
        "verify-main-ready-for-tag",
        `local ${baseRef} is clean, matches origin/${baseRef}, contains the merge commit, and the release tag does not already exist`,
        [mainReady.summary, "", "Sync-main stage output:", excerpt(syncMain.text, 2_000)].join("\n"),
      );
    }

    const pushTag = await ctx.task("cut-release-tag", {
      prompt: [
        `Cut the release tag off ${baseRef}. This is the sole publish trigger stage. ${baseRef} is never bumped.`,
        "",
        baseInstructions,
        "",
        "Deterministic tag readiness gate:",
        excerpt(mainReady.summary),
        "",
        "Required actions:",
        `1. Verify you are on clean local \`${baseRef}\` at commit \`${mainReady.mainOid}\`.`,
        `2. Run \`bun run scripts/cut-release.ts ${release.version} --base ${baseRef} --push --yes\`. This stamps the real version onto a throwaway off-${baseRef} "Release ${release.version}" commit (parent = the current ${baseRef} commit), tags it, and pushes ONLY the tag.`,
        `3. Do not push ${baseRef}. Do not force-push or overwrite an existing tag. Do not run scripts/bump-version.ts.`,
        "4. You may start monitoring the publish workflow, but the workflow body will verify the tag and publish run deterministically after this stage.",
        "",
        "Final response format:",
        `- Include the pushed tag, the off-${baseRef} release commit SHA and its parent (which must equal the ${baseRef} commit above), local/remote tag SHA evidence, GitHub Actions run URL/status if available, commands run, and any observed blockers.`,
      ].join("\n"),
    });

    const tagVerification = verifyReleaseTagPublished(release, mainReady.mainOid);
    if (!tagVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-tag-published",
        "local and remote release tag exist, the release commit parent is the verified main commit, and the tagged @bastani/atomic manifest carries the target version",
        [tagVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
        "failed",
      );
    }

    const publishVerification = await verifyPublishWorkflowSucceeded(release, tagVerification.tagTargetOid);
    if (!publishVerification.ok) {
      return blockedOutput(
        release,
        "verify-publish-workflow-succeeded",
        "GitHub Actions Publish run for the release tag has matching headSha, status completed, and conclusion success",
        [publishVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
        "failed",
      );
    }

    const prUrl = mergeVerification.prUrl ?? prReference.prUrl;
    const actionUrl = publishVerification.runUrl;
    const summary = [
      `publish-release completed for ${release.kind} ${release.version}.`,
      `Branch: ${release.branch}`,
      prUrl === undefined ? "PR URL: see open-release-pr stage output" : `PR URL: ${prUrl}`,
      `Tag: ${release.version}`,
      actionUrl === undefined ? "Publish run: see push-release-tag stage output" : `Publish run: ${actionUrl}`,
      "",
      "Stage summaries:",
      "## prepare-release-branch-and-metadata",
      excerpt(prepare.text, 800),
      "",
      "## deterministic-release-preparation",
      excerpt(preparationVerification.summary, 800),
      "",
      "## deterministic-local-release-checks",
      excerpt(localChecks.summary, 800),
      "",
      "## open-release-pr",
      excerpt(pr.text, 800),
      "",
      "## deterministic-pr-reference",
      excerpt(prReference.summary, 800),
      "",
      "## wait-for-release-ci",
      excerpt(ciWait.text, 800),
      "",
      "## deterministic-ci-verification",
      excerpt(ciVerification.summary, 800),
      "",
      "## merge-verified-release-pr",
      excerpt(merge.text, 800),
      "",
      "## deterministic-merge-verification",
      excerpt(mergeVerification.summary, 800),
      "",
      "## sync-main-after-merge",
      excerpt(syncMain.text, 800),
      "",
      "## deterministic-main-ready-for-tag",
      excerpt(mainReady.summary, 800),
      "",
      "## push-release-tag",
      excerpt(pushTag.text, 800),
      "",
      "## deterministic-tag-verification",
      excerpt(tagVerification.summary, 800),
      "",
      "## deterministic-publish-verification",
      excerpt(publishVerification.summary, 800),
    ].join("\n");

    const result: PublishReleaseOutput = {
      status: "completed",
      target_version: release.version,
      release_kind: release.kind,
      branch: release.branch,
      tag: release.version,
      summary,
    };

    if (prUrl !== undefined) {
      return { ...result, pr_url: prUrl };
    }

    return result;
  })
  .compile();
