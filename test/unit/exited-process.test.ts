import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { processCreationTime } from "@bastani/atomic-natives";
import { afterEach, onTestFinished, test, vi } from "vitest";
import { keepProcessPid, keepProcessPidByStartTime } from "../helpers/exited-process.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

afterEach(() => vi.restoreAllMocks());

for (const matches of [false, true]) {
	test(`${matches ? "retains" : "refuses"} an opened PID ${matches ? "matching" : "different from"} its recorded start (#5332)`, async () => {
		const recorded = "134077392000000001";
		const opened = matches ? recorded : "134077392000000002";
		const holder = childProcess.spawn(
			process.execPath,
			[
				"-e",
				`process.stdin.once("data", () => process.stdout.write("${opened}\\n")); process.stdin.once("end", () => process.exit(0));`,
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const holderClosed = once(holder, "close");
		onTestFinished(async () => {
			holder.kill("SIGKILL");
			await holderClosed;
		});
		await once(holder, "spawn");
		vi.mocked(spawn).mockReturnValueOnce(holder);
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platform);
		let keeping: ReturnType<typeof keepProcessPidByStartTime>;
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			keeping = keepProcessPidByStartTime(process.pid, recorded);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		try {
			const outcome = matches
				? keeping.then((release) => release())
				: assert.rejects(keeping, /start time changed before its PID could be kept/u);
			holder.stdin.write("report\\n");
			await outcome;
			assert.equal(holder.exitCode, 0);
		} finally {
			await keeping.then(
				(release) => release(),
				() => {},
			);
		}
	});
}

for (const matches of [false, true]) {
	test(`Windows handle ${matches ? "retains" : "refuses"} a real process by its recorded start (#5332)`, {
		skip: process.platform !== "win32",
	}, async () => {
		const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const childExited = once(child, "exit");
		let release = async () => {};
		let finished = false;
		onTestFinished(async () => {
			finished = true;
			try {
				child.kill("SIGKILL");
				await childExited;
			} finally {
				await release();
			}
		});
		await once(child, "spawn");
		assert.ok(child.pid !== undefined);
		const recorded = processCreationTime(child.pid);
		assert.ok(recorded !== null);
		const keeping = keepProcessPidByStartTime(child.pid, matches ? recorded : String(BigInt(recorded) + 1n));
		if (matches) {
			release = await keeping;
			if (finished) {
				await release();
				throw new Error("process PID retention completed after test cleanup");
			}
			child.kill("SIGKILL");
			await childExited;
			assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
		} else {
			await assert.rejects(keeping, /start time changed before its PID could be kept/u);
			assert.equal(child.exitCode, null);
			assert.equal(child.signalCode, null);
		}
	});
}

test("refuses an exited child before its PID can name another process (#5332)", async () => {
	const child = childProcess.spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
	await once(child, "exit");
	await assert.rejects(keepProcessPid(child), new RegExp(`Process ${child.pid} exited before its PID could be kept`));
});

test("refuses a child killed before the holder answers and closes that holder (#5332)", async () => {
	const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		windowsHide: true,
	});
	const childExited = once(child, "exit");
	const holder = childProcess.spawn(
		process.execPath,
		[
			"-e",
			`process.stdin.once("data", () => process.stdout.write("held\\n"));
			process.stdin.once("end", () => process.exit(0));`,
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const holderClosed = once(holder, "close");
	onTestFinished(async () => {
		child.kill("SIGKILL");
		holder.kill("SIGKILL");
		await Promise.all([childExited, holderClosed]);
	});
	await Promise.all([once(child, "spawn"), once(holder, "spawn")]);
	vi.mocked(spawn).mockReturnValueOnce(holder);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	let keeping: ReturnType<typeof keepProcessPid>;
	try {
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		keeping = keepProcessPid(child);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
	const refusal = assert.rejects(keeping, new RegExp(`Process ${child.pid} exited before its PID could be kept`));
	child.kill("SIGKILL");
	await childExited;
	holder.stdin.write("report\n");
	try {
		await refusal;
		assert.equal(holder.exitCode, 0);
	} finally {
		await keeping.then(
			(release) => release(),
			() => {},
		);
	}
});

test("exited holders use the configured Bun executable without a PATH entry (#5331)", () => {
	const executable = bunExecutable();
	const moduleUrl = new URL("../helpers/exited-process.ts", import.meta.url).href;
	const result = spawnSyncCollect(
		[
			executable,
			"--eval",
			`const { exitedProcess } = await import(${JSON.stringify(moduleUrl)});
			process.stdout.write(JSON.stringify(exitedProcess()));`,
		],
		{ env: { ATOMIC_BUN_EXECUTABLE: executable, PATH: "" } },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const holder = JSON.parse(result.stdout.toString()) as { pid: number };
	assert.ok(Number.isInteger(holder.pid) && holder.pid > 0);
});
