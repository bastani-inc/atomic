// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
/**
 * Storage seam for the hashline patcher. {@link Filesystem} is intentionally
 * minimal — `readText`, `writeText`, `exists` — so any backing store can be
 * adapted: disk, memory, S3, an LSP text-document protocol, a Git tree, a
 * VFS, etc.
 *
 * The patcher does its own BOM stripping and LF normalization between
 * {@link Filesystem.readText} and {@link Filesystem.writeText}; the FS deals
 * only in raw text strings.
 */
import * as pathModule from "node:path";

/**
 * Result returned by {@link Filesystem.writeText}. The patcher echoes back
 * `text` so adapters that transform on serialization (e.g. notebooks) can
 * report what actually landed on disk.
 */
export interface WriteResult {
	/** Final text that was persisted. May differ from the input if the FS transformed it. */
	text: string;
}

/**
 * ENOENT-like error thrown by {@link Filesystem.readText} when a path is
 * missing. Carrying a `code` property keeps the contract compatible with
 * `node:fs` callers that already check `err.code === "ENOENT"`.
 */
export class NotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(path: string, cause?: unknown) {
		super(`File not found: ${path}`);
		this.name = "NotFoundError";
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

/** Type guard for {@link NotFoundError} and structurally-compatible errors. */
export function isNotFound(error: unknown): boolean {
	if (error instanceof NotFoundError) return true;
	if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true;
	return false;
}

/**
 * Abstract storage backend the {@link Patcher} reads from and writes to.
 * Subclass for new backends; the package ships {@link InMemoryFilesystem} and
 * {@link NodeFilesystem} for the most common cases.
 *
 * Implementations work with raw text — the patcher handles BOM stripping and
 * line-ending normalization itself. `readText` MUST throw {@link
 * NotFoundError} (or any error for which {@link isNotFound} returns true)
 * when the path doesn't exist; that's how the patcher detects a create-vs-
 * update.
 */
export abstract class Filesystem {
	/** Read the file's full text content. Throw on missing file. */
	abstract readText(path: string): Promise<string>;

	/** Validate that `path` is writable before a prepared batch starts committing. */
	async preflightWrite(_path: string): Promise<void> {}

	/** Persist `content` at `path`. Returns the actual final text that was written. */
	abstract writeText(path: string, content: string): Promise<WriteResult>;

	/** Return true when the path exists and can be read. Default: probe via {@link readText}. */
	async exists(path: string): Promise<boolean> {
		try {
			await this.readText(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	/**
	 * Canonical path used as a key by external caches (e.g. snapshot
	 * stores). The default is identity; override to return an absolute or
	 * otherwise canonicalised path so producers and consumers of cached
	 * snapshots agree on the key without each having to redo the resolution.
	 */
	canonicalPath(path: string): string {
		return path;
	}
}

/**
 * In-memory {@link Filesystem}. Useful for tests, sandboxes, dry-runs, and as
 * a building block for stacked adapters (e.g. an LRU layer on top).
 */
export class InMemoryFilesystem extends Filesystem {
	#files = new Map<string, string>();

	constructor(initial?: Iterable<readonly [string, string]>) {
		super();
		if (initial) {
			for (const [path, content] of initial) this.#files.set(path, content);
		}
	}

	async readText(path: string): Promise<string> {
		const text = this.#files.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		this.#files.set(path, content);
		return { text: content };
	}

	async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	/** Synchronous helper for setting up fixtures without awaiting. */
	set(path: string, content: string): void {
		this.#files.set(path, content);
	}

	/** Synchronous helper for inspecting state without awaiting. */
	get(path: string): string | undefined {
		return this.#files.get(path);
	}

	/** Remove a single entry. Returns true when something was removed. */
	delete(path: string): boolean {
		return this.#files.delete(path);
	}

	/** Wipe all entries. */
	clear(): void {
		this.#files.clear();
	}

	/** Iterate `[path, content]` pairs. */
	entries(): IterableIterator<[string, string]> {
		return this.#files.entries();
	}
}

/**
 * Disk-backed {@link Filesystem} using Bun's file APIs. The default for CLI
 * use. Paths are accepted as-is; callers responsible for any cwd or
 * jail/sandbox resolution should wrap this with their own subclass.
 */
export class NodeFilesystem extends Filesystem {
	async readText(path: string): Promise<string> {
		if (!existsSync(path)) throw new NotFoundError(path);
		return readFile(path, "utf8");
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		await writeFile(path, content, "utf8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return pathModule.resolve(path);
	}

	async exists(path: string): Promise<boolean> {
		return existsSync(path);
	}
}
