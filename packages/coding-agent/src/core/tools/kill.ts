import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { experimentalToolSamplingProperty } from "../experimental.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { CancelReceipt } from "../tasks/contracts.js";
import { lookupOwnedTask, type SupervisedCommandOwner } from "./bash-pty-native.js";
import { formatKillCall, rebuildKillResult } from "./shell-task-render.ts";
import { cancelReceiptSentence, TaskToolError } from "./shell-task-status.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const killSchema = Type.Object({
	id: Type.String({ description: "Task ID returned by a background or auto-yielded bash or powershell call" }),
});

export interface KillToolOptions {
	/** Resolve the live trusted owner at execution time, including after session switches. */
	taskOwner?: () => SupervisedCommandOwner | undefined;
}

export function createKillToolDefinition(options?: KillToolOptions): ToolDefinition<typeof killSchema, CancelReceipt> {
	return {
		name: "kill",
		label: "Kill",
		description:
			"Stop an owned background bash or PowerShell task by its task ID, not a PID. Does not stop subagents or other owners' tasks. Returns the cancellation decision and current execution/cleanup state; a cancellation request alone does not confirm termination.",
		parameters: killSchema,
		...experimentalToolSamplingProperty(),
		promptSnippet: "Stop an owned background shell task by task ID",
		execute: async (_toolCallId, { id }) => {
			const binding = options?.taskOwner?.();
			if (!binding) throw new Error("kill requires a supported task owner");
			const { supervisor, owner } = binding;
			const task = lookupOwnedTask(binding, id);
			const watched = supervisor.watchOwnerTasks(owner);
			if (!watched.ok) throw new TaskToolError(watched.error, id);
			try {
				const record = watched.value.snapshot.tasks.find((entry) => entry.ref.taskId === id);
				if (record?.kind !== "command") throw new Error("kill only supports shell tasks");
				const result = await supervisor.cancelTask(task, "user");
				if (!result.ok) throw new TaskToolError(result.error, id);
				const receipt = result.value;
				return {
					content: [{ type: "text", text: cancelReceiptSentence(receipt) }],
					details: receipt,
					...(receipt.cleanup.kind === "failed" ? { isError: true } : {}),
				};
			} finally {
				watched.value.dispose();
			}
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatKillCall(args));
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildKillResult(component, result, { isError: context.isError, taskId: context.args.id });
			component.invalidate();
			return component;
		},
	};
}

export function createKillTool(options?: KillToolOptions) {
	return wrapToolDefinition(createKillToolDefinition(options));
}
