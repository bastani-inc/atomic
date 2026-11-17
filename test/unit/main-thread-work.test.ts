import assert from "node:assert/strict";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, test, vi } from "vitest";
import { longestMainThreadBlockMs } from "../helpers/main-thread-work.js";

const priority = vi.hoisted(() => ({ value: 0, reads: 0, requests: [] as number[], refuse: false }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		getPriority: () => {
			priority.reads += 1;
			return priority.value;
		},
		setPriority: (value: number) => {
			priority.requests.push(value);
			if (priority.refuse) throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
			priority.value = value;
		},
	};
});

const BLOCK_LIMIT_MS = 50;
const BLOCKING_WORK_MS = 80;
const MICROTASK_SEGMENTS = 4;
const OUTSIDE_WORK_DELAY_MS = 10;
const { PRIORITY_HIGH, PRIORITY_HIGHEST, PRIORITY_NORMAL } = constants.priority;

function blockMainThread(durationMs: number): void {
	const end = performance.now() + durationMs;
	while (performance.now() < end) {}
}

function setPlatform(platform: NodeJS.Platform): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	return () => {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	};
}

async function measurementLoadedOn(platform: NodeJS.Platform): Promise<typeof longestMainThreadBlockMs> {
	const restorePlatform = setPlatform(platform);
	try {
		vi.resetModules();
		return (await import("../helpers/main-thread-work.js")).longestMainThreadBlockMs;
	} finally {
		restorePlatform();
	}
}

beforeEach(() => {
	priority.value = PRIORITY_NORMAL;
	priority.reads = 0;
	priority.requests = [];
	priority.refuse = false;
});

test("main-thread work excludes warm-up activity outside the requested operation (#5324)", async () => {
	const beforeWork = sleep(OUTSIDE_WORK_DELAY_MS).then(() => blockMainThread(BLOCKING_WORK_MS));
	const blockedMs = await longestMainThreadBlockMs(async () => {});
	await beforeWork;
	assert.ok(blockedMs < BLOCK_LIMIT_MS, `unrelated warm-up was counted as ${blockedMs} ms of work`);
});

test("main-thread work still detects a blocking operation (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		blockMainThread(BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of blocking work was recorded`);
});

test("main-thread work accumulates microtasks until the event loop can run (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		for (let index = 0; index < MICROTASK_SEGMENTS; index++) {
			blockMainThread(BLOCKING_WORK_MS / MICROTASK_SEGMENTS);
			await Promise.resolve();
		}
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of a starving microtask chain was recorded`);
});

test("main-thread work counts a synchronous wait that uses no CPU (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of a synchronous wait was recorded`);
});

test("main-thread work does not count asynchronous waiting as blocking (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		await sleep(BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs < BLOCK_LIMIT_MS, `${blockedMs} ms of asynchronous waiting was counted as blocking`);
});

test.each([
	{
		outcome: "rejects",
		operation: async () => {
			throw new Error("operation failed");
		},
	},
	{
		outcome: "throws before returning",
		operation: (): Promise<void> => {
			throw new Error("operation failed");
		},
	},
	{
		outcome: "is aborted",
		operation: () => {
			const controller = new AbortController();
			setImmediate(() => controller.abort(new Error("operation failed")));
			return new Promise<void>((_, reject) => {
				controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
			});
		},
	},
])(
	"Windows main-thread work runs ahead of other processes and restores the priority when the operation $outcome (#5324)",
	async ({ operation }) => {
		const measure = await measurementLoadedOn("win32");
		let priorityDuring: number | undefined;
		await assert.rejects(
			measure(() => {
				priorityDuring = priority.value;
				return operation();
			}),
			/operation failed/,
		);
		assert.equal(priorityDuring, PRIORITY_HIGH);
		assert.equal(priority.value, PRIORITY_NORMAL);
		assert.deepEqual(priority.requests, [PRIORITY_HIGH, PRIORITY_NORMAL]);
	},
);

test("overlapping Windows main-thread work raises the priority once and restores it after the last operation (#5324)", async () => {
	const measure = await measurementLoadedOn("win32");
	let finishFirst: () => void = () => {};
	const first = measure(
		() =>
			new Promise<void>((resolve) => {
				finishFirst = resolve;
			}),
	);
	let priorityAfterFirst: number | undefined;
	await measure(async () => {
		finishFirst();
		await first;
		priorityAfterFirst = priority.value;
	});
	assert.equal(priorityAfterFirst, PRIORITY_HIGH);
	assert.equal(priority.value, PRIORITY_NORMAL);
	assert.deepEqual(priority.requests, [PRIORITY_HIGH, PRIORITY_NORMAL]);
});

test.each([PRIORITY_HIGH, PRIORITY_HIGHEST])(
	"Windows main-thread work leaves a process already at priority %i as it is (#5324)",
	async (initial) => {
		priority.value = initial;
		const measure = await measurementLoadedOn("win32");
		await measure(async () => {});
		assert.equal(priority.value, initial);
		assert.deepEqual(priority.requests, []);
	},
);

test("a refused Windows priority raise still measures the operation and leaves nothing to restore (#5324)", async () => {
	const measure = await measurementLoadedOn("win32");
	priority.refuse = true;
	const blockedMs = await measure(async () => {
		blockMainThread(BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of blocking work was recorded`);
	assert.deepEqual(priority.requests, [PRIORITY_HIGH]);

	priority.refuse = false;
	let priorityDuring: number | undefined;
	await measure(async () => {
		priorityDuring = priority.value;
	});
	assert.equal(priorityDuring, PRIORITY_HIGH, "the refused raise left an owner behind");
	assert.deepEqual(priority.requests, [PRIORITY_HIGH, PRIORITY_HIGH, PRIORITY_NORMAL]);
});

test("main-thread work loaded off Windows never reads or changes the priority, even while Windows is simulated (#5324)", async () => {
	const measure = await measurementLoadedOn("linux");
	const restorePlatform = setPlatform("win32");
	try {
		await measure(async () => {});
	} finally {
		restorePlatform();
	}
	assert.equal(priority.reads, 0);
	assert.deepEqual(priority.requests, []);
});
