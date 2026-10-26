import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { terminateRpcClientProcess } from "../src/modes/rpc/rpc-client-process.ts";

/**
 * How late a terminated child's exit is reported. On Windows both SIGTERM and
 * SIGKILL map to TerminateProcess, which only starts termination, and a loaded
 * runner has reported the exit more than 500 ms later.
 */
const LATE_EXIT_REPORT_MS = 1_000;

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("shares concurrent stop teardown and makes repeat stop a no-op", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.resume();
`),
		});

		await client.start();
		const firstStop = client.stop();
		const secondStop = client.stop();

		assert.strictEqual(firstStop, secondStop);
		await firstStop;
		await client.stop();
	});

	test("waits for a terminated child whose exit is reported late instead of reporting it unkillable", async () => {
		const child = new ChildProcess();
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		child.kill = (signal) => {
			signals.push(signal);
			if (signals.length === 1) setTimeout(() => child.emit("exit", null, "SIGTERM"), LATE_EXIT_REPORT_MS);
			return true;
		};

		await terminateRpcClientProcess(child, false);

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
