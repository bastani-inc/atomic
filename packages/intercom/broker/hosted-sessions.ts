import { isLiveWorkflowStageRouteRefusalCode } from "../live-route-refusal.js";
import type { HostedSessionAssignment, HostedSessionRefusal, SessionInfo } from "../types.js";
import { isSessionRegistration } from "./client-message-validation.js";
import type { JsonWireValue } from "./framing.js";

/** Sessions per `host_sessions` frame, and session ids per `unhost_sessions` frame (#4642). */
export const HOSTED_SESSION_FRAME_MAX = 500;

export interface ParsedHostedSession {
	readonly key: string;
	readonly session: Omit<SessionInfo, "id">;
	readonly returnAddress?: string;
	readonly liveRoute?: { readonly runId: string; readonly stageKeys: readonly string[]; readonly capability: string };
}

export type HostedSessionFrameValidation =
	| { readonly ok: true; readonly sessions: readonly ParsedHostedSession[] }
	| { readonly ok: false; readonly refusal: HostedSessionRefusal };

export type UnhostSessionsFrameValidation =
	| { readonly ok: true; readonly sessionIds: readonly string[] }
	| { readonly ok: false; readonly refusal: HostedSessionRefusal };

type WireObject = { readonly [key: string]: JsonWireValue };

export const isWireObject = (value: JsonWireValue | undefined): value is WireObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: JsonWireValue | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0;

function parseLiveRoute(value: JsonWireValue | undefined): ParsedHostedSession["liveRoute"] | false {
	if (!isWireObject(value)) return false;
	const { runId, stageKeys, capability } = value;
	if (!isNonEmptyString(runId) || !isNonEmptyString(capability) || !Array.isArray(stageKeys)) return false;
	if (stageKeys.length < 1 || stageKeys.length > 2 || !stageKeys.every(isNonEmptyString)) return false;
	return { runId, stageKeys: stageKeys as string[], capability };
}

/**
 * Validate one `host_sessions` frame as a whole, before anything is hosted: 1 to 500 items under distinct keys, each a
 * named agent registration with an optional return address and live workflow-stage route. The first invalid item
 * refuses the frame.
 */
export function validateHostSessionsFrame(sessions: JsonWireValue | undefined): HostedSessionFrameValidation {
	if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > HOSTED_SESSION_FRAME_MAX) {
		return { ok: false, refusal: { code: "invalid_hosted_frame" } };
	}
	const keys = new Set<string>();
	const parsed: ParsedHostedSession[] = [];
	for (const item of sessions) {
		if (!isWireObject(item) || !isNonEmptyString(item.key) || keys.has(item.key)) {
			return {
				ok: false,
				refusal:
					isWireObject(item) && typeof item.key === "string"
						? { code: "invalid_hosted_frame", key: item.key }
						: { code: "invalid_hosted_frame" },
			};
		}
		const key = item.key;
		keys.add(key);
		const invalid = { ok: false, refusal: { code: "invalid_hosted_session", key } } as const;
		const { session, returnAddress } = item;
		if (
			!isSessionRegistration(session) ||
			!isNonEmptyString(session.name) ||
			session.recipientPurpose === "control"
		) {
			return invalid;
		}
		if (returnAddress !== undefined && !isNonEmptyString(returnAddress)) return invalid;
		const liveRoute = item.liveRoute === undefined ? undefined : parseLiveRoute(item.liveRoute);
		if (liveRoute === false) return invalid;
		parsed.push({
			key,
			session,
			...(returnAddress === undefined ? {} : { returnAddress }),
			...(liveRoute === undefined ? {} : { liveRoute }),
		});
	}
	return { ok: true, sessions: parsed };
}

/** Validate one `unhost_sessions` frame: 1 to 500 session ids. */
export function validateUnhostSessionsFrame(sessionIds: JsonWireValue | undefined): UnhostSessionsFrameValidation {
	if (
		!Array.isArray(sessionIds) ||
		sessionIds.length === 0 ||
		sessionIds.length > HOSTED_SESSION_FRAME_MAX ||
		!sessionIds.every(isNonEmptyString)
	) {
		return { ok: false, refusal: { code: "invalid_hosted_frame" } };
	}
	return { ok: true, sessionIds: sessionIds as string[] };
}

/** Validate the assignments of a `hosted_sessions_ack` read off the wire; `undefined` when they are not. */
export function readHostedSessionAssignments(value: JsonWireValue | undefined): HostedSessionAssignment[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const assignments: HostedSessionAssignment[] = [];
	for (const item of value) {
		if (!isWireObject(item) || typeof item.key !== "string" || !isNonEmptyString(item.sessionId)) return undefined;
		const { liveRouteRefusal } = item;
		if (liveRouteRefusal !== undefined && !isLiveWorkflowStageRouteRefusalCode(liveRouteRefusal)) return undefined;
		assignments.push({
			key: item.key,
			sessionId: item.sessionId,
			...(liveRouteRefusal === undefined ? {} : { liveRouteRefusal }),
		});
	}
	return assignments;
}
