import { bindTaskResumer, type ExtensionContext, type TaskId, type TaskResumer } from "@bastani/atomic";
import type { SubagentChildRestoreDeps } from "./subagent-child-restore.js";
import { controlSubagentChildren, subagentChildOfTask, subagentChildStoppedForResume } from "./subagent-run-control.js";

/**
 * Lets a finished child's chat continue it: a message sent there resumes the child in its own session, as
 * `subagent({ action: "resume", id, message })` does. A child stopped for good, or one this session did not launch,
 * keeps a read-only chat.
 */
export function bindSubagentTaskResumer(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
): { readonly ensure: () => void; readonly dispose: () => void } {
	let unbind: (() => void) | undefined;
	let disposed = false;
	const ensure = () => {
		if (disposed || unbind !== undefined) return;
		try {
			const supervisor = ctx.getAgentTaskHost?.()?.ownerBinding.supervisor;
			if (supervisor !== undefined) unbind = bindTaskResumer(supervisor, resumer(deps, ctx));
		} catch {}
	};
	ensure();
	return {
		ensure,
		dispose: () => {
			disposed = true;
			unbind?.();
		},
	};
}

function resumer(deps: SubagentChildRestoreDeps, ctx: ExtensionContext): TaskResumer {
	const childOf = (taskId: TaskId) => subagentChildOfTask(ctx, taskId);
	return {
		readOnlyReason(taskId: TaskId) {
			const child = childOf(taskId);
			if (child === undefined) return "This subagent is no longer kept; its chat is read-only.";
			return child.readOnlyReason;
		},
		stop(taskId: TaskId) {
			const child = childOf(taskId);
			if (child === undefined || child.readOnlyReason !== undefined) return undefined;
			// `quit` stops it and keeps it resumable.
			return controlSubagentChildren(deps, ctx, { action: "quit", id: child.childId }).then((result) => {
				if (ctx.hasUI && !result.isError) {
					for (const note of result.details.runControl?.worktreeNotes ?? []) ctx.ui.notify(note, "warning");
				}
				return result.isError
					? {
							ok: false as const,
							reason: result.content.map((part) => (part.type === "text" ? part.text : "")).join(" "),
						}
					: { ok: true as const };
			});
		},
		isStopped(taskId: TaskId) {
			const child = childOf(taskId);
			return child !== undefined && subagentChildStoppedForResume(ctx, child.childId);
		},
		async resume(taskId: TaskId, message: string) {
			const child = childOf(taskId);
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
