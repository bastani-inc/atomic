import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.ts";
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
const PREFIX = "@@ATOMIC_TEST@@";
const REAL_EXTENSION_FALLBACK_TEST_TIMEOUT_MS = 120_000;
const ISOLATED_ENGINE_REPORT_TIMEOUT_MS = 30_000;
const warning =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";

interface HarnessReport {
	type?: string;
	output?: string;
	modelProvider?: string;
	modelId?: string;
	message?: string;
	modelFallbackMessage?: string;
	modelFallbackReason?: string;
}

class Driver {
	readonly process: SpawnedProcess;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], env: Record<string, string>, cwd = join(moduleDir(import.meta.url), "../..")) {
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

	send(command: { type: "input" | "reload" | "state"; data?: string }): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	async waitFor(predicate: (report: HarnessReport) => boolean, from = 0): Promise<HarnessReport> {
		const inspectReports = (): HarnessReport | undefined => this.reports.slice(from).find(predicate);
		const existing = inspectReports();
		if (existing) return existing;
		return new Promise<HarnessReport>((resolve, reject) => {
			const inspect = (): void => {
				const found = inspectReports();
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				resolve(found);
			};
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				reject(
					new Error(
						`Timed out waiting for isolated engine report: ${JSON.stringify(this.reports.slice(-5))}; stderr=${this.stderr.slice(-2000)}`,
					),
				);
			}, ISOLATED_ENGINE_REPORT_TIMEOUT_MS);
			this.waiters.add(inspect);
		});
	}

	async stop(): Promise<void> {
		if (this.process.exitCode === null) this.process.kill("SIGTERM");
		await this.process.exited;
	}

	async waitForCleanExit(timeoutMs = ISOLATED_ENGINE_REPORT_TIMEOUT_MS): Promise<number> {
		const timeout = sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for clean fixture exit; stderr=${this.stderr.slice(-2000)}`);
		});
		return Promise.race([this.process.exited, timeout]);
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = decodeStream(stdout).getReader();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += value;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const marker = line.indexOf(PREFIX);
				if (marker === -1) continue;
				this.reports.push(JSON.parse(line.slice(marker + PREFIX.length)) as HarnessReport);
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

async function waitForInputLoopState(driver: Driver, from = 0): Promise<HarnessReport> {
	const ready = await driver.waitFor((report) => report.type === "input_loop_ready", from);
	const readyIndex = driver.reports.indexOf(ready);
	return driver.waitFor((report) => report.type === "state", readyIndex + 1);
}

serialTest(
	"isolated interactive startup replaces preliminary fallback with extension-aware engine state",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-extension-default-fallback-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "isolation-fixture",
				defaultModel: "blocking-model",
				defaultThinkingLevel: "high",
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
			}),
		);
		const extension = join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts");
		const driver = new Driver(
			[
				"--no-extensions",
				"--extension",
				extension,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
				"--approve",
			],
			{ ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" },
		);
		try {
			await driver.waitFor((report) => report.type === "engine_bound");
			const initial = await waitForInputLoopState(driver);
			assert.equal(initial.modelProvider, "isolation-fixture");
			assert.equal(initial.modelId, "blocking-model");
			assert.equal(initial.modelFallbackMessage, undefined);
			assert.equal(initial.modelFallbackReason, undefined);
			assert.deepEqual(
				driver.reports.filter((report) => report.type === "warning"),
				[],
			);
			assert.equal(initial.output?.includes(warning), false);

			const beforeReload = driver.reports.length;
			driver.send({ type: "reload" });
			await driver.waitFor((report) => report.type === "reload_done", beforeReload);
			driver.send({ type: "state" });
			const reloaded = await driver.waitFor((report) => report.type === "state", beforeReload);
			assert.equal(reloaded.modelProvider, "isolation-fixture");
			assert.equal(reloaded.modelId, "blocking-model");
			assert.equal(reloaded.modelFallbackMessage, undefined);
			assert.equal(reloaded.output?.includes(warning), false);
		} finally {
			await driver.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_EXTENSION_FALLBACK_TEST_TIMEOUT_MS,
);

serialTest(
	"isolated interactive startup resolves a settings-configured extension provider default",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-settings-extension-default-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "isolation-fixture",
				defaultModel: "blocking-model",
				extensions: [join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts")],
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
			}),
		);
		const driver = new Driver(["--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve"], {
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			NO_COLOR: "1",
		});
		try {
			const settled = await waitForInputLoopState(driver);
			assert.equal(settled.modelProvider, "isolation-fixture");
			assert.equal(settled.modelId, "blocking-model");
			assert.equal(settled.modelFallbackMessage, undefined);
			assert.deepEqual(
				driver.reports.filter((report) => report.type === "warning"),
				[],
			);
		} finally {
			await driver.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_EXTENSION_FALLBACK_TEST_TIMEOUT_MS,
);

serialTest(
	"isolated interactive persisted stale state shows one generic warning and remains live",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-persisted-stale-interactive-"));
		const cwd = join(root, "cwd");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		mkdirSync(sessionDir);
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
		const persisted = await SessionManager.create(cwd, sessionDir);
		await persisted.appendModelChange(removedProvider, removedModel);
		await persisted.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted stale model" }],
			timestamp: Date.now(),
		});
		await persisted.appendMessage({
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
				"--session-dir",
				persisted.getSessionDir(),
				"--session",
				persisted.getSessionId(),
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
			const settled = await waitForInputLoopState(driver);
			assert.equal(settled.modelProvider, "unknown");
			assert.equal(settled.modelFallbackReason, "configured-provider-unsupported");
			assert.equal(settled.modelFallbackMessage, warning);
			assert.deepEqual(
				driver.reports.filter((report) => report.type === "warning").map((report) => report.message),
				[warning],
				"generic warning must be shown exactly once before the input loop",
			);
			assert.equal(settled.output?.includes("API key"), false);
			assert.equal(settled.output?.toLowerCase().includes(removedProvider), false);
			driver.send({ type: "input", data: "/exit" });
			driver.send({ type: "input", data: "\r" });
			assert.equal(await driver.waitForCleanExit(), 0);
		} finally {
			await driver.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_EXTENSION_FALLBACK_TEST_TIMEOUT_MS,
);

const MODEL_NOTICE = /^(Could not restore model|Configured default model|No models available)/;
const STARTUP_NOTICE_SETTLE_MS = 1_500;
const HOST_NOTICE_REPLAY_TIMEOUT_MS = 240_000;

/** How the engine child gets the extension that registers the default model's provider. */
type ExtensionLoading = "settings" | "cli-extension" | "project-extension";

/** Model notices one startup shows: host warnings and engine stderr warnings, one line per notice. */
function startupModelNotices(reports: readonly HarnessReport[]): string[] {
	return reports
		.filter((report) => report.type === "warning" || report.type === "diagnostic")
		.flatMap((report) => (report.message ?? "").split("\n"))
		.map((line) => line.replace(/^Warning: /, "").trim())
		.filter((line) => MODEL_NOTICE.test(line))
		.sort();
}

async function startupWithExtensionDefault(
	loading: ExtensionLoading,
	{ continued, credentials }: { continued: boolean; credentials: boolean },
): Promise<{ model: string; notices: string[] }> {
	const root = mkdtempSync(join(tmpdir(), `atomic-extension-default-notices-${loading}-`));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionDir);
	const extensionSource = `export default function (pi) {
	pi.registerProvider("notice-ext", {
		api: "anthropic-messages",
		baseUrl: "https://notice-ext.invalid",
		${credentials ? 'apiKey: "notice-key",' : ""}
		models: [{ id: "notice-model", name: "Notice", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
	});
}
`;
	const extensionPath = join(root, "notice-extension.ts");
	writeFileSync(extensionPath, extensionSource);
	if (loading === "project-extension") {
		mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "extensions", "notice-extension.ts"), extensionSource);
		new ProjectTrustStore(agentDir).set(cwd, true);
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "notice-ext",
			defaultModel: "notice-model",
			...(loading === "settings" ? { extensions: [extensionPath] } : {}),
			lastChangelogVersion: "0.0.0",
			firstRunOnboardingStartedVersion: "0.0.0",
			onboardedVersion: "0.0.0",
		}),
	);
	const sessionArgs = ["--session-dir", sessionDir];
	if (continued) {
		const persisted = await SessionManager.create(cwd, sessionDir);
		await persisted.appendModelChange("gone-provider", "old-model");
		await persisted.appendMessage({ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 });
		sessionArgs.push("--session", persisted.getSessionId());
	}
	const driver = new Driver(
		[
			...sessionArgs,
			...(loading === "cli-extension" ? ["--no-extensions", "--extension", extensionPath] : []),
			// A trust override would skip the stored project trust that loads the project extension.
			...(loading === "project-extension" ? [] : ["--approve"]),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
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
		await waitForInputLoopState(driver);
		await driver.waitFor((report) => report.type === "engine_resources_ready");
		await sleep(STARTUP_NOTICE_SETTLE_MS);
		const stateFrom = driver.reports.length;
		driver.send({ type: "state" });
		const state = await driver.waitFor((report) => report.type === "state", stateFrom);
		return { model: `${state.modelProvider}/${state.modelId}`, notices: startupModelNotices(driver.reports) };
	} finally {
		await driver.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

serialTest(
	"isolated --extension startup reports a continued session's replaced model once, as eager startup does (#5247)",
	async () => {
		const options = { continued: true, credentials: true };
		const eager = await startupWithExtensionDefault("settings", options);
		assert.deepEqual(eager, {
			model: "notice-ext/notice-model",
			notices: ["Could not restore model gone-provider/old-model. Using notice-ext/notice-model"],
		});
		assert.deepEqual(await startupWithExtensionDefault("cli-extension", options), eager);
	},
	HOST_NOTICE_REPLAY_TIMEOUT_MS,
);

for (const continued of [false, true]) {
	for (const credentials of [true, false]) {
		serialTest(
			`isolated startup with a trusted project extension default shows eager startup's model notices, continued=${continued}, credentials=${credentials} (#5247)`,
			async () => {
				const options = { continued, credentials };
				const eager = await startupWithExtensionDefault("settings", options);
				assert.deepEqual(
					eager.notices.map((notice) => notice.replace(/\. Use \/login.*/, "")),
					credentials
						? continued
							? ["Could not restore model gone-provider/old-model. Using notice-ext/notice-model"]
							: []
						: [continued ? "Could not restore model gone-provider/old-model" : "No models available"],
				);
				assert.deepEqual(await startupWithExtensionDefault("project-extension", options), eager);
			},
			HOST_NOTICE_REPLAY_TIMEOUT_MS,
		);
	}
}
