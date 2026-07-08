import { type FSWatcher, realpathSync, type WatchListener, watch } from "node:fs";

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export const SAFE_FS_WATCH_CANONICALIZATION_FAILED = "ERR_SAFE_FS_WATCH_CANONICALIZATION_FAILED";
export const SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH = "ERR_SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH";

export type SafeFsWatchErrorCode =
	| typeof SAFE_FS_WATCH_CANONICALIZATION_FAILED
	| typeof SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH;

export interface SafeFsWatchPathError extends Error {
	code: SafeFsWatchErrorCode;
	watchedPath: string;
	resolvedPath?: string;
}

export interface NativeWatchPathResult {
	path: string;
}

export interface NativeWatchPathErrorResult {
	error: SafeFsWatchPathError;
}

export type NativeWatchPathResolution = NativeWatchPathResult | NativeWatchPathErrorResult;

export interface SafeFsWatchOptions {
	platform?: NodeJS.Platform;
	realpathSyncNative?: (path: string) => string;
	watch?: (path: string, listener: WatchListener<string>) => FSWatcher;
}

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

function createSafeFsWatchPathError(
	code: SafeFsWatchErrorCode,
	watchedPath: string,
	message: string,
	resolvedPath?: string,
	cause?: Error,
): SafeFsWatchPathError {
	const error = new Error(message, cause ? { cause } : undefined) as SafeFsWatchPathError;
	error.name = "SafeFsWatchPathError";
	error.code = code;
	error.watchedPath = watchedPath;
	if (resolvedPath !== undefined) {
		error.resolvedPath = resolvedPath;
	}
	return error;
}

export function isUnsafeWindowsShortPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32") {
		return false;
	}

	return path
		.split(/[\\/]+/)
		.some((component) => /~\d+(?:\.|$)/i.test(component));
}

export function isSafeFsWatchPathError(error: unknown): error is SafeFsWatchPathError {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = (error as { code?: string }).code;
	return code === SAFE_FS_WATCH_CANONICALIZATION_FAILED || code === SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH;
}

export function resolveNativeWatchPath(path: string, options: SafeFsWatchOptions = {}): NativeWatchPathResolution {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { path };
	}

	const resolvePath = options.realpathSyncNative ?? realpathSync.native;
	let resolvedPath: string;
	try {
		resolvedPath = resolvePath(path);
	} catch (error) {
		return {
			error: createSafeFsWatchPathError(
				SAFE_FS_WATCH_CANONICALIZATION_FAILED,
				path,
				`Cannot canonicalize Windows fs.watch path '${path}'.`,
				undefined,
				error instanceof Error ? error : undefined,
			),
		};
	}

	if (isUnsafeWindowsShortPath(resolvedPath, platform)) {
		return {
			error: createSafeFsWatchPathError(
				SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
				path,
				`Refusing native fs.watch for unsafe Windows short-name path '${resolvedPath}'.`,
				resolvedPath,
			),
		};
	}

	return { path: resolvedPath };
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: (error: Error) => void,
	options: SafeFsWatchOptions = {},
): FSWatcher | null {
	const resolved = resolveNativeWatchPath(path, options);
	if ("error" in resolved) {
		onError(resolved.error);
		return null;
	}

	try {
		const watchPath = options.watch ?? watch;
		const watcher = watchPath(resolved.path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch (error) {
		onError(error instanceof Error ? error : new Error(String(error)));
		return null;
	}
}
