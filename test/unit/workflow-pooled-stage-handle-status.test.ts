/**
 * The root mirror of a stage on a local worker follows the stage's status (#3996).
 */
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { test } from "vitest";
import { openPooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import type { PooledStageWatchMessage, WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";

test("a stage watched while paused reads running once it is resumed (#3996)", async () => {
	let send: ((message: PooledStageWatchMessage) => void) | undefined;
	const opened = await openPooledStageHandle(
		{
			async watch(_ref, listener) {
				send = listener;
				return {
					ok: true,
					watch: {
						id: "watch-1" as WatchId,
						attempt: { workId: "work", generation: 1 },
						snapshot: {
							sessionId: "session",
							status: "paused",
							isStreaming: false,
							messages: [],
							pendingToolExecutionEvents: [],
							queued: { steering: [], followUp: [] },
							seq: 3,
						},
					},
				};
			},
			async unwatch() {},
		},
		{ runId: "child", stageId: "agent" },
		"agent",
	);
	assert.ok(opened.ok);
	assert.equal(opened.handle.status, "paused");
	send?.({ kind: "events", events: [{ seq: 4, event: { type: "agent_start" } as AgentSessionEvent }] });
	assert.equal(opened.handle.status, "running");
	assert.equal(opened.handle.isStreaming, true);
});
