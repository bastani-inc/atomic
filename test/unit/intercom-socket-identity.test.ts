import assert from "node:assert/strict";
import type * as nodeFs from "node:fs";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test, vi } from "vitest";

const COLLIDING_INO_A = 0x00f9_0000_0003_9deen;
const COLLIDING_INO_B = 0x00f9_0000_0003_9defn;
const DEV_A = 10n;
const DEV_B = 11n;

interface FakeStatOverride {
	dev: bigint;
	ino: bigint;
}

const fakeStats = vi.hoisted(() => ({
	overrides: new Map<string, FakeStatOverride>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = ((path: nodeFs.PathLike, options?: nodeFs.StatSyncOptions) => {
		const result = actual.statSync(path, options as never);
		if (result === undefined) return undefined;
		const override = fakeStats.overrides.get(resolve(String(path)));
		if (override === undefined) return result;
		if (options?.bigint === true) {
			return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
				dev: override.dev,
				ino: override.ino,
			});
		}
		return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
			dev: Number(override.dev),
			ino: Number(override.ino),
		});
	}) as typeof actual.statSync;
	return { ...actual, default: { ...actual, statSync }, statSync };
});

const directoryHold = await import("../../packages/intercom/broker/directory-hold.js");

afterEach(() => {
	fakeStats.overrides.clear();
});

describe("64-bit BigInt socketPathIdentity in intercom broker", () => {
	test("distinguishes sockets with colliding 64-bit inodes and different devices, and returns undefined when absent", () => {
		assert.equal(Number(COLLIDING_INO_A), Number(COLLIDING_INO_B));
		const socketPathIdentity = (directoryHold as { socketPathIdentity?: (path: string) => string | undefined })
			.socketPathIdentity;
		assert.equal(typeof socketPathIdentity, "function", "socketPathIdentity must be exported from directory-hold.js");

		const dir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-sock-")));
		try {
			const sockPath = join(dir, "broker.sock");
			assert.equal(socketPathIdentity!(sockPath), undefined, "absent socket returns undefined");

			writeFileSync(sockPath, "");
			fakeStats.overrides.set(resolve(sockPath), { dev: DEV_A, ino: COLLIDING_INO_A });
			const idA = socketPathIdentity!(sockPath);
			assert.equal(idA, `${DEV_A}:${COLLIDING_INO_A}`);

			fakeStats.overrides.set(resolve(sockPath), { dev: DEV_A, ino: COLLIDING_INO_B });
			const idB = socketPathIdentity!(sockPath);
			assert.notEqual(idA, idB, "distinct 64-bit inodes must not collide");

			fakeStats.overrides.set(resolve(sockPath), { dev: DEV_B, ino: COLLIDING_INO_A });
			const idOtherDev = socketPathIdentity!(sockPath);
			assert.notEqual(idA, idOtherDev, "different devices with the same inode must not collide");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
