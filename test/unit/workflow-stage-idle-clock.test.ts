import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { StageIdleReleaser } from "../../packages/workflows/src/runs/foreground/stage-idle-release.js";
import { sleep } from "../helpers/runtime.js";

/** The stage's `releaseWhenWaiting` threshold. */
const AFTER_MS = 200;
/** How far the wall clock steps back while the stage is idle, as an NTP correction might. */
const STEP_BACK_MS = 5_000;

afterEach(() => {
	vi.restoreAllMocks();
});

test("an idle stage is released after its threshold even if the wall clock steps back meanwhile (#5058)", async () => {
	const releaser = new StageIdleReleaser(() => {});
	const idleAt = performance.now();
	let releasedAfterMs: number | undefined;
	releaser.watch("stage", {
		afterMs: AFTER_MS,
		idleSince: () => idleAt,
		release: async () => {
			releasedAfterMs = performance.now() - idleAt;
		},
	});
	await sleep(AFTER_MS / 4);
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() - STEP_BACK_MS);
	try {
		await vi.waitFor(() => assert.notEqual(releasedAfterMs, undefined), { timeout: STEP_BACK_MS / 2, interval: 20 });
		assert.ok(releasedAfterMs! >= AFTER_MS, `released after ${releasedAfterMs} ms`);
	} finally {
		releaser.dispose();
	}
});
