/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js (development, npm run build)
 * 2. Bun compiled binaries (standalone distribution)
 *
 * The challenge: photon-node's CJS entry uses fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * which bakes the build machine's absolute path into Bun compiled binaries.
 *
 * Solution:
 * 1. Preload photon_rs_bg.wasm asynchronously via fs/promises before importing photon-node
 * 2. Patch fs.readFileSync to serve the preloaded WASM bytes from memory
 * 3. Copy photon_rs_bg.wasm next to the executable in build:binary
 */

import type { PathOrFileDescriptor } from "fs";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const requireFromHere = createRequire(import.meta.url);
const fs = requireFromHere("fs") as { readFileSync: (...args: unknown[]) => unknown };
const unpatchedReadFile: (...args: unknown[]) => unknown = fs.readFileSync.bind(fs);

// Re-export types from the main package
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(execDir, WASM_FILENAME),
		path.join(execDir, "photon", WASM_FILENAME),
		path.join(process.cwd(), WASM_FILENAME),
	];
}

function getCandidateWasmPaths(): string[] {
	const candidates: string[] = [];
	try {
		const entryPath = requireFromHere.resolve("@silvia-odwyer/photon-node");
		candidates.push(path.join(path.dirname(entryPath), WASM_FILENAME));
	} catch {}
	candidates.push(...getFallbackWasmPaths());
	return candidates;
}

async function readPhotonWasmBytes(): Promise<Buffer | null> {
	for (const candidate of getCandidateWasmPaths()) {
		try {
			return await readFile(candidate);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code && err.code !== "ENOENT") {
				throw error;
			}
		}
	}
	return null;
}

function formatWasmReadResult(bytes: Buffer, options: unknown): Buffer | string {
	if (typeof options === "string") {
		return bytes.toString(options as BufferEncoding);
	}
	if (typeof options === "object" && options !== null && "encoding" in options) {
		const encoding = (options as { encoding?: BufferEncoding | null }).encoding;
		if (encoding) {
			return bytes.toString(encoding);
		}
	}
	return bytes;
}

function installPhotonWasmRead(wasmBytes: Buffer | null): () => void {
	const interceptedReadFile = (...args: unknown[]): unknown => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file as PathOrFileDescriptor);

		if (resolvedPath?.endsWith(WASM_FILENAME) && wasmBytes !== null) {
			return formatWasmReadResult(wasmBytes, options);
		}

		return unpatchedReadFile(...args);
	};

	try {
		fs.readFileSync = interceptedReadFile;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: interceptedReadFile,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			fs.readFileSync = unpatchedReadFile;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: unpatchedReadFile,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		try {
			const wasmBytes = await readPhotonWasmBytes();
			const restoreWasmRead = installPhotonWasmRead(wasmBytes);
			try {
				photonModule = await import("@silvia-odwyer/photon-node");
				return photonModule;
			} finally {
				restoreWasmRead();
			}
		} catch {
			photonModule = null;
			return photonModule;
		}
	})();

	return loadPromise;
}
