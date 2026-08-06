import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import { progressEmissionFor } from "../../packages/subagents/src/runs/inprocess/runner.ts";

/**
 * The in-process runner publishes AgentProgress into chat scrollback, which can
 * sit above pi-tui's viewport fold. A publish for an event the widget does not
 * render still repaints an above-fold row, which makes pi-tui take its
 * `firstChanged < viewportTop` branch and issue a scrollback-clearing full
 * redraw. These tests pin the narrow emission table that keeps that from firing
 * on every streaming delta.
 */

type EventType = AgentSessionEvent["type"];

const FORCED: readonly EventType[] = ["agent_start", "tool_execution_start", "tool_execution_end"];
const THROTTLED: readonly EventType[] = ["message_end"];

/**
 * High-frequency traffic the live widget never renders. `message_update` is the
 * assistant streaming delta and fires many times per second; publishing there is
 * what destroyed the user's scrollback on every Ctrl+O-expanded subagent run.
 */
const SILENT: readonly EventType[] = [
	"message_update",
	"message_start",
	"tool_execution_update",
	"turn_start",
	"turn_end",
	"entry_appended",
	"queue_update",
	"agent_settled",
	"agent_end",
	"bash_execution_update",
	"session_info_changed",
	"model_changed",
	"thinking_level_changed",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"model_fallback_start",
	"model_fallback_end",
];

describe("in-process runner progress emission profile", () => {
	test("events that change rendered progress publish immediately", () => {
		for (const eventType of FORCED) {
			assert.equal(progressEmissionFor(eventType), "force", `${eventType} must bypass the throttle`);
		}
	});

	test("message_end publishes under the 400 ms throttle", () => {
		for (const eventType of THROTTLED) {
			assert.equal(progressEmissionFor(eventType), "throttled", `${eventType} must stay throttled`);
		}
	});

	test("high-frequency events the widget does not render publish nothing", () => {
		for (const eventType of SILENT) {
			assert.equal(
				progressEmissionFor(eventType),
				"none",
				`${eventType} must not repaint the live subagent widget; a catch-all publish here clears the ` +
					"user's terminal scrollback on every streaming delta",
			);
		}
	});

	test("there is no catch-all: unknown events default to none", () => {
		assert.equal(progressEmissionFor("some_future_event" as EventType), "none");
	});

	test("streaming a realistic turn publishes once per milestone, not once per delta", () => {
		// One assistant turn: 40 streaming deltas around a single tool call.
		const stream: EventType[] = [
			"agent_start",
			"turn_start",
			"message_start",
			...Array.from({ length: 20 }, (): EventType => "message_update"),
			"message_end",
			"tool_execution_start",
			...Array.from({ length: 8 }, (): EventType => "tool_execution_update"),
			"tool_execution_end",
			"message_start",
			...Array.from({ length: 20 }, (): EventType => "message_update"),
			"message_end",
			"turn_end",
			"agent_settled",
		];
		const published = stream.filter((eventType) => progressEmissionFor(eventType) !== "none");
		assert.deepEqual(published, [
			"agent_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_end",
		]);
		assert.equal(published.length, 5, `55 session events must publish 5 progress updates, not ${stream.length}`);
	});
});
