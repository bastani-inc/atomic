import assert from "node:assert/strict";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { postmasterIdentityChanged } from "../helpers/postgres-process-identity.js";
import { makeTempDirectory, removePathSync, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

// #3074: shutdown observation must survive pidfile removal and immediate replacement.
test("fault fixture observes the captured postmaster, not its replacement", () => {
	const home = makeTempDirectory("atomic-postmaster-observation-");
	const pidfile = join(home, "postmaster.pid");
	const expected = { pid: 123, started: 456 };
	try {
		writeTextSync(pidfile, "123\nowned-data\n456\n5439\n");
		assert.equal(postmasterIdentityChanged(pidfile, expected), false);
		removePathSync(pidfile);
		assert.equal(postmasterIdentityChanged(pidfile, expected), true, "removal during shutdown is completion");
		writeTextSync(pidfile, "124\nowned-data\n457\n5439\n");
		assert.equal(postmasterIdentityChanged(pidfile, expected), true);
		writeTextSync(pidfile, "123\nowned-data\n457\n5439\n");
		assert.equal(postmasterIdentityChanged(pidfile, expected), true, "PID reuse must compare start identity");
		writeTextSync(pidfile, "124\n");
		assert.equal(postmasterIdentityChanged(pidfile, expected), false, "wait for an incomplete replacement pidfile");
		assert.throws(() => postmasterIdentityChanged(home, expected), /EISDIR|EPERM|EACCES/, "do not hide read errors");
	} finally {
		removeTempDirectory(home);
	}
});

const windowsFsConstants = constants as typeof constants & { readonly UV_FS_O_TEMPORARY: number };
const RELEASED_PIDFILE_REMOVAL_DEADLINE_MS = 5_000;

test.runIf(process.platform === "win32")(
	"fault fixture keeps polling while Windows still holds the deleted pidfile",
	async () => {
		const home = makeTempDirectory("atomic-postmaster-delete-pending-");
		const pidfile = join(home, "postmaster.pid");
		const expected = { pid: 123, started: 456 };
		try {
			writeTextSync(pidfile, "123\nowned-data\n456\n5439\n");
			const postmasterHandle = openSync(pidfile, "r");
			closeSync(openSync(pidfile, constants.O_RDONLY | windowsFsConstants.UV_FS_O_TEMPORARY));
			try {
				assert.equal(
					postmasterIdentityChanged(pidfile, expected),
					false,
					"a delete-pending pidfile is not yet gone",
				);
			} finally {
				closeSync(postmasterHandle);
			}
			const deadline = Date.now() + RELEASED_PIDFILE_REMOVAL_DEADLINE_MS;
			while (!postmasterIdentityChanged(pidfile, expected)) {
				assert.ok(Date.now() < deadline, "the released pidfile completes shutdown");
				await sleep(20);
			}
		} finally {
			removeTempDirectory(home);
		}
	},
);
