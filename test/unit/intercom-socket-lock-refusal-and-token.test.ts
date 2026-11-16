import assert from "node:assert/strict";
import fsModule, { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	acquireSocketReplacementLock,
	type SocketReplacementLock,
} from "../../packages/intercom/broker/socket-replacement-lock.js";
import { holderRecord, setUnknownHolderWaitForTesting } from "../../packages/intercom/broker/stale-lock-file.js";
import { makeTempDirectory, removePathSync, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-socket-refusal-");
afterAll(() => removeTempDirectory(tempDir));

const OBSERVATION_MS = 1_500;
const UNKNOWN_WAIT_MS = 600;
const PAST_WAIT_MS = 120;

let counter = 0;
const nextPath = (name: string) => join(tempDir, `${name}-${counter++}`);

function unreadable(isUnreadable: (path: string) => boolean): () => void {
	const real = fsModule.readFileSync;
	fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
		const path = String(args[0]);
		if (isUnreadable(path)) {
			const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		}
		return real(...args);
	}) as typeof fsModule.readFileSync;
	syncBuiltinESMExports();
	return () => {
		fsModule.readFileSync = real;
		syncBuiltinESMExports();
	};
}

const fileOrItsParkedCopy = (target: string) => (path: string) =>
	path === target || (path.startsWith(`${target}.`) && path.endsWith(".stale"));

type Outcome =
	| { kind: "taken"; release: SocketReplacementLock }
	| { kind: "refused"; message: string }
	| { kind: "waiting" };

async function observeSocketLock(lockPath: string): Promise<{ outcome: Outcome; settle: () => Promise<void> }> {
	const acquiring = acquireSocketReplacementLock(lockPath).then(
		(release): Outcome => ({ kind: "taken", release }),
		(error: Error): Outcome => ({ kind: "refused", message: error.message }),
	);
	const outcome = await Promise.race([acquiring, sleep(OBSERVATION_MS).then((): Outcome => ({ kind: "waiting" }))]);
	return {
		outcome,
		settle: async () => {
			const final = await acquiring;
			if (final.kind === "taken") final.release();
		},
	};
}

