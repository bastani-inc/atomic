import { execFileSync } from "node:child_process";

export const minimumGhVersion = "2.87.0";

export type GhVersionCheck =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly summary: string };

function versionParts(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function checkGhVersion(output: string): GhVersionCheck {
  const match = /^gh version (\d+\.\d+\.\d+)\b/mu.exec(output);
  const version = match?.[1];
  if (version === undefined) {
    return { ok: false, summary: `Unable to parse gh version; publish-release requires gh >= ${minimumGhVersion}.` };
  }
  const actual = versionParts(version);
  const minimum = versionParts(minimumGhVersion) as readonly [number, number, number];
  if (actual === undefined) {
    return { ok: false, summary: `Unable to parse gh version; publish-release requires gh >= ${minimumGhVersion}.` };
  }
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = actual[index] as number;
    const minimumPart = minimum[index] as number;
    if (actualPart > minimumPart) return { ok: true, version };
    if (actualPart < minimumPart) {
      return { ok: false, summary: `gh ${version} is too old; publish-release requires gh >= ${minimumGhVersion}.` };
    }
  }
  return { ok: true, version };
}

export function detectGhVersion(): GhVersionCheck {
  try {
    return checkGhVersion(execFileSync("gh", ["--version"], { encoding: "utf8" }));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: `Unable to execute gh --version; publish-release requires gh >= ${minimumGhVersion}. ${details}` };
  }
}
