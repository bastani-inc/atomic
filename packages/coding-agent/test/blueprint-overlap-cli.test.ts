/**
 * Real `atomic --session` processes without a UI, resuming into a worktree whose blueprint build runs behind the first
 * turn (#4748): the build's warnings reach the user once, every session and shell command in that worktree waits for
 * it, and a process that ends during the build stops it.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { renameWithRetry } from "../src/core/rename-retry.ts";
import { buildLockPath } from "../src/core/resume/blueprint/build-lock.ts";
import { rootKey } from "../src/core/resume/blueprint/ledger.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { processStartToken } from "../src/core/worktree-snapshot/pool.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { bunExecutable, cliPath } from "./cli-test-helpers.ts";
import { forThisHost } from "./helpers/blueprint-fixtures.ts";

/** Each test starts real CLI processes that restore a worktree and run a blueprint shell step. */
const CLI_RESUME_TIMEOUT_MS = 180_000;
/** How long a process gets to show that it does not run something early, before the build is let through. */
const HOLD_MS = 2_000;

let sandbox: GitSandbox;
let server: Server;
let requests = 0;
const children: ChildProcessWithoutNullStreams[] = [];

/** What the build's step did, in order. */
const markers = () => sandbox.path("markers.txt");
/** The worktree each run of the build's step started in, in order. */
const places = () => sandbox.path("places.txt");
/** The file the build's step waits for, so a test decides when the build ends. */
const gate = () => sandbox.path("gate");
/** The file the model's bash call or the user's shell command writes. */
const toolRan = () => sandbox.path("tool-ran");
const ran = () => (existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split(/\r?\n/) : []);
const shellPath = (path: string) => path.replaceAll("\\", "/");
/** A command bash and PowerShell both run: it creates {@link toolRan}. */
const TOOL_COMMAND = () => `echo ran > "${toolRan()}"`;

