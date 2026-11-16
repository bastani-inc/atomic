import assert from "node:assert/strict";
import { closeSync, openSync, readdirSync, utimesSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { makeTempDirectory, readTextSync, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const race = vi.hoisted(() => ({
	lockPath: undefined as string | undefined,
	beforeRenameOnto: undefined as (() => void) | undefined,
	beforeRenameAway: undefined as (() => void) | undefined,
	beforePutBack: undefined as (() => void) | undefined,
	linkError: undefined as string | undefined,
	procListings: 0,
	foreignUid: undefined as number | undefined,
	afterCreating: undefined as (() => void) | undefined,
	afterBinding: undefined as (() => void) | undefined,
}));

function once(take: () => (() => void) | undefined, clear: () => void): void {
	const hook = take();
	if (hook === undefined) return;
	clear();
	hook();
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const renameSync = ((from, to) => {
		if (race.lockPath !== undefined && String(to) === race.lockPath) {
			once(
				() => race.beforeRenameOnto,
				() => {
					race.beforeRenameOnto = undefined;
				},
			);
		}
		if (race.lockPath !== undefined && String(from) === race.lockPath) {
			once(
				() => race.beforeRenameAway,
				() => {
					race.beforeRenameAway = undefined;
				},
			);
		}
		actual.renameSync(from, to);
		if (race.lockPath !== undefined && String(from).startsWith(`${race.lockPath}.writing.`)) {
			once(
				() => race.afterBinding,
				() => {
					race.afterBinding = undefined;
				},
			);
		}
	}) as typeof actual.renameSync;
	const linkSync = ((existing, path) => {
		if (race.lockPath !== undefined && String(path) === race.lockPath) {
			if (race.linkError !== undefined) {
				throw Object.assign(new Error(`${race.linkError}: link not permitted`), { code: race.linkError });
			}
			if (String(existing).endsWith(".stale")) {
				once(
					() => race.beforePutBack,
					() => {
						race.beforePutBack = undefined;
					},
				);
			}
		}
		actual.linkSync(existing, path);
	}) as typeof actual.linkSync;
	const openSync = ((path: import("fs").PathLike, flags?: import("fs").OpenMode, mode?: import("fs").Mode | null) => {
		const fd = (actual.openSync as (...args: unknown[]) => number)(path, flags, mode);
		if (flags === "wx" && race.lockPath !== undefined && String(path) === race.lockPath) {
			const hook = race.afterCreating;
			race.afterCreating = undefined;
			hook?.();
		}
		return fd;
	}) as typeof actual.openSync;
	const readdirSync = ((path: import("fs").PathLike, options?: unknown) => {
		if (String(path) === "/proc" || String(path).startsWith("/proc/")) race.procListings++;
		return (actual.readdirSync as (path: import("fs").PathLike, options?: unknown) => unknown)(path, options);
	}) as typeof actual.readdirSync;
	const statSync = ((path, options) => {
		const stats = actual.statSync(path, options);
		if (race.foreignUid === undefined || String(path) !== race.lockPath || stats === undefined) return stats;
		return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: race.foreignUid });
	}) as typeof actual.statSync;
	return {
		...actual,
		default: { ...actual, renameSync, linkSync, readdirSync, statSync, openSync },
		openSync,
		renameSync,
		linkSync,
		readdirSync,
		statSync,
	};
});

const { acquireSpawnLock, BROKER_SPAWN_LOCK_MAX_AGE_MS, renewSpawnLock } = await import(
	"../../packages/intercom/broker/spawn.js"
);
const staleLockFile: Record<string, unknown> = await import("../../packages/intercom/broker/stale-lock-file.js");
const { statSync: realStat } = await vi.importActual<typeof import("node:fs")>("node:fs");

const ownHost = () => (staleLockFile.hostIdentity as (() => string) | undefined)?.() ?? "unknown-host";

function writingMarker(path: string, pid: number, host = ownHost(), file = fileIdentity(path)): string {
	const nonce = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
	const marker = `${path}.writing.${pid}.x.${host}.${nonce}${file === undefined ? "" : `.${file}`}`;
	writeTextSync(marker, "");
	return marker;
}

