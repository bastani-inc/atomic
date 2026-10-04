import assert from "node:assert/strict";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test, vi } from "vitest";
import { RealPostgresClient } from "../helpers/real-postgres.js";
import * as runtime from "../helpers/runtime.js";

const TRANSPORT_FAILURE_TIMEOUT_MS = 2000;

async function withClient(
	script: string,
	run: (client: RealPostgresClient) => Promise<void>,
	executablePath = process.execPath,
) {
	const home = runtime.makeTempDirectory("atomic-fixture-transport-");
	const fixture = join(home, "client.mjs");
	await runtime.writeFileEnsuringDir(fixture, script);
	const executable = vi.spyOn(runtime, "bunExecutable").mockReturnValue(executablePath);
	const client = new RealPostgresClient(home, 5439, {}, fixture);
	try {
		await client.request("pid");
		await run(client);
	} finally {
		try {
			await client.crash();
			await client.exit();
			await runtime.removePath(home, { recursive: true, force: true });
		} finally {
			executable.mockRestore();
		}
	}
}

async function withHeldStderr(
	script: string,
	run: (client: RealPostgresClient, waitForDrain: () => Promise<void>, release: () => void) => Promise<void>,
	executablePath: string,
) {
	let markReady!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	async function waitForDrain() {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Fixture stderr did not reach held drain")),
						TRANSPORT_FAILURE_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	const spawn = runtime.spawnProcess;
	const held = vi.spyOn(runtime, "spawnProcess").mockImplementation((first, second) => {
		const child = spawn(first, second);
		assert.ok(child.stderr);
		const reader = child.stderr.getReader();
		const stderr = new ReadableStream<Uint8Array<ArrayBufferLike>>({
			async start(controller) {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						controller.enqueue(value);
					}
					markReady();
					await released;
					controller.close();
				} catch (error) {
					controller.error(error);
				} finally {
					reader.releaseLock();
				}
			},
		});
		return {
			...child,
			stderr,
			get exitCode() {
				return child.exitCode;
			},
		};
	});
	try {
		await withClient(
			script,
			async (client) => {
				try {
					await run(client, waitForDrain, release);
				} finally {
					release();
				}
			},
			executablePath,
		);
	} finally {
		release();
		held.mockRestore();
	}
}

const OUTPUT_CLOSE_FIXTURE = `
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'pid') process.stdout.write(JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'close-output') process.stdout.end(() => closeSync(1));
  if (command === 'exit') process.exit(0);
});
`;

test("closed fixture output promptly rejects pending and subsequent RPCs (#3419)", async () => {
	await withClient(OUTPUT_CLOSE_FIXTURE, async (client) => {
		await assert.rejects(
			client.request("close-output", undefined, TRANSPORT_FAILURE_TIMEOUT_MS),
			/Postgres fixture (output closed|exited)/,
		);
		await assert.rejects(
			client.request("after-close", undefined, TRANSPORT_FAILURE_TIMEOUT_MS),
			/Postgres fixture (output closed|exited)/,
		);
	});
});

const INPUT_CLOSE_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'pid' || command === 'close-input')
    writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
});
`;

test("broken fixture stdin rejects all pending and subsequent RPCs without uncaught EPIPE (#3419)", async () => {
	const spawn = runtime.spawnProcess;
	let stdin: Writable | undefined;
	const endpoint = vi.spyOn(runtime, "spawnProcess").mockImplementation((first, second) => {
		const child = spawn(first, second);
		assert.ok(child.stdin instanceof Writable);
		stdin = child.stdin;
		return child;
	});
	try {
		await withClient(INPUT_CLOSE_FIXTURE, async (client) => {
			await client.request("close-input", undefined, TRANSPORT_FAILURE_TIMEOUT_MS);
			const first = client.request("first", undefined, TRANSPORT_FAILURE_TIMEOUT_MS);
			const second = client.request("second", undefined, TRANSPORT_FAILURE_TIMEOUT_MS);
			const rejected = Promise.all([
				assert.rejects(first, /EPIPE|stdin closed|destroyed/),
				assert.rejects(second, /EPIPE|stdin closed|destroyed/),
			]);
			assert.ok(stdin);
			stdin.destroy();
			assert.equal(stdin.destroyed, true);
			await assert.rejects(
				client.request("write-after-close", undefined, TRANSPORT_FAILURE_TIMEOUT_MS),
				/EPIPE|stdin closed|destroyed/,
			);
			await rejected;
			await assert.rejects(
				client.request("after-error", undefined, TRANSPORT_FAILURE_TIMEOUT_MS),
				/EPIPE|stdin closed|destroyed/,
			);
		});
	} finally {
		endpoint.mockRestore();
	}
});

const EXIT_RPC_MARKER_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'exit') writeFileSync(join(process.env.ATOMIC_FAULT_TEST_HOME, 'exit-rpc'), 'exit');
  writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'exit') process.exit(0);
});
`;

