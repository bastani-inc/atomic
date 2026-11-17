import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { subagentWakeNamespace } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { registerSubagentChildRecordReader } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.ts";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
	subagentChildRecordFailures,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { launchReleasedTask } from "../helpers/released-task-launch.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
});

test(
	"a released child whose record cannot be read once its run ends is reported to its owner, never left as an unhandled rejection",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const dispatcher = new AgentWakeDispatcher();
		dispatcher.handle(subagentWakeNamespace(owner.getSessionId()), async () => {});
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: "wake-read-owner" },
			authorizeLaunch() {},
		});
		cleanups.push(async () => {
			await host.close("session-close");
		});
		// A copy of the owner's session, read first, whose store fails to read a released child's record. Its run's own
		// records are still saved and found: only the read that looks for results held while it ran fails.
		const storeFailed = new RangeError("the session's store failed");
		const failingCopy = {
			getSessionId: () => owner.getSessionId(),
			getLeafEntry: () => owner.getLeafEntry(),
			getEntry: (id: string) => {
				const entry = owner.getEntry(id);
				const data = entry?.type === "custom" ? (entry.data as SubagentChildRecord) : undefined;
				if (data?.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) throw storeFailed;
				return entry;
			},
		};
		// Readers are held weakly: the test keeps this copy open until its end, as an open session keeps itself.
		registerSubagentChildRecordReader(failingCopy, true);
		const failures = subagentChildRecordFailures.count;
		const unhandled: unknown[] = [];
		const recordUnhandled = (reason: unknown) => unhandled.push(reason);
		process.prependListener("unhandledRejection", recordUnhandled);
		cleanups.push(() => void process.removeListener("unhandledRejection", recordUnhandled));

		await launchReleasedTask(0, env, host, owner, dispatcher);
		for (let turn = 0; turn < 400 && unhandled.length === 0 && subagentChildRecordFailures.count === failures; turn++)
			await new Promise((resolve) => setTimeout(resolve, 25));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(unhandled, [], "the failed read escaped as an unhandled rejection");
		assert.equal(subagentChildRecordFailures.count, failures + 1);
		const reported = subagentChildRecordFailures.last;
		assert.deepEqual(
			[reported?.code, reported?.fields.childId, reported?.fields.reason, reported?.cause],
			["wake-failed", "gct-0:0", storeFailed.message, storeFailed],
		);
		assert.equal(failingCopy.getSessionId(), owner.getSessionId());
	},
	CHILD_LOAD_TIMEOUT_MS,
);
