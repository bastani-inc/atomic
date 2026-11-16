import assert from "node:assert/strict";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, test, vi } from "vitest";
import {
	acquireSocketReplacementLock,
	type SocketReplacementLock,
} from "../../packages/intercom/broker/socket-replacement-lock.js";
import { acquireSpawnLock } from "../../packages/intercom/broker/spawn.js";
import { setUnknownHolderWaitForTesting, writerState } from "../../packages/intercom/broker/stale-lock-file.js";
import {
	makeTempDirectory,
	readTextSync,
	removePathSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-unstatable-wait-");
afterAll(() => removeTempDirectory(tempDir));

const UNKNOWN_WAIT_MS = 1_000;
const INTER_EPISODE_MS = 1_200;
const SECOND_EPISODE_ELAPSED_MS = 400;

let counter = 0;
const nextPath = (name: string) => join(tempDir, `${name}-${counter++}`);

function permissionError(operation: string, target: string): NodeJS.ErrnoException {
	const error = new Error(`EPERM: operation not permitted, ${operation} '${target}'`) as NodeJS.ErrnoException;
	error.code = "EPERM";
	return error;
}

type SocketOutcome =
	| { kind: "taken"; release: SocketReplacementLock }
	| { kind: "refused"; message: string }
	| { kind: "waiting" };

describe("unstat-able lock episodes across a checkable interval (#5220)", () => {
	test("a legacy socket lock that becomes unstat-able and unreadable a second time after a checkable interval keeps waiting (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		writeTextSync(lockPath, `${process.ppid}\n`);
		setUnknownHolderWaitForTesting(UNKNOWN_WAIT_MS);

		const realReadFileSync = fsModule.readFileSync;
		const realStatSync = fsModule.statSync;
		let phase: "first" | "checkable" | "second" | "clear" = "first";
		let firstEpisodeStats = 0;
		let checkableStats = 0;
		let secondEpisodeStats = 0;

		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			const target = String(args[0]);
			if (target === lockPath && (phase === "first" || phase === "second")) {
				throw permissionError("open", target);
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		const stat = vi.spyOn(fsModule, "statSync").mockImplementation(((
			...args: Parameters<typeof fsModule.statSync>
		) => {
			const target = String(args[0]);
			if (target === lockPath) {
				if (phase === "first") {
					firstEpisodeStats++;
					throw permissionError("stat", target);
				}
				if (phase === "checkable") {
					checkableStats++;
				}
				if (phase === "second") {
					secondEpisodeStats++;
					throw permissionError("stat", target);
				}
			}
			return realStatSync(...args);
		}) as typeof fsModule.statSync);
		syncBuiltinESMExports();

		const acquiring = acquireSocketReplacementLock(lockPath).then(
			(release): SocketOutcome => ({ kind: "taken", release }),
			(error: Error): SocketOutcome => ({ kind: "refused", message: error.message }),
		);

		try {
			await vi.advanceTimersByTimeAsync(100);
			assert.ok(firstEpisodeStats >= 2);
			phase = "checkable";
			await vi.advanceTimersByTimeAsync(INTER_EPISODE_MS);
			assert.ok(checkableStats > 0);
			phase = "second";
			await vi.advanceTimersByTimeAsync(SECOND_EPISODE_ELAPSED_MS);
			assert.ok(secondEpisodeStats >= 2);

			const secondEpisodeOutcome = await Promise.race([
				acquiring,
				Promise.resolve<SocketOutcome>({ kind: "waiting" }),
			]);
			assert.equal(
				secondEpisodeOutcome.kind,
				"waiting",
				`expected socket replacement lock to keep waiting ${SECOND_EPISODE_ELAPSED_MS} ms into second episode, got ${JSON.stringify(secondEpisodeOutcome)}`,
			);

			removePathSync(lockPath, { force: true });
			phase = "clear";
			await vi.advanceTimersByTimeAsync(100);
			const finalOutcome = await acquiring;
			assert.equal(finalOutcome.kind, "taken");
			if (finalOutcome.kind === "taken") {
				assert.equal(finalOutcome.release.held(), true);
				finalOutcome.release();
			}
		} finally {
			phase = "clear";
			fsModule.readFileSync = realReadFileSync;
			stat.mockRestore();
			syncBuiltinESMExports();
			removePathSync(lockPath, { force: true });
			await vi.advanceTimersByTimeAsync(100);
			const settled = await acquiring;
			if (settled.kind === "taken") settled.release();
			vi.useRealTimers();
			setUnknownHolderWaitForTesting(undefined);
		}
	});

	test("a spawn lock that becomes unstat-able and unreadable a second time after a checkable interval does not warn (#5220)", () => {
		const lockPath = nextPath("broker.spawn.lock");
		const realNow = Date.now;
		const realReadFileSync = fsModule.readFileSync;
		const realStatSync = fsModule.statSync;
		const baseNow = realNow.call(Date);
		let clockOffsetMs = 0;
		let unstatable = false;

		writeTextSync(lockPath, `${process.ppid}\n${baseNow}\n`);
		setUnknownHolderWaitForTesting(UNKNOWN_WAIT_MS);
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

		Date.now = () => baseNow + clockOffsetMs;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			const target = String(args[0]);
			if (unstatable && target === lockPath) {
				throw permissionError("open", target);
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		const stat = vi.spyOn(fsModule, "statSync").mockImplementation(((
			...args: Parameters<typeof fsModule.statSync>
		) => {
			const target = String(args[0]);
			if (unstatable && target === lockPath) {
				throw permissionError("stat", target);
			}
			return realStatSync(...args);
		}) as typeof fsModule.statSync);
		syncBuiltinESMExports();

		try {
			unstatable = true;
			assert.equal(acquireSpawnLock(lockPath), undefined);
			clockOffsetMs = 100;
			assert.equal(acquireSpawnLock(lockPath), undefined);

			unstatable = false;
			clockOffsetMs = 600;
			const currentContent = readTextSync(lockPath, "utf8");
			assert.equal(writerState(lockPath, currentContent), undefined);
			assert.equal(acquireSpawnLock(lockPath), undefined);

			clockOffsetMs = INTER_EPISODE_MS;
			unstatable = true;
			assert.equal(acquireSpawnLock(lockPath), undefined);
			clockOffsetMs = INTER_EPISODE_MS + SECOND_EPISODE_ELAPSED_MS;
			assert.equal(acquireSpawnLock(lockPath), undefined);

			const warnings = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((message) => message.includes(lockPath));
			assert.deepEqual(warnings, []);
		} finally {
			Date.now = realNow;
			fsModule.readFileSync = realReadFileSync;
			stat.mockRestore();
			syncBuiltinESMExports();
			warn.mockRestore();
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(lockPath, { force: true });
		}
	});
});
