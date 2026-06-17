import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function bunExecutable(): string {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath?.endsWith("bun") || npmExecPath?.endsWith("bun.exe")) {
		return npmExecPath;
	}
	return "bun";
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const CLI_PATH = resolve(PACKAGE_ROOT, "src/cli.ts");

function readPersistedDefaultContextWindow(agentDir: string): number | undefined {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) {
		return undefined;
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { defaultContextWindow?: number };
	return settings.defaultContextWindow;
}

describe("CLI context window diagnostics", () => {
	let tempDir: string;
	let agentDir: string;
	let sessionDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-context-window-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		sessionDir = join(tempDir, "sessions");
		cwd = join(tempDir, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://example.invalid/v1",
						apiKey: "test-key",
						api: "openai-responses",
						models: [
							{
								id: "selectable-context",
								name: "Selectable Context",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 400_000,
								contextWindowOptions: [1_000_000],
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	test("reports unsupported strict CLI context window once", () => {
		const result = spawnSync(
			bunExecutable(),
			[
				CLI_PATH,
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--model",
				"custom/selectable-context",
				"--context-window",
				"2m",
				"-p",
				"hello",
			],
			{
				cwd,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
					ATOMIC_OFFLINE: "1",
					ATOMIC_SKIP_VERSION_CHECK: "1",
					NO_COLOR: "1",
				},
				encoding: "utf8",
				input: "",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		const stderr = result.stderr.toString();
		const duplicateMatches = stderr.match(/Context window 2m is not supported by custom\/selectable-context/g) ?? [];
		expect(duplicateMatches).toHaveLength(1);
	});

	test("runs the child CLI when invoked with the repository root cwd", () => {
		const result = spawnSync(
			bunExecutable(),
			[
				CLI_PATH,
				"--help",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			],
			{
				cwd: REPO_ROOT,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
					ATOMIC_OFFLINE: "1",
					ATOMIC_SKIP_VERSION_CHECK: "1",
					NO_COLOR: "1",
				},
				encoding: "utf8",
				input: "",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toContain("--context-window <tokens>");
	});

	test("does not persist defaultContextWindow when startup has fatal diagnostics", () => {
		const missingExtensionPath = join(cwd, "missing-extension.ts");
		const result = spawnSync(
			bunExecutable(),
			[
				CLI_PATH,
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--extension",
				missingExtensionPath,
				"--model",
				"custom/selectable-context",
				"--context-window",
				"1m",
				"-p",
				"hello",
			],
			{
				cwd,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
					ATOMIC_OFFLINE: "1",
					ATOMIC_SKIP_VERSION_CHECK: "1",
					NO_COLOR: "1",
				},
				encoding: "utf8",
				input: "",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr.toString()).toContain("Failed to load extension");
		expect(readPersistedDefaultContextWindow(agentDir)).toBeUndefined();
	});

	for (const scenario of [
		{ name: "--help", args: ["--help"] },
		{ name: "--list-models", args: ["--list-models", "selectable-context"] },
	]) {
		test(`${scenario.name} does not persist defaultContextWindow`, () => {
			const result = spawnSync(
				bunExecutable(),
				[
					CLI_PATH,
					...scenario.args,
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					"--model",
					"custom/selectable-context",
					"--context-window",
					"1m",
				],
				{
					cwd,
					env: {
						...process.env,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
						ATOMIC_OFFLINE: "1",
						ATOMIC_SKIP_VERSION_CHECK: "1",
						NO_COLOR: "1",
					},
					encoding: "utf8",
					input: "",
				},
			);

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(readPersistedDefaultContextWindow(agentDir)).toBeUndefined();
		});
	}
});
