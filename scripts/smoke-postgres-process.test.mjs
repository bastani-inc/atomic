import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSmokeCommand, startOnAvailablePort } from "./smoke-postgres-process.mjs";

test("a successful launcher returns while its server still inherits stdout and stderr", () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-pg-inherited-pipes-"));
	const pidFile = join(cwd, "server.pid");
	try {
		const output = runSmokeCommand(
			process.execPath,
			[
				"-e",
				`const { spawn } = require('node:child_process');
				const { writeFileSync, writeSync } = require('node:fs');
				const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
					stdio: ['ignore', 'inherit', 'inherit'], detached: true
				});
				writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
				server.unref();
				writeSync(1, 'waiting for server to start.... done\\nserver started\\n');`,
			],
			{ cwd, env: process.env },
		);
		assert.match(output, /server started/u);
		// Returning must not require terminating the successfully launched server.
		process.kill(Number(readFileSync(pidFile, "utf8")), 0);
	} finally {
		try {
			process.kill(Number(readFileSync(pidFile, "utf8")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

function listen(server, port) {
	return new Promise((done, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", done);
	});
}

function close(server) {
	return new Promise((done, reject) => {
		if (!server.listening) return done();
		server.close((error) => (error ? reject(error) : done()));
	});
}

test("startup retries a released-port collision without stopping the intervening listener", async () => {
	const competitor = createServer();
	let owned;
	let attempts = 0;
	let cleanups = 0;
	try {
		const port = await startOnAvailablePort(
			async (candidate) => {
				attempts += 1;
				if (attempts === 1) await listen(competitor, candidate);
				owned = createServer();
				await listen(owned, candidate);
			},
			async () => {
				cleanups += 1;
				await close(owned);
			},
		);
		assert.equal(attempts, 2);
		assert.equal(cleanups, 1);
		assert.equal(owned.address().port, port);
		assert.notEqual(port, competitor.address().port);
		assert.equal(competitor.listening, true);
	} finally {
		if (owned) await close(owned);
		await close(competitor);
	}
});

test("persistent released-port collisions stop after three attempts and clean each failed start", async () => {
	const competitors = [];
	let owned;
	let cleanups = 0;
	try {
		await assert.rejects(
			startOnAvailablePort(
				async (port) => {
					const competitor = createServer();
					competitors.push(competitor);
					await listen(competitor, port);
					owned = createServer();
					await listen(owned, port);
				},
				async () => {
					cleanups += 1;
					await close(owned);
				},
			),
			{ code: "EADDRINUSE" },
		);
		assert.equal(competitors.length, 3);
		assert.equal(cleanups, 3);
		assert.ok(competitors.every((server) => server.listening));
	} finally {
		if (owned) await close(owned);
		await Promise.all(competitors.map(close));
	}
});

test("command failures preserve nonzero status and both diagnostic streams without retrying", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-pg-command-failure-"));
	let attempts = 0;
	let cleanups = 0;
	try {
		await assert.rejects(
			startOnAvailablePort(
				() => {
					attempts += 1;
					runSmokeCommand(
						process.execPath,
						["-e", "console.log('startup'); console.error('permission denied'); process.exitCode = 7"],
						{ cwd, env: process.env },
					);
				},
				() => {
					cleanups += 1;
				},
			),
			(error) => {
				assert.equal(error.status, 7);
				assert.match(error.stdout, /startup/u);
				assert.match(error.stderr, /permission denied/u);
				return true;
			},
		);
		assert.equal(attempts, 1);
		assert.equal(cleanups, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

for (const message of [
	"Address already in use",
	"Only one usage of each socket address (protocol/network address/port) is normally permitted.",
]) {
	test(`pg_ctl's logged ${message} triggers a bounded retry`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-pg-logged-collision-"));
		let attempts = 0;
		let cleanups = 0;
		try {
			await assert.rejects(
				startOnAvailablePort(
					() => {
						attempts += 1;
						try {
							runSmokeCommand(
								process.execPath,
								["-e", "console.error('pg_ctl: could not start server'); process.exitCode = 1"],
								{ cwd, env: process.env },
							);
						} catch (error) {
							error.postgresLog = `LOG: could not bind IPv4 address "127.0.0.1": ${message}\nFATAL: could not create any TCP/IP sockets\n`;
							throw error;
						}
					},
					() => {
						cleanups += 1;
					},
				),
				{ status: 1 },
			);
			assert.equal(attempts, 3);
			assert.equal(cleanups, 3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

test("an actual command deadline still fails and is not retried", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-pg-command-timeout-"));
	let attempts = 0;
	let cleanups = 0;
	try {
		await assert.rejects(
			startOnAvailablePort(
				() => {
					attempts += 1;
					runSmokeCommand(process.execPath, ["-e", "console.log('still starting'); setInterval(() => {}, 1000)"], {
						cwd,
						env: process.env,
					});
				},
				() => {
					cleanups += 1;
				},
			),
			(error) => {
				assert.equal(error.code, "ETIMEDOUT");
				assert.match(error.stdout, /still starting/u);
				return true;
			},
		);
		assert.equal(attempts, 1);
		assert.equal(cleanups, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a failed owned cleanup aborts collision retry", async () => {
	const competitor = createServer();
	const owned = createServer();
	let attempts = 0;
	const cleanupError = new Error("owned cluster could not be stopped");
	try {
		await assert.rejects(
			startOnAvailablePort(
				async (port) => {
					attempts += 1;
					await listen(competitor, port);
					await listen(owned, port);
				},
				() => {
					throw cleanupError;
				},
			),
			(error) => error === cleanupError,
		);
		assert.equal(attempts, 1);
	} finally {
		await close(owned);
		await close(competitor);
	}
});
