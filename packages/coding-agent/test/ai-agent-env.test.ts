import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { spawnRpcClientProcess } from "../src/modes/rpc/rpc-client-process.ts";
import { bunExecutable } from "./cli-test-helpers.ts";

const temporaryDirectories: string[] = [];
const originalAiAgent = process.env.AI_AGENT;
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = join(packageRoot, "src", "cli.ts");
const rpcEntry = join(packageRoot, "src", "rpc-entry.ts");
const splitLoader = join(packageRoot, "src", "bun", "split-loader.ts");
const REAL_ENTRYPOINT_PROBE_TIMEOUT_MS = 90_000;
const REAL_ENTRYPOINT_PROBE_TEST_TIMEOUT_MS = 120_000;
function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	expect(process.env.AI_AGENT).toBe(originalAiAgent);
});

function writeEntrypointProbeExtension(directory: string): { extension: string; probe: string } {
	const extension = join(directory, "probe-extension.ts");
	const probe = join(directory, "probe.txt");
	writeFileSync(
		extension,
		`import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.AI_AGENT ?? '')"], { encoding: "utf8", env: { ...process.env } });
writeFileSync(process.env.ATOMIC_AI_AGENT_PROBE_FILE!, child.stdout);
process.exit(0);
export default function probeExtension(): void {}
`,
	);
	return { extension, probe };
}

function runEntrypointProbe(entrypoint: string): string {
	const directory = temporaryDirectory("atomic-ai-agent-entry-");
	const { extension, probe } = writeEntrypointProbeExtension(directory);
	const result = spawnSync(
		bunExecutable(),
		[
			entrypoint,
			"--mode",
			"rpc",
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--offline",
			"--extension",
			extension,
		],
		{
			cwd: process.cwd(),
			env: { ...process.env, AI_AGENT: "parent", ATOMIC_AI_AGENT_PROBE_FILE: probe },
			encoding: "utf8",
			timeout: REAL_ENTRYPOINT_PROBE_TIMEOUT_MS,
		},
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.error).toBeUndefined();
	return readFileSync(probe, "utf8");
}

describe("Atomic child-process attribution", () => {
	test(
		"the CLI entry gives its spawned child the Atomic attribution",
		() => {
			expect(runEntrypointProbe(cliEntry)).toBe("atomic");
		},
		REAL_ENTRYPOINT_PROBE_TEST_TIMEOUT_MS,
	);

	test(
		"the RPC entry gives its spawned child the Atomic attribution",
		() => {
			expect(runEntrypointProbe(rpcEntry)).toBe("atomic");
		},
		REAL_ENTRYPOINT_PROBE_TEST_TIMEOUT_MS,
	);

	test(
		"the compiled split loader gives its app bundle's child the Atomic attribution",
		() => {
			const directory = temporaryDirectory("atomic-ai-agent-split-");
			const app = join(directory, "app.js");
			writeFileSync(
				app,
				`import { spawnSync } from "node:child_process";
const child = spawnSync(process.env.ATOMIC_AI_AGENT_RUNTIME, ["-e", "process.stdout.write(process.env.AI_AGENT ?? '')"], { encoding: "utf8", env: { ...process.env } });
if (child.error) throw child.error;
process.stdout.write(child.stdout);
`,
			);
			const launcherScript = `import { join } from "node:path";
Object.defineProperty(process, "execPath", { value: join(process.env.ATOMIC_AI_AGENT_SPLIT_ROOT, "atomic"), configurable: true });
await import(${JSON.stringify(pathToFileURL(splitLoader).href)});
`;
			const result = spawnSync(bunExecutable(), ["--eval", launcherScript], {
				cwd: process.cwd(),
				env: {
					...process.env,
					AI_AGENT: "parent",
					ATOMIC_AI_AGENT_RUNTIME: bunExecutable(),
					ATOMIC_AI_AGENT_SPLIT_ROOT: directory,
				},
				encoding: "utf8",
				timeout: REAL_ENTRYPOINT_PROBE_TIMEOUT_MS,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("atomic");
		},
		REAL_ENTRYPOINT_PROBE_TEST_TIMEOUT_MS,
	);

	test(
		"the RPC process seam overrides the child value without changing the parent environment",
		async () => {
			const directory = temporaryDirectory("atomic-ai-agent-rpc-process-");
			const childScript = join(directory, "child.mjs");
			writeFileSync(childScript, 'process.stdout.write(process.env.AI_AGENT ?? "");\n');
			const child = spawnRpcClientProcess({
				cliPath: childScript,
				cliArgs: [],
				runtimeExecutable: bunExecutable(),
				env: { AI_AGENT: "caller" },
				interactiveEngine: false,
			});
			let stdout = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			await new Promise<void>((resolvePromise, reject) => {
				child.once("error", reject);
				child.once("close", (code) => {
					if (code !== 0) {
						reject(new Error(`child exited with code ${code}`));
						return;
					}
					resolvePromise();
				});
			});
			expect(stdout).toBe("atomic");
		},
		REAL_ENTRYPOINT_PROBE_TEST_TIMEOUT_MS,
	);
});
