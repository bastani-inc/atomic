import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskCompletionMessage } from "./child-command-owner.js";
import { COMMAND_DETAIL_TAIL_BYTES, type OmissionSpan, readTaskOutputTail } from "./command-output.js";
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

/** The model-facing completion notice of a settled task, with its structured envelope in the details. */
export function taskCompletionMessage(
	envelope: TaskCompletionEnvelope,
	task: TaskRecord | undefined,
	output: string | CommandOutputExcerpt | undefined,
	/** The subagent's Intercom name, when its session names one. */
	intercomTarget?: string,
): TaskCompletionMessage {
	const text = typeof output === "object" ? output.text : output;
	const omissions = typeof output === "object" ? output.omissions : undefined;
	return {
		customType: TASK_COMPLETION_MESSAGE_TYPE,
		content: formatTaskCompletion(envelope, task, text, omissions, intercomTarget),
		details: { ...envelope, notification: taskCompletionNotice(envelope, task, text, omissions) },
		display: true,
	};
}
