import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { signalUnlessExited } from "../helpers/process-signal.js";
import { spawnProcess } from "../helpers/runtime.js";

const HOLDER_PID = 424242;

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" });
}

function killThrowing(thrown: unknown) {
	return vi.spyOn(process, "kill").mockImplementation(() => {
		throw thrown;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("a holder that exits on its own between a liveness check and the cleanup kill is already exited, not a failure (#4439)", () => {
	const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
		if (signal === 0) return true;
		throw errno("ESRCH");
	});
	assert.equal(signalUnlessExited(HOLDER_PID, "SIGKILL"), "already-exited");
	assert.deepEqual(kill.mock.calls, [[HOLDER_PID, "SIGKILL"]], "the kill alone decides; no liveness check first");
});

test("a live holder takes the cleanup kill and is reported signalled (#4439)", () => {
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
	assert.equal(signalUnlessExited(HOLDER_PID, "SIGKILL"), "signalled");
	assert.deepEqual(kill.mock.calls, [[HOLDER_PID, "SIGKILL"]]);
});

test("a refused kill (EPERM) is thrown unchanged, not taken for an exit (#4439)", () => {
	const refusal = errno("EPERM");
	killThrowing(refusal);
	assert.throws(
		() => signalUnlessExited(HOLDER_PID, "SIGKILL"),
		(error) => error === refusal,
	);
});

test("a kill failure without an errno code is thrown unchanged (#4439)", () => {
	const failure = new Error("kill failed");
	killThrowing(failure);
	assert.throws(
		() => signalUnlessExited(HOLDER_PID, "SIGKILL"),
		(error) => error === failure,
	);
});

test("a thrown value that is not an Error is not read as ESRCH (#4439)", () => {
	const thrown = { code: "ESRCH" };
	killThrowing(thrown);
	assert.throws(
		() => signalUnlessExited(HOLDER_PID, "SIGKILL"),
		(error) => error === thrown,
	);
});

test.skipIf(process.platform === "win32")(
	"the OS's own ESRCH for a process that already exited and was reaped is already exited (#4439)",
	async () => {
		const child = spawnProcess([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
		assert.ok(child.pid !== undefined);
		assert.equal(await child.exited, 0);
		assert.equal(signalUnlessExited(child.pid, 0), "already-exited");
	},
);

test.skipIf(process.platform === "win32")(
	"a live process is killed by the signal and reported signalled (#4439)",
	async () => {
		const child = spawnProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			assert.ok(child.pid !== undefined);
			assert.equal(signalUnlessExited(child.pid, "SIGKILL"), "signalled");
			await child.exited;
			assert.equal(child.signalCode, "SIGKILL");
		} finally {
			child.kill("SIGKILL");
		}
	},
);
