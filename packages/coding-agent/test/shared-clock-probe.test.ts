import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
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
	stamp: 0,
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			io.calls.push("open");
			const file = await fs.open(...args);
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
			io.stamp = result.mtimeMs;
			return result;
		},
		unlink: (path: string) => {
			io.calls.push("unlink");
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

afterEach(() => {
	io.calls.length = 0;
	io.afterList = undefined;
	io.refuseDelete = false;
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
