/**
 * CI detection follows the convention CI providers actually use: the variable
 * is SET AND NONEMPTY, with any value. GitHub Actions sets `CI=true`, but
 * other providers and users export arbitrary values (`CI=github-actions`,
 * `CI=circleci`); an allowlist of truthy spellings let those reach the
 * alternate screen and write escape sequences into CI logs (Greptile P1 on
 * PR #2308). Only explicit opt-outs (`0`, `false`, empty) read as not-CI.
 */
function isCiEnvironment(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Whether the interactive session draws on the alternate screen: never for `TERM=dumb`; for a terminal a caller
 * injected, always; otherwise only with a terminal on both ends outside CI.
 */
export function shouldUseFullscreenTui(usesInjectedTerminal: boolean): boolean {
	if (process.env.TERM?.toLowerCase() === "dumb") return false;
	if (usesInjectedTerminal) return true;
	return process.stdin.isTTY === true && process.stdout.isTTY === true && !isCiEnvironment(process.env.CI);
}
