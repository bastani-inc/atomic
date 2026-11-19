import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, test, vi } from "vitest";
import { sharedClockNow, sharedClockOffset } from "../src/core/worktree-snapshot/shared-clock.js";

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
	onStat: undefined as ((path: string) => void) | undefined,
	refusalClock: undefined as { now: number; stamp: number } | undefined,
	stamp: 0,
}));
vi.mock("../src/core/worktree-snapshot/windows-temporary.ts", async (original) => {
	const actual = await original<typeof import("../src/core/worktree-snapshot/windows-temporary.ts")>();
	return {
		openWindowsTemporary: (path: string, kind: "record" | "clock") => {
			const clock = io.refusalClock;
			if (clock) {
				if (kind !== "clock") {
					clock.now += 150; // asking for delete-on-close at creation is refused
					return undefined;
				}
				writeFileSync(path, "", { flag: "wx" });
				clock.stamp = clock.now;
				return {
					close: async () => {
						clock.now += 150;
					},
				}; // one refused disposition on the original handle
			}
			return io.withoutDeleteOnClose ? undefined : actual.openWindowsTemporary(path, kind);
		},
		sweepWindowsProbe: (path: string, before: number) =>
			io.withoutDeleteOnClose ? undefined : actual.sweepWindowsProbe(path, before),
	};
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			io.calls.push("open");
			const file = await fs.open(...args);
			if (io.refusalClock) io.refusalClock.stamp = io.refusalClock.now;
			const close = file.close.bind(file);
			file.close = () => {
				io.calls.push("close");
				return close();
			};
			return file;
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

beforeAll(() => {
	if (process.platform === "win32") createRequire(import.meta.url)("@bastani/atomic-natives");
});

afterEach(() => {
	io.calls.length = 0;
	io.afterList = undefined;
	io.refuseDelete = false;
	io.withoutDeleteOnClose = false;
	io.refusalClock = undefined;
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
	"a failed native create in a missing directory is not tried again (#5674)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "clock-missing-"));
		try {
			assert.equal(await sharedClockOffset(join(directory, "missing")), 0);
			assert.ok(!io.calls.includes("open"), "retried a failed native create by pathname");
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

test("filesystem time includes time spent sweeping probes after the measurement (#5674)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "clock-time-"));
	try {
		let time = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => time);
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
