// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag is a content-derived hash of the *whole file* (see
 * {@link computeFileHash}). Any read of byte-identical content mints the same
 * tag, so reads of one file state fuse onto one anchor and a follow-up edit
 * anchored at any line validates whenever the live file still hashes to it.
 *
 * Producers (typically `read` / `search` / `write` tools) call
 * {@link SnapshotStore.record} with the full normalized text they observed.
 * The store hashes it, dedups against the per-path history, and returns the
 * tag. Consumers (the patcher) resolve an unambiguous stale tag back to the
 * recorded full text via {@link SnapshotStore.byHash} and 3-way-merge the
 * would-be edit onto the live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default backed by `lru-cache`: a bounded set of paths, each with a
 * short history of full-file versions so in-session edit chains can still
 * recover against the version a stale tag names.
 */
import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format.js";

/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
	/** Canonical path this version belongs to. */
	readonly path: string;
	/** Full normalized (LF, no BOM) file text as observed. */
	readonly text: string;
	/** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
	readonly hash: string;
	/** Timestamp (ms since epoch) the version was recorded. */
	recordedAt: number;
}

/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * specific historical version a section's stale tag names.
 */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Recorded unambiguous version for `path` whose tag equals `hash`, or `null`. */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/** Recorded version for `path` whose tag and full text both match, or `null`. */
	byHashAndText(path: string, hash: string, text: string): Snapshot | null {
		const snapshot = this.byHash(path, hash);
		return snapshot?.text === text ? snapshot : null;
	}

	/** Record the full normalized text of `path` and return its content tag. */
	abstract record(path: string, fullText: string): string;

	/** Drop the version history for a single path. */
	abstract invalidate(path: string): void;

	/** Drop every version history. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text across all paths (UTF-16 code units). */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
	maxVersionsPerPath?: number;
	/**
	 * Global ceiling on retained snapshot text summed across every path's
	 * version history, measured in UTF-16 code units (default 64 MiB).
	 * Least-recently-used path histories are evicted to stay under it.
	 */
	maxTotalBytes?: number;
}

/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path history is a
 * short ring of full-file versions (oldest dropped first); per-session path
 * tracking is LRU-bounded so cold paths age out automatically.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions: LRUCache<string, Snapshot[]>;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#versions = new LRUCache<string, Snapshot[]>({
			max: options.maxPaths ?? DEFAULT_MAX_PATHS,
			maxSize: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			sizeCalculation: history => {
				let total = 1;
				for (const version of history) total += version.text.length;
				return total;
			},
		});
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const matches = this.#versions.get(path)?.filter(version => version.hash === hash) ?? [];
		// A 4-hex tag can collide. Recovery only proceeds when the tag maps to a
		// single retained snapshot; otherwise the caller must re-read.
		return matches.length === 1 ? matches[0]! : null;
	}

	override byHashAndText(path: string, hash: string, text: string): Snapshot | null {
		return this.#versions.get(path)?.find(version => version.hash === hash && version.text === text) ?? null;
	}

	record(path: string, fullText: string): string {
		const hash = computeFileHash(fullText);
		// `get` refreshes LRU recency for `path`.
		const history = this.#versions.get(path) ?? [];
		const existing = history.find(version => version.hash === hash && version.text === fullText);
		if (existing) {
			// Same content state observed again: refresh recency and promote to
			// head (it is the current file content), then reuse the tag. Hash
			// collisions with different text must be retained as distinct
			// snapshots; the 4-hex tag is only a lookup key, not proof of identity.
			existing.recordedAt = Date.now();
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(version => version !== existing)]);
			}
			return hash;
		}

		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		return hash;
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	clear(): void {
		this.#versions.clear();
	}
}
