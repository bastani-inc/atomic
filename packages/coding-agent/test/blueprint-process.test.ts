import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	copiesOutputToLog,
	LOG_TAIL_BYTES,
	type LoggedProcess,
	type LoggedProcessOptions,
	logTail,
	openStepLog,
	type ProcessExit,
	runLoggedProcess,
	startElapsedMs,
	startsProcessGroup,
	stepProcessWatcher,
	stepStartingWatcher,
} from "../src/core/resume/blueprint/process.ts";
import { getShellConfig } from "../src/utils/shell.ts";

const STEADY_TIMEOUT_MS = 60_000;
const PROCESS_START_WAIT_MS = 20_000;
/**
 * The codes with which the system refuses to start a program for a moment, as runLoggedProcess treats them. A busy
 * Windows machine has refused to start Node for most of a second (#6124).
 */
const PASSING_REFUSALS = process.platform === "win32" ? ["EPERM", "EBUSY"] : ["ETXTBSY"];
/**
 * How many times a test that needs a running process starts it: a step tries for two seconds, so about ten in all. A
 * machine that refuses starts can also be scanning a program just written, as the copy a held program is.
 */
const REFUSED_STARTS = 5;
/** How many times, 50 ms apart, the process of such a test tries to start its own child: about ten seconds. */
const REFUSED_CHILD_TRIES = 200;
/** The most tries a step makes of a program that stays refused: ten 50 ms apart, then at most six, further apart. */
const MAX_REFUSED_TRIES = 16;
/** Bound on the event-loop turns until a refused step is waiting to try again. */
const UNTIL_WAITING_TURNS = 10_000;

let sandbox: string;
let logCount = 0;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-process-")));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

/** Runs `script` under Node; `scriptArgs` reach it as `process.argv[1]` onward, so paths never become source text. */
function nodeProcess(script: string, overrides: Partial<LoggedProcess> = {}, scriptArgs: string[] = []): LoggedProcess {
	return {
		command: process.execPath,
		args: ["-e", script, ...scriptArgs],
		cwd: sandbox,
		env: { ...process.env },
		...overrides,
	};
}

