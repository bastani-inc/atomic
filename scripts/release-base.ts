const FULL_SHA_RE = /^[0-9a-f]{40}$/u;
const SAFE_BRANCH_CHARS_RE = /^[A-Za-z0-9._/-]+$/u;

export interface ReleaseBaseMetadata {
  readonly baseRef: string;
  readonly baseSha: string;
}

function invalidBranch(ref: string): never {
  throw new Error(`Release base "${ref}" is not a canonical remote branch name suitable for publication.`);
}

function validateBranchName(branch: string, original: string): void {
  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    !SAFE_BRANCH_CHARS_RE.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{")
  ) {
    invalidBranch(original);
  }
  for (const component of branch.split("/")) {
    if (component.startsWith(".") || component.endsWith(".lock")) invalidBranch(original);
  }
}

export function canonicalReleaseBaseRef(branch: string): string {
  validateBranchName(branch, branch);
  if (branch.startsWith("refs/") || branch.startsWith("origin/")) invalidBranch(branch);
  return `refs/heads/${branch}`;
}

export function validateCanonicalReleaseBaseRef(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`Release base ref "${ref}" is not a canonical refs/heads branch ref.`);
  }
  const branch = ref.slice(prefix.length);
  try {
    validateBranchName(branch, ref);
  } catch {
    throw new Error(`Release base ref "${ref}" is not a canonical refs/heads branch ref.`);
  }
  return ref;
}

export function parseReleaseBaseTrailers(message: string): ReleaseBaseMetadata {
  const lines = message.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  const paragraph: string[] = [];
  while (lines.length > 0 && lines.at(-1) !== "") paragraph.unshift(lines.pop() as string);

  const refs: string[] = [];
  const shas: string[] = [];
  for (const line of paragraph) {
    if (line.startsWith("Release-base-ref:") && !line.startsWith("Release-base-ref: ")) {
      throw new Error("Release base trailer metadata contains a malformed Release-base-ref trailer.");
    }
    if (line.startsWith("Release-base-sha:") && !line.startsWith("Release-base-sha: ")) {
      throw new Error("Release base trailer metadata contains a malformed Release-base-sha trailer.");
    }
    if (line.startsWith("Release-base-ref: ")) refs.push(line.slice("Release-base-ref: ".length));
    if (line.startsWith("Release-base-sha: ")) shas.push(line.slice("Release-base-sha: ".length));
  }
  if (refs.length !== 1 || shas.length !== 1) {
    throw new Error("Release base trailer metadata must contain exactly one Release-base-ref and Release-base-sha.");
  }
  let baseRef: string;
  try {
    baseRef = validateCanonicalReleaseBaseRef(refs[0] as string);
  } catch {
    throw new Error("Release base trailer metadata contains an invalid canonical release base ref.");
  }
  const baseSha = shas[0] as string;
  if (!FULL_SHA_RE.test(baseSha)) {
    throw new Error("Release base trailer metadata contains an invalid full lowercase base SHA.");
  }
  return { baseRef, baseSha };
}

export function verifyReleaseBaseMetadata(
  message: string,
  releaseParent: string,
  expectedBaseRef: string,
  expectedBaseSha: string,
): ReleaseBaseMetadata {
  validateCanonicalReleaseBaseRef(expectedBaseRef);
  if (!FULL_SHA_RE.test(expectedBaseSha)) {
    throw new Error("Expected release base SHA must be a full lowercase commit SHA.");
  }
  if (!FULL_SHA_RE.test(releaseParent)) {
    throw new Error("Release parent must be a full lowercase commit SHA.");
  }
  const metadata = parseReleaseBaseTrailers(message);
  if (metadata.baseRef !== expectedBaseRef) {
    throw new Error(`Release trailer base ref ${metadata.baseRef} does not match expected ${expectedBaseRef}.`);
  }
  if (metadata.baseSha !== expectedBaseSha) {
    throw new Error(`Release trailer base SHA ${metadata.baseSha} does not match expected ${expectedBaseSha}.`);
  }
  if (releaseParent !== expectedBaseSha) {
    throw new Error(`Release parent ${releaseParent} does not match expected base SHA ${expectedBaseSha}.`);
  }
  return metadata;
}
