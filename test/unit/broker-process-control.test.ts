import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { createBrokerProcessControl } from "../helpers/broker-process-control.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const CONTROL_SHUTDOWN_MS = 10_000;

function childProcess(args: string[]): {
	child: ChildProcessWithoutNullStreams;
	closed: Promise<[number | null, NodeJS.Signals | null]>;
} {
	const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
	onTestFinished(async () => {
		child.kill("SIGKILL");
		await closed;
	});
	return { child, closed };
}

async function controlFixture() {
	const directory = makeTempDirectory("broker-control-");
	const control = await createBrokerProcessControl(directory, CONTROL_SHUTDOWN_MS);
	onTestFinished(async () => {
		try {
			await control.close();
		} finally {
			removeTempDirectory(directory);
		}
	});
	return { directory, control };
}

test("broker cleanup stops only its connected child (#5332)", async () => {
	const { control } = await controlFixture();
	const stranger = childProcess(["-e", "setInterval(() => {}, 1000)"]);
	await once(stranger.child, "spawn");
	const owned = childProcess([
		"--import",
		control.preloadUrl,
		"-e",
		'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
	]);
	await once(owned.child.stdout, "data");
	assert.ok(owned.child.pid !== undefined);
	await control.stop(owned.child.pid);
	assert.deepEqual(await owned.closed, [null, "SIGKILL"]);
	assert.equal(stranger.child.exitCode, null);
	assert.equal(stranger.child.signalCode, null);
	const strangerPid = stranger.child.pid;
	assert.ok(strangerPid !== undefined);
	assert.doesNotThrow(() => process.kill(strangerPid, 0));
});

test("an unreferenced broker control connection preserves natural exit in long quoted directories (#5332)", async () => {
	const directory = makeTempDirectory("broker-control-");
	const longDirectory = join(directory, `${"x".repeat(150)} 'quoted'`);
	mkdirSync(longDirectory);
	const control = await createBrokerProcessControl(longDirectory, CONTROL_SHUTDOWN_MS);
	onTestFinished(async () => {
		try {
			await control.close();
		} finally {
			removeTempDirectory(directory);
		}
	});
	const owned = childProcess(["--import", control.preloadUrl, "-e", "process.exitCode = 0"]);
	assert.deepEqual(await owned.closed, [0, null]);
});

test("a broker launched after control teardown exits before publishing fixture files (#5332)", async () => {
	const { directory, control } = await controlFixture();
	await control.close();
	const published = join(directory, "published");
	const owned = childProcess([
		"--import",
		control.preloadUrl,
		"-e",
		'require("node:fs").writeFileSync(process.argv[1], "started"); setInterval(() => {}, 1000);',
		published,
	]);
	let stderr = "";
	owned.child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	assert.deepEqual(await owned.closed, [null, "SIGKILL"], stderr);
	assert.equal(existsSync(published), false);
});
