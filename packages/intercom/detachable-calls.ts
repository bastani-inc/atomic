import { type ExtensionAPI, isStaleExtensionContextError } from "@bastani/atomic";

export function intercomCallMayDetach(params: { readonly action?: string }): boolean {
	return params.action === "ask";
}

export function contactSupervisorCallMayDetach(params: { readonly reason?: string }): boolean {
	return params.reason === "need_decision" || params.reason === "interview_request";
}

export function heavyToolCallMayDetach(toolName: string, params: { readonly action?: string; readonly reason?: string }): boolean {
	if (toolName === "intercom") return intercomCallMayDetach(params);
	return toolName === "contact_supervisor" && contactSupervisorCallMayDetach(params);
}

export async function appendEntryUnlessReleased<T>(
	pi: Pick<ExtensionAPI, "appendEntry">,
	customType: string,
	data: T,
): Promise<"appended" | "released"> {
	try {
		await pi.appendEntry(customType, data);
		return "appended";
	} catch (error) {
		if (isStaleExtensionContextError(error)) return "released";
		throw error;
	}
}
