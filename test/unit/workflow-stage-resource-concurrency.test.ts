import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type PiCodingAgentSdk,
	prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/atomic-stage-session.js";
import type { StageStartupPhase } from "../../packages/workflows/src/shared/stage-startup.js";

function reloadFixture(count: number) {
	const gates = Array.from({ length: count }, () => Promise.withResolvers<void>());
	const phases: StageStartupPhase[][] = Array.from({ length: count }, () => []);
	const started: number[] = [];
	let active = 0;
	let peak = 0;
	const sdk: PiCodingAgentSdk = {
		getAgentDir: () => "/tmp/workflow-reload-test",
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			private readonly id: number;
			constructor(options: { cwd: string }) {
				this.id = Number(options.cwd);
			}
			async reload() {
				started.push(this.id);
				active++;
				peak = Math.max(peak, active);
				try {
					await gates[this.id]!.promise;
				} finally {
					active--;
				}
			}
		},
		async createAgentSession() {
			assert.fail("resource preparation must not create a session");
		},
	};
	return {
		gates,
		phases,
		started,
		get active() {
			return active;
		},
		get peak() {
			return peak;
		},
		prepare(id: number, signal?: AbortSignal) {
			return prepareAtomicStageSessionOptions({ cwd: String(id) }, sdk, {
				signal,
				onStartupPhase: (phase) => phases[id]!.push(phase),
			});
		},
	};
}

async function flushStartup(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("prepares four workflow resource loaders concurrently and queues excess stages in order (#3861)", async () => {
	const fixture = reloadFixture(10);
	const preparations = fixture.gates.map((_, id) => fixture.prepare(id));
	try {
		await flushStartup();
		assert.deepEqual([...fixture.started], [0, 1, 2, 3], "one stalled loader must not serialize its siblings");
		assert.equal(fixture.active, 4);
		assert.deepEqual(fixture.phases[0], ["resource-preparation", "reload-queued", "reload-active"]);
		assert.deepEqual(fixture.phases[4], ["resource-preparation", "reload-queued"]);
		for (let id = 0; id < 6; id++) {
			fixture.gates[id]!.resolve();
			await preparations[id];
			await flushStartup();
			assert.equal(fixture.started.at(-1), id + 4);
			assert.equal(fixture.active, 4);
		}
	} finally {
		for (const gate of fixture.gates) gate.resolve();
		await Promise.allSettled(preparations);
	}
	assert.equal(fixture.peak, 4, "the process-wide reload bound must hold across the whole fan-out");
	assert.equal(fixture.active, 0);
});

test("cancels queued preparation promptly without releasing a cancelled active reload's slot (#3861)", async () => {
	const fixture = reloadFixture(7);
	const activeOwner = new AbortController();
	const queuedOwner = new AbortController();
	const activeReason = new Error("active stage cancelled");
	const queuedReason = new Error("queued stage cancelled");
	const preparations = fixture.gates
		.slice(0, 6)
		.map((_, id) => fixture.prepare(id, id === 0 ? activeOwner.signal : id === 4 ? queuedOwner.signal : undefined));
	let activeSettled = false;
	let queuedSettled = false;
	const activeFailure = assert.rejects(preparations[0]!, (error) => {
		activeSettled = true;
		return error === activeReason;
	});
	const queuedFailure = assert.rejects(preparations[4]!, (error) => {
		queuedSettled = true;
		return error === queuedReason;
	});
	try {
		await flushStartup();
		activeOwner.abort(activeReason);
		queuedOwner.abort(queuedReason);
		preparations.push(fixture.prepare(6));
		await flushStartup();
		assert.equal(queuedSettled, true, "queued cancellation must not wait for a reload slot");
		assert.equal(activeSettled, false, "active preparation owns its slot until reload settles");
		assert.deepEqual([...fixture.started], [0, 1, 2, 3]);
		assert.deepEqual(fixture.phases[4], ["resource-preparation", "reload-queued"]);
		fixture.gates[0]!.resolve();
		await activeFailure;
		await flushStartup();
		assert.deepEqual([...fixture.started], [0, 1, 2, 3, 5], "skip the aborted waiter, preserving FIFO order");
		assert.equal(fixture.active, 4);
	} finally {
		for (const gate of fixture.gates) gate.resolve();
		await Promise.allSettled([...preparations, activeFailure, queuedFailure]);
	}
	assert.equal(fixture.started.includes(4), false, "cancelled waiters must never reload later");
	assert.equal(fixture.peak, 4);
});

test("a rejected resource reload releases capacity for queued workflow stages (#3861)", async () => {
	const fixture = reloadFixture(5);
	const preparations = fixture.gates.map((_, id) => fixture.prepare(id));
	const failure = new Error("resource discovery failed");
	const rejected = assert.rejects(preparations[0]!, (error) => error === failure);
	try {
		await flushStartup();
		assert.deepEqual([...fixture.started], [0, 1, 2, 3]);
		fixture.gates[0]!.reject(failure);
		await rejected;
		await flushStartup();
		assert.deepEqual([...fixture.started], [0, 1, 2, 3, 4]);
		assert.equal(fixture.active, 4);
	} finally {
		for (const gate of fixture.gates) gate.resolve();
		await Promise.allSettled([...preparations, rejected]);
	}
	assert.equal(fixture.peak, 4);
	assert.equal(fixture.active, 0);
});
