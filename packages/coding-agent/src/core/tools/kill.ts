import { Type } from "@bastani/atomic-ai/utils/typebox/index";
import { Container, Text } from "@bastani/atomic-tui";
import { experimentalToolSamplingProperty } from "../experimental.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { CancelReceipt } from "../tasks/contracts.js";
import { lookupOwnedTask, type SupervisedCommandOwner } from "./bash-pty-native.js";
import { HistoryTaskRegistry } from "./history-tasks.ts";
import { formatKillCall, rebuildKillResult } from "./shell-task-render.ts";
import { cancelReceiptSentence, TaskToolError } from "./shell-task-status.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const killSchema = Type.Object({
	id: Type.String({
		description:
			"Task ID returned by a bash or powershell command, or a history:// read or search, that is running in the background",
	}),
});

export interface KillToolOptions {
	/** Resolve the live trusted owner at execution time, including after session switches. */
	taskOwner?: () => SupervisedCommandOwner | undefined;
	/** The session's background history tasks, resolved per call. */
	historyTasks?: () => HistoryTaskRegistry | undefined;
}

export function createKillToolDefinition(
	options?: KillToolOptions,
): ToolDefinition<typeof killSchema, CancelReceipt | undefined> {
	return {
		name: "kill",
		label: "Kill",
		description:
			"Stop a background task this session started: a bash or PowerShell command, or a history:// read or search. Pass its task ID, not a process ID. It does not stop subagents or tasks owned by others. For a shell task, the result says whether the stop was accepted and whether the process and its cleanup have finished; an accepted stop does not mean the process has exited yet.",
		parameters: killSchema,
		...experimentalToolSamplingProperty(),
		promptSnippet: "Stop a background shell or history task by its task ID",
		execute: async (_toolCallId, { id }) => {
			if (HistoryTaskRegistry.isTaskId(id)) {
				const history = options?.historyTasks?.();
				if (!history) throw new Error("kill of a history task requires a session");
				return { content: [{ type: "text", text: await history.cancel(id) }], details: undefined };
			}
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
