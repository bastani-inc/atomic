import { type FSWatcher, realpathSync, type WatchListener, watch } from "node:fs";
import { realpath } from "node:fs/promises";

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
	realpathNative?: (path: string) => Promise<string>;
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

	return path.split(/[\\/]+/).some((component) => /~\d+(?:\.|$)/i.test(component));
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
		return canonicalizationFailed(path, error);
	}
	return checkedWindowsWatchPath(path, resolvedPath, platform);
}

/** {@link resolveNativeWatchPath} without blocking the event loop while the path is canonicalized. */
export async function resolveNativeWatchPathAsync(
	path: string,
	options: SafeFsWatchOptions = {},
): Promise<NativeWatchPathResolution> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { path };
	}

	const resolvePath = options.realpathNative ?? realpath;
	let resolvedPath: string;
	try {
		resolvedPath = await resolvePath(path);
	} catch (error) {
		return canonicalizationFailed(path, error);
	}
	return checkedWindowsWatchPath(path, resolvedPath, platform);
}

function canonicalizationFailed(path: string, error: unknown): NativeWatchPathErrorResult {
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

function checkedWindowsWatchPath(
	path: string,
	resolvedPath: string,
	platform: NodeJS.Platform,
): NativeWatchPathResolution {
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
	return watchResolvedPath(resolveNativeWatchPath(path, options), listener, onError, options);
}

/** {@link watchWithErrorHandler} without blocking the event loop while the path is canonicalized. */
export function watchWithErrorHandlerAsync(
	path: string,
	listener: WatchListener<string>,
	onError: (error: Error) => void,
	options: SafeFsWatchOptions = {},
): Promise<FSWatcher | null> {
	if ((options.platform ?? process.platform) !== "win32")
		return Promise.resolve(watchResolvedPath({ path }, listener, onError, options));
	return resolveNativeWatchPathAsync(path, options).then((resolved) =>
		watchResolvedPath(resolved, listener, onError, options),
	);
}

function watchResolvedPath(
	resolved: NativeWatchPathResolution,
	listener: WatchListener<string>,
	onError: (error: Error) => void,
	options: SafeFsWatchOptions,
): FSWatcher | null {
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
