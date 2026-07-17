export type ReleaseKind = "release" | "prerelease";

export type ValidatedRelease = {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
};

export const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const prereleaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.[1-9]\d*$/u;

export function validateReleaseRequest(kind: ReleaseKind, version: string): ValidatedRelease {
  if (version.startsWith("v")) {
    throw new Error(`target_version must not include a leading "v"; received ${version}`);
  }

  const matches = kind === "release"
    ? stableVersionPattern.test(version)
    : prereleaseVersionPattern.test(version);
  if (!matches || version === "0.0.0") {
    const expected = kind === "release"
      ? "MAJOR.MINOR.PATCH"
      : "MAJOR.MINOR.PATCH-alpha.REVISION";
    throw new Error(`target_version ${JSON.stringify(version)} is not valid for ${kind}; expected ${expected}`);
  }

  return { kind, version, branch: `${kind}/${version}` };
}


export function releaseFacts(release: ValidatedRelease, baseRef: string): string {
  return [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Release branch: ${release.branch}`,
    `Protected release base: ${baseRef}`,
    "The release base is versionless: package manifests, bun.lock, Cargo files, and generated version files must remain at 0.0.0.",
    "Only scripts/cut-release.ts may materialize the real version, on the detached Release commit after the changelog PR merges.",
    "Use Bun for development commands. npm is allowed only inside the protected GitHub publisher for OIDC publication.",
    "Never use gh --watch, sleep, timeouts, polling loops, force pushes, force tags, or duplicate release workflow launches.",
  ].join("\n");
}
