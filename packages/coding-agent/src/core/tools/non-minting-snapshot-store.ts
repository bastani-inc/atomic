import { computeFileHash, type Snapshot, SnapshotStore } from "./hashline-engine/index.ts";

/**
 * {@link SnapshotStore} decorator that answers every read from the session's real store but
 * never persists anything through {@link NonMintingSnapshotStore.record}.
 *
 * It exists because building a hashline rejection mints provenance. `Patcher`'s mismatch path
 * records the live file into the snapshot store before constructing the error, then hands the
 * model that tag as `actualFileHash`. An identical retry quoting that tag validates, because
 * the tag now names content the store has seen, even though the model never re-read the file.
 * The rejection issues the credential that defeats it.
 *
 * The engine is vendored and must not be edited, so the fix is injected at the single
 * `new Patcher(...)` construction site instead. That is safe because every record the patcher
 * would make is either unreachable or redundant when it is driven by the edit tool:
 *
 * - `commit()`'s no-op branch never runs. `edit.ts` filters no-op sections and returns before
 *   `apply` is ever called.
 * - `commit()`'s post-write record is duplicated by `recordHashlineSnapshot` in `edit.ts`,
 *   which is also what populates the display-header map the patcher bypasses. That call stays
 *   the single writer of provenance.
 * - The mismatch record is the bug.
 *
 * Reads delegate, so `Recovery` still resolves stale tags against the real per-session history
 * and in-session drift recovery is unchanged.
 *
 * @see https://github.com/bastani-inc/atomic/issues/2329
 */
export class NonMintingSnapshotStore extends SnapshotStore {
	readonly #inner: SnapshotStore;

	constructor(inner: SnapshotStore) {
		super();
		this.#inner = inner;
	}

	head(path: string): Snapshot | null {
		return this.#inner.head(path);
	}

	byHash(path: string, hash: string): Snapshot | null {
		return this.#inner.byHash(path, hash);
	}

	/**
	 * Delegated rather than inherited. The base implementation is derived from
	 * {@link SnapshotStore.byHash}, but `InMemorySnapshotStore` overrides it with different
	 * hash-collision semantics, and a decorator must present whichever the wrapped store
	 * actually implements.
	 */
	override byHashAndText(path: string, hash: string, text: string): Snapshot | null {
		return this.#inner.byHashAndText(path, hash, text);
	}

	/**
	 * Returns the tag the content would receive without retaining it, so a tag quoted back in
	 * an error never becomes valid provenance. Callers that legitimately need to record a
	 * snapshot do so against the session store directly.
	 */
	record(_path: string, fullText: string): string {
		return computeFileHash(fullText);
	}

	invalidate(path: string): void {
		this.#inner.invalidate(path);
	}

	clear(): void {
		this.#inner.clear();
	}
}
