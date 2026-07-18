export type ReleaseKind = "release" | "prerelease";

export type ValidatedRelease = {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
};

export const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const prereleaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.[1-9]\d*$/u;

export function validateReleaseRequest(kind: ReleaseKind, version: string): ValidatedRelease {
  if (version.startsWith("v")) {
    throw new Error(`target_version must not include a leading "v"; received ${version}`);
  }

  const matches = kind === "release"
    ? releaseVersionPattern.test(version)
    : prereleaseVersionPattern.test(version);
  if (!matches || version === "0.0.0") {
    const expected = kind === "release"
      ? "MAJOR.MINOR.PATCH"
      : "MAJOR.MINOR.PATCH-alpha.REVISION";
    throw new Error(`target_version ${JSON.stringify(version)} is not valid for ${kind}; expected ${expected}`);
  }

  return { kind, version, branch: `${kind}/${version}` };
}
