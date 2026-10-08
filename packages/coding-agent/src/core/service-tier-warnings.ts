import type { AssistantMessage } from "@bastani/pi-ai/compat";

/** Warnings a response carries because a requested Fast or Ultrafast tier did not apply. */
export function serviceTierWarnings(message: AssistantMessage): string[] {
	return (message.diagnostics ?? []).flatMap((diagnostic) =>
		diagnostic.type === "service_tier_unavailable" && typeof diagnostic.details?.message === "string"
			? [diagnostic.details.message]
			: [],
	);
}
