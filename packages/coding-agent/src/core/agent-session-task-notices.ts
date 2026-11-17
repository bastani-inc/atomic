import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { sessionLifetime } from "./session-lifecycle-work.ts";
import type { TaskCompletionMessage } from "./tasks/child-command-owner.js";
import { TASK_COMPLETION_MESSAGE_TYPE, taskNoticeCompletionIds } from "./tasks/completion.js";

/**
 * Finished-task notices reach a session's model as one message per batch: the notices that arrive together, or, in a
 * chat or workflow stage, while the session works, are joined and delivered once it is idle, so a burst of finished
 * shells or subagents costs one message and at most one turn. The joined message is what the transcript shows and the
 * model reads, one notice line per task.
 */

/** Sends a joined notice to the session; resolves once the session admitted it. */
export type TaskNoticeSend = (
	message: TaskCompletionMessage,
	options: {
		readonly triggerTurn: boolean;
		readonly stageAdmissionKey: string | undefined;
		/**
		 * The session works now, or holds its queued input after an interrupt: the notice waits, durably, for the next
		 * safe boundary or the user's next message.
		 */
		readonly busy: boolean;
	},
) => Promise<void>;

export interface TaskNoticeDelivery {
	/** The notice's completion id: its admission key, and how a saved notice is recognized after a restart. */
	readonly completionId: string | undefined;
	/** Whether the notice starts a turn in an idle session; a restored one only joins the transcript. */
	readonly triggerTurn: boolean;
	readonly send: TaskNoticeSend;
	/**
	 * Wait until the session is idle. A chat or stage reads its notices after the turn it is in; a running subagent,
	 * whose execution ends with its turn, reads them within that turn.
	 */
	readonly afterTurn: boolean;
}

interface PendingNotice extends TaskNoticeDelivery {
	readonly message: TaskCompletionMessage;
	readonly done: PromiseWithResolvers<void>;
}

interface TaskNoticeInbox {
	readonly pending: PendingNotice[];
	draining: boolean;
}

const inboxes = new WeakMap<AgentSession, TaskNoticeInbox>();

/** The details of each notice a notice entry carries, in order: itself, or every notice it joined. */
export function taskNoticeDetails(details: unknown): unknown[] {
	if (details === null || typeof details !== "object") return [];
	const joined = (details as { notices?: unknown }).notices;
	return Array.isArray(joined) ? joined : [details];
}

/** One message for several notices: their texts in order, and each notice's details under `notices`. */
export function joinTaskNotices(messages: readonly TaskCompletionMessage[]): TaskCompletionMessage {
	if (messages.length === 1) return messages[0]!;
	return {
		customType: TASK_COMPLETION_MESSAGE_TYPE,
		content: messages.map((message) => message.content).join("\n\n"),
		details: { notices: messages.flatMap((message) => taskNoticeDetails(message.details)) },
		display: true,
	};
}

function busy(session: AgentSession): boolean {
	return session.isStreaming || session._isPreparingRun !== false || session._activePromptCount > 0;
}

/** Notices that finish within this long of each other count as finishing together. */
export const TASK_NOTICE_GATHER_MS = 50;
/** The longest a steady stream of finishing tasks holds back the first of their notices. */
const TASK_NOTICE_GATHER_LIMIT_MS = 1000;

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until no notice has arrived for {@link TASK_NOTICE_GATHER_MS}, or the gather limit passed. */
async function gather(inbox: TaskNoticeInbox): Promise<void> {
	const started = Date.now();
	for (;;) {
		const arrived = inbox.pending.length;
		await sleep(TASK_NOTICE_GATHER_MS);
		if (inbox.pending.length === arrived || Date.now() - started >= TASK_NOTICE_GATHER_LIMIT_MS) return;
	}
}

/**
 * Resolves once the session has saved an entry carrying `completionId`, as a queued message is saved when it is read;
 * rejects when the session closes first, so the notice is kept for its next run.
 */
function whenSaved(session: AgentSession, completionId: string | undefined): Promise<void> {
	if (completionId === undefined) return Promise.resolve();
	const saved = () =>
		session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					(entry.stageAdmissionKey === completionId ||
						taskNoticeCompletionIds(entry.details).includes(completionId)),
			);
	if (saved()) return Promise.resolve();
	const lifetime = sessionLifetime(session);
	return new Promise((resolve, reject) => {
		const closed = () => {
			unsubscribe();
			reject(new Error("The session closed before it saved the notice"));
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end" || !saved()) return;
			unsubscribe();
			lifetime.removeEventListener("abort", closed);
			resolve();
		});
		if (lifetime.aborted) closed();
		else lifetime.addEventListener("abort", closed, { once: true });
	});
}

/**
 * Deliver a finished task's notice to `session` through `send`, joined with every other notice that arrives before
 * the session is idle. Resolves once the joined notice is saved in the session; rejects when the session refused it.
 */
export function deliverTaskNotice(
	session: AgentSession,
	message: TaskCompletionMessage,
	options: TaskNoticeDelivery,
): Promise<void> {
	let inbox = inboxes.get(session);
	if (inbox === undefined) {
		inbox = { pending: [], draining: false };
		inboxes.set(session, inbox);
	}
	const done = Promise.withResolvers<void>();
	inbox.pending.push({ message, ...options, done });
	if (!inbox.draining) {
		inbox.draining = true;
		void drain(session, inbox).finally(() => {
			inbox.draining = false;
		});
	}
	return done.promise;
}

async function drain(session: AgentSession, inbox: TaskNoticeInbox): Promise<void> {
	for (;;) {
		// Notices that finish together, or arrive while a chat works, join one message.
		await gather(inbox);
		while (inbox.pending.some((notice) => notice.afterTurn) && busy(session) && !session._disposed) {
			if (session.isStreaming) await session.agent.waitForIdle();
			else await sleep(20);
			await nextTick();
		}
		const batch = inbox.pending.splice(0);
		if (batch.length === 0) return;
		const message = joinTaskNotices(batch.map((notice) => notice.message));
		const stageAdmissionKey = batch.find((notice) => notice.completionId !== undefined)?.completionId;
		try {
			await batch[0]!.send(message, {
				triggerTurn: batch.some((notice) => notice.triggerTurn),
				stageAdmissionKey,
				busy: busy(session) || session._queuedMessagesPaused,
			});
			await whenSaved(session, stageAdmissionKey);
			for (const notice of batch) notice.done.resolve();
		} catch (error) {
			for (const notice of batch) notice.done.reject(error);
		}
	}
}
