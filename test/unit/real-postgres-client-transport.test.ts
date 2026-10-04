import assert from "node:assert/strict";
import { join } from "node:path";
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

const OUTPUT_CLOSE_FIXTURE = `
import { createInterface } from 'node:readline';
import { closeSync, writeSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'pid') writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'close-output') setTimeout(() => closeSync(1), 20);
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
import { closeSync, writeSync } from 'node:fs';
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'close-input') closeSync(0);
  writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
});
`;

test("broken fixture stdin rejects all pending and subsequent RPCs without uncaught EPIPE (#3419)", async () => {
	await withClient(INPUT_CLOSE_FIXTURE, async (client) => {
		await client.request("close-input");
		const first = client.request("first", undefined, TRANSPORT_FAILURE_TIMEOUT_MS);
		const second = client.request("second", undefined, TRANSPORT_FAILURE_TIMEOUT_MS);
		await Promise.all([
			assert.rejects(first, /EPIPE|stdin closed|destroyed/),
			assert.rejects(second, /EPIPE|stdin closed|destroyed/),
		]);
		await assert.rejects(
			client.request("after-error", undefined, TRANSPORT_FAILURE_TIMEOUT_MS),
			/EPIPE|stdin closed|destroyed/,
		);
	});
});

const INHERITED_OUTPUT_FIXTURE = `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  if (command === 'hold-output') {
    const script = "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(0); } }, 10); setTimeout(() => process.exit(1), 10000);";
    spawn(process.execPath, ['-e', script, process.env.HOME + '/release'], { stdio: ['ignore', 1, 2] });
  }
  writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'exit') process.exit(0);
});
`;

test("intentional crash waits for inherited output drain without an exit RPC and permits repeated cleanup (#3419)", async () => {
	await withClient(INHERITED_OUTPUT_FIXTURE, async (client) => {
		await client.request("hold-output");
		try {
			const exit = client.crash();
			assert.equal(
				await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
				"draining",
			);
			await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
			await exit;
			await client.exit();
		} finally {
			await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
		}
	});
});

test("graceful fixture exit still consumes its acknowledgement and permits repeated cleanup (#3419)", async () => {
	await withClient(INHERITED_OUTPUT_FIXTURE, async (client) => {
		await client.exit();
		await client.waitForExit();
		await client.exit();
	});
});

const CLEAN_EXIT_BEFORE_CLOSE_FIXTURE = `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, command } = JSON.parse(line);
  writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');
  if (command === 'finish' || command === 'exit') {
    const script = "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(0); } }, 10); setTimeout(() => process.exit(1), 10000);";
    spawn(process.execPath, ['-e', script, process.env.HOME + '/release'], { stdio: ['ignore', 'ignore', 2] });
    process.exit(Number(process.env.FIXTURE_EXIT_CODE || 0));
  }
});
`;

for (const executable of [process.execPath, runtime.bunExecutable()]) {
	test(`clean fixture exit before adapter close permits cleanup after terminal output (${executable}) (#3419)`, async () => {
		await withClient(
			CLEAN_EXIT_BEFORE_CLOSE_FIXTURE,
			async (client) => {
				await client.request("finish");
				await assert.rejects(client.request("after-finish"), /output closed|EPIPE|destroyed/);
				try {
					const exit = client.exit();
					assert.equal(
						await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
						"draining",
					);
					await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
					await exit;
					await client.exit();
				} finally {
					await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
				}
			},
			executable,
		);
	});

	test(`clean fixture exit during exit RPC permits cleanup without an acknowledgement (${executable}) (#3419)`, async () => {
		const fixture = CLEAN_EXIT_BEFORE_CLOSE_FIXTURE.replace(
			"writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');",
			"if (command !== 'exit') writeSync(1, JSON.stringify({ id, result: process.pid }) + '\\n');",
		);
		await withClient(
			fixture,
			async (client) => {
				const exit = client.exit();
				try {
					assert.equal(
						await Promise.race([exit.then(() => "exited"), runtime.sleep(50).then(() => "draining")]),
						"draining",
					);
				} finally {
					await runtime.writeFileEnsuringDir(join(client.home, "release"), "release");
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
	).replace(
		"spawn(process.execPath, ['-e', script, process.env.HOME + '/release'], { stdio: ['ignore', 'ignore', 2] });",
		"",
	);
	await withClient(fixture, async (client) => {
		await assert.rejects(client.exit(), /exit handler failed/);
	});
});

test("terminal output from a still-running fixture retains the graceful exit timeout (#3419)", async () => {
	await withClient(OUTPUT_CLOSE_FIXTURE, async (client) => {
		await assert.rejects(client.request("close-output"), /output closed/);
		await assert.rejects(client.exit(), /Postgres fixture graceful exit exceeded 5000ms/);
	});
});
