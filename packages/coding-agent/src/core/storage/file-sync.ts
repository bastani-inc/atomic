import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { createModuleRequire } from "../../utils/module-require.js";

type DescriptorSync = (fd: number) => Promise<void>;

let plainSync: DescriptorSync | null | undefined;

/**
 * atomic-natives' plain `fsync(2)`, on macOS only, or null where the module or that binding is missing. There Node runs
 * `fcntl(F_FULLFSYNC)` for both `FileHandle.sync()` and `datasync()`, which also flushes the drive's own cache and
 * costs milliseconds a call. SQLite on macOS syncs with plain `fsync(2)` unless `PRAGMA fullfsync` is on, and so does
 * Bun: a file store synced through this makes the same promise as the SQLite store (#6686).
 */
function nativePlainSync(): DescriptorSync | null {
	if (process.platform !== "darwin") return null;
	if (plainSync === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				fsyncDescriptor?: DescriptorSync;
			};
			plainSync = binding.fsyncDescriptor ?? null;
		} catch {
			plainSync = null;
		}
	}
	return plainSync;
}

/**
 * Whether this platform and build sync through atomic-natives' plain `fsync(2)` rather than Node's `FileHandle.sync()`
 * or `datasync()`. True on macOS when the binding is loaded.
 */
export function usesNativePlainSync(): boolean {
	return nativePlainSync() !== null;
}

/**
 * Syncs what was written through `handle` to the drive: its data, and the size that reaches it. On macOS this is plain
 * `fsync(2)`; elsewhere `fdatasync(2)`, or `FlushFileBuffers` on Windows.
 */
export async function syncFile(handle: FileHandle): Promise<void> {
	const sync = nativePlainSync();
	if (sync === null) await handle.datasync();
	else await sync(handle.fd);
}

/**
 * Syncs the file at `path`, reusing `handle` when it can be synced on this platform. On Unix an `O_RDONLY` handle can
 * be synced directly; on Windows `FlushFileBuffers` requires write access, so a non-writable handle is not reused.
 */
export async function syncPath(path: string, handle?: FileHandle, handleWritable = false): Promise<void> {
	if (handle !== undefined && (process.platform !== "win32" || handleWritable)) {
		await syncFile(handle);
		return;
	}
	const opened = await open(path, process.platform === "win32" ? "r+" : "r");
	try {
		await syncFile(opened);
	} finally {
		await opened.close();
	}
}

/**
 * Syncs the directory at `path`, so the names linked, renamed and removed in it last a crash. Windows cannot open a
 * directory as a file to sync it: there NTFS journals the change of name itself.
 */
export async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		const sync = nativePlainSync();
		if (sync === null) await handle.sync();
		else await sync(handle.fd);
	} finally {
		await handle.close();
	}
}
