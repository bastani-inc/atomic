import assert from "node:assert/strict";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { lockShared, sharedClockNow, sharedClockOffset } from "../src/core/worktree-snapshot/shared-clock.js";

const names = vi.hoisted(() => [] as Buffer[]);
vi.mock("node:crypto", async (original) => {
	const crypto = await original<typeof import("node:crypto")>();
	return { ...crypto, randomBytes: (n: number) => names.shift() ?? crypto.randomBytes(n) };
});

const io = vi.hoisted(() => ({
	calls: [] as string[],
	afterList: undefined as (() => void) | undefined,
	refuseDelete: false,
	withoutDeleteOnClose: false,
	beforeOpen: undefined as (() => void) | undefined,
	nativeTick: undefined as (() => number) | undefined,
	onStat: undefined as ((path: string) => void) | undefined,
	refusalClock: undefined as { now: number; stamp: number } | undefined,
	stamp: 0,
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		open: (path: string, flags: string, callback: (err: NodeJS.ErrnoException | null, fd: number) => void) => {
			io.calls.push("open");
			io.beforeOpen?.();
			if (io.refusalClock) io.refusalClock.stamp = io.refusalClock.now;
			fs.open(path, flags, callback);
		},
		stat: (path: string, callback: (err: NodeJS.ErrnoException | null, stats?: import("node:fs").Stats) => void) => {
			io.calls.push("stat");
			fs.stat(path, (error, stats) => {
				if (error) return callback(error);
				io.onStat?.(path);
				io.stamp = stats.mtimeMs;
				callback(null, stats);
			});
		},
		unlink: (path: string, callback: (err: NodeJS.ErrnoException | null) => void) => {
			io.calls.push("unlink");
			if (io.refusalClock) io.refusalClock.now += 150;
			if (io.refuseDelete) return callback(Object.assign(new Error("sharing violation"), { code: "EBUSY" }));
			fs.unlink(path, callback);
		},
		close: (fd: number, callback: (err: NodeJS.ErrnoException | null) => void) => {
			io.calls.push("close");
			fs.close(fd, callback);
		},
	};
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: (...args: Parameters<typeof fs.open>) => {
			io.calls.push("open");
			return fs.open(...args);
		},
		stat: async (path: string) => {
			io.calls.push("stat");
			const result = await fs.stat(path);
			io.onStat?.(path);
			io.stamp = result.mtimeMs;
			return io.refusalClock ? { ...result, mtimeMs: io.refusalClock.stamp } : result;
		},
		unlink: (path: string) => {
			io.calls.push("unlink");
			if (io.refusalClock) io.refusalClock.now += 150;
			if (io.refuseDelete) return Promise.reject(Object.assign(new Error("sharing violation"), { code: "EBUSY" }));
			return fs.unlink(path);
		},
		readdir: async (path: string) => {
			io.calls.push("readdir");
			const entries = await fs.readdir(path);
			io.afterList?.();
			return entries;
		},
	};
});

const loadedKey = Symbol.for("@bastani/atomic/windows-temporary@4");
let originalRegistration: PropertyDescriptor | undefined;
beforeAll(() => {
	if (process.platform !== "win32") return;
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives");
	originalRegistration = Object.getOwnPropertyDescriptor(process, loadedKey);
	assert.ok(originalRegistration);
	Object.defineProperty(process, loadedKey, {
		configurable: true,
		get: () =>
			io.withoutDeleteOnClose
				? undefined
				: {
						deref: () => ({
							...binding,
							windowsClockTick: () => io.refusalClock?.now ?? io.nativeTick?.() ?? binding.windowsClockTick(),
							readWindowsClockProbe: async (path: string) => {
								io.calls.push("sample");
								io.beforeOpen?.();
								const clock = io.refusalClock;
								if (!clock) {
									const reading = await binding.readWindowsClockProbe(path);
									if (reading) {
										if (io.nativeTick) reading.sampledAtMs = io.nativeTick();
										io.stamp = reading.mtimeMs;
										io.onStat?.(path);
									}
									return reading;
								}
								clock.stamp = clock.now;
								return {
									mtimeMs: clock.stamp,
									sampledAtMs: clock.now,
									pending: {
										close: async () => {
											clock.now += 150;
										},
									},
								};
							},
						}),
					},
	});
});
afterAll(() => {
	if (originalRegistration) Object.defineProperty(process, loadedKey, originalRegistration);
});

