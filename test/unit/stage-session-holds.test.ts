import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import { StageSessionHolds } from "../../packages/workflows/src/runs/foreground/stage-session-holds.js";

function event(type: string): AgentSessionEvent {
	return { type } as AgentSessionEvent;
}

describe("what holds a stage's live session (#4642)", () => {
	test("a subscription holds the session until it ends, once, and tells the listeners", () => {
		const holds = new StageSessionHolds();
		let lifted = 0;
		let unsubscribed = 0;
		holds.onLifted(() => {
			lifted += 1;
		});
		const end = holds.subscription(() => {
			unsubscribed += 1;
		});
		assert.equal(holds.held, true);
		assert.equal(holds.holdsTaken, 1);

		end();
		end();

		assert.equal(holds.held, false);
		assert.equal(unsubscribed, 1, "the subscription is ended once");
		assert.equal(lifted, 1, "the end of a hold is reported once");
		assert.equal(holds.holdsTaken, 1);
	});

	test("an operation holds the session while it runs, even when it fails", async () => {
		const holds = new StageSessionHolds();
		let lifted = 0;
		holds.onLifted(() => {
			lifted += 1;
		});
		let heldInside = false;
		assert.equal(
			await holds.operation(async () => {
				heldInside = holds.held;
				return "done";
			}),
			"done",
		);
		await assert.rejects(
			holds.operation(async () => {
				throw new Error("turn failed");
			}),
			/turn failed/,
		);

		assert.equal(heldInside, true);
		assert.equal(holds.held, false);
		assert.equal(holds.holdsTaken, 2);
		assert.equal(lifted, 2);
	});

	test("only the session events after which it may be quiet tell the listeners", () => {
		const holds = new StageSessionHolds();
		const seen: string[] = [];
		let next = "";
		holds.onLifted(() => seen.push(next));
		for (const type of ["message_update", "agent_start", "turn_end", "tool_execution_end", "entry_appended"]) {
			next = type;
			holds.observe(event(type));
		}
		for (const type of ["agent_end", "agent_settled", "queue_update", "compaction_end", "auto_retry_end"]) {
			next = type;
			holds.observe(event(type));
		}

		assert.deepEqual(seen, ["agent_end", "agent_settled", "queue_update", "compaction_end", "auto_retry_end"]);
		assert.equal(holds.holdsTaken, 0, "observing events takes no hold");
	});

	test("a listener that stopped watching, or every listener after clear, is told nothing", () => {
		const holds = new StageSessionHolds();
		let stopped = 0;
		let cleared = 0;
		const stop = holds.onLifted(() => {
			stopped += 1;
		});
		holds.onLifted(() => {
			cleared += 1;
		});
		stop();
		holds.observe(event("agent_end"));
		holds.clear();
		holds.observe(event("agent_end"));

		assert.equal(stopped, 0);
		assert.equal(cleared, 1);
	});
});
