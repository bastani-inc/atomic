/** Text shared by workflow and session event children: the seed prompt and the report a subscriber receives. */

import { Type } from "typebox";
import { defineTool } from "../extensions/tool-types.ts";
import { isToolModifier } from "../settings-merge.js";
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

/**
 * An explicit tool allowlist keeps `report_to_subscriber` available. A list of `+name`/`-name` modifiers changes the
 * defaults and leaves custom tools enabled, so it needs no entry; a list that mixes names and modifiers is passed on
 * unchanged and fails with the usual tool-list error.
 */
export function toolsWithReport(tools: readonly string[]): string[] {
	if (tools.some(isToolModifier) || tools.includes(SUBSCRIPTION_REPORT_TOOL_NAME)) return [...tools];
	return [...tools, SUBSCRIPTION_REPORT_TOOL_NAME];
}

/** The message a subscriber receives for one report. */
export function formatEventReport(childName: string, eventId: string, text: string): string {
	return `Report from event child "${childName}" (event ${eventId}):\n\n${text}`;
}

const reportParameters = Type.Object({ text: Type.String({ description: "The report: a few sentences at most." }) });

/** The `report_to_subscriber` tool an event child gets; it calls `report` with the child's text. */
export function createSubscriberReportTool(report: (text: string) => Promise<void>, subscriber: "stage" | "session") {
	return defineTool({
		name: SUBSCRIPTION_REPORT_TOOL_NAME,
		label: "Report to subscriber",
		description: `Send a short report about this event to the ${subscriber} that subscribed to it. Call it at most once, and only when the event matters.`,
		parameters: reportParameters,
		async execute(_toolCallId, params) {
			await report(params.text);
			return { content: [{ type: "text", text: "Report delivered to the subscriber." }], details: undefined };
		},
	});
}