function chunk(delta: object, finish: string | null = null): string {
	const body = {
		id: "c",
		object: "chat.completion.chunk",
		created: 0,
		model: "m",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

beforeEach(async () => {
	sandbox = new GitSandbox();
	requests = 0;
	// A prompt that says GOBASH gets one bash call; everything else gets a text answer.
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (data) => {
			raw += data;
		});
		request.on("end", () => {
			requests++;
			const { messages } = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
			const last = messages[messages.length - 1];
			const bash = last?.role === "user" && JSON.stringify(last.content).includes("GOBASH");
			response.writeHead(200, { "content-type": "text/event-stream" });
			const call = {
				index: 0,
				id: `call_${requests}`,
				type: "function",
				function: { name: "bash", arguments: JSON.stringify({ command: TOOL_COMMAND() }) },
			};
			response.end(
				bash
					? `${chunk({ role: "assistant", tool_calls: [call] })}${chunk({}, "tool_calls")}data: [DONE]\n\n`
					: `${chunk({ role: "assistant", content: "ANSWER-TEXT" })}${chunk({}, "stop")}data: [DONE]\n\n`,
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	mkdirSync(sandbox.path("agent"), { recursive: true });
	const model = {
		id: "m",
		name: "M",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
	writeFileSync(
		sandbox.path("agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "k", models: [model] },
			},
		}),
	);
	writeFileSync(
		sandbox.path("agent", "settings.json"),
		JSON.stringify({ defaultProvider: "mock", defaultModel: "m", defaultProjectTrust: "always" }),
	);
});

afterEach(async () => {
	if (!existsSync(gate())) writeFileSync(gate(), "");
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	sandbox.dispose();
});

/** A session recorded in a clone whose blueprint's maintenance waits for {@link gate}; the clone is then gone. */
async function recordedSession(afterGate = "", custom?: string): Promise<{ sessionId: string; storePath: string }> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const blueprint =
		custom ??
		[
			"maintenance:",
			"  - name: Install dependencies",
			"    run: |",
			`      basename "$PWD" >> "${shellPath(places())}"`,
			`      echo started >> "${shellPath(markers())}"`,
			`      while [ ! -f "${shellPath(gate())}" ]; do sleep 0.05; done`,
			`      echo built >> "${shellPath(markers())}"`,
			...(afterGate === "" ? [] : [`      ${afterGate}`]),
			"",
		].join("\n");
	sandbox.write(join(clone, ".atomic", "blueprint.yaml"), forThisHost(blueprint));
	const storePath = sandbox.path("sessions.sqlite");
	const database = await openNodeSqliteDatabase(storePath);
	const store = await SqlSessionStore.open(database);
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "work on it", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: store.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error("the fixture's snapshot was not captured");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	const sessionId = manager.getSessionId();
	await store.close();
	await database.close();
	await renameWithRetry(clone, sandbox.path("node-a-gone"));
	return { sessionId, storePath };
}

function launch(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
	const child = spawn(
		bunExecutable(),
		[
			cliPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			...args,
		],
		{
			cwd: sandbox.root,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: sandbox.path("agent"),
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
				ATOMIC_INTERCOM_GROUP: undefined,
				PI_INTERCOM_GROUP: undefined,
				NO_COLOR: "1",
				...extraEnv,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.push(child);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return { child, exited, out: () => stdout, err: () => stderr };
}

/** `atomic --session <id> --session-store <store>` with `args`. */
function resume(recorded: { sessionId: string; storePath: string }, ...args: string[]) {
	return launch(["--session-store", recorded.storePath, "--session", recorded.sessionId, ...args]);
}

async function until(condition: () => boolean, what: string, ms = 120_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The JSON lines a process wrote to stdout that have `type`. */
function events(stdout: string, type: string): Array<Record<string, unknown>> {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === type);
}

function send(child: ChildProcessWithoutNullStreams, command: object): void {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

/** A session recorded in the store of {@link recordedSession} in a directory that holds no checkout. */
async function plainSession(storePath: string): Promise<string> {
	const directory = sandbox.path("elsewhere");
	mkdirSync(directory, { recursive: true });
	const database = await openNodeSqliteDatabase(storePath);
	const store = await SqlSessionStore.open(database);
	const manager = await SessionManager.create(store, directory);
	await manager.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
	const sessionId = manager.getSessionId();
	await store.close();
	await database.close();
	return sessionId;
}

const count = (marker: string) => ran().filter((line) => line === marker).length;

const PARTIAL_BUILD = /Partial build: .*Install dependencies/;

describe("a resume without a UI whose blueprint build runs behind the first turn (#4748)", () => {
	test(
		"-p shows a failed build's warning once on stderr, also when the model calls no tool (#4748)",
		async () => {
			const recorded = await recordedSession("exit 3");
			writeFileSync(gate(), "");
			const run = resume(recorded, "-p", "hello");
			run.child.stdin.end();
			assert.equal(await run.exited, 0);
			assert.match(run.out(), /ANSWER-TEXT/);
			assert.equal(
				run
					.err()
					.split("\n")
					.filter((line) => PARTIAL_BUILD.test(line)).length,
				1,
				run.err(),
			);
			assert.match(run.err(), /Warning: Partial build/);
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"--mode json emits the build's end once, with the failed build's warning (#4748)",
		async () => {
			const recorded = await recordedSession("exit 3");
			writeFileSync(gate(), "");
			const run = resume(recorded, "--mode", "json", "hello");
			run.child.stdin.end();
			assert.equal(await run.exited, 0);
			const finished = events(run.out(), "blueprint_build_finished");
			assert.equal(finished.length, 1, run.out());
			const notices = finished[0]!.notices as Array<{ type: string; message: string }>;
			assert.ok(notices.some((notice) => notice.type === "warning" && PARTIAL_BUILD.test(notice.message)));
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"--mode rpc emits the build's end as an event once the build ends (#4748)",
		async () => {
			const recorded = await recordedSession("exit 3");
			const run = resume(recorded, "--mode", "rpc");
			await until(() => ran().includes("started"), "the build to start");
			await sleep(HOLD_MS);
			assert.deepEqual(events(run.out(), "blueprint_build_finished"), [], "not before the build ends");
			writeFileSync(gate(), "");
			await until(() => events(run.out(), "blueprint_build_finished").length > 0, "the build's end");
			const [finished] = events(run.out(), "blueprint_build_finished");
			const notices = finished!.notices as Array<{ message: string }>;
			assert.ok(notices.some((notice) => PARTIAL_BUILD.test(notice.message)));
			run.child.stdin.end();
			await run.exited;
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"a new RPC session in the restored worktree waits for the build before its tool calls run (#4748)",
		async () => {
			const recorded = await recordedSession();
			const run = resume(recorded, "--mode", "rpc");
			await until(() => ran().includes("started"), "the build to start");
			send(run.child, { id: "n1", type: "new_session" });
			await until(() => run.out().includes('"n1"'), "the new session");
			send(run.child, { id: "p1", type: "prompt", message: "GOBASH" });
			await until(() => requests >= 1, "the first request");
			await sleep(HOLD_MS);
			assert.equal(existsSync(toolRan()), false, "the new session's bash call waits for the build");
			writeFileSync(gate(), "");
			await until(() => existsSync(toolRan()), "the bash call after the build");
			assert.deepEqual(ran(), ["started", "built"]);
			run.child.stdin.end();
			await run.exited;
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"an RPC bash command waits for the build of the worktree it runs in (#4748)",
		async () => {
			const recorded = await recordedSession();
			const run = resume(recorded, "--mode", "rpc");
			await until(() => ran().includes("started"), "the build to start");
			send(run.child, { id: "b1", type: "bash", command: TOOL_COMMAND() });
			await sleep(HOLD_MS);
			assert.equal(existsSync(toolRan()), false, "the shell command waits for the build");
			assert.equal(run.out().includes('"b1"'), false);
			writeFileSync(gate(), "");
			await until(() => run.out().includes('"b1"'), "the shell command's answer");
			assert.ok(existsSync(toolRan()));
			run.child.stdin.end();
			await run.exited;
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"-p does not end while a build runs behind a session it replaced with a new one (#4748)",
		async () => {
			const recorded = await recordedSession();
			const extension = sandbox.path("new-session.ts");
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";\nexport default function (pi) { pi.registerCommand("fresh", { description: "new session", handler: async (_args, ctx) => { await ctx.newSession(); writeFileSync(${JSON.stringify(sandbox.path("fresh-ran"))}, ""); } }); }\n`,
			);
			const run = launch([
				"--session-store",
				recorded.storePath,
				"--session",
				recorded.sessionId,
				"-e",
				extension,
				"-p",
				"/fresh",
			]);
			run.child.stdin.end();
			await until(() => ran().includes("started"), "the build to start");
			const early = await Promise.race([run.exited.then(() => "exited"), sleep(HOLD_MS * 2).then(() => "running")]);
			assert.equal(early, "running", "the run waits for the build");
			writeFileSync(gate(), "");
			await run.exited;
			assert.ok(existsSync(sandbox.path("fresh-ran")), "the command opened a new session");
			assert.deepEqual(ran(), ["started", "built"]);
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"switching an RPC session away and back during its build joins that build instead of starting another (#4748)",
		async () => {
			const recorded = await recordedSession();
			const other = await plainSession(recorded.storePath);
			const run = resume(recorded, "--mode", "rpc");
			await until(() => ran().includes("started"), "the build to start");
			send(run.child, { id: "away", type: "switch_session", sessionId: other });
			await until(() => run.out().includes('"away"'), "the switch away");
			send(run.child, { id: "back", type: "switch_session", sessionId: recorded.sessionId });
			await until(() => run.out().includes('"back"'), "the switch back, before the build ends");
			await sleep(HOLD_MS);
			assert.equal(count("started"), 1, "no second build of the worktree started");
			send(run.child, { id: "p1", type: "prompt", message: "GOBASH" });
			await until(() => requests >= 1, "the first request");
			await sleep(HOLD_MS);
			assert.equal(existsSync(toolRan()), false, "the session's bash call waits for the joined build");
			writeFileSync(gate(), "");
			await until(() => existsSync(toolRan()), "the bash call after the build");
			run.child.stdin.end();
			await run.exited;
			assert.deepEqual(ran(), ["started", "built"]);
			assert.equal(events(run.out(), "blueprint_build_finished").length, 1, "the build's end is told once");
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	test(
		"a clone of a resumed RPC session works in the restored worktree, not the missing recorded checkout (#4748)",
		async () => {
			const recorded = await recordedSession();
			writeFileSync(gate(), "");
			const run = resume(recorded, "--mode", "rpc");
			await until(() => ran().includes("built"), "the build");
			send(run.child, { id: "c1", type: "clone" });
			await until(() => run.out().includes('"c1"'), "the clone");
			send(run.child, { id: "p1", type: "prompt", message: "GOBASH" });
			await until(() => events(run.out(), "tool_execution_end").length > 0, "the bash call");
			const [end] = events(run.out(), "tool_execution_end");
			assert.equal(end!.isError, false, JSON.stringify(end).slice(-400));
			assert.ok(existsSync(toolRan()));
			run.child.stdin.end();
			await run.exited;
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	/** The restored worktrees of the store, by slot name. */
	const storeDir = () => sandbox.path("agent", "worktree-snapshots");
	const worktreesDir = () => join(storeDir(), "worktrees");
	/** The worktree each run of the step started in. */
	const startedIn = () => (existsSync(places()) ? readFileSync(places(), "utf8").trim().split(/\r?\n/) : []);
	/** The step processes the build lock of the worktree `slot` names with their start, which proves each to a resume. */
	const lockedSteps = (slot: string): number => {
		try {
			const lock = JSON.parse(readFileSync(buildLockPath(storeDir(), join(worktreesDir(), slot)), "utf8"));
			return Array.isArray(lock.steps) ? lock.steps.filter((step: { start?: unknown }) => step.start).length : 0;
		} catch {
			return 0;
		}
	};

	// On Windows a step's process is in a job object that ends with the host that started it, so the worktree is built
	// again in place. Stopping a leftover step needs its recorded start to prove it is that step.
	for (const window of ["after the build lock named the step", "before the build lock named the step"] as const) {
		test.skipIf(process.platform === "win32" || processStartToken(process.pid) === undefined)(
			`a resume after its host was killed during the build, ${window}, cancels that build and builds a fresh worktree (#5379)`,
			async () => {
				const recorded = await recordedSession();
				const killed = resume(recorded, "-p", "hello");
				killed.child.stdin.end();
				await until(() => ran().includes("started"), "the build to start");
				const [cancelled] = startedIn();
				if (window === "after the build lock named the step") {
					await until(() => lockedSteps(cancelled!) > 0, "the build lock to name the step");
				}
				killed.child.kill("SIGKILL");
				await killed.exited;
				// A kill that lands between the step's start and its record leaves the lock the build wrote before it started
				// anything, which names no step.
				if (window === "before the build lock named the step") {
					const file = buildLockPath(storeDir(), join(worktreesDir(), cancelled!));
					writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), steps: [] }));
				}
				// The killed host may have held the settings lock, so the trust this run needs comes from --approve.
				const again = resume(recorded, "--approve", "-p", "hello");
				again.child.stdin.end();
				await until(() => count("started") === 2, "the second build to start").catch((error: Error) => {
					const state = again.child.exitCode === null ? "still running" : `exited ${again.child.exitCode}`;
					throw new Error(`${error.message}; the second resume (${state}) wrote: ${again.err()}${again.out()}`);
				});
				const [, fresh] = startedIn();
				assert.notEqual(fresh, cancelled, "the second build runs in another worktree");
				writeFileSync(gate(), "");
				assert.equal(await again.exited, 0);
				await sleep(HOLD_MS);
				const warning = again
					.err()
					.split("\n")
					.filter(
						(line) => line.includes("may still be running") && line.includes(join(worktreesDir(), cancelled!)),
					);
				assert.equal(warning.length, 1, again.err());
				assert.match(warning[0]!, /blueprint-logs/);
				if (window === "after the build lock named the step") {
					assert.deepEqual(ran(), ["started", "started", "built"], "the recorded step was stopped");
				} else {
					// The step no lock named was not stopped: it ended in the worktree set aside for it, not in the fresh one.
					assert.deepEqual([...ran()].sort(), ["built", "built", "started", "started"]);
				}
				assert.deepEqual(startedIn(), [cancelled, fresh], "no build ran in the cancelled worktree again");
			},
			CLI_RESUME_TIMEOUT_MS,
		);
	}

	test.skipIf(process.platform === "win32" || processStartToken(process.pid) === undefined)(
		"a resume after its host was killed while a first action's ENVRC evaluator ran cancels that build and builds a fresh worktree (#5379)",
		async () => {
			const evaluating = sandbox.path("evaluating.txt");
			const startup = sandbox.path("bash-startup.sh");
			// What a shell startup file can run in the evaluator's bash before anything else of the step.
			writeFileSync(
				startup,
				[
					'if [ "$0" = atomic-blueprint-envrc ]; then',
					`  echo evaluating >> "${shellPath(evaluating)}"`,
					`  while [ ! -f "${shellPath(gate())}" ]; do sleep 0.05; done`,
					"fi",
					"",
				].join("\n"),
			);
			const recorded = await recordedSession("", "initialize:\n  - uses: github.com/example/setup@v1\n");
			const startupEnv = { BASH_ENV: startup, ATOMIC_BLUEPRINT_GITHUB_BASE_URL: sandbox.path("no-actions") };
			const evaluations = () =>
				existsSync(evaluating) ? readFileSync(evaluating, "utf8").trim().split(/\r?\n/) : [];
			const killed = launch(
				["--session-store", recorded.storePath, "--session", recorded.sessionId, "-p", "hello"],
				startupEnv,
			);
			killed.child.stdin.end();
			await until(() => evaluations().length === 1, "the first build's ENVRC evaluation to start").catch(
				(error: Error) => {
					throw new Error(`${error.message}; the first resume wrote: ${killed.err()}${killed.out()}`);
				},
			);
			const [cancelled] = readdirSync(worktreesDir());
			killed.child.kill("SIGKILL");
			await killed.exited;
			const again = launch(
				["--session-store", recorded.storePath, "--session", recorded.sessionId, "--approve", "-p", "hello"],
				startupEnv,
			);
			again.child.stdin.end();
			await until(() => evaluations().length === 2, "the second build's ENVRC evaluation to start").catch(
				(error: Error) => {
					throw new Error(`${error.message}; the second resume wrote: ${again.err()}${again.out()}`);
				},
			);
			writeFileSync(gate(), "");
			assert.equal(await again.exited, 0);
			const warning = again
				.err()
				.split("\n")
				.filter((line) => line.includes("may still be running") && line.includes(join(worktreesDir(), cancelled!)));
			assert.equal(warning.length, 1, again.err());
			const ledger = JSON.parse(readFileSync(join(storeDir(), "blueprint-builds", "ledger.json"), "utf8")) as {
				roots: Record<string, { state: string }>;
			};
			assert.equal(
				ledger.roots[rootKey(join(worktreesDir(), cancelled!))]?.state,
				"running",
				"the cancelled worktree was never built again",
			);
			const fresh = readdirSync(worktreesDir()).filter((slot) => slot !== cancelled);
			assert.equal(fresh.length, 1, "a fresh worktree was restored");
			assert.notEqual(ledger.roots[rootKey(join(worktreesDir(), fresh[0]!))], undefined, "and built");
		},
		CLI_RESUME_TIMEOUT_MS,
	);

	for (const mode of ["text", "json"] as const) {
		test.skipIf(processStartToken(process.pid) === undefined)(
			`-p in ${mode} mode says at once that it waits for another process's build of the worktree (#4748)`,
			async () => {
				const recorded = await recordedSession();
				writeFileSync(gate(), "");
				const first = resume(recorded, "-p", "hello");
				first.child.stdin.end();
				assert.equal(await first.exited, 0);
				const worktrees = sandbox.path("agent", "worktree-snapshots", "worktrees");
				const [slot] = readdirSync(worktrees);
				const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				const lock = buildLockPath(sandbox.path("agent", "worktree-snapshots"), join(worktrees, slot!));
				mkdirSync(dirname(lock), { recursive: true });
				const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
				writeFileSync(
					lock,
					JSON.stringify({ host, pid: holder.pid, start: processStartToken(holder.pid!), steps: [] }),
				);
				const again =
					mode === "json" ? resume(recorded, "--mode", "json", "hello") : resume(recorded, "-p", "hello");
				again.child.stdin.end();
				const waiting = /Waiting for another Atomic process's blueprint build of .* to end/;
				await until(
					() =>
						mode === "json"
							? events(again.out(), "blueprint_build_waiting").length > 0
							: waiting.test(again.err()),
					"the wait to be shown",
				);
				holder.kill("SIGKILL");
				assert.equal(await again.exited, 0);
				if (mode === "json") {
					const [event] = events(again.out(), "blueprint_build_waiting");
					assert.match(String(event!.message), waiting);
					assert.equal(events(again.out(), "blueprint_build_waiting").length, 1);
				} else {
					assert.equal(
						again
							.err()
							.split("\n")
							.filter((line) => waiting.test(line)).length,
						1,
						again.err(),
					);
				}
			},
			CLI_RESUME_TIMEOUT_MS,
		);
	}

	for (const [how, end] of [
		["SIGTERM during -p's wait for the build", "SIGTERM"],
		["SIGINT during -p's wait for the build", "SIGINT"],
		["closing RPC's stdin", "stdin"],
	] as const) {
		test.skipIf(end !== "stdin" && process.platform === "win32")(
			`${how} stops the build's process tree, and the next resume builds the worktree again (#4748)`,
			async () => {
				const recorded = await recordedSession();
				const run = end === "stdin" ? resume(recorded, "--mode", "rpc") : resume(recorded, "-p", "hello");
				await until(() => ran().includes("started"), "the build to start");
				if (end === "stdin") {
					await sleep(HOLD_MS);
					run.child.stdin.end();
				} else {
					await until(() => run.out().includes("ANSWER-TEXT"), "the answer");
					run.child.kill(end);
				}
				const code = await run.exited;
				if (end !== "stdin") assert.equal(code, end === "SIGINT" ? 130 : 143);
				writeFileSync(gate(), "");
				await sleep(HOLD_MS);
				assert.deepEqual(ran(), ["started"], "the build's shell ended with the process");

				const again = resume(recorded, "-p", "hello");
				again.child.stdin.end();
				assert.equal(await again.exited, 0);
				assert.deepEqual(ran(), ["started", "started", "built"], "the next resume built the worktree again");
				const [first, second] = startedIn();
				assert.equal(second, first, "a build its own process stopped is built again in place (#5379)");
			},
			CLI_RESUME_TIMEOUT_MS,
		);
	}
});
