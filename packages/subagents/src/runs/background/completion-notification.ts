import type { IntercomEventBus } from "../../shared/types.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";

export interface CompletionNotificationEnvelope extends Record<string, unknown> {
	notificationId: string;
	acknowledge: (delivered: boolean) => void;
	defer: () => void;
}

export function deliverLocalCompletionNotification(
	events: IntercomEventBus,
	payload: Record<string, unknown>,
	notificationId: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let deferred = false;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			resolve(delivered);
		};
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				...payload,
				notificationId,
				defer: () => { deferred = true; },
				acknowledge: finish,
			} satisfies CompletionNotificationEnvelope);
			if (!deferred) finish(true);
		} catch {
			finish(false);
		}
	});
}
