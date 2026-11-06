/** Text shared by workflow and session event children: the seed prompt and the report a subscriber receives. */

import type { SubscriptionEvent } from "./types.js";

export const SUBSCRIPTION_REPORT_TOOL_NAME = "report_to_subscriber";

/** Seeds an event child: the subscriber's handling instructions, the event, and when to report. */
export function seedEventPrompt(instructions: string, subscription: string, event: SubscriptionEvent): string {
	return [
		instructions,
		"",
		"## Event",
		`Subscription: ${subscription}`,
		`Event id: ${event.id}`,
		...(event.type === undefined ? [] : [`Event type: ${event.type}`]),
		"Payload:",
		"```json",
		JSON.stringify(event.payload ?? null, null, 2),
		"```",
		"",
		`If this event matters to the subscriber, call \`${SUBSCRIPTION_REPORT_TOOL_NAME}\` once with a short report. If it does not matter, finish without calling it.`,
	].join("\n");
}

/** The message a subscriber receives for one report. */
export function formatEventReport(childName: string, eventId: string, text: string): string {
	return `Report from event child "${childName}" (event ${eventId}):\n\n${text}`;
}