function fileIdentity(path: string): string | undefined {
	try {
		const stats = realStat(path, { bigint: true });
		return `${stats.ino}-${stats.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

function inodeWritingMarker(path: string, pid: number): string {
	const marker = `${path}.writing.${realStat(path, { bigint: true }).ino}.${pid}.x.${ownHost()}`;
	writeTextSync(marker, "");
	return marker;
}

function warningsDuring(act: () => void): string[] {
	const warnings: string[] = [];
	const spy = vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
		warnings.push(String(warning));
	});
	try {
		act();
	} finally {
		spy.mockRestore();
	}
	return warnings;
}

function shortenUnknownHolderWait(): void {
	(staleLockFile.setUnknownHolderWaitForTesting as ((ms: number | undefined) => void) | undefined)?.(0);
}

const tempDir = makeTempDirectory("ic5220-holder-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.lockPath = undefined;
	race.beforeRenameOnto = undefined;
	race.beforeRenameAway = undefined;
	race.beforePutBack = undefined;
	race.linkError = undefined;
	race.procListings = 0;
	race.foreignUid = undefined;
	race.afterCreating = undefined;
	race.afterBinding = undefined;
	(staleLockFile.setUnknownHolderWaitForTesting as ((ms: number | undefined) => void) | undefined)?.(undefined);
});

let lockCount = 0;

const WRITER_STALL_MS = 1_500;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function agedOwnLock(): { readonly path: string; readonly owner: string } {
	const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
	const owner = `${process.pid}\n${Date.now() - BROKER_SPAWN_LOCK_MAX_AGE_MS - 1_000}\n`;
	writeTextSync(path, owner);
	race.lockPath = path;
	return { path, owner };
}

function holderStillOwns(owner: string | undefined, path: string): boolean {
	if (owner === undefined) return false;
	return renewSpawnLock(owner, Date.now() + BROKER_SPAWN_LOCK_MAX_AGE_MS, path) !== undefined;
}

describe("a spawn-lock holder and a spawner replacing its aged lock (#5220)", () => {
	test("a holder paused between checking its lock and renewing it never writes over a lock another spawner took (#5220)", () => {
		const { path, owner } = agedOwnLock();
		let taker: string | undefined;
		race.beforeRenameOnto = () => {
			taker = acquireSpawnLock(path);
		};

		const renewed = renewSpawnLock(owner, Date.now(), path);
		const owners = [holderStillOwns(renewed, path) ? "holder" : undefined, taker === undefined ? undefined : "taker"];
		assert.equal(
			owners.filter((held) => held !== undefined).length,
			1,
			`exactly one spawner owns the lock: ${owners.join(",")}; lock ${JSON.stringify(readTextSync(path, "utf8"))}`,
		);
	});

	test("a holder renewing while a spawner moves its aged lock aside never loses it to a third spawner unawares (#5220)", () => {
		const { path, owner } = agedOwnLock();
		let renewed: string | undefined = owner;
		let third: string | undefined;
		race.beforeRenameAway = () => {
			renewed = renewSpawnLock(owner, Date.now(), path);
		};
		race.beforePutBack = () => {
			third = acquireSpawnLock(path);
		};

		const taker = acquireSpawnLock(path);
		const owners = [
			holderStillOwns(renewed, path) ? "holder" : undefined,
			taker === undefined ? undefined : "taker",
			third === undefined ? undefined : "third",
		];
		assert.equal(
			owners.filter((held) => held !== undefined).length,
			1,
			`exactly one spawner owns the lock: ${owners.join(",")}; lock ${JSON.stringify(readTextSync(path, "utf8"))}`,
		);
	});

	test("a holder whose aged lock another spawner replaced is told at its next renewal that it lost it (#5220)", () => {
		const { path, owner } = agedOwnLock();
		const taker = acquireSpawnLock(path);
		assert.ok(taker !== undefined, "another spawner replaces the aged lock");

		assert.equal(renewSpawnLock(owner, Date.now(), path), undefined, "the holder learns the lock is no longer its");
		assert.ok(readTextSync(path, "utf8").startsWith(taker), "the other spawner's lock is left in place");
	});
});

describe("a spawn lock on a file system without hard links (#5220)", () => {
	for (const code of ["EPERM", "ENOTSUP"]) {
		test(`a spawner takes the lock when linking fails with ${code}, and a second one waits (#5220)`, () => {
			const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
			race.lockPath = path;
			race.linkError = code;

			const owner = acquireSpawnLock(path);
			assert.ok(owner !== undefined, "the spawner takes the lock");
			assert.ok(readTextSync(path, "utf8").startsWith(owner), "the lock records its spawner");
			assert.equal(acquireSpawnLock(path), undefined, "a second spawner finds the lock held");
		});
	}

	test("a lock still being written is not replaced, however long its writer stalls and however old FAT makes it look (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		const writer = openSync(path, "wx");
		try {
			writingMarker(path, process.pid);
			writeSync(writer, `${process.pid}\n17`);
			const coarse = new Date(Math.floor((Date.now() - 2_000) / 2_000) * 2_000);
			utimesSync(path, coarse, coarse);
			sleepSync(WRITER_STALL_MS);

			assert.equal(acquireSpawnLock(path), undefined, "another spawner waits");
			assert.equal(readTextSync(path, "utf8"), `${process.pid}\n17`, "the lock being written is left to its writer");
		} finally {
			closeSync(writer);
		}
	});

	test("a completed aged header with a live-looking leftover marker is replaced without retaining its old owner (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		const aged = `${process.pid}\n${Date.now() - BROKER_SPAWN_LOCK_MAX_AGE_MS - 1_000}\n`;
		writeTextSync(path, aged);
		writingMarker(path, process.pid);

		const replacement = acquireSpawnLock(path);
		assert.ok(replacement !== undefined, "a leftover marker cannot keep an aged complete header");
		assert.equal(renewSpawnLock(aged, Date.now(), path), undefined, "the replaced writer no longer owns the lock");
		assert.ok(readTextSync(path, "utf8").startsWith(replacement));
	});

	test("a lock left part-written by a spawner killed while writing it is replaced (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "2147483646\n17");
		writingMarker(path, 2147483646);

		const owner = acquireSpawnLock(path);
		assert.ok(owner !== undefined, "the spawner takes the abandoned lock");
		assert.ok(readTextSync(path, "utf8").startsWith(owner));
	});

	test("judging a part-written lock never scans other processes' open files (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, `${process.pid}\n17`);
		writingMarker(path, process.pid);

		for (let attempt = 0; attempt < 5; attempt++) assert.equal(acquireSpawnLock(path), undefined);
		assert.equal(race.procListings, 0, "no process's descriptors were listed");
	});

	test("a lock being written in another container or on another host is never taken, and is refused with advice (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "2147483646\n17");
		writingMarker(path, 2147483646, "0123456789ab");
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined, "never taken");
		});
		assert.equal(readTextSync(path, "utf8"), "2147483646\n17", "the lock is left to its writer");
		assert.ok(
			warnings.some((warning) => warning.includes(path) && warning.includes("remove")),
			`the refusal names the lock and the fix: ${warnings.join(" | ")}`,
		);
	});

	test("a foreign unbound marker never blocks a complete dead spawner record (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, `2147483645\n${Date.now()}\n`);
		writeTextSync(`${path}.writing.2147483646.x.0123456789ab.12345678`, "");

		const owner = acquireSpawnLock(path);
		assert.ok(owner !== undefined);
		assert.ok(readTextSync(path, "utf8").startsWith(owner));
	});

	test("an empty lock blocked by a foreign marker names that marker in recovery advice (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		const marker = `${path}.writing.2147483646.x.0123456789ab.12345678`;
		writeTextSync(path, "");
		writeTextSync(marker, "");
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined);
		});
		assert.ok(warnings.some((warning) => warning.includes(`remove ${marker}`)));
		assert.equal(readTextSync(path, "utf8"), "");
	});

	test("a part-written lock another user left is refused with advice instead of waited on forever (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "2147483646\n17");
		race.lockPath = path;
		race.foreignUid = 0;
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined, "never taken");
		});
		assert.ok(
			warnings.some((warning) => warning.includes(path) && warning.includes("chown")),
			`the refusal names the lock and the fix: ${warnings.join(" | ")}`,
		);
	});

	test("a dead writer's marker is never taken for a live spawner's, even on a reused inode: one owner (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		race.lockPath = path;
		race.linkError = "EPERM";
		let other: string | undefined;
		race.afterCreating = () => {
			inodeWritingMarker(path, 2147483646);
			writingMarker(path, 2147483646);
			other = acquireSpawnLock(path);
		};

		const owner = acquireSpawnLock(path);
		const owners = [owner, other].filter((held) => held !== undefined);
		assert.equal(owners.length, 1, `exactly one spawner owns the lock: ${JSON.stringify([owner, other])}`);
	});

	for (const stage of ["creation", "binding"] as const) {
		test(`a matching dead marker cannot hide the live writer after ${stage}, even when inode and birthtime repeat (#5220)`, () => {
			const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
			race.lockPath = path;
			race.linkError = "EPERM";
			let other: string | undefined;
			const whilePublishing = () => {
				writingMarker(path, 2147483646);
				other = acquireSpawnLock(path);
			};
			if (stage === "creation") race.afterCreating = whilePublishing;
			else race.afterBinding = whilePublishing;

			const owner = acquireSpawnLock(path);
			assert.ok(owner !== undefined, "the writer takes its lock");
			assert.equal(other, undefined, "the other spawner waits despite the matching dead marker");
		});
	}

	test("a matching dead marker never abandons an earlier version's empty lock when file identity repeats (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "");
		writingMarker(path, 2147483646);
		shortenUnknownHolderWait();
		const holderState = staleLockFile.holderState as (path: string, written: string) => string;
		const isAbandoned = staleLockFile.isAbandoned as (path: string, written: string) => boolean;

		assert.equal(holderState(path, ""), "unknown");
		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined);
		});
		assert.equal(readTextSync(path, "utf8"), "");
		assert.ok(warnings.some((warning) => warning.includes(path) && warning.includes("killed")));

		const token = `${path}.takeover-2147483646`;
		writeTextSync(token, "");
		writingMarker(token, 2147483646);
		assert.equal(isAbandoned(token, ""), false);
		assert.equal(readTextSync(token, "utf8"), "");
	});

	test("a matching dead marker never abandons an earlier version's live partial record (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		const partial = `${process.pid}\n17`;
		writeTextSync(path, partial);
		writingMarker(path, 2147483646);

		assert.equal(acquireSpawnLock(path), undefined);
		assert.equal(readTextSync(path, "utf8"), partial);
	});

	test("an empty lock with no marker is refused with advice that names an earlier version (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "");
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined, "never taken");
		});
		assert.ok(
			warnings.some((warning) => warning.includes(path) && warning.includes("earlier version")),
			`the refusal names the likely cause: ${warnings.join(" | ")}`,
		);
	});

	test("a live lock moved aside by a stale judgment is put back where no hard link can be made (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		const live = `${process.pid}\n${Date.now()}\n`;
		writeTextSync(path, live);
		race.lockPath = path;
		race.linkError = "EPERM";
		const removeFileIfUnchanged = staleLockFile.removeFileIfUnchanged as (path: string, inspected: string) => boolean;

		assert.equal(removeFileIfUnchanged(path, "2147483646\n17\n"), false);
		assert.equal(readTextSync(path, "utf8"), live, "the live lock is back in place");
		assert.equal(acquireSpawnLock(path), undefined, "and still held");
		assert.deepEqual(
			readdirSync(tempDir).filter((name) => name.startsWith(`${basename(path)}.`)),
			[],
			"nothing is left parked",
		);
	});
});