for (const executable of [process.execPath, runtime.bunExecutable()]) {
	test(`intentional crash waits for held stderr drain without an exit RPC and permits repeated cleanup (${executable}) (#3419)`, async () => {
		await withHeldStderr(
			EXIT_RPC_MARKER_FIXTURE,
			async (client, waitForDrain, release) => {
				const marker = join(client.home, "exit-rpc");
				assert.equal(await runtime.fileExists(marker), false);
				const exit = client.crash();
				try {
					await waitForDrain();
					assert.equal(
						await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
						"draining",
					);
				} finally {
					release();
				}
				await exit;
				await client.exit();
				await client.exit();
				assert.equal(
					await runtime.fileExists(marker),
					false,
					"crash and repeated cleanup must not send an exit RPC",
				);
			},
			executable,
		);
	});
}

test("graceful fixture exit still consumes its acknowledgement and permits repeated cleanup (#3419)", async () => {
	await withClient(EXIT_RPC_MARKER_FIXTURE, async (client) => {
		await client.exit();
		assert.equal(await runtime.fileExists(join(client.home, "exit-rpc")), true);
		await client.waitForExit();
		await client.exit();
	});
});

const CLEAN_EXIT_BEFORE_CLOSE_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'finish' || command === 'exit') {
    process.exit(Number(process.env.FIXTURE_EXIT_CODE || 0));
  }
});
`;

for (const executable of [process.execPath, runtime.bunExecutable()]) {
	test(`clean fixture exit permits cleanup after terminal output and held stderr drain (${executable}) (#3419)`, async () => {
		await withHeldStderr(
			CLEAN_EXIT_BEFORE_CLOSE_FIXTURE,
			async (client, waitForDrain, release) => {
				await client.request("finish");
				await assert.rejects(client.request("after-finish"), /output closed|EPIPE|destroyed/);
				try {
					await waitForDrain();
					const exit = client.exit();
					assert.equal(
						await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
						"draining",
					);
					release();
					await exit;
					await client.exit();
				} finally {
					release();
				}
			},
			executable,
		);
	});

	test(`clean fixture exit during exit RPC drains stderr without an acknowledgement (${executable}) (#3419)`, async () => {
		const fixture = CLEAN_EXIT_BEFORE_CLOSE_FIXTURE.replace(
			"writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');",
			"if (command !== 'exit') writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');",
		);
		await withHeldStderr(
			fixture,
			async (client, waitForDrain, release) => {
				const exit = client.exit();
				try {
					await waitForDrain();
					assert.equal(
						await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
						"draining",
					);
				} finally {
					release();
				}
				await exit;
			},
			executable,
		);
	});

	test(`terminal fixture cleanup rejects unexpected nonzero exit (${executable}) (#3419)`, async () => {
		const fixture = CLEAN_EXIT_BEFORE_CLOSE_FIXTURE.replace("Number(process.env.FIXTURE_EXIT_CODE || 0)", "7");
		await withClient(
			fixture,
			async (client) => {
				await client.request("finish");
				await assert.rejects(client.request("after-finish"), /output closed|EPIPE|destroyed/);
				const exit = assert.rejects(client.exit(), /Postgres fixture exited with code 7/);
				await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
				await exit;
			},
			executable,
		);
	});
}

test("fixture exit RPC handler errors remain cleanup failures even after a clean process exit (#3419)", async () => {
	const fixture = CLEAN_EXIT_BEFORE_CLOSE_FIXTURE.replace(
		"{ id, result: process.pid }",
		"command === 'exit' ? { id, error: 'exit handler failed' } : { id, result: process.pid }",
	);
	await withClient(fixture, async (client) => {
		await assert.rejects(client.exit(), /exit handler failed/);
	});
});

test("terminal output from a still-running fixture retains the graceful exit timeout (#3419)", async () => {
	await withClient(OUTPUT_CLOSE_FIXTURE, async (client) => {
		await assert.rejects(client.request("close-output", undefined, TRANSPORT_FAILURE_TIMEOUT_MS), /output closed/);
		await assert.rejects(client.exit(), /Postgres fixture graceful exit exceeded 5000ms/);
	});
});
