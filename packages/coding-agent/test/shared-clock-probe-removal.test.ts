import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, test, vi } from "vitest";
import { lockShared, sharedClockOffset } from "../src/core/worktree-snapshot/shared-clock.js";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fsPromises>();
	return { ...actual, stat: vi.fn(actual.stat), unlink: vi.fn(actual.unlink) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "shared-clock-probe-"));
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.mocked(fsPromises.unlink).mockReset();
	vi.mocked(fsPromises.stat).mockReset();
	rmSync(directory, { recursive: true, force: true });
});

/** The probe files of the filesystem's clock in `directory`. */
const probes = () => readdirSync(directory).filter((name) => name.startsWith(".clock-"));

/**
 * Has Windows refuse deletes of probe files while `refuses(n)` says so for the `n`th such delete, with EPERM, EACCES and
 * EBUSY in turn, as when another program (an antivirus scan, the indexer) has the new file open for a moment. Each
 * refused delete fails after `refusalMs`.
 */
async function refuseProbeDeletes(refuses: (attempt: number) => boolean, refusalMs = 0): Promise<void> {
	const { unlink } = await vi.importActual<typeof fsPromises>("node:fs/promises");
	const codes = ["EPERM", "EACCES", "EBUSY"];
	let attempt = 0;
	vi.mocked(fsPromises.unlink).mockImplementation(async (path) => {
		if (!/\.clock-[0-9a-f]{16}\.probe$/.test(String(path)) || !refuses(++attempt)) return unlink(path);
		if (refusalMs > 0) await sleep(refusalMs);
		const code = codes[attempt % codes.length]!;
		throw Object.assign(new Error(`${code}: unlink '${String(path)}'`), { code });
	});
}

test("a clock probe whose delete Windows keeps refusing is removed by the next probe in its directory (#5605)", async () => {
	let refusing = true;
	await refuseProbeDeletes(() => refusing);

	assert.equal(Number.isFinite(await sharedClockOffset(directory)), true);
	assert.equal(probes().length, 1);
	refusing = false;
	await sharedClockOffset(directory);

	assert.deepEqual(probes(), []);
});

test("a clock reading whose probe delete Windows refuses still returns the filesystem clock's offset (#5605)", async () => {
	const ahead = 60 * 60_000;
	const { stat } = await vi.importActual<typeof fsPromises>("node:fs/promises");
	// The filesystem stamps probes an hour ahead of this process's clock, as on a share whose clock is off.
	vi.mocked(fsPromises.stat).mockImplementation((async (path: string) => {
		const stats = await stat(path);
		if (!/\.clock-[0-9a-f]{16}\.probe$/.test(String(path))) return stats;
		return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mtimeMs: stats.mtimeMs + ahead });
	}) as typeof fsPromises.stat);
	await refuseProbeDeletes(() => true);

	const offset = await sharedClockOffset(directory);

	assert.ok(Math.abs(offset - ahead) < 60_000, `offset ${offset}`);
	assert.equal(probes().length, 1);
});

/** A lock not refreshed for this long is stale: another process may take it. */
const LOCK_STALE_MS = 5_000;
/** How often the lock's holder refreshes it. */
const LOCK_UPDATE_MS = 1_000;
/** How long a delete that Windows refuses takes to fail. */
const REFUSAL_MS = 10;

test("a held lock never looks stale while Windows refuses every delete of its clock probes (#5605)", async () => {
	await refuseProbeDeletes(() => true, REFUSAL_MS);
	const file = join(directory, "locked.json");
	writeFileSync(file, "{}");
	let compromised: Error | undefined;
	const unlock = await lockShared(file, {
		realpath: false,
		stale: LOCK_STALE_MS,
		update: LOCK_UPDATE_MS,
		onCompromised: (error) => {
			compromised = error;
		},
	});
	try {
		// Each refresh of the lock reads the filesystem's clock through probes whose deletes are refused.
		let oldest = 0;
		const end = Date.now() + LOCK_STALE_MS + 2 * LOCK_UPDATE_MS;
		while (Date.now() < end && oldest <= LOCK_STALE_MS) {
			oldest = Math.max(oldest, Date.now() - statSync(`${file}.lock`).mtimeMs);
			await sleep(50);
		}
		assert.ok(oldest <= LOCK_STALE_MS, `the held lock went ${Math.round(oldest)} ms without a refresh`);
		assert.equal(compromised, undefined);
	} finally {
		await unlock().catch(() => {});
	}
});
