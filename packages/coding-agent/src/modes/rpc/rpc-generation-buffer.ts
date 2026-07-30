/**
 * Host-side frame buffer tagged with the engine generation that produced it.
 *
 * The interactive host buffers custom-UI frames and extension UI requests that
 * arrive before their controller subscribes. Without generation tags a frame
 * buffered by a child that has since died would be delivered to the live host
 * afterwards, remounting exactly the UI that death teardown just removed —
 * component IDs restart at `remote_component_1` for every child, so the stale
 * frame would also collide with the replacement's own mounts.
 */
export class GenerationBuffer<T> {
	private entries: Array<{ generation: number; value: T }> = [];

	get size(): number {
		return this.entries.length;
	}

	push(generation: number, value: T): void {
		this.entries.push({ generation, value });
	}

	/** Take the entries owned by `generation`; anything else is dropped, never requeued. */
	drain(generation: number): T[] {
		const entries = this.entries;
		this.entries = [];
		return entries.filter((entry) => entry.generation === generation).map((entry) => entry.value);
	}

	/** Forget everything a now-dead generation left behind. */
	dropGeneration(generation: number): void {
		this.entries = this.entries.filter((entry) => entry.generation !== generation);
	}

	clear(): void {
		this.entries = [];
	}
}
