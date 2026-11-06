import assert from "node:assert/strict";
import {
	createSubscriberReportTool,
	formatEventReport,
	SUBSCRIPTION_REPORT_TOOL_NAME,
	seedEventPrompt,
} from "@bastani/atomic";
import { test } from "vitest";

test("an event child's seed carries the instructions, the event and when to report", () => {
	assert.equal(
		seedEventPrompt("Triage CI.", "ci", { id: "run-7", type: "check_run", payload: { failed: true } }),
		[
			"Triage CI.",
			"",
			"## Event",
			"Subscription: ci",
			"Event id: run-7",
			"Event type: check_run",
			"Payload:",
			"```json",
			'{\n  "failed": true\n}',
			"```",
			"",
			"If this event matters to the subscriber, call `report_to_subscriber` once with a short report. If it does not matter, finish without calling it.",
		].join("\n"),
	);
	assert.equal(
		seedEventPrompt("", "logs", { id: "l1" }),
		[
			"",
			"",
			"## Event",
			"Subscription: logs",
			"Event id: l1",
			"Payload:",
			"```json",
			"null",
			"```",
			"",
			"If this event matters to the subscriber, call `report_to_subscriber` once with a short report. If it does not matter, finish without calling it.",
		].join("\n"),
	);
	assert.equal(
		formatEventReport("ci/run-7", "run-7", "red"),
		'Report from event child "ci/run-7" (event run-7):\n\nred',
	);
});

test("the report tool tells the model what it is for and passes the text through", async () => {
	const reports: string[] = [];
	const tool = createSubscriberReportTool(async (text) => {
		reports.push(text);
	}, "stage");
	assert.equal(tool.name, SUBSCRIPTION_REPORT_TOOL_NAME);
	assert.equal(tool.name, "report_to_subscriber");
	assert.equal(tool.label, "Report to subscriber");
	assert.equal(
		tool.description,
		"Send a short report about this event to the stage that subscribed to it. Call it at most once, and only when the event matters.",
	);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["text"]);
	const result = await tool.execute("call-1", { text: "deploy failed" }, undefined, undefined, undefined as never);
	assert.deepEqual(result, {
		content: [{ type: "text", text: "Report delivered to the subscriber." }],
		details: undefined,
	});
	assert.deepEqual(reports, ["deploy failed"]);
	assert.match(createSubscriberReportTool(async () => {}, "session").description, /to the session that subscribed/);
});
