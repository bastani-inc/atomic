/**
 * Coalesce in-flight hashline `edit` calls that target the same snapshot.
 *
 * Models often emit several parallel `edit` calls against one `[path#TAG]`.
 * Those hunks were authored against the original snapshot, so they must apply
 * as one batch — the same merge `Patch.parse` already does inside a single
 * call. The first writer to hold the file mutation lock absorbs every
 * compatible sibling that has already announced and applies them together.
 */
export function parallelEditBatchWarning(count: number): string {
	return `Applied ${count} parallel edit calls as one snapshot-anchored batch.`;
}

export class EditBatchEntry<T> {
	readonly input: string;
	readonly paths: ReadonlyMap<string, string>;
	readonly signal: AbortSignal | undefined;
	readonly promise: Promise<T>;
	#resolve!: (value: T) => void;
	#reject!: (reason: unknown) => void;
	#settled = false;

	constructor(input: string, paths: ReadonlyMap<string, string>, signal?: AbortSignal) {
		this.input = input;
		this.paths = paths;
		this.signal = signal;
		this.promise = new Promise<T>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		// A follower may still be waiting on the file lock when the leader
		// rejects the group. Swallow here so that rejection is not "unhandled"
		// before the follower awaits the same promise.
		this.promise.catch(() => undefined);
	}

	get settled(): boolean {
		return this.#settled;
	}

	resolve(value: T): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#resolve(value);
	}

	reject(reason: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#reject(reason);
	}
}

export class EditBatchCoordinator<T> {
	readonly #pending = new Set<EditBatchEntry<T>>();

	announce(input: string, paths: ReadonlyMap<string, string>, signal?: AbortSignal): EditBatchEntry<T> {
		const entry = new EditBatchEntry<T>(input, paths, signal);
		this.#pending.add(entry);
		return entry;
	}

	/**
	 * Claim `leader` plus every pending sibling whose sections are a subset of
	 * the leader's locked `(path → tag)` set. Aborted siblings are rejected and
	 * dropped instead of being absorbed.
	 */
	takeCompatible(leader: EditBatchEntry<T>): EditBatchEntry<T>[] {
		const group = [leader];
		this.#pending.delete(leader);
		for (const other of [...this.#pending]) {
			if (other.signal?.aborted) {
				this.#pending.delete(other);
				other.reject(new Error("Operation aborted"));
				continue;
			}
			if (!isSubsetWithMatchingTags(other.paths, leader.paths)) continue;
			this.#pending.delete(other);
			group.push(other);
		}
		return group;
	}

	drop(entry: EditBatchEntry<T>): void {
		this.#pending.delete(entry);
	}
}

function isSubsetWithMatchingTags(
	candidate: ReadonlyMap<string, string>,
	locked: ReadonlyMap<string, string>,
): boolean {
	if (candidate.size === 0) return false;
	for (const [path, tag] of candidate) {
		if (tag.length === 0) return false;
		if (locked.get(path) !== tag) return false;
	}
	return true;
}
