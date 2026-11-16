import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, onTestFinished, test, vi } from "vitest";
import { keepProcessPid } from "../helpers/exited-process.js";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

afterEach(() => vi.restoreAllMocks());

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
