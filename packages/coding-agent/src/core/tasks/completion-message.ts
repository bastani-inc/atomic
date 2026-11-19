import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskCompletionMessage } from "./child-command-owner.js";
import {
	COMMAND_DETAIL_TAIL_BYTES,
	type OmissionSpan,
	readTaskOutputTail,
	taskOutputHeadText,
} from "./command-output.js";
import {
	formatTaskCompletion,
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "./completion.js";
import type { TaskRecord } from "./contracts.js";
import type { TaskLease } from "./supervisor.js";

export const COMMAND_OUTPUT_UNAVAILABLE = "Output unavailable";

export type CommandOutputExcerpt = { text: string; omissions: OmissionSpan[] };

/** Keep synthetic labels separate from identical text the command might have printed. */
export async function commandOutputExcerpt(
	host: AgentTaskHost,
	lease: TaskLease,
	task: TaskRecord,
): Promise<CommandOutputExcerpt> {
	try {
		const bytes = BigInt(task.output.byteCount);
		const start = bytes > BigInt(COMMAND_DETAIL_TAIL_BYTES) ? bytes - BigInt(COMMAND_DETAIL_TAIL_BYTES) : 0n;
		const prefix = start > 0n ? "[Earlier output omitted]\n" : "";
		const omissions = prefix ? [{ start: 0, end: prefix.length }] : [];
		const page = await readTaskOutputTail(
			host.ownerBinding.supervisor,
			lease,
			{
				start: String(start),
				maximumBytes: COMMAND_DETAIL_TAIL_BYTES,
			},
			(gap) => omissions.push({ start: prefix.length + gap.start, end: prefix.length + gap.end }),
		);
		if (page.ok) return { text: prefix + page.value.text, omissions };
	} catch {
		// A missing output never drops the notice.
	}
	return { text: COMMAND_OUTPUT_UNAVAILABLE, omissions: [] };
}

/** Most of a tool task's output its completion notice quotes, from its start: a search's results read top-down. */
export const TOOL_NOTICE_HEAD_BYTES = 8192;

/**
 * The start of a `tool` task's output for its completion notice: its first results, and a note when more follows. All
 * of it stays readable through the tool's `action: "wait"` and `/tasks`.
 */
export async function toolOutputExcerpt(host: AgentTaskHost, lease: TaskLease): Promise<string> {
	try {
		const page = await host.ownerBinding.supervisor.readTaskOutput(lease, {
			start: "0",
			maximumBytes: TOOL_NOTICE_HEAD_BYTES,
		});
		if (!page.ok) return COMMAND_OUTPUT_UNAVAILABLE;
		const text = taskOutputHeadText(page.value);
		return page.value.nextOffset === undefined ? text : `${text}\n[Later output omitted]`;
	} catch {
		return COMMAND_OUTPUT_UNAVAILABLE;
	}
}

/** The model-facing completion notice of a settled task, with its structured envelope in the details. */
export function taskCompletionMessage(
	envelope: TaskCompletionEnvelope,
	task: TaskRecord | undefined,
	output: string | CommandOutputExcerpt | undefined,
): TaskCompletionMessage {
	const text = typeof output === "object" ? output.text : output;
	const omissions = typeof output === "object" ? output.omissions : undefined;
	return {
		customType: TASK_COMPLETION_MESSAGE_TYPE,
		content: formatTaskCompletion(envelope, task, text, omissions),
		details: { ...envelope, notification: taskCompletionNotice(envelope, task, text, omissions) },
		display: true,
	};
}
