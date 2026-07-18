import { verifyReleaseBaseMetadata } from "../../../scripts/release-base.js";
import {
  commandSummary,
  runCommand,
  type CommandResult,
  type ValidatedRelease,
} from "./publish-release.js";

type Execute = (args: readonly string[]) => CommandResult | Promise<CommandResult>;

export type ReleaseTagRecovery =
  | {
      readonly ok: true;
      readonly state: "absent" | "local-only" | "remote-only" | "published";
      readonly summary: string;
      readonly tagTargetOid?: string;
    }
  | { readonly ok: false; readonly summary: string };


export async function inspectReleaseTagRecovery(
  release: ValidatedRelease,
  currentBaseOid: string,
  requiredMergeOid: string,
  expectedBaseRef: string,
  execute: Execute = runCommand,
): Promise<ReleaseTagRecovery> {
  const localTag = await execute(["git", "rev-parse", `${release.version}^{commit}`]);
  const remoteTag = await execute(["git", "ls-remote", "--tags", "origin", `refs/tags/${release.version}`]);
  if (remoteTag.exitCode !== 0) {
    return { ok: false, summary: ["Remote release tag lookup failed.", commandSummary(remoteTag)].join("\n\n") };
  }

  const localOid = localTag.exitCode === 0 ? localTag.stdout : "";
  const remoteOid = remoteTag.stdout.split(/\s+/u)[0] ?? "";
  const commands = [commandSummary(localTag), commandSummary(remoteTag)];
  if (localOid.length === 0 && remoteOid.length === 0) {
    return { ok: true, state: "absent", summary: ["Release tag is absent locally and on origin.", ...commands].join("\n\n") };
  }
  if (localOid.length === 0) {
    return {
      ok: true,
      state: "remote-only",
      summary: ["Release tag exists only on origin and must be fetched without force before verification.", `remoteTagTargetOid: ${remoteOid}`, ...commands].join("\n\n"),
    };
  }

  const tagParent = await execute(["git", "rev-parse", `${release.version}^{commit}^`]);
  const taggedManifest = await execute(["git", "show", `${release.version}:packages/coding-agent/package.json`]);
  const tagMessage = await execute(["git", "show", "-s", "--format=%B", `${release.version}^{commit}`]);
  const integratedParent = await execute(["git", "merge-base", "--is-ancestor", tagParent.stdout, currentBaseOid]);
  const containsMerge = await execute(["git", "merge-base", "--is-ancestor", requiredMergeOid, tagParent.stdout]);
  let stampedVersion: string | undefined;
  if (taggedManifest.exitCode === 0) {
    try {
      stampedVersion = (JSON.parse(taggedManifest.stdout) as { readonly version?: string }).version;
    } catch {
      stampedVersion = undefined;
    }
  }
  let releaseBaseError: string | undefined;
  if (tagMessage.exitCode !== 0) {
    releaseBaseError = "release commit message could not be read";
  } else {
    try {
      verifyReleaseBaseMetadata(tagMessage.stdout, tagParent.stdout, expectedBaseRef, tagParent.stdout);
    } catch (error) {
      releaseBaseError = error instanceof Error ? error.message : String(error);
    }
  }
  const validationCommands = [
    ...commands,
    commandSummary(tagParent),
    commandSummary(taggedManifest),
    commandSummary(tagMessage),
    commandSummary(integratedParent),
    commandSummary(containsMerge),
  ];
  const failures: string[] = [];
  if (tagParent.exitCode !== 0 || tagParent.stdout.length === 0) {
    failures.push("release commit parent could not be resolved");
  } else if (integratedParent.exitCode !== 0) {
    failures.push(`release commit parent ${tagParent.stdout} is not integrated into current base ${currentBaseOid}`);
  }
  if (containsMerge.exitCode !== 0) {
    failures.push(`verified merge commit ${requiredMergeOid} is not an ancestor of release parent ${tagParent.stdout || "missing"}`);
  }
  if (stampedVersion !== release.version) {
    failures.push(`tagged @bastani/atomic version was ${stampedVersion ?? "unparseable"}, expected ${release.version}`);
  }
  if (releaseBaseError !== undefined) failures.push(releaseBaseError);
  if (remoteOid.length > 0 && remoteOid !== localOid) {
    failures.push(`remote tag target was ${remoteOid}, expected local release commit ${localOid}`);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      summary: ["Existing release tag conflicts with deterministic release evidence.", ...failures.map((failure) => `- ${failure}`), ...validationCommands].join("\n\n"),
    };
  }

  const state = remoteOid.length === 0 ? "local-only" : "published";
  return {
    ok: true,
    state,
    tagTargetOid: localOid,
    summary: [
      state === "published"
        ? "Existing local and remote release tags match deterministic release evidence."
        : "Existing local release tag matches deterministic release evidence and must be pushed without force.",
      `tagTargetOid: ${localOid}`,
      ...validationCommands,
    ].join("\n\n"),
  };
}
