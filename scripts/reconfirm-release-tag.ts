/**
 * Protected-publisher helper: re-resolve the exact remote release tag and prove
 * it still points at the verified off-branch release SHA immediately before an
 * irreversible side effect (each npm publish and GitHub Release creation).
 *
 * npm publications are immutable. If a release tag is force-moved or deleted
 * between the integrity job pinning `release-integrity.outputs.sha` and a
 * downstream publish, we must fail *before* the publish rather than emit bytes
 * bound to a SHA that no longer matches the remote tag. This helper is invoked
 * once per irreversible step so the exact same tag/SHA binding is enforced at
 * each boundary, not only once at the end of the job.
 */

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

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

/**
 * Resolve the current remote SHA for `refs/tags/<tag>` on `origin`. Throws if
 * the tag is missing/deleted or does not resolve to exactly one 40-hex commit.
 */
export function resolveRemoteTagSha(tag: string, runGit: RunGit = defaultRunGit): string {
  if (!tag) throw new Error("Release tag is required to reconfirm remote immutability.");
  const result = runGit(["ls-remote", "--exit-code", "--refs", "origin", `refs/tags/${tag}`]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Release tag ${tag} is no longer resolvable on origin (git ls-remote exit ${result.exitCode}); refusing irreversible publication. ${result.stderr.trim()}`,
    );
  }
  const firstLine = result.stdout.split("\n").find((line) => line.trim().length > 0) ?? "";
  const sha = firstLine.trim().split(/\s+/u)[0] ?? "";
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Could not resolve release tag ${tag} to a single commit SHA; got: ${sha || "empty"}`);
  }
  return sha;
}

/**
 * Assert the freshly resolved remote tag SHA equals the verified release SHA.
 */
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

/**
 * Re-resolve and bind the remote tag to the verified SHA. Returns the confirmed
 * SHA on success and throws before the caller performs its side effect on any
 * move/delete/ambiguity.
 */
export function reconfirmReleaseTag(tag: string, verifiedSha: string, runGit: RunGit = defaultRunGit): string {
  const currentSha = resolveRemoteTagSha(tag, runGit);
  assertReleaseTagUnmoved(tag, verifiedSha, currentSha);
  return currentSha;
}

if (import.meta.main) {
  const tag = process.env.RELEASE_TAG;
  const verifiedSha = process.env.VERIFIED_SHA;
  if (!tag) throw new Error("RELEASE_TAG is required");
  if (!verifiedSha) throw new Error("VERIFIED_SHA is required");
  const confirmed = reconfirmReleaseTag(tag, verifiedSha);
  console.log(`Release tag ${tag} still points at verified ${confirmed} immediately before the irreversible step.`);
}
