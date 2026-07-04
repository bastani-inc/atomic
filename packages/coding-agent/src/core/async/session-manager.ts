import type { CustomMessage } from "../messages.js";
import type { SendMessageOptions } from "../extensions/index.js";
import { AsyncJobManager } from "./job-manager.js";
import type { AsyncJobDeliveryHandler, AsyncJobDeliveryMessage } from "./types.js";

export interface SessionAsyncJobManagerHandle {
	manager: AsyncJobManager;
	owns: boolean;
	sessionId: symbol;
}
interface AsyncDeliverySession {
	readonly isStreaming?: boolean;
	sendCustomMessage<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendMessageOptions,
	): Promise<void>;
}

const STREAMING_DELIVERY_POLL_MS = 10;

function scheduleBoundaryCheck(callback: () => void): NodeJS.Timeout {
	const timer = setTimeout(callback, STREAMING_DELIVERY_POLL_MS);
	timer.unref?.();
	return timer;
}

function waitForStreamingBoundary(session: AsyncDeliverySession, isStale: () => boolean): Promise<"ready" | "stale"> {
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const settle = (value: "ready" | "stale") => {
			if (timer) clearTimeout(timer);
			resolve(value);
		};
		const check = () => {
			timer = undefined;
			if (isStale()) {
				settle("stale");
				return;
			}
			if (session.isStreaming !== true) {
				settle("ready");
				return;
			}
			timer = scheduleBoundaryCheck(check);
		};
		check();
	});
}

export function createSessionAsyncDeliveryHandler(session: AsyncDeliverySession, manager?: AsyncJobManager, sessionId?: symbol): AsyncJobDeliveryHandler {
	return async (message: AsyncJobDeliveryMessage) => {
		const isStale = () =>
			manager?.disposed === true ||
			manager?.isDeliverySuppressed(message.details.jobId) === true ||
			(sessionId !== undefined && manager?.isSessionDisposed(sessionId) === true);
		if (await waitForStreamingBoundary(session, isStale) === "stale") return;
		if (isStale()) return;
		await session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true });
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

