/**
 * The `atomic -p` side of #4223, through a real CLI process: an explicit `--model` never falls back to the settings
 * `fallbackModels`, an opt-in `--fallback-models` fallback is reported on stderr and tells the fallback model its own
 * name, and an untrusted project's ignored settings are named. A local OpenAI-compatible server stands in for three
 * provider accounts; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runCliProcess } from "./cli-test-helpers.ts";

/** A real Bun CLI process transpiles the CLI graph and the mandatory Intercom extension before its first request. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;

const REQUESTED = "acct-a/argon-mock";
const SETTINGS_CHAIN = "acct-b/opus-mock";
const OPT_IN = "acct-c/sol-mock";
const CYBER_POLICY = {
	message:
		"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
	code: "cyber_policy",
};

type Failure = "500" | "422";

interface Harness {
	root: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/** `provider/model` of every chat request, in order. */
	requests: string[];
	fail(failure: Failure): void;
}

let server: Server | undefined;
let harness: Harness;

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

function model(id: string, name: string) {
	return {
		id,
		name,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

beforeEach(async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-explicit-model-fallback-"));
	const requests: string[] = [];
	let failure: Failure = "500";
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (data: Buffer) => {
			raw += data.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as { model: string; messages: { role: string; content: unknown }[] };
			const account = request.url?.split("/")[1] ?? "";
			requests.push(`acct-${account}/${body.model}`);
			if (account === "a") {
				response.writeHead(failure === "500" ? 500 : 422, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						error: failure === "500" ? { message: "Internal server error", type: "server_error" } : CYBER_POLICY,
					}),
				);
				return;
			}
			// Answer with the model line of the system prompt this model was sent.
			const system = body.messages.find((message) => message.role === "system" || message.role === "developer");
			const text = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
			const line = text.match(/Model name[^\n"]*/)?.[0] ?? "no model line";
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`${chunk(body.model, { role: "assistant", content: `${body.model} was told: ${line}` })}${chunk(body.model, {}, "stop")}data: [DONE]\n\n`,
			);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true });
	const provider = (account: string, id: string, name: string) => ({
		baseUrl: `http://127.0.0.1:${port}/${account}/v1`,
		api: "openai-completions",
		apiKey: "fixture-key",
		models: [model(id, name)],
	});
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"acct-a": provider("a", "argon-mock", "Argon Mock"),
				"acct-b": provider("b", "opus-mock", "Opus Mock"),
				"acct-c": provider("c", "sol-mock", "Sol Mock"),
			},
		}),
	);
	// The user-level settings default to the requested model and name another family as their fallback.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "acct-a",
			defaultModel: "argon-mock",
			fallbackModels: [SETTINGS_CHAIN],
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
		}),
	);
	harness = {
		root,
		cwd,
		agentDir,
		sessionDir,
		requests,
		fail: (next) => {
			failure = next;
		},
	};
});

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	rmSync(harness.root, { recursive: true, force: true });
});

async function atomic(args: string[]) {
	const result = await runCliProcess(
		[
			"--session-dir",
			harness.sessionDir,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			...args,
		],
		{
			cwd: harness.cwd,
			timeoutMs: REAL_CLI_PROCESS_TIMEOUT_MS,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: harness.agentDir,
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

function sessionEntries(): { type: string; provider?: string; fallback?: Record<string, string> }[] {
	const [file] = readdirSync(harness.sessionDir).filter((name) => name.endsWith(".jsonl"));
	assert.ok(file, "the run wrote a session");
	return readFileSync(join(harness.sessionDir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("atomic -p with an explicit --model (#4223)", () => {
	test(
		"a failing explicit model is retried and fails naming itself, without running the settings fallbackModels (#4223)",
		async () => {
			harness.fail("500");
			const result = await atomic(["-p", "--model", `${REQUESTED}:high`, "Say which model you are."]);

			assert.deepEqual(harness.requests, [REQUESTED, REQUESTED]);
			assert.equal(result.code, 1);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, new RegExp(`Model ${REQUESTED} failed: 500`));
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"--fallback-models opts in: a content-filter refusal moves on at once, and the fallback is reported and named (#4223)",
		async () => {
			harness.fail("422");
			const result = await atomic([
				"-p",
				"--model",
				`${REQUESTED}:high`,
				"--fallback-models",
				OPT_IN,
				"Say which model you are.",
			]);

			assert.deepEqual(harness.requests, [REQUESTED, OPT_IN]);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /sol-mock was told: Model name \(used for commit attribution\): Sol Mock/);
			assert.match(
				result.stderr,
				new RegExp(`Model fallback: ${REQUESTED} failed, continuing on ${OPT_IN}: .*cyber_policy`),
			);
			assert.match(result.stderr, new RegExp(`Model: ran on ${OPT_IN}, not the requested ${REQUESTED}\\.`));
			const change = sessionEntries().find((entry) => entry.type === "model_change" && entry.provider === "acct-c");
			assert.equal(change?.fallback?.requested, REQUESTED);
			assert.match(change?.fallback?.reason ?? "", /cyber_policy/);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);

	test(
		"an untrusted project's settings file is named as ignored, and --no-fallback keeps the run on its model (#4223)",
		async () => {
			harness.fail("500");
			mkdirSync(join(harness.cwd, ".atomic"));
			const projectSettings = join(harness.cwd, ".atomic", "settings.json");
			writeFileSync(projectSettings, JSON.stringify({ fallbackModels: [] }));
			const result = await atomic(["-p", "--no-fallback", "Say which model you are."]);

			assert.match(
				result.stderr,
				/Warning: Ignoring .*\.atomic[\\/]settings\.json: this project is not trusted\. Pass --approve/,
			);
			assert.deepEqual(harness.requests, [REQUESTED, REQUESTED]);
			assert.equal(result.code, 1);
		},
		REAL_CLI_PROCESS_TIMEOUT_MS,
	);
});
