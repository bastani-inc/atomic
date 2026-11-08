import type { SessionInfo, WorkflowFutureStageRosterEntry, WorkflowStageRosterEntry } from "../types.js";
import { sessionsInGroup, sessionsVisibleTo } from "./group-membership.js";

type SessionDirectoryView = ReadonlyMap<string, { readonly info: SessionInfo }>;

export interface SessionsReply {
	readonly type: "sessions";
	readonly requestId: string;
	readonly sessions: SessionInfo[];
	readonly workflowStages: WorkflowStageRosterEntry[];
	readonly workflowFutureStages: WorkflowFutureStageRosterEntry[];
	readonly restricted?: true;
}

export interface ListReplyRequest {
	readonly requestId: string;
	readonly requesterInfo: SessionInfo;
	readonly selectedGroup: string | undefined;
	readonly localSessions: () => SessionDirectoryView;
	/** Present only in multi-node mode; sessions connected through other nodes are live peers too. */
	readonly remoteSessions: (() => Promise<SessionDirectoryView>) | undefined;
	readonly canInspectSelectedGroup: (selectedGroup: string) => boolean;
	readonly workflowStages: () => WorkflowStageRosterEntry[];
	readonly workflowFutureStages: () => WorkflowFutureStageRosterEntry[];
	readonly write: (reply: SessionsReply) => void;
}

/**
 * The restriction is decided when the reply is built, after any remote read, so a group joined while that read was
 * pending is honoured and the message, rows and `restricted` flag always describe the same decision.
 */
export function replyToList(request: ListReplyRequest): void {
	const respond = (remote: SessionDirectoryView | undefined): void => {
		const { selectedGroup } = request;
		const restricted = selectedGroup !== undefined && !request.canInspectSelectedGroup(selectedGroup);
		const visible = (sessions: SessionDirectoryView): SessionInfo[] =>
			restricted
				? []
				: selectedGroup !== undefined
					? sessionsInGroup(sessions, selectedGroup)
					: sessionsVisibleTo(sessions, request.requesterInfo);
		request.write({
			type: "sessions",
			requestId: request.requestId,
			sessions: [...visible(request.localSessions()), ...(remote === undefined ? [] : visible(remote))],
			workflowStages: restricted ? [] : request.workflowStages(),
			workflowFutureStages: restricted ? [] : request.workflowFutureStages(),
			...(restricted ? { restricted: true as const } : {}),
		});
	};
	if (request.remoteSessions === undefined) respond(undefined);
	else void request.remoteSessions().then(respond);
}
