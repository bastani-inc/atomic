import { randomUUID } from "node:crypto";
import type { TaskMessageDelivery } from "../../../coding-agent/src/core/tasks/supervisor.js";
import {
	type IntercomEventBus,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../shared/types.js";

/** How long a message typed into a task's transcript waits for Intercom to confirm its delivery. */
export const TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;

export interface TaskTranscriptMessageOptions {
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

/**
 * Sends `text` to the child Intercom target `to` through the Intercom relay the parent session already uses for
 * child results, and reports what the relay acknowledged. A relay that cannot be reached rejects; one that never
 * answers resolves as unconfirmed after `timeoutMs`.
 */
export function sendTaskTranscriptMessage(
	events: IntercomEventBus,
	to: string,
	text: string,
	options: TaskTranscriptMessageOptions = {},
): Promise<TaskMessageDelivery> {
	const timeoutMs = options.timeoutMs ?? TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS;
	const now = options.now ?? (() => performance.now());
	const requestId = randomUUID();
	const startedAt = now();
	return new Promise<TaskMessageDelivery>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let settled = false;
		const release = (): boolean => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			return true;
		};
		unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
			if (typeof data !== "object" || data === null) return;
			const ack = data as {
				readonly requestId?: unknown;
				readonly delivered?: unknown;
				readonly error?: unknown;
				readonly unconfirmed?: unknown;
			};
			if (ack.requestId !== requestId || !release()) return;
			resolve(
				ack.delivered === true
					? { delivered: true }
					: {
							delivered: false,
							reason: ack.unconfirmed === true ? "lost" : "refused",
							...(typeof ack.error === "string" ? { detail: ack.error } : {}),
						},
			);
		});
		timer = setTimeout(() => {
			if (release()) resolve({ delivered: false, reason: "unconfirmed", timeoutMs, elapsedMs: now() - startedAt });
		}, timeoutMs);
		timer.unref?.();
		try {
			events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { to, message: text, requestId });
		} catch (error) {
			if (release()) reject(error);
		}
	});
}
