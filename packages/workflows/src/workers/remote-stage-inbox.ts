import { type SerializedError, serializeError } from "../shared/error-codec.js";
import { WorkflowInfrastructureError } from "../shared/workflow-infrastructure-error.js";
import type { WorkerDeliver } from "./protocol.js";
import type { IntercomRefusal } from "./stage-watch-types.js";

interface StageRef {
	readonly runId: string;
	readonly stageId: string;
}

/** The outcome of one hand-over: delivered (`{}`), refused with a reason, or failed in the session with `error`. */
export type RemoteStageInboxResult = { readonly refusal?: IntercomRefusal; readonly error?: SerializedError };

/**
 * Where the stages of an attempt on a host that does not run its root take their Intercom messages (#4391). Such a
 * stage holds no live route: its session's pending-stage delivery hands its sink over here, and the root's messages
 * reach that sink through the stage's input queue. Each stage keeps its latest session, with that session's sink until
 * the session closes; a message meant for an earlier session of the stage is refused, one for a session that has not
 * handed its sink over yet waits for it.
 */
export class RemoteStageInbox {
	private readonly sessions = new Map<
		string,
		{ readonly sessionId: string; readonly deliver?: WorkerDeliver; readonly owner?: object }
	>();
	private readonly replaced = new Map<string, Set<string>>();

	/**
	 * Records the sink of the stage's session `sessionId`, handed over by `owner`, the session's own pending-stage
	 * delivery; a later session of the stage replaces it, also one that resumes the same session id.
	 */
	register(stage: StageRef, sessionId: string, deliver: WorkerDeliver, owner: object): void {
		const key = stageKey(stage);
		const previous = this.sessions.get(key);
		if (previous !== undefined && previous.sessionId !== sessionId) {
			const replaced = this.replaced.get(key) ?? new Set();
			replaced.add(previous.sessionId);
			this.replaced.set(key, replaced);
		}
		this.sessions.set(key, { sessionId, deliver, owner });
	}

	/**
	 * Drops the stage's sink once the session whose delivery is `owner` closed, so the inbox no longer holds the session
	 * (#4505). Only the registration `owner` made is dropped: a session that replaced it keeps its sink, also one that
	 * resumed the same session id, as a model fallback's next session does.
	 */
	unregister(stage: StageRef, owner: object): void {
		const key = stageKey(stage);
		const current = this.sessions.get(key);
		if (current?.owner === owner) this.sessions.set(key, { sessionId: current.sessionId });
	}

	/**
	 * Hands `message` to the stage session `sessionId`, through the sink that session handed over. A session that closed,
	 * as one a waiting stage released, fails the hand-over as its ended Intercom runtime would: the message stays the
	 * stage's, for that session once it reopens or as replaced once another session takes over.
	 */
	async deliver(
		stage: StageRef,
		sessionId: string,
		from: Parameters<WorkerDeliver>[0],
		message: Parameters<WorkerDeliver>[1],
	): Promise<RemoteStageInboxResult> {
		const key = stageKey(stage);
		const session = this.sessions.get(key);
		if (session?.sessionId !== sessionId)
			return { refusal: this.replaced.get(key)?.has(sessionId) === true ? "SessionReplaced" : "StaleAttempt" };
		if (session.deliver === undefined) {
			const ended = new WorkflowInfrastructureError("intercom_unavailable", {
				runId: stage.runId,
				stageId: stage.stageId,
			});
			return { error: serializeError(ended) };
		}
		try {
			await session.deliver(from, message);
			return {};
		} catch (error) {
			return { error: serializeError(error) };
		}
	}
}

function stageKey(stage: StageRef): string {
	return JSON.stringify([stage.runId, stage.stageId]);
}
