import assert from "node:assert/strict";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, test, vi } from "vitest";
import { acquireSpawnLock } from "../../packages/intercom/broker/spawn.js";
import {
	holderState,
	setUnknownHolderWaitForTesting,
	unknownHolderAdvice,
	unknownHolderWaitedOut,
	writerState,
} from "../../packages/intercom/broker/stale-lock-file.js";
import { makeTempDirectory, removePathSync, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-stale-lock-");
afterAll(() => removeTempDirectory(tempDir));

let counter = 0;
const nextPath = (name: string) => join(tempDir, `${name}-${counter++}`);

function withUnreadable(isUnreadable: (path: string) => boolean, run: () => void): void {
	const realReadFileSync = fsModule.readFileSync;
	fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
		const target = String(args[0]);
		if (isUnreadable(target)) {
			const error = new Error(`EACCES: permission denied, open '${target}'`) as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		}
		return realReadFileSync(...args);
	}) as typeof fsModule.readFileSync;
	syncBuiltinESMExports();
	try {
		run();
	} finally {
		fsModule.readFileSync = realReadFileSync;
		syncBuiltinESMExports();
	}
}

describe("unreadable locks and unknown-holder wait reset (#5220)", () => {
	test("an existing lock that cannot be read is unknown and advises chown, while an absent lock is held (#5220)", () => {
		const absentPath = nextPath("absent.lock");
		assert.equal(writerState(absentPath, undefined), "held");
		assert.equal(holderState(absentPath, undefined), "held");

		const lockPath = nextPath("broker.spawn.lock");
		writeTextSync(lockPath, `2147483646\n${Date.now()}\n`);
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		setUnknownHolderWaitForTesting(0);
		try {
			withUnreadable(
				(target) => target === lockPath,
				() => {
					assert.equal(writerState(lockPath, undefined), "unknown");
					assert.equal(holderState(lockPath, undefined), "unknown");
					assert.equal(acquireSpawnLock(lockPath), undefined);
					assert.equal(acquireSpawnLock(lockPath), undefined);

					const advice = unknownHolderAdvice(lockPath);
					assert.ok(advice.includes(lockPath));
					assert.ok(advice.includes("this user cannot read it"));
					assert.ok(advice.includes("chown"));

					const stats = fsModule.statSync(lockPath, { bigint: true });
					const foreignMarker = `${lockPath}.writing.2147483646.x.0f0f0f0f0f0f.12345678.${stats.ino}-${stats.birthtimeNs}`;
					writeTextSync(foreignMarker, "");
					try {
						const markerAdvice = unknownHolderAdvice(lockPath);
						assert.ok(markerAdvice.includes("this user cannot read it"));
						assert.ok(markerAdvice.includes(foreignMarker));
						assert.ok(markerAdvice.includes("chown"));
					} finally {
						removePathSync(foreignMarker, { force: true });
					}

					const realReaddirSync = fsModule.readdirSync;
					fsModule.readdirSync = (() => {
						const error = new Error("EACCES: permission denied, scandir") as NodeJS.ErrnoException;
						error.code = "EACCES";
						throw error;
					}) as typeof fsModule.readdirSync;
					syncBuiltinESMExports();
					try {
						const fallbackAdvice = unknownHolderAdvice(lockPath);
						assert.ok(fallbackAdvice.includes("this user cannot read it"));
						assert.ok(fallbackAdvice.includes("chown"));
					} finally {
						fsModule.readdirSync = realReaddirSync;
						syncBuiltinESMExports();
					}
				},
			);
			const warnings = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((message) => message.includes(lockPath));
			assert.ok(
				warnings.some((message) => message.includes("this user cannot read it") && message.includes("chown $USER")),
				`warnings=${JSON.stringify(warnings)}`,
			);

			const generationDir = `${lockPath}.gen1`;
			fsModule.mkdirSync(generationDir);
			writeTextSync(join(generationDir, "owner"), "2147483646\n");
			const generationAdvice = unknownHolderAdvice(generationDir);
			assert.ok(generationAdvice.includes(generationDir));
			assert.ok(generationAdvice.includes("this user cannot read it"));
			assert.ok(generationAdvice.includes("chown -R $USER"));
		} finally {
			warn.mockRestore();
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(`${lockPath}.gen1`, { recursive: true, force: true });
			removePathSync(lockPath, { force: true });
		}
	});

	test("unknownHolderWaitedOut restarts the wait when a new file or new content appears at the same path (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		const waitMs = 80;
		setUnknownHolderWaitForTesting(waitMs);
		try {
			writeTextSync(lockPath, "");
			assert.equal(unknownHolderWaitedOut(lockPath, ""), false);
			await sleep(20);
			removePathSync(lockPath, { force: true });
			await sleep(waitMs);

			const secondPath = nextPath("replacement-inode");
			writeTextSync(secondPath, "");
			fsModule.renameSync(secondPath, lockPath);
			assert.equal(unknownHolderWaitedOut(lockPath, ""), false, "a new file identity restarts the wait");
			await sleep(waitMs + 20);
			assert.equal(unknownHolderWaitedOut(lockPath, ""), true);

			assert.equal(
				unknownHolderWaitedOut(lockPath, "partial"),
				false,
				"changed content at the same path restarts the wait",
			);
			assert.equal(
				unknownHolderWaitedOut(lockPath, ""),
				false,
				"reverting to earlier content still restarts the wait",
			);
		} finally {
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(lockPath, { force: true });
		}
	});
});
