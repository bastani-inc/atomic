import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
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

async function createCompactingSession(): Promise<{ harness: Harness; releaseCompaction: () => void }> {
	const harness = await createHarness();
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
});
