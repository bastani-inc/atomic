import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import nativePath, { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export type PathStyle = "posix" | "windows";

export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to the live home environment or `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
	/** Path syntax to apply, independent of the control machine. Defaults to native syntax. */
	pathStyle?: PathStyle;
}

export function getHomeDir(): string {
	if (process.platform === "win32") {
		if (process.env.USERPROFILE) return process.env.USERPROFILE;
		if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
		if (process.env.HOME) return process.env.HOME;
		return homedir();
	}
	return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a remote URL protocol. Bare names, relative paths, and file: URLs
 * are considered local.
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// Known non-local prefixes. file: URLs are local paths and are intentionally resolved by resolvePath().
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

function pathApi(style: PathStyle | undefined): typeof posix | typeof win32 {
	if (style === "windows") return win32;
	if (style === "posix") return posix;
	return nativePath;
}

function decodeFileUrlPath(value: string, style: PathStyle | undefined): string {
	if (style === undefined) return fileURLToPath(value);
	const url = new URL(value);
	if (/%2f|%5c/iu.test(url.pathname)) throw new TypeError("File URL path must not include encoded path separators");
	const pathname = decodeURIComponent(url.pathname);
	const host = url.hostname === "localhost" ? "" : decodeURIComponent(url.hostname);
	if (style === "posix") {
		if (host) throw new TypeError("POSIX file URL host must be empty or localhost");
		return pathname;
	}
	if (host) return `\\\\${host}${pathname.replaceAll("/", "\\")}`;
	if (!/^\/[A-Za-z]:\//u.test(pathname)) throw new TypeError("Windows file URL path must include a drive letter");
	return pathname.slice(1).replaceAll("/", "\\");
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	const paths = pathApi(options.pathStyle);
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (paths === win32) {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? getHomeDir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (paths === win32 && normalized.startsWith("~\\"))) {
			return paths.join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return decodeFileUrlPath(normalized, options.pathStyle);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const paths = pathApi(options.pathStyle);
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir, { pathStyle: options.pathStyle, expandTilde: false });
	return paths.isAbsolute(normalized) ? paths.resolve(normalized) : paths.resolve(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const paths = pathApi(undefined);
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = paths.relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}
export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).replaceAll("\\", "/");
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
