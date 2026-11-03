/**
 * #4226 through a real CLI process: when another writer changes the session file under a running `atomic -p`,
 * the message the run then cannot save stops the run. It exits 1, names the cause on stderr, and still prints
 * the answer it got. A local OpenAI-compatible server answers; before it does, the test appends to the session
 * file as a second writer. No network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { runCliProcess } from "./cli-test-helpers.js";

/** A real Bun CLI process transpiles the CLI graph and the mandatory Intercom extension before its first request. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;

const ANSWER = "final answer";
const SAVE_ERROR =
	/Extension error \(<session>\): could not persist the assistant message: Session conflict: \S+, expected \d+, actual \d+/;

let server: Server | undefined;
let root: string;
let cwd: string;
let agentDir: string;
let sessionDir: string;
let requests: number;

function chunk(model: string, delta: object, finishReason: string | null = null): string {
	const body = {
		id: "c1",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

/** Append to the run's session file from a second writer, so the run's next append conflicts. */
async function writeAsSecondWriter(): Promise<void> {
	const [file] = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
	assert.ok(file, "the run saved its prompt before its first request");
	const other = await SessionManager.open(join(sessionDir, file), sessionDir);
	await other.appendCustomEntry("other-writer", {});
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-session-save-failure-"));
	requests = 0;
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (data: Buffer) => {
			raw += data.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as { model: string };
			requests++;
			void writeAsSecondWriter().then(
				() => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(
						`${chunk(body.model, { role: "assistant", content: ANSWER })}${chunk(body.model, {}, "stop")}data: [DONE]\n\n`,
					);
				},
				(error: unknown) => {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: `second writer failed: ${String(error)}` } }));
				},
			);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	sessionDir = join(root, "sessions");
	for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true });
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
		JSON.stringify({
			defaultProvider: "local",
			defaultModel: "local-model",
			retry: { enabled: true, maxRetries: 2 },
		}),
	);
});

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

async function atomic(args: string[]) {
	const result = await runCliProcess(
		[
			"--session-dir",
			sessionDir,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			...args,
		],
		{
			cwd,
			timeoutMs: REAL_CLI_PROCESS_TIMEOUT_MS,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
				ATOMIC_INTERACTIVE_ENGINE_API_KEY: undefined,
				ATOMIC_INTERCOM_GROUP: undefined,
				PI_INTERCOM_GROUP: undefined,
				NO_COLOR: "1",
			},
		},
	);
	assert.equal(result.timedOut, false, result.stderr);
	return result;
}

describe("atomic -p when another writer changes its session file (#4226)", () => {
	test(
		"exits 1, names why the answer could not be saved, and still prints the answer",
		async () => {
			const result = await atomic(["-p", "Answer once."]);

			assert.equal(result.code, 1, result.stderr);
			assert.equal(result.stdout, `${ANSWER}\n`);
			assert.match(result.stderr, SAVE_ERROR);
			assert.doesNotMatch(result.stderr, /turn_end could not resolve|Model \S+ failed/);
			assert.equal(requests, 1);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"--mode json exits 1 and names why the answer could not be saved",
		async () => {
			const result = await atomic(["--mode", "json", "Answer once."]);

			assert.equal(result.code, 1, result.stderr);
			assert.match(result.stderr, SAVE_ERROR);
			assert.equal(requests, 1);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);
});