async function execute(
	run: LoggedProcess,
	options: LoggedProcessOptions = { timeoutMs: STEADY_TIMEOUT_MS },
): Promise<{ exit: ProcessExit; output: string }> {
	const log = await openStepLog(path(`step-${++logCount}.log`));
	try {
		const exit = await runLoggedProcess(run, log, options);
		return { exit, output: readFileSync(log.path, "utf8") };
	} finally {
		await log.close();
	}
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (!done()) {
		assert.ok(Date.now() < deadline, `${what} never happened`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Runs `start` and counts each try it makes to start a process: `onTry` is told the count before the try. */
async function counting<T>(start: () => Promise<T>, onTry: (tries: number) => void = () => {}) {
	let tries = 0;
	const result = await stepStartingWatcher.run(() => onTry(++tries), start);
	return { result, tries };
}

/** A fresh copy of Node that Windows refuses to start, with EPERM, until `allow` runs: no one may execute it. */
function refusedNode(): { command: string; allow: () => void } {
	const command = path("refused-node.exe");
	copyFileSync(process.execPath, command);
	execFileSync("icacls", [command, "/deny", "*S-1-1-0:(X)"], { stdio: "ignore" });
	return { command, allow: () => execFileSync("icacls", [command, "/remove:d", "*S-1-1-0"], { stdio: "ignore" }) };
}

/** Whether the system refuses to start a program that another program holds open for writing: Windows and Linux do. */
const refusesHeldPrograms = process.platform === "win32" || process.platform === "linux";

/**
 * A program that runs Node, written just now and held open for writing until `release` runs, so the system refuses to
 * start it: a copy of Node on Windows (EBUSY), a script on Linux (ETXTBSY). `run` makes it run `script` as
 * {@link nodeProcess} does.
 */
function heldNode(): {
	refusal: string;
	run: (script: string, scriptArgs?: string[]) => LoggedProcess;
	release: () => void;
} {
	const command = path(process.platform === "win32" ? "held-node.exe" : "held-node");
	if (process.platform === "win32") copyFileSync(process.execPath, command);
	else writeFileSync(command, '#!/bin/sh\nexec "$HELD_NODE" "$@"\n', { mode: 0o755 });
	const held = openSync(command, "r+");
	let open = true;
	return {
		refusal: process.platform === "win32" ? "EBUSY" : "ETXTBSY",
		run: (script, scriptArgs = []) =>
			nodeProcess(script, { command, env: { ...process.env, HELD_NODE: process.execPath } }, scriptArgs),
		release: () => {
			if (open) closeSync(held);
			open = false;
		},
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

test("an ordinary elapsed time matches the wall sample even if the thread is descheduled between reads (#5707)", () => {
	let now = 0;
	const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
	const monotonic = vi.spyOn(performance, "now").mockImplementation(() => now);
	try {
		const elapsedMs = startElapsedMs();
		now = 450;
		wall.mockImplementation(() => {
			// The wall clock samples 450 ms; the thread loses another 20 ms before it can read anything else.
			now += 20;
			return 1_450;
		});
		assert.equal(elapsedMs(), 450);
	} finally {
		monotonic.mockRestore();
		wall.mockRestore();
	}
});

describe("running a logged process (#4588)", () => {
	test("both output streams are appended to the log and the exit status is reported (#4588)", async () => {
		const before = Date.now();
		const { exit, output } = await execute(nodeProcess('console.log("out"); console.error("err"); process.exit(3)'));
		const after = Date.now();
		assert.equal(output, "out\nerr\n");
		assert.equal(exit.exitStatus, 3);
		assert.equal(exit.signal, null);
		assert.equal(exit.timedOut, false);
		assert.equal(exit.spawnError, undefined);
		assert.ok(exit.elapsedMs >= 0 && exit.elapsedMs <= after - before, `elapsed ${exit.elapsedMs} ms`);
	});

	test("the process gets exactly the given working directory and environment (#4588)", async () => {
		process.env.BLUEPRINT_PROCESS_LEAK = "leaked";
		try {
			mkdirSync(path("work"));
			const run = nodeProcess(
				"console.log(JSON.stringify([process.cwd(), process.env.GIVEN, process.env.BLUEPRINT_PROCESS_LEAK]))",
				{
					cwd: path("work"),
					env: { ...process.env, GIVEN: "kept", BLUEPRINT_PROCESS_LEAK: undefined },
				},
			);
			const { output } = await execute(run);
			assert.deepEqual(JSON.parse(output), [path("work"), "kept", null]);
		} finally {
			delete process.env.BLUEPRINT_PROCESS_LEAK;
		}
	});

	test("the text given as stdin reaches the process and is closed, and without any the process sees end of input (#4588)", async () => {
		const echo =
			'let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => console.log("got:" + data));';
		const given = await execute(nodeProcess(echo, { stdin: "hello\nworld" }));
		assert.equal(given.output, "got:hello\nworld\n");
		assert.equal(given.exit.exitStatus, 0);
		const none = await execute(nodeProcess(echo));
		assert.equal(none.output, "got:\n");
		assert.equal(none.exit.timedOut, false);
		assert.equal(none.exit.exitStatus, 0);
	});

	test("a process that outlives its timeout is stopped and reported as timed out (#4588)", async () => {
		const { exit } = await execute(nodeProcess("setInterval(() => {}, 1000)"), { timeoutMs: 300 });
		assert.equal(exit.timedOut, true);
		assert.equal(exit.spawnError, undefined);
		assert.ok(exit.elapsedMs >= 200, `elapsed ${exit.elapsedMs} ms`);
		assert.equal(exit.exitStatus === 0, false);
	});

	test("a running budget beyond the largest timer delay does not kill a short command after 1 ms (#5707)", async () => {
		const { exit, output } = await execute(nodeProcess('setTimeout(() => console.log("finished"), 30)'), {
			timeoutMs: 2_147_483_648.5,
		});
		assert.equal(exit.timedOut, false);
		assert.equal(exit.exitStatus, 0);
		assert.equal(output, "finished\n");
	});

	test("a command that cannot be started resolves with the spawn error instead of rejecting (#4588)", async () => {
		const { exit } = await execute(nodeProcess("", { command: path("missing-command") }));
		assert.equal((exit.spawnError as NodeJS.ErrnoException).code, "ENOENT");
		assert.equal(exit.exitStatus, null);
		assert.equal(exit.signal, null);
		assert.equal(exit.timedOut, false);
		assert.ok(exit.elapsedMs >= 0);
	});

	test("a process the system refuses to start at once resolves with the refusal after one try instead of rejecting (#5608)", async () => {
		writeFileSync(path("not-a-directory"), "");
		const { result, tries } = await counting(() =>
			execute(nodeProcess('console.log("ran")', { cwd: path("not-a-directory") })),
		);
		assert.ok(result.exit.spawnError instanceof Error);
		assert.equal(result.exit.exitStatus, null);
		assert.equal(result.exit.signal, null);
		assert.equal(result.exit.timedOut, false);
		assert.equal(result.output, "");
		assert.equal(tries, 1);
	});

	test("cancelling a step just as its process is about to start rejects with the reason and never starts it (#5608)", async () => {
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const run = nodeProcess('require("node:fs").writeFileSync(process.argv[1], "")', {}, [path("started")]);
		const { result, tries } = await counting(
			() =>
				execute(run, { timeoutMs: STEADY_TIMEOUT_MS, signal: controller.signal }).then(
					() => "resolved",
					(error: unknown) => error,
				),
			() => controller.abort(reason),
		);
		assert.equal(result, reason);
		assert.equal(tries, 1);
		assert.equal(existsSync(path("started")), false);
	});

	test.skipIf(!refusesHeldPrograms)(
		"a program the system refuses to start while another program holds it open for writing is started once it lets go (#5608)",
		async () => {
			const held = heldNode();
			try {
				const { result, tries } = await counting(
					() => execute(held.run('console.log("started")')),
					(tries) => {
						if (tries === 2) held.release();
					},
				);
				assert.equal(result.output, "started\n");
				assert.equal(result.exit.exitStatus, 0);
				assert.equal(result.exit.spawnError, undefined);
				assert.equal(tries, 2);
			} finally {
				held.release();
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"a refusal at 1950 whole milliseconds still gets the final retry (#5608, #5707, #6124)",
		async () => {
			const log = await openStepLog(path("boundary.log"));
			const spawn = childProcess.spawn;
			const held = heldNode();
			const run = held.run('console.log("started")');
			let release: NodeJS.Timeout | undefined;
			// Both clocks read millisecond 1950 when the step checks the real refusal. They are held still only from its
			// start to that check, which runs without a turn of the event loop, so a loaded host cannot move the check to
			// another millisecond. The retry and the started process then run on the real clocks.
			const wallStart = Date.now();
			const monoStart = performance.now();
			const wall = vi.spyOn(Date, "now").mockReturnValue(wallStart);
			const monotonic = vi.spyOn(performance, "now").mockReturnValue(monoStart);
			const realClocks = () => {
				wall.mockRestore();
				monotonic.mockRestore();
			};
			let decisionMs: number | undefined;
			const options = {
				get timeoutMs() {
					if (decisionMs === undefined) {
						decisionMs = Date.now() - wallStart;
						realClocks();
					}
					return 3_000;
				},
			};
			const os = vi.spyOn(childProcess, "spawn").mockImplementationOnce((...args) => {
				try {
					return spawn(...args);
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ETXTBSY");
					// The real refusal, partway through millisecond 1950. Release the file during the wait.
					wall.mockReturnValue(wallStart + 1_950);
					monotonic.mockReturnValue(monoStart + 1_950.25);
					release = setTimeout(held.release, 25);
					throw error;
				}
			});
			syncBuiltinESMExports();
			try {
				const exit = await runLoggedProcess(run, log, options);
				assert.equal(decisionMs, 1_950);
				assert.equal(exit.spawnError, undefined);
				assert.equal(exit.exitStatus, 0);
			} finally {
				realClocks();
				os.mockRestore();
				syncBuiltinESMExports();
				clearTimeout(release);
				held.release();
				await log.close();
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"a program Windows refuses to start for a moment with EPERM is started when it is tried again (#5608)",
		async () => {
			const refused = refusedNode();
			try {
				const { result, tries } = await counting(
					() => execute(nodeProcess('console.log("started")', { command: refused.command })),
					(tries) => {
						if (tries === 2) refused.allow();
					},
				);
				assert.equal(result.output, "started\n");
				assert.equal(result.exit.exitStatus, 0);
				assert.equal(result.exit.spawnError, undefined);
				assert.equal(tries, 2);
			} finally {
				refused.allow();
			}
		},
	);

	test.skipIf(!refusesHeldPrograms)(
		"a program the system keeps refusing to start resolves with the refusal within about two seconds, however long each try takes (#5608, #6124)",
		async () => {
			const sleeper = new Int32Array(new SharedArrayBuffer(4));
			for (const tryMs of [0, 100]) {
				const held = heldNode();
				try {
					const controller = new AbortController();
					const { result, tries } = await counting(
						() =>
							execute(held.run('console.log("started")'), {
								timeoutMs: STEADY_TIMEOUT_MS,
								signal: controller.signal,
							}),
						() => {
							if (tryMs > 0) Atomics.wait(sleeper, 0, 0, tryMs);
						},
					);
					const what = `each try taking ${tryMs} ms`;
					assert.equal((result.exit.spawnError as NodeJS.ErrnoException).code, held.refusal, what);
					assert.equal(result.exit.exitStatus, null, what);
					assert.equal(result.exit.timedOut, false, what);
					assert.equal(result.output, "", what);
					// Ten tries in the first half second, then a few more, ever further apart.
					assert.ok(tries > 1 && tries <= MAX_REFUSED_TRIES, `${what}: tried ${tries} times`);
					// Tries stop two seconds after the first; the rest is room for a busy machine.
					assert.ok(result.exit.elapsedMs < 4_000, `${what}: refused after ${result.exit.elapsedMs} ms`);
					assert.equal(getEventListeners(controller.signal, "abort").length, 0, what);
				} finally {
					held.release();
				}
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"a program Windows keeps refusing to start with EPERM resolves with the refusal within about two seconds (#5608, #6124)",
		async () => {
			const refused = refusedNode();
			try {
				const { result, tries } = await counting(() =>
					execute(nodeProcess('console.log("started")', { command: refused.command })),
				);
				assert.equal((result.exit.spawnError as NodeJS.ErrnoException).code, "EPERM");
				assert.equal(result.exit.spawnError?.message, "spawn EPERM");
				assert.equal(result.exit.timedOut, false);
				assert.equal(result.output, "");
				assert.ok(tries > 1 && tries <= MAX_REFUSED_TRIES, `tried ${tries} times`);
				assert.ok(result.exit.elapsedMs < 4_000, `refused after ${result.exit.elapsedMs} ms`);
			} finally {
				refused.allow();
			}
		},
	);

	test.skipIf(!refusesHeldPrograms).each([0, -1_000])(
		"a late retry never starts a refused program after its deadline with a wall-clock correction of %i ms (#5678, #5707)",
		async (correction) => {
			const held = heldNode();
			const marker = path("started late");
			const timeoutMs = 200;
			const sleeper = new Int32Array(new SharedArrayBuffer(4));
			const started: number[] = [];
			const wallNow = Date.now.bind(Date);
			const clock = vi.spyOn(Date, "now");
			let releaseTimer: NodeJS.Timeout | undefined;
			try {
				const { result } = await counting(
					() =>
						stepProcessWatcher.run(
							(pid, running) => {
								if (running) started.push(pid);
							},
							() =>
								execute(held.run('require("node:fs").writeFileSync(process.argv[1], "")', [marker]), {
									timeoutMs,
								}),
						),
					(tries) => {
						if (tries !== 1) return;
						// While it waits to be tried again, the program is released and the event loop stays busy past the
						// step's timeout, so the next try wakes after it.
						releaseTimer = setTimeout(() => {
							clock.mockImplementation(() => wallNow() + correction);
							held.release();
							Atomics.wait(sleeper, 0, 0, timeoutMs + 150);
						}, 10);
					},
				);
				assert.deepEqual(started, []);
				assert.ok(result.exit.elapsedMs >= timeoutMs, `elapsed ${result.exit.elapsedMs} ms`);
				assert.equal((result.exit.spawnError as NodeJS.ErrnoException).code, held.refusal);
				assert.equal(result.exit.exitStatus, null);
				assert.equal(result.exit.timedOut, false);
				assert.equal(result.output, "");
			} finally {
				clearTimeout(releaseTimer);
				clock.mockRestore();
				held.release();
			}
			assert.equal(existsSync(marker), false);
		},
	);

	test.skipIf(process.platform !== "linux")(
		"a refused program is not started when its retry deadline passes during system suspend (#5678, #5707)",
		async () => {
			const held = heldNode();
			const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
			const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
			try {
				const { result, tries } = await counting(
					() => execute(held.run('console.log("started")'), { timeoutMs: 200 }),
					(attempt) => {
						if (attempt !== 2) return;
						// Linux's monotonic clock counts the 50 ms retry delay, but not the 350 ms spent asleep.
						wall.mockReturnValue(1_400);
						monotonic.mockReturnValue(50);
						held.release();
					},
				);
				assert.equal(tries, 2);
				assert.equal((result.exit.spawnError as NodeJS.ErrnoException | undefined)?.code, "ETXTBSY");
				assert.equal(result.output, "");
				assert.equal(result.exit.elapsedMs, 400);
			} finally {
				monotonic.mockRestore();
				wall.mockRestore();
				held.release();
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"a retried command's timeout reports the time spent asleep before it started (#5707)",
		async () => {
			const held = heldNode();
			const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
			const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
			try {
				const { result, tries } = await counting(
					() =>
						stepProcessWatcher.run(
							(_pid, running) => {
								if (running) return;
								// The child has been stopped after 605 more milliseconds awake.
								wall.mockReturnValue(2_005);
								monotonic.mockReturnValue(655);
							},
							() => execute(held.run("setInterval(() => {}, 1000)"), { timeoutMs: 1_000 }),
						),
					(attempt) => {
						if (attempt !== 2) return;
						// The 50 ms retry and 350 ms of suspend leave the child 600 ms to run.
						wall.mockReturnValue(1_400);
						monotonic.mockReturnValue(50);
						held.release();
					},
				);
				assert.equal(tries, 2);
				assert.equal(result.exit.timedOut, true);
				assert.equal(result.exit.elapsedMs, 1_005);
			} finally {
				monotonic.mockRestore();
				wall.mockRestore();
				held.release();
			}
		},
	);

	test.skipIf(!refusesHeldPrograms)(
		"cancelling a refused program while it waits to be tried again, or as it is tried again, rejects with the reason and never starts it (#5608)",
		async () => {
			for (const when of ["while it waits", "as it is tried again"] as const) {
				const held = heldNode();
				const controller = new AbortController();
				const reason = new Error(`resume cancelled ${when}`);
				const marker = path(`started ${when}`);
				try {
					const { result, tries } = await counting(
						() =>
							execute(held.run('require("node:fs").writeFileSync(process.argv[1], "")', [marker]), {
								timeoutMs: STEADY_TIMEOUT_MS,
								signal: controller.signal,
							}).then(
								() => "resolved",
								(error: unknown) => error,
							),
						(tries) => {
							if (when === "while it waits" && tries === 1) setTimeout(() => controller.abort(reason), 0);
							if (when === "as it is tried again" && tries === 2) {
								held.release();
								controller.abort(reason);
							}
						},
					);
					assert.equal(result, reason, when);
					assert.equal(tries, when === "while it waits" ? 1 : 2, when);
					assert.equal(getEventListeners(controller.signal, "abort").length, 0, when);
				} finally {
					held.release();
				}
				assert.equal(existsSync(marker), false, when);
			}
		},
	);

	test.skipIf(!refusesHeldPrograms)(
		"the time a refused program waits to be tried again counts toward the step's timeout (#5608)",
		async () => {
			const held = heldNode();
			const timeoutMs = 3_000;
			const waitedMs = 2_000;
			const sleeper = new Int32Array(new SharedArrayBuffer(4));
			let firstTry = 0;
			try {
				const { result, tries } = await counting(
					() => execute(held.run("setInterval(() => {}, 1000)"), { timeoutMs }),
					(tries) => {
						if (tries === 1) firstTry = Date.now();
						if (tries !== 2) return;
						// The second try starts two of the step's three seconds after the first.
						const left = firstTry + waitedMs - Date.now();
						if (left > 0) Atomics.wait(sleeper, 0, 0, left);
						held.release();
					},
				);
				assert.equal(tries, 2);
				assert.equal(result.exit.timedOut, true);
				assert.equal(result.exit.spawnError, undefined);
				// Stopped once the step's time ran out, not after a whole timeout of its own.
				assert.ok(result.exit.elapsedMs < waitedMs + timeoutMs, `stopped after ${result.exit.elapsedMs} ms`);
			} finally {
				held.release();
			}
		},
	);

	test.skipIf(!refusesHeldPrograms)(
		"a refused program is not tried again past the step's timeout, and resolves with the refusal (#5608)",
		async () => {
			const held = heldNode();
			try {
				const { result, tries } = await counting(() =>
					execute(held.run('console.log("started")'), { timeoutMs: 1 }),
				);
				assert.equal((result.exit.spawnError as NodeJS.ErrnoException).code, held.refusal);
				assert.equal(result.exit.timedOut, false);
				assert.equal(tries, 1);
			} finally {
				held.release();
			}
		},
	);

	test.skipIf(!refusesHeldPrograms)(
		"cancelling a refused program during one of the longer waits between later tries rejects at once and never starts it (#6124)",
		async () => {
			const held = heldNode();
			const marker = path("started");
			const controller = new AbortController();
			const reason = new Error("resume cancelled while it waits");
			const wallStart = Date.now();
			const wall = vi.spyOn(Date, "now");
			// The step's own timers are fake, so only the abort can end its wait.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const outcome = counting(
					() =>
						execute(held.run('require("node:fs").writeFileSync(process.argv[1], "")', [marker]), {
							timeoutMs: STEADY_TIMEOUT_MS,
							signal: controller.signal,
						}).then(
							() => "resolved",
							(error: unknown) => error,
						),
					// The refusal is seen a second into the step, past the tries 50 ms apart, so it waits longer.
					() => wall.mockReturnValue(wallStart + 1_000),
				);
				for (let turn = 0; vi.getTimerCount() === 0 && turn < UNTIL_WAITING_TURNS; turn++)
					await new Promise((resolve) => setImmediate(resolve));
				assert.equal(vi.getTimerCount(), 1, "the step waits to try again");
				controller.abort(reason);
				const { result, tries } = await outcome;
				assert.equal(result, reason);
				assert.equal(tries, 1);
				assert.equal(vi.getTimerCount(), 0, "the wait ended with the abort");
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			} finally {
				vi.useRealTimers();
				wall.mockRestore();
				held.release();
			}
			assert.equal(existsSync(marker), false);
		},
	);

	test("an already aborted signal rejects with its reason before anything starts (#4588)", async () => {
		const reason = new Error("cancelled early");
		const run = nodeProcess('require("node:fs").writeFileSync(process.argv[1], "")', {}, [path("started")]);
		await assert.rejects(
			execute(run, { timeoutMs: STEADY_TIMEOUT_MS, signal: AbortSignal.abort(reason) }),
			(error: unknown) => error === reason,
		);
		assert.equal(existsSync(path("started")), false);
	});

	/**
	 * Starts `script` as `launch` runs it, aborts it once its grandchild runs, and checks that both stopped and the step
	 * rejected with the reason. `onRefused` runs each time the system refused to start the step's process.
	 */
	async function abortsRunningProcess(
		launch: (script: string, scriptArgs: string[]) => LoggedProcess,
		onRefused: () => void = () => {},
	): Promise<void> {
		const grandchild = "setInterval(() => {}, 1000)";
		// What is checked is the abort of a running process, so a start the system refuses for a moment is made again,
		// the grandchild's here and the process's below (#6124).
		const script = [
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			"let child;",
			`for (let tries = 1; child === undefined; tries++) {`,
			`\ttry { child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); }`,
			`\tcatch (error) { if (tries >= ${REFUSED_CHILD_TRIES} || !${JSON.stringify(PASSING_REFUSALS)}.includes(error.code)) throw error; }`,
			"\tif (child === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
			"}",
			"fs.writeFileSync(process.argv[1], String(child.pid));",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		let pending: Promise<{ exit: ProcessExit; output: string }>;
		for (let start = 1; ; start++) {
			const running = execute(launch(script, [path("grandchild.pid")]), {
				timeoutMs: STEADY_TIMEOUT_MS,
				signal: controller.signal,
			});
			// A process that ends, or cannot start, before its grandchild starts fails the wait at once with how it ended.
			const ended: { first?: unknown; refused?: boolean } = {};
			running.then(
				({ exit, output }) => {
					const code = (exit.spawnError as NodeJS.ErrnoException | undefined)?.code ?? "";
					ended.refused = start < REFUSED_STARTS && PASSING_REFUSALS.includes(code);
					ended.first = { ...exit, spawnError: exit.spawnError?.message, output };
				},
				(error: unknown) => {
					ended.first = error;
				},
			);
			await waitFor(() => {
				if (ended.refused) return true;
				assert.equal(ended.first, undefined, "the process ended before its grandchild started");
				return existsSync(path("grandchild.pid")) && readFileSync(path("grandchild.pid"), "utf8") !== "";
			}, "the grandchild starting");
			if (!ended.refused) {
				pending = running;
				break;
			}
			onRefused();
		}
		const grandchildPid = Number(readFileSync(path("grandchild.pid"), "utf8"));
		try {
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
			await waitFor(() => !isAlive(grandchildPid), "the grandchild stopping");
		} finally {
			if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
		}
	}

	test("aborting while the process runs stops it and everything it started, and rejects with the reason (#4588)", async () => {
		await abortsRunningProcess((script, scriptArgs) => nodeProcess(script, {}, scriptArgs));
	});

	test.skipIf(!refusesHeldPrograms)(
		"aborting is checked on a running process even when the system refused to start it for longer than a step tries again (#6124)",
		async () => {
			const held = heldNode();
			try {
				await abortsRunningProcess(held.run, held.release);
			} finally {
				held.release();
			}
		},
	);

	test.skipIf(process.platform !== "win32")(
		"aborting a bash step rejects only once every process it started has ended, even one whose shell ended first",
		async () => {
			const { shell, args, commandTransport } = getShellConfig();
			const work = path("work");
			mkdirSync(work);
			const script = "(sleep 30 3>held.txt & cat /proc/$!/winpid > sleep.pid); sleep 30";
			const controller = new AbortController();
			const reason = new Error("resume cancelled");
			const pending = execute(
				{
					command: shell,
					args: commandTransport === "stdin" ? args : [...args, script],
					cwd: work,
					env: { ...process.env },
					...(commandTransport === "stdin" ? { stdin: script } : {}),
				},
				{ timeoutMs: STEADY_TIMEOUT_MS, signal: controller.signal },
			);
			const pidFile = join(work, "sleep.pid");
			await waitFor(
				() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
				"the background sleep starting",
			);
			const sleeper = Number(readFileSync(pidFile, "utf8").trim());
			try {
				controller.abort(reason);
				await assert.rejects(pending, (error: unknown) => error === reason);
				assert.equal(isAlive(sleeper), false, "the sleep holding a file in the step's directory has ended");
				renameSync(work, path("work-moved"));
			} finally {
				if (isAlive(sleeper)) process.kill(sleeper, "SIGKILL");
			}
		},
	);

	test("an abort that arrives before the command's spawn error rejects instead of reporting the failure (#4588)", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled at once");
		const log = await openStepLog(path("step.log"));
		try {
			const pending = runLoggedProcess(nodeProcess("", { command: path("missing-command") }), log, {
				timeoutMs: STEADY_TIMEOUT_MS,
				signal: controller.signal,
			});
			controller.abort(reason);
			await assert.rejects(pending, (error: unknown) => error === reason);
		} finally {
			await log.close();
		}
	});

	test("the timeout timer and abort listener are released when the process exits (#4588)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const { exit } = await execute(nodeProcess("process.exit(0)"), {
			timeoutMs: 3 * 60 * 60_000,
			signal: controller.signal,
		});
		assert.equal(exit.exitStatus, 0);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("the timeout timer and abort listener are released as soon as the command is known not to start (#4588)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const log = await openStepLog(path("step.log"));
		try {
			const before = Date.now();
			const exit = await runLoggedProcess(nodeProcess("", { command: path("missing-command") }), log, {
				timeoutMs: 3 * 60 * 60_000,
				signal: controller.signal,
			});
			const after = Date.now();
			assert.ok(exit.spawnError !== undefined);
			assert.ok(exit.elapsedMs >= 0 && exit.elapsedMs <= after - before, `elapsed ${exit.elapsedMs} ms`);
			assert.equal(vi.getTimerCount(), 0);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			await log.close();
		}
	});

	test("the output of the shell a blueprint step runs in reaches the log, for echo to stdout and to stderr alike (#4588)", async () => {
		const { shell, args, commandTransport } = getShellConfig();
		const script = 'echo "to stdout"; echo "to stderr" >&2';
		const { exit, output } = await execute({
			command: shell,
			args: commandTransport === "stdin" ? args : [...args, script],
			cwd: sandbox,
			env: { ...process.env },
			...(commandTransport === "stdin" ? { stdin: script } : {}),
		});
		assert.equal(exit.exitStatus, 0, output);
		assert.deepEqual(output.split("\n").sort(), ["", "to stderr", "to stdout"]);
	});

	test("output copied into the log keeps both streams and the exit status, whatever platform runs it (#4588)", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const { exit, output } = await execute(
				nodeProcess('process.stdout.write("out\\n", () => { console.error("err"); process.exitCode = 3; })'),
			);
			assert.equal(output, "out\nerr\n");
			assert.equal(exit.exitStatus, 3);
			assert.equal(exit.spawnError, undefined);
			assert.equal(exit.timedOut, false);
			const missing = await execute(nodeProcess("", { command: path("missing-command") }));
			assert.equal((missing.exit.spawnError as NodeJS.ErrnoException).code, "ENOENT");
			assert.equal(missing.exit.exitStatus, null);
		} finally {
			Object.defineProperty(process, "platform", { value: real });
		}
	});

	test("output that cannot be copied into the log rejects naming the log instead of being lost (#4588)", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await assert.rejects(
				runLoggedProcess(
					nodeProcess('console.log("lost")'),
					{ fd: 999_999, path: path("unwritable.log") },
					{
						timeoutMs: STEADY_TIMEOUT_MS,
					},
				),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(path("unwritable.log")) &&
					(error.cause as NodeJS.ErrnoException).code === "EBADF",
			);
		} finally {
			Object.defineProperty(process, "platform", { value: real });
		}
	});

	test("only Windows has the output of a process copied into the log instead of written to it by the process (#4588)", () => {
		assert.equal(copiesOutputToLog("win32"), true);
		for (const platform of ["linux", "darwin", "freebsd"] as const) assert.equal(copiesOutputToLog(platform), false);
	});

	test("only platforms other than Windows start the process as the leader of its own group (#4588)", () => {
		assert.equal(startsProcessGroup("win32"), false);
		for (const platform of ["linux", "darwin", "freebsd"] as const) assert.equal(startsProcessGroup(platform), true);
	});
});

describe("step logs (#4588)", () => {
	test("a log is created with its directories, appended to and closed on request (#4588)", async () => {
		const logPath = path("deep", "er", "step.log");
		const first = await openStepLog(logPath);
		assert.equal(first.path, logPath);
		await first.close();
		assert.throws(() => fstatSync(first.fd), { code: "EBADF" });
		writeFileSync(logPath, "kept\n");
		const second = await openStepLog(logPath);
		try {
			await runLoggedProcess(nodeProcess('console.log("added")'), second, { timeoutMs: STEADY_TIMEOUT_MS });
		} finally {
			await second.close();
		}
		assert.equal(readFileSync(logPath, "utf8"), "kept\nadded\n");
		if (process.platform !== "win32") assert.equal(statSync(logPath).mode & 0o777, 0o600);
	});

	test("the tail of a log is its last bytes, at most 4096 by default (#4588)", async () => {
		assert.equal(LOG_TAIL_BYTES, 4096);
		const content = `${"a".repeat(2000)}${"b".repeat(3000)}`;
		writeFileSync(path("long.log"), content);
		assert.equal(await logTail(path("long.log")), content.slice(content.length - 4096));
		assert.equal(await logTail(path("long.log"), 10), "b".repeat(10));
		writeFileSync(path("short.log"), "short\n");
		assert.equal(await logTail(path("short.log")), "short\n");
		assert.equal(await logTail(path("short.log"), 3), "rt\n");
	});

	test("the tail of a log that does not exist or cannot be read is empty, because the failure it belongs to is reported anyway (#4588)", async () => {
		assert.equal(await logTail(path("missing.log")), "");
		mkdirSync(path("directory"));
		assert.equal(await logTail(path("directory")), "");
	});
});
