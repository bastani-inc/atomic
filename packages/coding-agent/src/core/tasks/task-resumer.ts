import type { NativeTaskRef, TaskId } from "./contracts.js";

/**
 * How a finished agent task continues when its chat sends it a message: the extension that launched it resumes it in
 * its own session with that message. A task stopped for good, or one the extension no longer knows, is not resumable,
 * and its chat becomes read-only.
 */
export interface TaskResumer {
	/** Why the task cannot take another message, or `undefined` when it can be resumed with one. */
	readOnlyReason(taskId: TaskId): string | undefined;
	/** Resumes the finished task with `message`; a refusal says why. */
	resume(
		taskId: TaskId,
		message: string,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
	/**
	 * Stops a running task so that it stays resumable, as `x x` and Ctrl+X Ctrl+K do. `undefined` when this task is not
	 * one the resumer stops, and its owner cancels it as usual.
	 */
	stop?(taskId: TaskId): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> | undefined;
	/** Whether the task was stopped resumably and waits for a message to resume it. */
	isStopped?(taskId: TaskId): boolean;
}

// An extension and its host can load separate SDK modules. Both must see the same owner binding, or a panel stop
// misses the extension's resumable quit and falls back to permanent cancellation.
type OwnerResumers = { current?: TaskResumer; readonly handlers: Map<TaskResumer, number> };
const TASK_RESUMERS = Symbol.for("atomic-coding-agent/task-resumers@2");
const registry = globalThis as {
	[TASK_RESUMERS]?: {
		owners: WeakMap<object, OwnerResumers>;
		releasedOwners: WeakMap<NativeTaskRef, WeakRef<object>>;
	};
};
registry[TASK_RESUMERS] ??= { owners: new WeakMap(), releasedOwners: new WeakMap() };
const { owners, releasedOwners } = registry[TASK_RESUMERS];

/** Registers how the tasks of `owner` (a task supervisor) resume; returns the unregister. */
export function bindTaskResumer(owner: object, resumer: TaskResumer): () => void {
	const bindings: OwnerResumers = owners.get(owner) ?? { handlers: new Map() };
	owners.set(owner, bindings);
	bindings.current = resumer;
	bindings.handlers.set(resumer, (bindings.handlers.get(resumer) ?? 0) + 1);
	let registration: { owner: object; resumer: TaskResumer } | undefined = { owner, resumer };
	return () => {
		if (!registration) return;
		const { owner, resumer } = registration;
		registration = undefined;
		const bindings = owners.get(owner)!;
		const remaining = bindings.handlers.get(resumer)! - 1;
		if (remaining > 0) bindings.handlers.set(resumer, remaining);
		else {
			bindings.handlers.delete(resumer);
			if (bindings.current === resumer) delete bindings.current;
			if (bindings.handlers.size === 0) owners.delete(owner);
		}
	};
}

/** Remember the supervisor of a released row without making the row keep its owner alive. */
export function bindReleasedTaskOwner(ref: NativeTaskRef, owner: object): void {
	releasedOwners.set(ref, new WeakRef(owner));
}

/** Only the row's owner can say whether its released child was stopped and awaits a resume. */
export function taskStoppedForResume(ref: NativeTaskRef): boolean {
	const owner = releasedOwners.get(ref)?.deref();
	const bindings = owner === undefined ? undefined : owners.get(owner);
	if (bindings === undefined) return false;
	for (const resumer of bindings.handlers.keys()) if (resumer.isStopped?.(ref.taskId) === true) return true;
	return false;
}

/** The resumer registered for `owner`, if any. */
export function taskResumer(owner: object): TaskResumer | undefined {
	return owners.get(owner)?.current;
}
