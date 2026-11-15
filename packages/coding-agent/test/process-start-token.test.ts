import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, test } from "vitest";
import { processStartToken, setNativeProcessCreationTimeForTesting } from "../src/core/process-start-token.js";

const windows = process.platform === "win32";
/** A process id no live process has: Windows assigns multiples of four, Linux ids stay below 2^22. */
const MISSING_PID = 2 ** 22 + 7;

async function runningChild() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
	return {
		pid: child.pid!,
		stop: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
}

afterEach(() => setNativeProcessCreationTimeForTesting(undefined));

describe("the start of a process of this host (#5141)", () => {
	test.skipIf(!windows)("the native module reads a running process's creation time on Windows (#5141)", async () => {
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			processCreationTime: (pid: number) => string | null;
		};
		const own = binding.processCreationTime(process.pid);
		assert.match(own ?? "", /^\d+$/);
		assert.equal(binding.processCreationTime(process.pid), own);
		assert.equal(binding.processCreationTime(MISSING_PID), null);
		const child = await runningChild();
		try {
			const created = binding.processCreationTime(child.pid);
			assert.match(created ?? "", /^\d+$/);
			assert.ok(BigInt(created!) >= BigInt(own!), "a child is created after its parent");
		} finally {
			await child.stop();
		}
		assert.equal(binding.processCreationTime(child.pid), null);
	});

	test.skipIf(!windows && process.platform !== "linux")(
		"two processes have different starts, and a gone one has none (#5141)",
		async () => {
			const child = await runningChild();
			const own = processStartToken(process.pid);
			const theirs = processStartToken(child.pid);
			await child.stop();
			assert.match(own ?? "", /^[0-9a-f]{12}$/);
			assert.match(theirs ?? "", /^[0-9a-f]{12}$/);
			assert.notEqual(theirs, own);
			assert.equal(processStartToken(child.pid), undefined);
			assert.equal(processStartToken(MISSING_PID), undefined);
			assert.equal(processStartToken(0), undefined);
			assert.equal(processStartToken(-1), undefined);
		},
	);

	test.skipIf(!windows)(
		"without the native module, the start is read alike by PowerShell, and a gone process has none (#5141)",
		async () => {
			const child = await runningChild();
			try {
				const native = processStartToken(child.pid);
				setNativeProcessCreationTimeForTesting(null);
				assert.equal(processStartToken(child.pid), native);
				assert.equal(processStartToken(process.pid), processStartToken(process.pid));
				assert.equal(processStartToken(MISSING_PID), undefined);
			} finally {
				await child.stop();
			}
		},
		60_000,
	);

	test.skipIf(!windows)(
		"without the native module, a start read is reused for a few seconds, then read again (#5141)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			const child = await runningChild();
			const start = processStartToken(child.pid);
			assert.match(start ?? "", /^[0-9a-f]{12}$/);
			await child.stop();
			assert.equal(processStartToken(child.pid), start);
			await new Promise((resolve) => setTimeout(resolve, 5_500));
			assert.equal(processStartToken(child.pid), undefined);
		},
		60_000,
	);

	test.skipIf(!windows)(
		"without the native module, PowerShell that cannot be started is given up on (#5141)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			const child = await runningChild();
			try {
				const path = process.env.PATH;
				process.env.PATH = "";
				try {
					assert.equal(processStartToken(process.pid), undefined);
				} finally {
					process.env.PATH = path;
				}
				// Another process, whose start was never read, has none either: PowerShell is not tried again.
				assert.equal(processStartToken(child.pid), undefined);
				setNativeProcessCreationTimeForTesting(null);
				assert.match(processStartToken(child.pid) ?? "", /^[0-9a-f]{12}$/);
			} finally {
				await child.stop();
			}
		},
		60_000,
	);

	test.skipIf(!windows)("a native reader that fails or answers nonsense gives no start (#5141)", () => {
		setNativeProcessCreationTimeForTesting(() => {
			throw new Error("unreadable");
		});
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "not a time");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => null);
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "0");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "132000000000000000");
		assert.match(processStartToken(process.pid) ?? "", /^[0-9a-f]{12}$/);
	});
});
