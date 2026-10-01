import { basename, dirname, relative, sep } from "node:path";
import { minimatch } from "minimatch";

export function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

export function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

export function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

export function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

export function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

export function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

export function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

interface PatternMatcher {
	matches(item: string, patterns: string[]): boolean;
	matchesExact(item: string, patterns: string[]): boolean;
}

function pathMatcher(baseDir: string): PatternMatcher {
	return {
		matches: (filePath, patterns) => matchesAnyPattern(filePath, patterns, baseDir),
		matchesExact: (filePath, patterns) => matchesAnyExactPattern(filePath, patterns, baseDir),
	};
}

const nameMatcher: PatternMatcher = {
	matches: (name, patterns) => patterns.some((pattern) => minimatch(name, pattern)),
	matchesExact: (name, patterns) => patterns.includes(name),
};

function selectByPatterns(items: string[], patterns: string[], matcher: PatternMatcher): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	let result: string[];
	if (includes.length === 0) {
		result = [...items];
	} else {
		result = items.filter((item) => matcher.matches(item, includes));
	}
	if (excludes.length > 0) {
		result = result.filter((item) => !matcher.matches(item, excludes));
	}
	if (forceIncludes.length > 0) {
		for (const item of items) {
			if (!result.includes(item) && matcher.matchesExact(item, forceIncludes)) {
				result.push(item);
			}
		}
	}
	if (forceExcludes.length > 0) {
		result = result.filter((item) => !matcher.matchesExact(item, forceExcludes));
	}

	return new Set(result);
}

function selectExplicitPatterns(items: string[], patterns: string[], matcher: PatternMatcher): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const prefixed = pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!");
		const target = prefixed ? pattern.slice(1) : pattern;
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const item of items) {
			if (exact ? matcher.matchesExact(item, [target]) : matcher.matches(item, [target])) {
				result.set(item, enabled);
			}
		}
	}
	return result;
}

export function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	return selectByPatterns(allPaths, patterns, pathMatcher(baseDir));
}

export function applyAutoloadDisabledPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Map<string, boolean> {
	return selectExplicitPatterns(allPaths, patterns, pathMatcher(baseDir));
}

/** `applyPatterns` for named resources such as MCP servers: globs match the name, `+`/`-` match it exactly. */
export function applyNamePatterns(names: string[], patterns: string[]): Set<string> {
	return selectByPatterns(names, patterns, nameMatcher);
}

/** `applyAutoloadDisabledPatterns` for named resources. */
export function applyAutoloadDisabledNamePatterns(names: string[], patterns: string[]): Map<string, boolean> {
	return selectExplicitPatterns(names, patterns, nameMatcher);
}
