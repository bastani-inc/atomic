/**
 * #4902 through a real CLI process: a wrong-typed `extensions` setting is ignored with a warning naming the settings
 * file and key, and the run still answers. A local OpenAI-compatible server stands in for the provider; no network is
 * contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { runCliProcess } from "./cli-test-helpers.js";

/** A real Bun CLI process transpiles the CLI graph and the builtin extensions before its first request. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;

let server: Server | undefined;
let root: string;
let port: number;

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

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-settings-types-cli-"));
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (data: Buffer) => {
			raw += data.toString();
		});
		request.on("end", () => {
			const { model } = JSON.parse(raw) as { model: string };
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`${chunk(model, { role: "assistant", content: "started normally" })}${chunk(model, {}, "stop")}data: [DONE]\n\n`,
			);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

test(
	'a string "extensions" setting starts normally and is reported naming the file and key (#4902)',
	async () => {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					mock: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "fixture-key",
						models: [
							{
								id: "mock-model",
								name: "Mock Model",
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
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model", extensions: "./x.ts" }),
		);

		const result = await runCliProcess(
			[
				"--session-dir",
				sessionDir,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"-p",
				"hello",
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
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /started normally/);
		const warnings = result.stderr.split("\n").filter((line) => line.includes('"extensions"'));
		assert.equal(warnings.length, 1, result.stderr);
		assert.ok(warnings[0]?.includes(settingsPath), result.stderr);
	},
	REAL_CLI_PROCESS_TIMEOUT_MS,
);
