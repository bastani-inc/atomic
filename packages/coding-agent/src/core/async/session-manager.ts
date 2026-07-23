import type { SendMessageOptions } from "../extensions/index.js";
import { AsyncJobManager } from "./job-manager.js";
import type { AsyncJobDeliveryHandler, AsyncJobDeliveryMessage } from "./types.js";

export interface SessionAsyncJobManagerHandle {
	manager: AsyncJobManager;
	owns: boolean;
	sessionId: symbol;
}
interface AsyncDeliverySession {
	sendCustomMessage(
		message: AsyncJobDeliveryMessage,
		options?: SendMessageOptions,
	): Promise<void>;
}


export function createSessionAsyncDeliveryHandler(session: AsyncDeliverySession, manager?: AsyncJobManager, sessionId?: symbol): AsyncJobDeliveryHandler {
	return async (message: AsyncJobDeliveryMessage) => {
		const isStale = () =>
			manager?.disposed === true ||
			manager?.isDeliverySuppressed(message.details.jobId) === true ||
			(sessionId !== undefined && manager?.isSessionDisposed(sessionId) === true);
		if (isStale()) return;
		await session.sendCustomMessage(message, {
			deliverAs: "followUp",
			triggerTurn: true,
			stageAdmissionKey: `async-job:${message.details.jobId}`,
		});
	};
}

export function createSessionAsyncJobManager(session: AsyncDeliverySession): SessionAsyncJobManagerHandle {
	const existing = AsyncJobManager.instance();
	if (existing) return { manager: existing, owns: false, sessionId: existing.registerSession() };
	let manager: AsyncJobManager;
	manager = new AsyncJobManager({
		onJobComplete: (message) => createSessionAsyncDeliveryHandler(session, manager)(message),
	});
	AsyncJobManager.setInstance(manager);
	return { manager, owns: true, sessionId: manager.registerSession() };
}

export function disposeSessionAsyncJobManager(manager: AsyncJobManager | undefined, sessionId: symbol | undefined): void {
	if (!manager || !sessionId) return;
	manager.releaseSession(sessionId);
	if (manager.disposed && AsyncJobManager.instance() === manager) AsyncJobManager.setInstance(undefined);
}

