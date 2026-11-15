/**
 * Real `atomic --session` processes without a UI, resuming into a worktree whose blueprint build runs behind the first
 * turn (#4748): the build's warnings reach the user once, every session and shell command in that worktree waits for
 * it, and a process that ends during the build stops it.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
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
async function recordedSession(afterGate = ""): Promise<{ sessionId: string; storePath: string }> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const blueprint = [
		"maintenance:",
		"  - name: Install dependencies",
		"    run: |",
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
	renameSync(clone, sandbox.path("node-a-gone"));
	return { sessionId, storePath };
}

function launch(args: readonly string[]) {
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

	for (const [how, end] of [
		["SIGTERM during -p's wait for the build", "sigterm"],
		["closing RPC's stdin", "stdin"],
	] as const) {
		test.skipIf(how.startsWith("SIGTERM") && process.platform === "win32")(
			`${how} stops the build's process tree, and the next resume builds the worktree again (#4748)`,
			async () => {
				const recorded = await recordedSession();
				const run = end === "sigterm" ? resume(recorded, "-p", "hello") : resume(recorded, "--mode", "rpc");
				await until(() => ran().includes("started"), "the build to start");
				if (end === "sigterm") {
					await until(() => run.out().includes("ANSWER-TEXT"), "the answer");
					run.child.kill("SIGTERM");
				} else {
					await sleep(HOLD_MS);
					run.child.stdin.end();
				}
				await run.exited;
				writeFileSync(gate(), "");
				await sleep(HOLD_MS);
				assert.deepEqual(ran(), ["started"], "the build's shell ended with the process");

				const again = resume(recorded, "-p", "hello");
				again.child.stdin.end();
				assert.equal(await again.exited, 0);
				assert.deepEqual(ran(), ["started", "started", "built"], "the next resume built the worktree again");
			},
			CLI_RESUME_TIMEOUT_MS,
		);
	}
});
