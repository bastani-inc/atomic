import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	bunExecutable,
	decodeStream,
	moduleDir,
	readStreamText,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;
const prefix = "@@ATOMIC_TEST@@";
const warning =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
const INTERACTIVE_STARTUP_TIMEOUT_MS = 30_000;
const INTERACTIVE_REPORT_TIMEOUT_MS = 30_000;

interface Report {
	type?: string;
	eventType?: string;
	message?: string;
	output?: string;
	modelProvider?: string;
	modelId?: string;
	modelFallbackMessage?: string;
	modelFallbackReason?: string;
}

class Driver {
	readonly process: SpawnedProcess;
	readonly reports: Report[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>, cwd: string) {
		const baseEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(baseEnv)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete baseEnv[key];
		}
		this.process = spawnProcess(
			[bunExecutable(), join(moduleDir(import.meta.url), "fixtures", "default-main-interactive-host.ts"), ...args],
			{
				cwd,
				env: { ...baseEnv, ...env },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		void this.readReports();
		void this.readStderr();
	}

	send(type: "input" | "state", data?: string): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin unavailable");
		stdin.write(`${JSON.stringify({ type, data })}\n`);
		void stdin.flush();
	}

	async waitFor(
		predicate: (report: Report) => boolean,
		from = 0,
		timeoutMs = INTERACTIVE_REPORT_TIMEOUT_MS,
	): Promise<Report> {
		const inspect = (): Report | undefined => this.reports.slice(from).find(predicate);
		const existing = inspect();
		if (existing) return existing;
		return new Promise<Report>((resolve, reject) => {
			const check = (): void => {
				const found = inspect();
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(check);
				resolve(found);
			};
			const timeout = setTimeout(() => {
				this.waiters.delete(check);
				reject(
					new Error(
						`Timed out waiting for report: ${JSON.stringify(this.reports.slice(-8))}; stderr=${this.stderr.slice(-2000)}`,
					),
				);
			}, timeoutMs);
			this.waiters.add(check);
		});
	}

	async waitForState(predicate: (report: Report) => boolean, from = 0): Promise<Report> {
		const deadline = performance.now() + INTERACTIVE_REPORT_TIMEOUT_MS;
		while (performance.now() < deadline) {
			this.send("state");
			await sleep(25);
			const state = this.reports.slice(from).find((report) => report.type === "state" && predicate(report));
			if (state) return state;
		}
		throw new Error(
			`Timed out waiting for state: ${JSON.stringify(
				this.reports
					.filter((report) => report.type === "state")
					.slice(-8)
					.map((report) => ({
						modelProvider: report.modelProvider,
						modelId: report.modelId,
						fallback: report.modelFallbackReason,
					})),
			)}`,
		);
	}

	async stop(): Promise<void> {
		if (this.process.exitCode === null) this.process.kill("SIGTERM");
		await this.process.exited;
	}

	async waitForExit(): Promise<number> {
		return Promise.race([
			this.process.exited,
			sleep(5_000).then(() => {
				throw new Error(`Timed out waiting for exit: ${this.stderr}`);
			}),
		]);
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = decodeStream(stdout).getReader();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += value;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const marker = line.indexOf(prefix);
				if (marker === -1) continue;
				this.reports.push(JSON.parse(line.slice(marker + prefix.length)) as Report);
				for (const waiter of this.waiters) waiter();
			}
		}
	}

	private async readStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (!stderr || typeof stderr === "number") return;
		this.stderr = await readStreamText(stderr);
	}
}

serialTest(
	"isolated Ctrl+P cycle clears stale fallback and accepts the next prompt",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-cycle-fallback-"));
		const cwd = join(root, "cwd");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		mkdirSync(sessionDir);
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			const message = {
				id: "msg_cycle",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "cycle recovered", annotations: [] }],
			};
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...message, status: "in_progress", content: [] },
				},
				{
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					item_id: message.id,
					delta: "cycle recovered",
				},
				{ type: "response.output_item.done", output_index: 0, item: message },
				{
					type: "response.completed",
					response: {
						id: "resp_cycle",
						status: "completed",
						output: [message],
						usage: {
							input_tokens: 1,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 2,
							total_tokens: 3,
						},
					},
				},
			];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const removedProvider = ["cur", "sor"].join("");
		const removedModel = ["composer", "-2"].join("");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: removedProvider,
				defaultModel: removedModel,
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
			}),
		);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				[removedProvider]: { type: "api_key", key: "stale-proof" },
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					recovery: {
						baseUrl,
						apiKey: "test-key",
						api: "openai-responses",
						models: ["recovery-one", "recovery-two"].map((id) => ({
							id,
							name: id,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 1024,
						})),
					},
				},
			}),
		);
		const persisted = SessionManager.create(cwd, sessionDir);
		persisted.appendModelChange(removedProvider, removedModel);
		persisted.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted stale model" }],
			timestamp: Date.now(),
		});
		persisted.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persisted stale response" }],
			api: "anthropic-messages",
			provider: removedProvider,
			model: removedModel,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = persisted.getSessionFile();
		assert.ok(sessionFile);
		const driver = new Driver(
			[
				"--session",
				sessionFile,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
				"--approve",
			],
			{
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				NO_COLOR: "1",
			},
			cwd,
		);
		try {
			const ready = await driver.waitFor(
				(report) => report.type === "input_loop_ready",
				0,
				INTERACTIVE_STARTUP_TIMEOUT_MS,
			);
			const readyIndex = driver.reports.indexOf(ready);
			const locked = await driver.waitForState(
				(state) => state.modelFallbackReason === "configured-provider-unsupported",
				readyIndex,
			);
			assert.equal(locked.modelProvider, "unknown");
			assert.deepEqual(
				driver.reports.filter((report) => report.type === "warning").map((report) => report.message),
				[warning],
			);

			const beforeCycle = driver.reports.length;
			driver.send("input", "\x10");
			const cycled = await driver.waitForState(
				(state) => state.modelProvider === "recovery" && state.modelFallbackReason === undefined,
				beforeCycle,
			);
			assert.match(cycled.modelId ?? "", /^recovery-/u);

			driver.send("input", "cycle prompt");
			driver.send("input", "\r");
			await driver.waitFor(
				(report) => report.type === "session_event" && report.eventType === "agent_start",
				beforeCycle,
			);
			await driver.waitFor(
				(report) => report.type === "session_event" && report.eventType === "agent_end",
				beforeCycle,
			);
			const final = await driver.waitForState(
				(state) => state.output?.includes("cycle recovered") === true,
				beforeCycle,
			);
			assert.equal(final.modelFallbackReason, undefined);
			assert.deepEqual(
				driver.reports.filter((report) => report.type === "warning").map((report) => report.message),
				[warning],
			);
			assert.equal(final.output?.includes("API key"), false);
			assert.equal(requests, 1);
			driver.send("input", "/exit");
			driver.send("input", "\r");
			assert.equal(await driver.waitForExit(), 0);
		} finally {
			await driver.stop();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
