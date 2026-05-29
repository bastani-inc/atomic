const SAFE_GIT_REF_INPUT_PATTERN = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

export function normalizeGitRefInput(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return SAFE_GIT_REF_INPUT_PATTERN.test(trimmed) ? trimmed : fallback;
}
