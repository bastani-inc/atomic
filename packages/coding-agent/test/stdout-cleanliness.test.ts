import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCliInProject(
	args: string[],
	options: { agentDir: string; projectDir: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return await new Promise((resolvePromise, reject) => {
		// Bun (the supported runtime; process.execPath under `bunx vitest`) runs
		// TypeScript entrypoints natively, so launch the CLI directly without a
		// transpiler indirection.
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: options.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: options.agentDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".pi");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		[
			'console.log("changed 1 package in 471ms");',
			'console.log("found 0 vulnerabilities");',
			"process.exit(0);",
		].join("\n"),
		"utf-8",
	);

	const packageSettings = JSON.stringify(
		{
			packages: ["npm:fake-package"],
			npmCommand: [process.execPath, fakeNpmPath],
		},
		null,
		2,
	);

	writeFileSync(join(agentDir, "settings.json"), packageSettings, "utf-8");
	writeFileSync(join(projectConfigDir, "settings.json"), packageSettings, "utf-8");

	return runCliInProject(args, { agentDir, projectDir });
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("keeps plain --version on stdout for scripts", async () => {
		const result = await runCli(["--version"]);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
		expect(result.stderr).toBe("");
	});

	it("keeps plain --help on stdout without project startup chatter", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).not.toContain("changed 1 package in 471ms");
		expect(result.stdout).not.toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
	});

	it("honors defaultProjectTrust=always before startup project migrations", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const commandsDir = join(projectDir, ".atomic", "commands");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }, null, 2), "utf-8");
		writeFileSync(join(commandsDir, "test.md"), "hello", "utf-8");

		const result = await runCliInProject(["--help"], { agentDir, projectDir });

		expect(result.code).toBe(0);
		expect(existsSync(join(projectDir, ".atomic", "prompts", "test.md"))).toBe(true);
		expect(existsSync(commandsDir)).toBe(false);
	});

	it("runs trusted project migrations after first-run extension approval", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const commandsDir = join(projectDir, ".atomic", "commands");
		const extensionPath = join(tempRoot, "approve-project-trust.ts");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(join(commandsDir, "test.md"), "hello", "utf-8");
		writeFileSync(
			extensionPath,
			`export default function (pi) { pi.on("project_trust", () => ({ trusted: "yes" })); }\n`,
			"utf-8",
		);

		const result = await runCliInProject(["--extension", extensionPath, "--help"], { agentDir, projectDir });

		expect(result.code).toBe(0);
		expect(existsSync(join(projectDir, ".atomic", "prompts", "test.md"))).toBe(true);
		expect(existsSync(commandsDir)).toBe(false);
	});

	it("keeps stdout empty for --mode json --help while routing startup chatter to stderr", async () => {
		const result = await runCli(["--approve", "--mode", "json", "--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
	});

	it("keeps stdout empty for -p --help while routing startup chatter to stderr", async () => {
		const result = await runCli(["--approve", "-p", "--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
	});
});
