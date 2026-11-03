/**
 * `atomic -p` and piped stdin (#4224): a run that has a prompt does not wait forever on a stdin pipe that stays open
 * and silent, as a harness, an agent's shell tool or a supervisor leaves it, while piped input still reaches the
 * prompt. Real CLI processes against a local OpenAI-compatible server; no network is contacted.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable, cliPath } from "./cli-test-helpers.ts";

/** A real Bun CLI process transpiles the CLI graph and the mandatory Intercom extension before it reads stdin. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;
/** How long a run may take before the test kills it as hung; well inside the test's own budget. */
const HUNG_AFTER_MS = 90_000;

let server: Server | undefined;
let root: string;
let cwd: string;
let agentDir: string;
/** The user text of every chat request, in order. */
let prompts: string[];
/** When set, the server holds each answer until this promise settles. */
let holdAnswers: Promise<void> | undefined;
/** Resolves on each chat request the server receives. */
let requestArrived: PromiseWithResolvers<void>;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-print-stdin-"));
	prompts = [];
	holdAnswers = undefined;
	requestArrived = Promise.withResolvers<void>();
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (data: Buffer) => {
			raw += data.toString();
		});
		request.on("end", async () => {
			const body = JSON.parse(raw) as { model: string; messages: { role: string; content: unknown }[] };
			const user = body.messages.filter((message) => message.role === "user").at(-1);
			const content = user?.content;
			prompts.push(
				typeof content === "string"
					? content
					: (content as { type: string; text?: string }[])
							.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
							.join(""),
			);
			requestArrived.resolve();
			await holdAnswers;
			const chunk = (delta: object, finishReason: string | null = null) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunk({ role: "assistant", content: "answered" })}${chunk({}, "stop")}data: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	agentDir = join(root, "agent");
	cwd = join(root, "project");
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
});

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

interface Run {
	child: ChildProcess;
	/** Resolves once stderr contains `text`. */
	printed(text: string): Promise<void>;
	result: Promise<{ code: number | null; stdout: string; stderr: string; hung: boolean }>;
}

/** Start `atomic` with its stdin as a pipe the test controls. */
function startAtomic(args: string[], env: NodeJS.ProcessEnv = {}): Run {
	const child = spawn(
		bunExecutable(),
		[
			cliPath,
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--model",
			"local/local-model",
			...args,
		],
		{
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_STDIN_TIMEOUT_MS: undefined,
				PI_STDIN_TIMEOUT_MS: undefined,
				ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
				ATOMIC_INTERCOM_GROUP: undefined,
				PI_INTERCOM_GROUP: undefined,
				NO_COLOR: "1",
				...env,
			},
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	const waiters: { text: string; resolve: () => void }[] = [];
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
		for (const waiter of waiters.filter((entry) => stderr.includes(entry.text))) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	});
	const printed = (text: string) =>
		stderr.includes(text)
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					waiters.push({ text, resolve });
				});
	const result = new Promise<{ code: number | null; stdout: string; stderr: string; hung: boolean }>((resolve) => {
		let hung = false;
		const timer = setTimeout(() => {
			hung = true;
			child.kill("SIGKILL");
		}, HUNG_AFTER_MS);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, hung });
		});
	});
	return { child, printed, result };
}

describe("atomic -p and piped stdin (#4224)", () => {
	test(
		"a prompt runs although stdin is an open pipe that never sends anything (#4224)",
		async () => {
			// The pipe stays open and silent until the run ends: nothing is written and it is never closed.
			const { child, result } = startAtomic(["-p", "Say hi."]);
			const { code, stdout, stderr, hung } = await result;
			child.stdin?.destroy();

			assert.equal(hung, false, `atomic -p waited on the silent stdin pipe:\n${stderr}`);
			assert.equal(code, 0, stderr);
			assert.equal(stdout.trim(), "answered");
			assert.deepEqual(prompts, ["Say hi."]);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"piped input still reaches the prompt, alone and before a prompt argument (#4224)",
		async () => {
			const alone = startAtomic(["-p"]);
			alone.child.stdin?.end("piped question");
			const withPrompt = startAtomic(["-p", " and the argument"]);
			withPrompt.child.stdin?.end("piped context");
			const [first, second] = await Promise.all([alone.result, withPrompt.result]);

			assert.equal(first.code, 0, first.stderr);
			assert.equal(second.code, 0, second.stderr);
			assert.deepEqual(prompts.sort(), ["piped context and the argument", "piped question"]);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"input that arrives after the run started without it is reported, not silently dropped (#4224)",
		async () => {
			const release = Promise.withResolvers<void>();
			holdAnswers = release.promise;
			const { child, printed, result } = startAtomic(["-p", "Say hi."], { ATOMIC_STDIN_TIMEOUT_MS: "1" });
			// The run has given up on stdin and its request is in flight: input that arrives now is too late.
			await requestArrived.promise;
			child.stdin?.write("late input");
			await printed("Input arrived on stdin after Atomic stopped waiting for it and was ignored");
			release.resolve();
			const { code, stdout, stderr, hung } = await result;
			child.stdin?.destroy();

			assert.equal(hung, false, stderr);
			assert.equal(code, 0, stderr);
			assert.equal(stdout.trim(), "answered");
			assert.deepEqual(prompts, ["Say hi."]);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"with no prompt argument, the run says it is waiting for stdin and runs what arrives (#4224)",
		async () => {
			const run = startAtomic(["-p"], { ATOMIC_STDIN_TIMEOUT_MS: "1" });
			await run.printed("Waiting for input on stdin");
			run.child.stdin?.end("question that came late");
			const { code, stderr, hung } = await run.result;

			assert.equal(hung, false, stderr);
			assert.equal(code, 0, stderr);
			assert.deepEqual(prompts, ["question that came late"]);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);
});
