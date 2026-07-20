import type { IntercomEventBus } from "../shared/types.ts";

export const SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";

export interface SupervisorAuthorization {
	capability: string;
	supervisorSessionId: string;
	childName: string;
}

/** Ask the parent Intercom extension to mint a broker-issued child capability. */
export async function requestSupervisorAuthorization(
	events: IntercomEventBus | undefined,
	childName: string | undefined,
): Promise<SupervisorAuthorization | undefined> {
	const normalizedChildName = childName?.trim();
	if (!events || !normalizedChildName) return undefined;
	const request: { childName: string; completion?: Promise<SupervisorAuthorization> } = {
		childName: normalizedChildName,
	};
	events.emit(SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT, request);
	return request.completion ? await request.completion : undefined;
}
