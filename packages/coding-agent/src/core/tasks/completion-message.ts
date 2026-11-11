import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskCompletionMessage } from "./child-command-owner.js";
import { COMMAND_DETAIL_TAIL_BYTES, taskOutputText } from "./command-output.js";
import {
	formatTaskCompletion,
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "./completion.js";
import type { TaskRecord } from "./contracts.js";
import type { TaskLease } from "./supervisor.js";

export const COMMAND_OUTPUT_UNAVAILABLE = "Output unavailable";

/** The tail of a settled command's retained output, for its completion notice. A missing output never drops the notice. */
export async function commandOutputExcerpt(host: AgentTaskHost, lease: TaskLease, task: TaskRecord): Promise<string> {
	try {
		const bytes = BigInt(task.output.byteCount);
		const start = bytes > BigInt(COMMAND_DETAIL_TAIL_BYTES) ? bytes - BigInt(COMMAND_DETAIL_TAIL_BYTES) : 0n;
		const page = await host.ownerBinding.supervisor.readTaskOutput(lease, {
			start: String(start),
			maximumBytes: COMMAND_DETAIL_TAIL_BYTES,
		});
		return page.ok
			? `${start > 0n ? "[Earlier output omitted]\n" : ""}${taskOutputText(page.value)}`
			: COMMAND_OUTPUT_UNAVAILABLE;
	} catch {
		return COMMAND_OUTPUT_UNAVAILABLE;
	}
}

/** The model-facing completion notice of a settled task, with its structured envelope in the details. */
export function taskCompletionMessage(
	envelope: TaskCompletionEnvelope,
	task: TaskRecord | undefined,
	output: string | undefined,
): TaskCompletionMessage {
	return {
		customType: TASK_COMPLETION_MESSAGE_TYPE,
		content: formatTaskCompletion(envelope, task, output),
		details: { ...envelope, notification: taskCompletionNotice(envelope, task, output) },
		display: true,
	};
}
