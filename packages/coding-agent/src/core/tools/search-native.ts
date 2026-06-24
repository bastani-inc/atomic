import { createRequire } from "node:module";

type NativeBinding = {
	glob: (options: NativeGlobOptions) => Promise<NativeGlobResult>;
	grep: (options: NativeGrepOptions) => Promise<NativeGrepResult>;
	search?: (content: string | Uint8Array, options: NativeTextSearchOptions) => NativeTextSearchResult;
	hasMatch?: (content: string | Uint8Array, pattern: string | Uint8Array, ignoreCase?: boolean | null, multiline?: boolean | null) => boolean;
	invalidateFsScanCache?: (path?: string | null) => void;
	blockRangeAt?: (options: { code: string; path: string; line: number }) => { startLine: number; endLine: number } | null;
};

export type NativeGlobMatch = {
	path: string;
	fileType: "File" | "Dir" | "Symlink" | number;
	mtime?: number;
	size?: number;
};

export type NativeGlobOptions = {
	pattern: string;
	path: string;
	fileType?: "File" | "Dir" | "Symlink" | number;
	recursive?: boolean;
	hidden?: boolean;
	maxResults?: number;
	gitignore?: boolean;
	cache?: boolean;
	sortByMtime?: boolean;
	includeNodeModules?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type NativeGlobResult = {
	matches: NativeGlobMatch[];
	totalMatches: number;
};

export type NativeGrepMatch = {
	path: string;
	lineNumber: number;
	line: string;
	contextBefore?: Array<{ lineNumber: number; line: string }>;
	contextAfter?: Array<{ lineNumber: number; line: string }>;
	truncated?: boolean;
	matchCount?: number;
};

export type NativeGrepOptions = {
	pattern: string;
	path: string;
	cwd?: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	hidden?: boolean;
	gitignore?: boolean;
	cache?: boolean;
	maxCount?: number;
	offset?: number;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
	maxColumns?: number;
	mode?: "content" | "count" | "filesWithMatches";
	maxCountPerFile?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type NativeGrepResult = {
	matches: NativeGrepMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached: boolean;
	skippedOversized?: number;
	error?: string;
};
export type NativeTextSearchOptions = Omit<NativeGrepOptions, "path" | "cwd" | "glob" | "type" | "hidden" | "gitignore" | "cache" | "maxCountPerFile" | "signal" | "timeoutMs">;
export type NativeTextSearchResult = { matches: Array<Omit<NativeGrepMatch, "path">>; matchCount: number; limitReached: boolean; error?: string };

let cachedLoadResult: NativeBinding | null | false = null;

export function resetNativeSearchBindingCache(): void {
	cachedLoadResult = null;
}

export function loadNativeSearchBinding(): NativeBinding | null {
	if (cachedLoadResult !== null) return cachedLoadResult || null;
	try {
		const require = createRequire(import.meta.url);
		const binding = require("@bastani/atomic-natives") as Partial<NativeBinding>;
		if (typeof binding.glob !== "function" || typeof binding.grep !== "function") {
			cachedLoadResult = false;
			return null;
		}
		cachedLoadResult = binding as NativeBinding;
		return cachedLoadResult;
	} catch {
		cachedLoadResult = false;
		return null;
	}
}

export function invalidateNativeSearchCache(_path?: string): void {
	loadNativeSearchBinding()?.invalidateFsScanCache?.(null);
}
