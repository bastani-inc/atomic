#!/usr/bin/env bun
/** Reconfirm that a remote release tag still names the integrity-verified SHA. */

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.[1-9]\d*)?$/u;

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunGit = (args: readonly string[]) => GitResult;

const defaultRunGit: RunGit = (args) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

export function resolveRemoteTagSha(tag: string, runGit: RunGit = defaultRunGit): string {
  if (!VERSION_PATTERN.test(tag) || tag === "0.0.0") {
    throw new Error(`Invalid release tag for reconfirmation: ${tag || "missing"}`);
  }
  const ref = `refs/tags/${tag}`;
  const result = runGit(["ls-remote", "--exit-code", "--refs", "origin", ref]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Release tag ${tag} is not resolvable on origin (exit ${result.exitCode}); refusing irreversible publication. ${result.stderr.trim()}`,
    );
  }
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(`Release tag ${tag} resolved to ${lines.length} refs; expected exactly one.`);
  }
  const fields = (lines[0] as string).trim().split(/\s+/u);
  const sha = fields[0] ?? "";
  if (fields.length !== 2 || fields[1] !== ref || !SHA_PATTERN.test(sha)) {
    throw new Error(`Could not resolve release tag ${tag} to one exact commit SHA.`);
  }
  return sha;
}

export function assertReleaseTagUnmoved(tag: string, verifiedSha: string, currentSha: string): void {
  if (!SHA_PATTERN.test(verifiedSha)) {
    throw new Error(`Invalid verified release SHA for tag ${tag}: ${verifiedSha || "missing"}`);
  }
  if (currentSha !== verifiedSha) {
    throw new Error(
      `Release tag ${tag} moved from verified ${verifiedSha} to ${currentSha || "missing"}; refusing irreversible publication.`,
    );
  }
}

export function reconfirmReleaseTag(tag: string, verifiedSha: string, runGit: RunGit = defaultRunGit): string {
  const currentSha = resolveRemoteTagSha(tag, runGit);
  assertReleaseTagUnmoved(tag, verifiedSha, currentSha);
  return currentSha;
}

if (import.meta.main) {
  const tag = process.env.RELEASE_TAG;
  const verifiedSha = process.env.VERIFIED_SHA;
  if (tag === undefined) throw new Error("RELEASE_TAG is required");
  if (verifiedSha === undefined) throw new Error("VERIFIED_SHA is required");
  const confirmed = reconfirmReleaseTag(tag, verifiedSha);
  console.log(`Release tag ${tag} still points at verified ${confirmed}.`);
}
