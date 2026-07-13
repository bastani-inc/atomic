import { posix, win32 } from "node:path";

interface SessionFileReport {
	sessionFile?: string;
	sessionFiles?: string[];
}

export function mergeStringArrays(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined {
	const merged = [...(left ?? []), ...(right ?? [])];
	return merged.length === 0 ? undefined : [...new Set(merged)];
}

export function pathApi(value: string): typeof posix | typeof win32 {
	return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") ? win32 : posix;
}

export function normalizedPathKey(path: string): string {
	const api = pathApi(path);
	const normalized = api.normalize(path);
	return api === win32 ? normalized.toLowerCase() : normalized;
}

export function sessionFileAliases(report: SessionFileReport): Set<string> {
	const aliases = [report.sessionFile, ...(report.sessionFiles ?? [])];
	return new Set(aliases.filter((value): value is string => typeof value === "string" && value.length > 0).map(normalizedPathKey));
}

export function sharesSessionFileAlias(left: SessionFileReport, right: SessionFileReport): boolean {
	const aliases = sessionFileAliases(right);
	if (aliases.size === 0) return false;
	for (const alias of sessionFileAliases(left)) {
		if (aliases.has(alias)) return true;
	}
	return false;
}

export function coversAllSessionFileAliases(covering: SessionFileReport, covered: SessionFileReport): boolean {
	const coveringAliases = sessionFileAliases(covering);
	const coveredAliases = sessionFileAliases(covered);
	return coveredAliases.size > 0 && [...coveredAliases].every((alias) => coveringAliases.has(alias));
}
