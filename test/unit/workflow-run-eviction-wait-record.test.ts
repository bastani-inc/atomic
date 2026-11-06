import { afterEach, beforeEach, describe, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, test, workflow } from "./executor-shared.js";
import { entriesOf, start } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

const watching = (text: string): boolean => text.startsWith("watch");

describe("a run whose waiting stage could not record its wait is not evicted (#4373)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z").getTime());
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("the stage's calls are answered from the live wait, and the run is never rebuilt (#4373)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (
				checkpoint.kind === "stage" &&
				checkpoint.wait !== undefined &&
				checkpoint.replayKey.startsWith("stage:agent:")
			)
				throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		const started = start(
			workflow({
				name: "evict-unrecorded-wait",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const stage = ctx.stage("agent");
					await Promise.all([
						ctx.stage("other").prompt("watch other"),
						(async () => {
							await stage.prompt("plan");
							await stage.sendUserMessage("watch ci");
						})(),
					]);
					return {};
				},
			}),
			{ durableBackend: backend, detachWhen: watching },
		);

		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(started.service.dispatches, 2);
		assert.deepEqual(entriesOf(started.runId), [], "evicted with a wait no replay can find");

		started.service.finishAll();
		let finished = false;
		void started.result.finally(() => {
			finished = true;
		});
		while (!finished) await vi.advanceTimersByTimeAsync(500);
		const result = await started.result;

		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 1);
		assert.equal(started.service.dispatches, 2);
		assert.equal(started.seen.continued.get("agent"), 1);
	});
});
