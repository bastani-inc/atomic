import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { jobTracker as defaultJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
export function createTempDir(prefix = "workflows-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {}
}

export function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of listeners.get(channel) ?? []) handler(payload);
		},
	};
}

// ---------------------------------------------------------------------------
// Background run helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a background workflow run to settle (any terminal status).
 * Prefers the JobTracker promise — that's set up by `runDetached()` and
 * resolves exactly when the executor finishes. Falls back to polling the
 * store snapshot for tests that pass a custom tracker or rely on the
 * default singleton.
 */
export async function waitForRun(
	runId: string,
	opts: { store?: Store; jobs?: JobTracker; timeoutMs?: number } = {},
): Promise<void> {
	const jobs = opts.jobs ?? defaultJobTracker;
	const job = jobs.get(runId);
	if (job) {
		try {
			await job.promise;
		} catch {
			// Background failures are recorded on the store by the executor; the
			// tracker promise rejects but we don't want test code to re-throw —
			// callers assert on store state after waiting.
		}
		return;
	}
	const store = opts.store;
	if (!store) return;
	const deadline = Date.now() + (opts.timeoutMs ?? 2000);
	while (Date.now() < deadline) {
		const run = store.runs().find((r) => r.id === runId);
		if (run?.endedAt !== undefined) return;
		await new Promise((r) => setTimeout(r, 5));
	}
}
