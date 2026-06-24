import type { TruncationResult } from "./truncate.ts";

export interface SearchToolDetails {
	scopePath?: string;
	searchPath?: string;
	cwd?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Record<string, number>;
	missingPaths?: string[];
	displayContent?: string;
	fileLimitReached?: boolean;
	perFileLimitReached?: boolean;
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	meta?: { source?: string; truncation?: TruncationResult; limits?: { fileLimit?: number } };
}

export function buildSearchDetails(base: SearchToolDetails | undefined, text: string, cwd: string, scopePath: string, missingPaths: string[] = []): SearchToolDetails {
	const files = new Set<string>(), fileMatches: Record<string, number> = {}; let currentPath = "", matchCount = 0;
	for (const line of text.split("\n")) {
		const header = line.match(/^\[([^\]#]+)#[0-9A-F]{4}\]$/); if (header) { currentPath = header[1] ?? ""; files.add(currentPath); continue; }
		const pathMatch = line.match(/^(.+?)(?::\d+: |-\d+- )/); if (pathMatch) { currentPath = pathMatch[1] ?? currentPath; files.add(currentPath); }
		const isMatch = /^\*\d+:/.test(line) || /^.+?:\d+: /.test(line); if (isMatch && currentPath) { matchCount++; fileMatches[currentPath] = (fileMatches[currentPath] ?? 0) + 1; }
	}
	return { ...(base ?? {}), scopePath, searchPath: scopePath, cwd, matchCount, fileCount: files.size, files: [...files], fileMatches, ...(missingPaths.length ? { missingPaths } : {}), displayContent: text, meta: { ...(base?.meta ?? {}), source: scopePath, ...(base?.truncation ? { truncation: base.truncation } : {}) } };
}