describe("socket replacement lock refusal and own-token recovery (#5220)", () => {
	test("a legacy socket lock that cannot be read is refused with advice naming it (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		writeTextSync(lockPath, "2147483646\n");
		const restore = unreadable(fileOrItsParkedCopy(lockPath));
		setUnknownHolderWaitForTesting(0);
		let observed: Awaited<ReturnType<typeof observeSocketLock>> | undefined;
		try {
			observed = await observeSocketLock(lockPath);
		} finally {
			restore();
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(lockPath, { force: true });
		}
		await observed?.settle();
		const outcome = observed?.outcome;
		assert.ok(
			outcome?.kind === "refused" &&
				outcome.message.includes(lockPath) &&
				outcome.message.includes("this user cannot read it") &&
				outcome.message.includes("chown"),
			`after ${OBSERVATION_MS} ms: ${JSON.stringify(outcome)}`,
		);
	});

	test("a legacy takeover token that cannot be read is refused with advice naming it (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		const token = `${lockPath}.takeover-2147483646`;
		writeTextSync(lockPath, "2147483646\n");
		writeTextSync(token, "2147483645\n");
		const restore = unreadable(fileOrItsParkedCopy(token));
		setUnknownHolderWaitForTesting(0);
		let observed: Awaited<ReturnType<typeof observeSocketLock>> | undefined;
		try {
			observed = await observeSocketLock(lockPath);
		} finally {
			restore();
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(token, { force: true });
			removePathSync(lockPath, { force: true });
		}
		await observed?.settle();
		const outcome = observed?.outcome;
		assert.ok(
			outcome?.kind === "refused" &&
				outcome.message.includes(token) &&
				outcome.message.includes("this user cannot read it") &&
				outcome.message.includes("chown"),
			`after ${OBSERVATION_MS} ms: ${JSON.stringify(outcome)}`,
		);
	});

	test("a socket lock generation whose owner record cannot be read is refused with advice naming its directory (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		const generation = `${lockPath}.gen1`;
		mkdirSync(generation);
		const owner = join(generation, "owner");
		writeTextSync(owner, "released\n");
		const restore = unreadable((path) => path === owner);
		setUnknownHolderWaitForTesting(0);
		let observed: Awaited<ReturnType<typeof observeSocketLock>> | undefined;
		try {
			observed = await observeSocketLock(lockPath);
		} finally {
			restore();
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(generation, { recursive: true, force: true });
		}
		await observed?.settle();
		const outcome = observed?.outcome;
		assert.ok(
			outcome?.kind === "refused" &&
				outcome.message.includes(generation) &&
				outcome.message.includes("this user cannot read it") &&
				outcome.message.includes("chown -R $USER"),
			`after ${OBSERVATION_MS} ms: ${JSON.stringify(outcome)}`,
		);
	});

	test("a broker whose own takeover token could not be removed once still takes the socket lock and removes its token (#5220)", async () => {
		for (const code of ["EPERM", "EXDEV"] as const) {
			const lockPath = nextPath("broker.sock.replace.lock");
			writeTextSync(lockPath, "2147483646\n");
			const token = `${lockPath}.takeover-2147483646`;
			const realRenameSync = fsModule.renameSync;
			let injected = 0;
			fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
				if (injected === 0 && String(from) === token) {
					injected++;
					const error = new Error(`${code}: rename '${String(from)}'`) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				realRenameSync(from, to);
			}) as typeof fsModule.renameSync;
			syncBuiltinESMExports();
			const acquiring = acquireSocketReplacementLock(lockPath).then(
				(release): Outcome => ({ kind: "taken", release }),
				(error: Error): Outcome => ({ kind: "refused", message: error.message }),
			);
			let outcome: Outcome;
			try {
				outcome = await Promise.race([acquiring, sleep(OBSERVATION_MS).then((): Outcome => ({ kind: "waiting" }))]);
			} finally {
				fsModule.renameSync = realRenameSync;
				syncBuiltinESMExports();
			}
			const tokenLeft = fsModule.existsSync(token);
			removePathSync(token, { force: true });
			const final = await acquiring;
			if (final.kind === "taken") {
				assert.equal(final.release.held(), true);
				final.release();
			}
			assert.equal(injected, 1, `the token's first removal failed with ${code}`);
			assert.equal(outcome.kind, "taken", `after ${OBSERVATION_MS} ms (${code}): ${JSON.stringify(outcome)}`);
			assert.equal(tokenLeft, false, `own leftover token was removed (${code})`);
		}
	});

	test("a broker can reuse its own leftover token even when that token cannot be renamed (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		const token = `${lockPath}.takeover-2147483646`;
		writeTextSync(lockPath, "2147483646\n");
		writeTextSync(token, holderRecord());
		const realRenameSync = fsModule.renameSync;
		let blockedTokenRenames = 0;
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (String(from) === token) {
				blockedTokenRenames++;
				const error = new Error(`EXDEV: rename '${String(from)}'`) as NodeJS.ErrnoException;
				error.code = "EXDEV";
				throw error;
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();
		let observed: Awaited<ReturnType<typeof observeSocketLock>> | undefined;
		try {
			observed = await observeSocketLock(lockPath);
			if (observed.outcome.kind === "taken") {
				assert.equal(observed.outcome.release.held(), true);
			}
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
			removePathSync(token, { force: true });
		}
		await observed?.settle();
		assert.equal(
			observed?.outcome.kind,
			"taken",
			`preplanted own token after ${OBSERVATION_MS} ms: ${JSON.stringify(observed?.outcome)}`,
		);
		assert.ok(blockedTokenRenames > 0, "the preexisting own token's rename failed on every attempt");
	});

	test("a socket lock that cannot be checked is waited on for the whole bound each time a new file appears (#5220)", async () => {
		const lockPath = nextPath("broker.sock.replace.lock");
		setUnknownHolderWaitForTesting(UNKNOWN_WAIT_MS);
		try {
			writeTextSync(lockPath, "");
			const first = await acquireSocketReplacementLock(lockPath, {
				onWait: () => removePathSync(lockPath, { force: true }),
			});
			first();
			await sleep(UNKNOWN_WAIT_MS + PAST_WAIT_MS);

			writeTextSync(lockPath, "");
			const startedAt = Date.now();
			const outcome = await acquireSocketReplacementLock(lockPath).then(
				(release) => {
					release();
					return "taken";
				},
				() => "refused",
			);
			const waitedMs = Date.now() - startedAt;
			assert.equal(outcome, "refused");
			assert.ok(waitedMs >= UNKNOWN_WAIT_MS - 50, `refused ${waitedMs} ms after the new record appeared`);
		} finally {
			setUnknownHolderWaitForTesting(undefined);
			removePathSync(lockPath, { force: true });
		}
	});
});
