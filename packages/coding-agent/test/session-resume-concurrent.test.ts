/**
 * Several processes resuming one session at once (#5135): the first claims the session before it writes or restores
 * anything, and every other one exits cleanly, before touching the session, with a message that names the session and
 * the process holding it, and exit code 75. A claim whose holder was killed is taken over. Real `atomic -p --session`
 * processes against a local OpenAI-compatible server; no network is contacted.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SessionAlreadyOpenError, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { openCliSession } from "../src/main-session.ts";
import { bunExecutable, cliPath } from "./cli-test-helpers.ts";

/** Real Bun CLI processes transpile the CLI graph before they open the session; several start at once. */
const TEST_TIMEOUT_MS = 240_000;
/** How long a run may take before the test kills it as hung. */
const HUNG_AFTER_MS = 150_000;
/** The exit code of a resume refused because another live process holds the session. */
const SESSION_HELD_EXIT_CODE = 75;

let server: Server | undefined;
let root: string;
let cwd: string;
let agentDir: string;
let storePath: string;
/** Every chat request the server received. */
let requests: number;
/** The server holds each answer until this promise settles. */
let holdAnswers: Promise<void>;
let releaseAnswers: () => void;
let requestArrived: PromiseWithResolvers<void>;
let secondRequestArrived: PromiseWithResolvers<void>;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-resume-concurrent-"));
	requests = 0;
	({ promise: holdAnswers, resolve: releaseAnswers } = Promise.withResolvers<void>());
	requestArrived = Promise.withResolvers<void>();
	secondRequestArrived = Promise.withResolvers<void>();
	server = createServer((request, response) => {
		request.resume();
		request.on("end", async () => {
			requests++;
			requestArrived.resolve();
			if (requests === 2) secondRequestArrived.resolve();
			await holdAnswers;
			const chunk = (delta: object, finishReason: string | null = null) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "local-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunk({ role: "assistant", content: "answered" })}${chunk({}, "stop")}data: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	storePath = join(root, "sessions.sqlite");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "fixture-key",
					models: [
						{
							id: "local-model",
							name: "Local Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "local", defaultModel: "local-model", defaultProjectTrust: "always" }),
	);
});

afterEach(async () => {
	releaseAnswers();
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

/** A session of the store at `storePath` with one user message, as an earlier run left it. */
async function recordedSession(): Promise<string> {
	const database = await openNodeSqliteDatabase(storePath);
	const store = await SqlSessionStore.open(database);
	try {
		const manager = await SessionManager.create(store, cwd);
		await manager.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
		return manager.getSessionId();
	} finally {
		await store.close();
		await database.close();
	}
}

/** How many user messages the session holds in the store. */
async function userMessages(sessionId: string): Promise<number> {
	const database = await openNodeSqliteDatabase(storePath);
	const store = await SqlSessionStore.open(database);
	try {
		const manager = await SessionManager.open(store, sessionId);
		return manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length;
	} finally {
		await store.close();
		await database.close();
	}
}

interface RunResult {
	readonly pid: number;
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly hung: boolean;
}

interface Run {
	readonly child: ChildProcess;
	readonly result: Promise<RunResult>;
}

function resume(sessionId: string, runAgentDir = agentDir): Run {
	const child = spawn(
		bunExecutable(),
		[
			cliPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session-store",
			storePath,
			"--session",
			sessionId,
			"-p",
			"continue",
		],
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: runAgentDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
				ATOMIC_INTERCOM_GROUP: undefined,
				PI_INTERCOM_GROUP: undefined,
				NO_COLOR: "1",
			},
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const result = new Promise<RunResult>((resolve) => {
		let hung = false;
		const timer = setTimeout(() => {
			hung = true;
			child.kill("SIGKILL");
		}, HUNG_AFTER_MS);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ pid: child.pid!, code, stdout, stderr, hung });
		});
	});
	return { child, result };
}

/**
 * Starts `count` resumes of one session at once and answers the one that reaches the model only once every other one
 * ended, so the holder is running the whole time the others start.
 */
async function concurrentResumes(count: number): Promise<void> {
	const sessionId = await recordedSession();
	const runs = Array.from({ length: count }, () => resume(sessionId));
	const ended: RunResult[] = [];
	const others = Promise.withResolvers<void>();
	for (const run of runs) {
		void run.result.then((result) => {
			ended.push(result);
			if (ended.length === count - 1) others.resolve();
		});
	}
	// The answer waits for the others to end; a run that never ends fails through HUNG_AFTER_MS.
	void others.promise.then(releaseAnswers);
	const results = await Promise.all(runs.map((run) => run.result));
	const describeRuns = results.map((result) => `pid ${result.pid} exit ${result.code}: ${result.stderr}`).join("\n");

	assert.equal(results.filter((result) => result.hung).length, 0, `a resume hung:\n${describeRuns}`);
	const ran = results.filter((result) => result.code === 0);
	assert.equal(ran.length, 1, `exactly one resume runs:\n${describeRuns}`);
	assert.match(ran[0]!.stdout, /answered/);
	const refused = results.filter((result) => result.code !== 0);
	assert.equal(refused.length, count - 1);
	for (const result of refused) {
		assert.equal(result.code, SESSION_HELD_EXIT_CODE, describeRuns);
		assert.ok(
			result.stderr.includes(`Session ${sessionId} is already open in process ${ran[0]!.pid}`),
			`the refusal names the session and its holder:\n${describeRuns}`,
		);
		assert.doesNotMatch(result.stderr, /SessionConflictError|\n\s+at /, describeRuns);
	}
	assert.equal(requests, 1, "only the holder reached the model");
	assert.equal(await userMessages(sessionId), 2, "only the holder wrote its prompt");
}

/** Appends a user message to the session in the store, as a writer that holds no claim would. */
async function writeElsewhere(sessionId: string): Promise<void> {
	const database = await openNodeSqliteDatabase(storePath);
	const store = await SqlSessionStore.open(database);
	try {
		const manager = await SessionManager.open(store, sessionId);
		await manager.appendMessage({ role: "user", content: "written elsewhere", timestamp: Date.now() });
	} finally {
		await store.close();
		await database.close();
	}
}

describe("concurrent resumes of one session (#5135)", () => {
	test(
		"an append conflict in the middle of a run ends it with a handled error (#5135)",
		async () => {
			const sessionId = await recordedSession();
			const run = resume(sessionId);
			await requestArrived.promise;
			await writeElsewhere(sessionId);
			releaseAnswers();
			const result = await run.result;
			assert.equal(result.hung, false, result.stderr);
			assert.equal(result.code, 1, result.stderr);
			assert.ok(
				result.stderr.includes(`Error: Another process wrote to session ${sessionId}`),
				`the conflict is reported as such:\n${result.stderr}`,
			);
			assert.doesNotMatch(result.stderr, /Extension error/, "the conflict is reported once");
			assert.doesNotMatch(result.stderr, /\n\s+at |\^/, `no uncaught error:\n${result.stderr}`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"two resumes at once leave exactly one running and the other exiting with the message (#5135)",
		async () => {
			await concurrentResumes(2);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"three resumes at once leave exactly one running and the others exiting with the message (#5135)",
		async () => {
			await concurrentResumes(3);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a resume takes over the session from a holder killed with SIGKILL (#5135)",
		async () => {
			const sessionId = await recordedSession();
			const holder = resume(sessionId);
			await requestArrived.promise;
			holder.child.kill("SIGKILL");
			await holder.result;
			releaseAnswers();
			const next = await resume(sessionId).result;
			assert.equal(next.code, 0, next.stderr);
			assert.match(next.stdout, /answered/);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"an append conflict with a process that holds no claim here ends the run with a handled error (#5135)",
		async () => {
			const sessionId = await recordedSession();
			// Another agent directory keeps its claims elsewhere, so both resumes run and their first writes conflict.
			const otherAgentDir = join(root, "other-agent");
			mkdirSync(otherAgentDir);
			for (const file of ["models.json", "settings.json"]) {
				writeFileSync(join(otherAgentDir, file), readFileSync(join(agentDir, file)));
			}
			const runs = [resume(sessionId), resume(sessionId, otherAgentDir)];
			void Promise.race([...runs.map((run) => run.result), secondRequestArrived.promise]).then(releaseAnswers);
			const results = await Promise.all(runs.map((run) => run.result));
			const describeRuns = results
				.map((result) => `pid ${result.pid} exit ${result.code}: ${result.stderr}`)
				.join("\n");
			const failed = results.filter((result) => result.code !== 0);
			assert.equal(failed.length, 1, describeRuns);
			assert.equal(failed[0]!.code, 1, describeRuns);
			assert.ok(
				failed[0]!.stderr.includes(`Error: Another process wrote to session ${sessionId}`),
				`the conflict is reported as such:\n${describeRuns}`,
			);
			assert.doesNotMatch(failed[0]!.stderr, /\n\s+at |\^/, `no uncaught error:\n${describeRuns}`);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("a resume with its own claims that opens a session another process is answering in (#5135)", () => {
	test(
		"leaves exactly one run to save its answer and the other to report the conflict (#5135)",
		async () => {
			const sessionId = await recordedSession();
			const otherAgentDir = join(root, "other-agent");
			mkdirSync(otherAgentDir);
			for (const file of ["models.json", "settings.json"]) {
				writeFileSync(join(otherAgentDir, file), readFileSync(join(agentDir, file)));
			}
			const first = resume(sessionId);
			await requestArrived.promise;
			const second = resume(sessionId, otherAgentDir);
			void Promise.race([first.result, second.result, secondRequestArrived.promise]).then(releaseAnswers);
			const [earlier, later] = await Promise.all([first.result, second.result]);
			const describeRuns = [earlier, later]
				.map((result) => `pid ${result.pid} exit ${result.code}: ${result.stderr}`)
				.join("\n");
			assert.equal(later.code, 0, describeRuns);
			assert.match(later.stdout, /answered/);
			assert.equal(earlier.code, 1, describeRuns);
			assert.ok(
				earlier.stderr.includes(`Error: Another process wrote to session ${sessionId}`),
				`the conflict is reported as such:\n${describeRuns}`,
			);
			assert.doesNotMatch(earlier.stderr, /\n\s+at |\^/, `no uncaught error:\n${describeRuns}`);
			assert.equal(requests, 2);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("the claim a CLI resume takes (#5135)", () => {
	const claimFile = (sessionId: string) => join(agentDir, "session-claims", `${sessionId}.json`);
	const open = (args: string[], claim?: boolean) =>
		openCliSession(parseArgs(args), cwd, SettingsManager.inMemory(), {
			agentDir,
			sessionStorage: { kind: "sqlite", path: storePath },
			trusted: () => false,
			...(claim === undefined ? {} : { claim }),
		});
	const closeOpened = async (opened: Awaited<ReturnType<typeof open>>) => {
		assert.notEqual(opened, "cancelled");
		if (opened !== "cancelled") await opened.sessionManager.getSessionStore().close();
	};

	test("--session claims the session it resumes for this process (#5135)", async () => {
		const sessionId = await recordedSession();
		await closeOpened(await open(["--session", sessionId]));
		assert.equal(JSON.parse(readFileSync(claimFile(sessionId), "utf8")).pid, process.pid);
	});

	test("a new session claims nothing (#5135)", async () => {
		const opened = await open([]);
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		const sessionId = opened.sessionManager.getSessionId();
		await closeOpened(opened);
		assert.equal(existsSync(claimFile(sessionId)), false);
	});

	test("the interactive engine child, whose host claimed the session, resumes it without a claim (#5135)", async () => {
		const sessionId = await recordedSession();
		const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		try {
			await new Promise<void>((resolve) => host.once("spawn", () => resolve()));
			mkdirSync(join(agentDir, "session-claims"), { recursive: true });
			writeFileSync(claimFile(sessionId), JSON.stringify({ token: "host", pid: host.pid, host: hostname() }));
			await assert.rejects(open(["--session", sessionId]), SessionAlreadyOpenError);
			await closeOpened(await open(["--session", sessionId], false));
			assert.equal(JSON.parse(readFileSync(claimFile(sessionId), "utf8")).pid, host.pid);
		} finally {
			host.kill("SIGKILL");
		}
	});
});
