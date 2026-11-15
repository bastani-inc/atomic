import ignore, { type Ignore } from "ignore";

/**
 * Git drops a line's trailing spaces unless the last one is escaped with a backslash. `ignore` decides whether a
 * pattern is anchored before stripping them, so `build/ ` would otherwise match at the root only.
 */
function trimTrailingSpaces(line: string): string {
	let lastSpace = -1;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === " ") {
			if (lastSpace < 0) lastSpace = index;
			continue;
		}
		if (char === "\\") {
			index++;
			if (index === line.length) return line;
		}
		lastSpace = -1;
	}
	return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

/**
 * The lines of a `.gitignore`-syntax file as Git reads them: without a UTF-8 byte order mark, the carriage return of
 * a CRLF line ending, or unescaped trailing spaces.
 */
export function gitignoreLines(content: string): string[] {
	return content
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.map(trimTrailingSpaces);
}

/** A matcher for one `.gitignore`-syntax file whose rules match as Git matches them. */
export function gitignoreMatcher(content: string, ignoreCase: boolean): Ignore {
	return ignore({ ignorecase: ignoreCase }).add(gitignoreLines(content));
}

/**
 * What `git init` records as `core.ignorecase` on this platform's default filesystem, for rules that do not belong
 * to a repository whose setting could be read.
 */
export const PLATFORM_IGNORE_CASE = process.platform === "win32" || process.platform === "darwin";

interface Level {
	/** The directory holding the rules, relative to the walk root, with a trailing `/` unless it is the root. */
	readonly base: string;
	readonly matcher: Ignore;
}

/**
 * The ignore files met on the way down a directory walk, each scoped to its own directory as Git scopes nested
 * `.gitignore` files: a deeper file's rules take precedence, and nothing inside an ignored directory is included.
 */
export class NestedGitignore {
	private readonly levels: readonly Level[];
	private readonly ignoreCase: boolean;

	private constructor(levels: readonly Level[], ignoreCase: boolean) {
		this.levels = levels;
		this.ignoreCase = ignoreCase;
	}

	static empty(ignoreCase = PLATFORM_IGNORE_CASE): NestedGitignore {
		return new NestedGitignore([], ignoreCase);
	}

	/** These rules plus `contents`, the ignore files of `dir` (relative to the walk root, `""` for the root). */
	within(dir: string, contents: readonly string[]): NestedGitignore {
		if (contents.length === 0) return this;
		const base = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
		const matcher = ignore({ ignorecase: this.ignoreCase });
		for (const content of contents) matcher.add(gitignoreLines(content));
		return new NestedGitignore([...this.levels, { base, matcher }], this.ignoreCase);
	}

	/** Whether `path`, relative to the walk root and ending in `/` for a directory, is ignored. */
	ignores(path: string): boolean {
		const parts = path.split("/");
		const isDirectory = path.endsWith("/");
		if (isDirectory) parts.pop();
		let prefix = "";
		for (let index = 0; index < parts.length; index++) {
			prefix += parts[index];
			const last = index === parts.length - 1;
			if (this.excludesItself(last && !isDirectory ? prefix : `${prefix}/`)) return true;
			prefix += "/";
		}
		return false;
	}

	private excludesItself(path: string): boolean {
		for (let index = this.levels.length - 1; index >= 0; index--) {
			const { base, matcher } = this.levels[index] as Level;
			if (!path.startsWith(base) || path === base) continue;
			const result = matcher.checkIgnore(path.slice(base.length));
			if (result.ignored) return true;
			if (result.unignored) return false;
		}
		return false;
	}
}
