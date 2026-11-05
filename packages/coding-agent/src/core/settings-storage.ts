import { randomUUID } from "crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, sep } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseJsonFileContent } from "../utils/json.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { normalizeAzureSettings } from "./azure-provider-compat.js";
import { deepMergeSettings } from "./settings-merge.js";
import type { Settings, SettingsFieldOrigin, SettingsScope, SettingsStorage } from "./settings-types.ts";

/** Windows refuses to replace a file another process has open for a moment; rename again before giving up. */
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 20;

/**
 * Rename `from` over `to`. On Windows, a rename that another process's open handle blocks (EPERM, EACCES, EBUSY) is
 * retried up to ten times, 20 ms apart; elsewhere, and for any other error, it throws at once.
 */
export function renameReplacing(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
	rename: (from: string, to: string) => void = renameSync,
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (platform !== "win32" || attempt === RENAME_ATTEMPTS || !["EPERM", "EACCES", "EBUSY"].includes(code)) {
				throw error;
			}
			const start = Date.now();
			while (Date.now() - start < RENAME_RETRY_MS) {
				// Sleep synchronously, as the settings lock does, so callers stay synchronous.
			}
		}
	}
}

/** A rename that cannot replace the file at all: it is a mount point (EBUSY), or on another device (EXDEV). */
const UNREPLACEABLE_FILE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EXDEV"]);

/** How {@link writeSettingsFile} wrote a file: `replaced` whole, or `in-place` because the file cannot be replaced. */
export type SettingsFileWrite =
	| { readonly mode: "replaced" }
	| { readonly mode: "in-place"; readonly reason: NodeJS.ErrnoException };

const inPlaceWrites = new Map<string, NodeJS.ErrnoException>();

/** The settings files this process wrote in place, each with the rename failure that first required it. */
export function settingsFilesWrittenInPlace(): ReadonlyMap<string, NodeJS.ErrnoException> {
	return inPlaceWrites;
}

/** How many symbolic links a settings path may pass through, as the Linux kernel allows. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The file a settings path names: its real path, or, when the file does not exist yet, the end of its symbolic link
 * chain, each link resolved against its own directory. A cycle or an overlong chain throws `ELOOP`, as writing through
 * the link would.
 */
function settingsFileTarget(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	let current = path;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
		if (!lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
		const link = readlinkSync(current);
		// Joined without normalizing, so a linked directory resolves before `..` as writing through the link would.
		current = isAbsolute(link) ? link : `${dirname(current)}${sep}${link}`;
	}
	throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, write '${path}'`), {
		code: "ELOOP",
		path,
	});
}

/**
 * Replace a settings file so readers and a killed or out-of-space writer only ever leave the old or the new content:
 * write a sibling temporary file with the same mode, then rename it over the file. A symbolic link stays a link; its
 * target is replaced, or created when it does not exist yet. A file that cannot be replaced, such as a single file
 * mounted into a container, is written in place instead, under the caller's lock; that fallback is returned and
 * recorded in {@link settingsFilesWrittenInPlace}.
 */
export function writeSettingsFile(path: string, content: string): SettingsFileWrite {
	const target = settingsFileTarget(path);
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf-8", ...(mode === undefined ? {} : { mode }) });
		if (mode !== undefined) chmodSync(temporary, mode);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	try {
		renameReplacing(temporary, target);
		return { mode: "replaced" };
	} catch (error) {
		rmSync(temporary, { force: true });
		const reason = error as NodeJS.ErrnoException;
		if (!UNREPLACEABLE_FILE_CODES.has(reason.code ?? "")) throw error;
		writeFileSync(target, content, "utf-8");
		if (!inPlaceWrites.has(target)) inPlaceWrites.set(target, reason);
		return { mode: "in-place", reason };
	}
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private globalReadPaths: string[];
	private projectReadPaths: string[];

	constructor(cwd: string, agentDir: string, options?: { globalReadPaths?: string[]; projectReadPaths?: string[] }) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
		this.globalReadPaths = (options?.globalReadPaths ?? [this.globalSettingsPath]).map((path) => normalizePath(path));
		this.projectReadPaths = (options?.projectReadPaths ?? [this.projectSettingsPath]).map((path) =>
			normalizePath(path),
		);
	}

	getFieldOrigin(scope: SettingsScope, field: keyof Settings): SettingsFieldOrigin | undefined {
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		for (const [index, readPath] of readPaths.entries()) {
			if (!existsSync(readPath)) continue;
			try {
				const parsed = parseJsonFileContent(readFileSync(readPath, "utf-8")) as Settings;
				if (Object.hasOwn(parsed, field)) {
					return index === 0 ? "primary" : "legacy";
				}
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	private readMergedSettings(readPaths: string[]): string | undefined {
		let merged: Settings = {};
		let found = false;
		for (let i = readPaths.length - 1; i >= 0; i--) {
			const readPath = readPaths[i]!;
			if (!existsSync(readPath)) continue;
			try {
				const parsed = parseJsonFileContent(readFileSync(readPath, "utf-8")) as Settings;
				merged = deepMergeSettings(merged, normalizeAzureSettings(parsed));
				found = true;
			} catch (error) {
				if (error instanceof Error) (error as Error & { path?: string }).path = readPath;
				throw error;
			}
		}
		return found ? JSON.stringify(merged, null, 2) : undefined;
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if the primary file exists or we need to write.
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = this.readMergedSettings(readPaths);
			const next = fn(current);

			if (next !== undefined) {
				// Only create directory when we actually need to write.
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					if (!existsSync(path)) writeFileSync(path, "{}", "utf-8");
					release = this.acquireLockSyncWithRetry(path);
				}
				writeSettingsFile(path, next);
			}
		} finally {
			if (release) {
				release();
			}
		}
	}

	withPrimaryWriteLock(scope: SettingsScope, fn: (currentPrimary: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const release = this.acquireLockSyncWithRetry(path);
		try {
			const currentPrimary = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			const next = fn(currentPrimary);
			if (next !== undefined) {
				writeSettingsFile(path, next);
			}
		} finally {
			release();
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}

	getFieldOrigin(scope: SettingsScope, field: keyof Settings): SettingsFieldOrigin | undefined {
		const raw = scope === "global" ? this.global : this.project;
		const settings = JSON.parse(raw ?? "{}") as Settings;
		return Object.hasOwn(settings, field) ? "primary" : undefined;
	}
}