afterEach(() => {
	io.calls.length = 0;
	io.afterList = undefined;
	io.refuseDelete = false;
	io.withoutDeleteOnClose = false;
	io.refusalClock = undefined;
	io.beforeOpen = undefined;
	io.nativeTick = undefined;
	io.onStat = undefined;
	names.length = 0;
	vi.restoreAllMocks();
});

test.runIf(process.platform === "win32")(
	"a Windows probe is reclaimed even when deleting its name is refused (#5605, #5634)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "clock-cleanup-"));
		try {
			io.refuseDelete = true;
			const time = Date.now.bind(Date);
			vi.spyOn(Date, "now").mockImplementation(() => time() + 180_000);
			const offset = await sharedClockOffset(directory);
			assert.ok(Math.abs(offset + 180_000) < 10_000, `expected a filesystem reading; got ${offset}`);
			io.refuseDelete = false;
			await sharedClockOffset(`${directory}/.`);
			assert.deepEqual(readdirSync(directory), []);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test.runIf(process.platform === "win32")(
	"a slow refused delete costs a reading only one refusal and does not skew the offset (#5605, #5674)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "clock-refused-"));
		try {
			await sharedClockOffset(directory); // the periodic sweep is not due during the timed reading
			const start = Date.now();
			const clock = { now: start, stamp: 0 };
			io.refusalClock = clock;
			io.refuseDelete = true;
			vi.spyOn(Date, "now").mockImplementation(() => clock.now);
			vi.spyOn(performance, "now").mockImplementation(() => clock.now);
			const offset = await sharedClockOffset(directory);
			assert.equal(clock.now - start, 150);
			assert.equal(offset, 0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test.runIf(process.platform === "win32")(
	"a compatible reader does not keep a finished probe's name in the pool (#5605)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "clock-reader-"));
		let reader: number | undefined;
		try {
			io.onStat = (path) => {
				reader ??= openSync(path, "r");
			};
			await sharedClockOffset(directory);
			assert.notEqual(reader, undefined);
			assert.deepEqual(readdirSync(directory), []);
		} finally {
			if (reader !== undefined) closeSync(reader);
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test.runIf(process.platform === "win32")(
	"a failed create in a missing directory is not tried again with the binding loaded (#5674)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "clock-missing-"));
		try {
			assert.equal(await sharedClockOffset(join(directory, "missing")), 0);
			assert.deepEqual(io.calls, ["sample"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("without delete-on-close a reading stays accurate and performs just its original I/O (#5605, #5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-fallback-"));
	try {
		io.withoutDeleteOnClose = true;
		const time = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(time + 180_000);
		vi.spyOn(performance, "now").mockReturnValue(0);
		await sharedClockOffset(directory); // warm the periodic directory sweep
		io.calls.length = 0;
		io.refuseDelete = true;
		const offset = await sharedClockOffset(directory);
		assert.equal(offset, io.stamp - (time + 180_000));
		assert.deepEqual(io.calls, ["open", "close", "stat", "unlink"]);
		assert.equal(readdirSync(directory).length, 1);
		io.refuseDelete = false;
		io.calls.length = 0;
		await sharedClockOffset(directory);
		assert.deepEqual(io.calls, ["open", "close", "stat", "unlink"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an invalid directory returns the local clock fallback (#5674)", async () => {
	io.withoutDeleteOnClose = true;
	vi.spyOn(Date, "now").mockReturnValue(123_456);
	assert.equal(await sharedClockOffset("ok\0bad"), 0);
	assert.equal(await sharedClockNow("ok\0bad"), 123_456);
});

test("a civil clock correction before a failed probe is delivered does not move its fallback (#5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-fallback-step-"));
	try {
		let time = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => time);
		io.beforeOpen = () => {
			time += 180_000;
		};
		assert.equal(await sharedClockNow(join(directory, "missing")), 10_000);
		assert.equal(time, 190_000);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("probe queue time is not added to the filesystem timestamp (#5050, #5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-queued-"));
	try {
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		io.beforeOpen = () => {
			elapsed += 7_000;
		};
		const now = await sharedClockNow(directory);
		assert.equal(elapsed, 7_000);
		assert.ok(Math.abs(now - io.stamp) < 100, `waiting to create the file added ${now - io.stamp} ms`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test.runIf(process.platform === "win32")("a paused contender cannot take a renewed lock (#5050)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-paused-lock-"));
	const slot = join(directory, "slot");
	let release: (() => Promise<void>) | undefined;
	try {
		mkdirSync(`${slot}.lock`);
		let elapsed = 0;
		const end = Date.now();
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		vi.spyOn(Date, "now").mockImplementation(() => end - 7_000 + elapsed);
		io.beforeOpen = () => {
			elapsed = 7_000;
			// The owner refreshed while the contender was descheduled before entering the worker.
			utimesSync(`${slot}.lock`, new Date(end), new Date(end));
		};
		await assert.rejects(
			async () => {
				release = await lockShared(slot, { realpath: false, stale: 5_000, retries: 0 });
			},
			{ code: "ELOCKED" },
		);
		assert.equal(elapsed, 7_000);
	} finally {
		await release?.();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("filesystem time includes time spent sweeping probes after the measurement (#5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-time-"));
	try {
		let time = Date.now();
		io.nativeTick = () => time;
		vi.spyOn(Date, "now").mockImplementation(() => time);
		vi.spyOn(performance, "now").mockImplementation(() => time);
		io.afterList = () => {
			time += 1_000;
		};
		const now = await sharedClockNow(directory);
		assert.equal(now, io.stamp + 1_000);
		if (process.platform !== "win32") assert.deepEqual(io.calls, ["open", "close", "stat", "unlink", "readdir"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stepping the reader's wall clock during cleanup does not age a fresh remote marker (#5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-step-"));
	try {
		const time = Date.now.bind(Date);
		let step = 0;
		vi.spyOn(Date, "now").mockImplementation(() => time() + step);
		io.afterList = () => {
			step = 180_000;
		};
		const now = await sharedClockNow(directory);
		assert.equal(step, 180_000);
		assert.ok(Math.abs(now - io.stamp) < 10_000, `filesystem time jumped by ${now - io.stamp} ms`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a clock step during a relative reading does not make a fresh lock thirty seconds old (#5050, #5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-relative-step-"));
	try {
		const time = Date.now.bind(Date);
		let step = 0;
		vi.spyOn(Date, "now").mockImplementation(() => time() + step);
		io.onStat = () => {
			step = 45_000;
		};
		const offset = await sharedClockOffset(directory);
		assert.equal(step, 45_000);
		assert.ok(Date.now() + offset - io.stamp < 30_000, "fresh lock appeared stale");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a clock reading preserves a recent file on a probe name collision and still measures the directory (#5634)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-collision-"));
	try {
		const name = Buffer.alloc(8, 0xab);
		names.push(name);
		const existing = join(directory, `.clock-${name.toString("hex")}.probe`);
		writeFileSync(existing, "a different reading");
		const now = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => now() + 180_000);
		const offset = await sharedClockOffset(directory);
		assert.equal(readFileSync(existing, "utf8"), "a different reading");
		assert.ok(Math.abs(offset + 180_000) < 10_000, `expected a filesystem reading; got ${offset}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
