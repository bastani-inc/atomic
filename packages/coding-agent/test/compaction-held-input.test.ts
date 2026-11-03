import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { sleep, waitFor } from "./helpers/busy-submission-rig.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

type CompactionInternals = {
	_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
};

const harnesses: Harness[] = [];
const heldCompactions: Array<() => void> = [];

afterEach(async () => {
	for (const release of heldCompactions.splice(0)) release();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function createCompactingSession(
	extensionFactories?: ExtensionFactory[],
): Promise<{ harness: Harness; releaseCompaction: () => void }> {
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("done")));
	const release = Promise.withResolvers<undefined>();
	vi.spyOn(harness.session as unknown as CompactionInternals, "_applyVerbatimCompaction").mockImplementation(
		() => release.promise,
	);
	const releaseCompaction = () => release.resolve(undefined);
	heldCompactions.push(releaseCompaction);
	return { harness, releaseCompaction };
}

describe("input held while the session compacts", () => {
	for (const stop of ["pause", "pause and abort"] as const) {
		test(`keeps a held message queued when the queue is paused (${stop}) before compaction ends (#4251)`, async () => {
			const { harness, releaseCompaction } = await createCompactingSession();
			const compaction = harness.session.compact().catch((error: Error) => error);
			await waitFor("compaction to start", () => harness.session.isCompacting);

			const held = harness.session.prompt("sent during compaction");
			// Let the message pass its input checks and wait for compaction before the queue is paused.
			await sleep(20);
			harness.session.pauseQueuedMessages();
			const abort = stop === "pause and abort" ? harness.session.abort() : undefined;
			releaseCompaction();
			await compaction;
			await abort;
			await held;

			assert.equal(harness.session.queuedMessagesPaused, true);
			assert.deepEqual(harness.session.getSteeringMessages(), ["sent during compaction"]);
			assert.equal(harness.faux.state.callCount, 0);
			assert.deepEqual(getUserTexts(harness), []);

			await harness.session.resumeQueuedMessages();
			await harness.session.prompt("next message");
			assert.deepEqual(getUserTexts(harness).sort(), ["next message", "sent during compaction"]);
		});
	}

	test("holds input that an input hook sends while the session compacts (#4251)", async () => {
		let session: AgentSession | undefined;
		const { harness, releaseCompaction } = await createCompactingSession([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== "outer") return { action: "continue" };
					// The hook waits for the input it sends; that input must still wait for compaction.
					await session?.prompt("nested", { streamingBehavior: "steer" });
					return { action: "handled" };
				});
			},
		]);
		session = harness.session;
		const compaction = harness.session.compact().catch((error: Error) => error);
		await waitFor("compaction to start", () => harness.session.isCompacting);

		const outer = harness.session.prompt("outer");
		await sleep(50);
		assert.equal(harness.session.isCompacting, true, "compaction must still be running");
		assert.equal(harness.faux.state.callCount, 0, "no provider request may start during compaction");
		assert.deepEqual(getUserTexts(harness), []);

		releaseCompaction();
		await compaction;
		await outer;
		assert.deepEqual(getUserTexts(harness), ["nested"]);
		assert.equal(harness.faux.state.callCount, 1);
	});
});
