import { bindTaskResumer, type ExtensionContext, type TaskId, type TaskResumer } from "@bastani/atomic";
import type { SubagentChildRestoreDeps } from "./subagent-child-restore.js";
import {
	controlSubagentChildren,
	subagentChildOfTask,
	subagentChildrenAwaitingResume,
} from "./subagent-run-control.js";

/**
 * Lets a finished child's chat continue it: a message sent there resumes the child in its own session, as
 * `subagent({ action: "resume", id, message })` does. A child stopped for good, or one this session did not launch,
 * keeps a read-only chat. Returns the unregister.
 */
export function bindSubagentTaskResumer(deps: SubagentChildRestoreDeps, ctx: ExtensionContext): () => void {
	let unbind: (() => void) | undefined;
	let disposed = false;
	const bind = (): boolean => {
		try {
			const supervisor = ctx.getAgentTaskHost?.()?.ownerBinding.supervisor;
			if (supervisor !== undefined) unbind = bindTaskResumer(supervisor, resumer(deps, ctx));
			return true;
		} catch {
			return false;
		}
	};
	// During a reload the previous task owner is still closing when the session starts; its replacement is bound a
	// moment later.
	if (!bind()) {
		const timer = setTimeout(() => {
			if (!disposed) bind();
		}, 0);
		timer.unref?.();
	}
	return () => {
		disposed = true;
		unbind?.();
	};
}

function resumer(deps: SubagentChildRestoreDeps, ctx: ExtensionContext): TaskResumer {
	return {
		readOnlyReason(taskId: TaskId) {
			const child = subagentChildOfTask(ctx, taskId);
			if (child === undefined) return "This subagent is no longer kept; its chat is read-only.";
			return child.readOnlyReason;
		},
		stop(taskId: TaskId) {
			const child = subagentChildOfTask(ctx, taskId);
			if (child === undefined || child.readOnlyReason !== undefined) return undefined;
			// `quit` stops it and keeps it resumable, as a quit workflow run is.
			return controlSubagentChildren(deps, ctx, { action: "quit", id: child.childId }).then((result) =>
				result.isError
					? {
							ok: false as const,
							reason: result.content.map((part) => (part.type === "text" ? part.text : "")).join(" "),
						}
					: { ok: true as const },
			);
		},
		isStopped(taskId: TaskId) {
			const child = subagentChildOfTask(ctx, taskId);
			return child !== undefined && subagentChildrenAwaitingResume(ctx, child.childId).length > 0;
		},
		async resume(taskId: TaskId, message: string) {
			const child = subagentChildOfTask(ctx, taskId);
			if (child === undefined) return { ok: false, reason: "this subagent is no longer kept" };
			if (child.readOnlyReason !== undefined) return { ok: false, reason: child.readOnlyReason };
			const result = await controlSubagentChildren(deps, ctx, { action: "resume", id: child.childId, message });
			if (!result.isError) return { ok: true };
			return {
				ok: false,
				reason: result.content.map((part) => (part.type === "text" ? part.text : "")).join(" "),
			};
		},
	};
}
