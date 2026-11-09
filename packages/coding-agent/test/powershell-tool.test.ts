import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import type * as BashPtyNative from "../src/core/tools/bash-pty-native.js";
import { allToolNames, getDefaultToolNames } from "../src/core/tools/index.ts";
import {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
} from "../src/core/tools/powershell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type * as Shell from "../src/utils/shell.ts";
import { getPowerShellConfig, isPowerShellAvailable, POWERSHELL_ARGS } from "../src/utils/shell.ts";

const REAL_POWERSHELL_EXIT_CODES_TIMEOUT_MS = 120_000;
const UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const EXIT_SUFFIX =
	'\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

const { shellOverride, ptyCalls } = vi.hoisted(() => ({
	shellOverride: { path: undefined as string | undefined },
	ptyCalls: [] as Array<{
		command: string;
		shell: string | undefined;
		args: string[] | undefined;
		description?: string;
	}>,
}));

vi.mock("../src/utils/shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Shell>();
	return {
		...actual,
		getPowerShellConfig: () =>
			shellOverride.path
				? { shell: shellOverride.path, args: [...actual.POWERSHELL_ARGS] }
				: actual.getPowerShellConfig(),
	};
});

vi.mock("../src/core/tools/bash-pty-native.js", async (importOriginal) => {
	const actual = await importOriginal<typeof BashPtyNative>();
	return {
		...actual,
		executeNativePty: async (
			command: string,
			_cwd: string,
			options: { shellConfig?: { shell: string; args: string[] }; commandDescription?: string },
		) => {
			ptyCalls.push({
				command,
				shell: options.shellConfig?.shell,
				args: options.shellConfig?.args,
				description: options.commandDescription,
			});
			return { exitCode: 0 };
		},
	};
});

afterEach(() => {
	shellOverride.path = undefined;
	ptyCalls.length = 0;
	vi.unstubAllEnvs();
});

const passthroughTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never;

function renderedCall(definition: { renderCall?: (...args: never[]) => { render(width: number): string[] } }): string {
	const context = { cwd: process.cwd(), state: {}, executionStarted: false } as never;
	return (
		definition
			.renderCall?.({ command: "Get-ChildItem" } as never, passthroughTheme, context)
			.render(80)
			.join("\n") ?? ""
	);
}

// Upstream 80e62761f7 gives each shell tool its own transcript prompt
// (`powershellToolConfig.prompt = "PS>"`); bash keeps `$`.
test("renders PowerShell calls with a PowerShell prompt, not the bash prompt", () => {
	initTheme("dark");
	const powershell = stripVTControlCharacters(renderedCall(createPowerShellToolDefinition(process.cwd())));
	const bash = stripVTControlCharacters(renderedCall(createBashToolDefinition(process.cwd())));

	expect(powershell).toContain("PS> Get-ChildItem");
	expect(powershell).not.toContain("$ Get-ChildItem");
	expect(bash).toContain("$ Get-ChildItem");
});

test("powershell is always a known tool name, on every platform", () => {
	// The name universe is platform-independent, so a shared settings.json that
	// lists `powershell` is never rejected as unknown on a non-Windows host.
	expect(allToolNames.has("powershell")).toBe(true);
});

test("powershell is a startup default only when an executable resolves", () => {
	expect(getDefaultToolNames({ powerShellAvailable: true })).toContain("powershell");
	expect(getDefaultToolNames({ powerShellAvailable: false })).not.toContain("powershell");
});

test("the resolved default set follows the host probe", () => {
	expect(getDefaultToolNames()).toEqual(getDefaultToolNames({ powerShellAvailable: isPowerShellAvailable() }));
});

test("uses process-local execution policy bypass", () => {
	expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
});

test("saves truncated PowerShell output with the PowerShell temp-file prefix", async () => {
	const tool = createPowerShellTool(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("x".repeat(60 * 1024), "utf8"), "stdout");
				return { exitCode: 0 };
			},
		},
	});

	const result = await tool.execute("powershell-prefix-test", { command: "Write-Output big" });
	const fullOutputPath = result.details?.fullOutputPath;
	expect(fullOutputPath).toBeDefined();
	const filename = basename(fullOutputPath!);
	expect(filename.startsWith(`${APP_NAME}-powershell`)).toBe(true);
	expect(filename.startsWith(`${APP_NAME}-bash`)).toBe(false);
});

test.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
	const config = getPowerShellConfig();
	expect(config.args).toEqual(POWERSHELL_ARGS);

	const tool = createPowerShellTool(process.cwd());
	const result = await tool.execute("powershell-test", {
		command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
	});
	const output = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	expect(output).toContain("héllo €");
	expect(output).toContain("Bypass");
});

test("pre-aborted signals reject without running a command", async () => {
	const ops = createLocalPowerShellOperations();
	const controller = new AbortController();
	controller.abort();
	await expect(
		ops.exec("Write-Output hi", process.cwd(), {
			onData: () => {},
			signal: controller.signal,
		}),
	).rejects.toThrow(/aborted|only available on Windows|No PowerShell executable found/);
});

test("abort settles promptly instead of waiting on descendant-held streams", async () => {
	if (!isPowerShellAvailable()) return;

	const ops = createLocalPowerShellOperations();
	const controller = new AbortController();
	const started = Date.now();
	const run = ops.exec("Start-Sleep -Seconds 20", process.cwd(), {
		onData: () => {},
		signal: controller.signal,
	});
	controller.abort();
	await expect(run).rejects.toThrow(/aborted/);
	expect(Date.now() - started).toBeLessThan(2000);
});

test("unbound PowerShell background observation refuses before executing, including PTY", async () => {
	for (const pty of [false, true]) {
		await expect(
			createLocalPowerShellOperations().exec("Write-Output must-not-run", process.cwd(), {
				pty,
				wait: { kind: "background" },
				onData: () => assert.fail("refused command produced output"),
			}),
		).rejects.toThrow(/supported task owner/);
	}
	let hooked = false;
	const tool = createPowerShellToolDefinition(process.cwd(), {
		spawnHook: (context) => {
			hooked = true;
			return context;
		},
	});
	await expect(
		tool.execute("unbound", { command: "Write-Output must-not-run", wait: { kind: "background" } }),
	).rejects.toThrow(/supported task owner/);
	assert.equal(hooked, false);
});

test("PowerShell validates direct observation and execution budgets", async () => {
	const operations = createLocalPowerShellOperations();
	await expect(
		operations.exec("Write-Output must-not-run", process.cwd(), {
			wait: { kind: "foreground", budgetMs: -1 },
			onData: () => {},
		}),
	).rejects.toThrow(/Invalid bash wait/);
	await expect(
		operations.exec("Write-Output must-not-run", process.cwd(), { timeout: -1, onData: () => {} }),
	).rejects.toThrow(/Invalid timeout/);
});

function findPowerShell(fileName: "powershell.exe" | "pwsh.exe"): string | undefined {
	if (process.platform !== "win32") return undefined;
	const candidates =
		fileName === "powershell.exe"
			? [win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", fileName)]
			: [win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", fileName)];
	const configured = getPowerShellConfig().shell;
	if (win32.basename(configured).toLowerCase() === fileName) candidates.unshift(configured);
	return candidates.find((candidate) => existsSync(candidate));
}

const stderrExit0 = 'cmd /c "echo progress 1>&2 & exit 0"';
const stderrExit7 = 'cmd /c "echo progress 1>&2 & exit 7"';
const exitCodeCases: Array<[command: string, exitCode: number]> = [
	[`${stderrExit0} 2>&1 | Select-Object -Last 3`, 0],
	[`${stderrExit0} 2>&1`, 0],
	[`${stderrExit0} 2>$null`, 0],
	[`$output = ${stderrExit0} 2>&1`, 0],
	[stderrExit0, 0],
	[`Get-Item C:\\atomic-missing-4610; ${stderrExit0} 2>&1`, 0],
	[`${stderrExit7} 2>&1 | Select-Object -Last 3`, 1],
	[stderrExit7, 1],
	['cmd /c "exit 3"', 1],
	["Get-Item C:\\atomic-missing-4610", 1],
	[`${stderrExit0} 2>&1; Get-Item C:\\atomic-missing-4610`, 1],
	['Write-Error "failed"', 1],
	['throw "failed"', 1],
	[`${stderrExit7}; Write-Output done`, 0],
	["Write-Output done # comment", 0],
	[`Set-StrictMode -Version Latest; ${stderrExit0} 2>&1`, 0],
	["exit 5", 5],
];
const unfinishedCommands = [
	"Write-Output done `",
	"Get-ChildItem |",
	"$true -and",
	"Write-Output a,",
	"$x =",
	"Write-Output (1 +",
	'Write-Output "unclosed',
	"if ($true) {",
].map((statement) => `Write-Output ("atomic-" + "ran"); ${statement}`);

test.runIf(process.platform === "win32")("Windows PowerShell 5.1 is installed for exit-code coverage", () => {
	expect(findPowerShell("powershell.exe")).toBeDefined();
});

for (const fileName of ["powershell.exe", "pwsh.exe"] as const) {
	const shellPath = findPowerShell(fileName);
	test.skipIf(!shellPath)(
		`reports PowerShell 7 exit codes with ${fileName} (#4610)`,
		async () => {
			shellOverride.path = shellPath;
			const operations = createLocalPowerShellOperations();
			const results: Array<[string, number | null]> = [];
			for (const [command] of exitCodeCases) {
				const { exitCode } = await operations.exec(command, process.cwd(), { onData: () => {} });
				results.push([command, exitCode]);
			}
			expect(results).toEqual(exitCodeCases);

			const unfinishedResults: Array<[string, number | null, boolean]> = [];
			for (const command of unfinishedCommands) {
				let output = "";
				const { exitCode } = await operations.exec(command, process.cwd(), {
					onData: (data) => {
						output += data.toString();
					},
				});
				unfinishedResults.push([command, exitCode, output.includes("atomic-ran")]);
			}
			expect(unfinishedResults).toEqual(unfinishedCommands.map((command) => [command, 1, false]));
		},
		REAL_POWERSHELL_EXIT_CODES_TIMEOUT_MS,
	);
}

const fakeShells: string[] = [];

afterEach(() => {
	for (const root of fakeShells.splice(0)) rmSync(root, { force: true, recursive: true });
});

function installFakeShell(fileName: string): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-powershell-argv-"));
	fakeShells.push(root);
	mkdirSync(root, { recursive: true });
	const path = join(root, fileName);
	writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
	chmodSync(path, 0o755);
	return path;
}

async function spawnedScript(fileName: string, command: string): Promise<string> {
	shellOverride.path = installFakeShell(fileName);
	let output = "";
	const { exitCode } = await createLocalPowerShellOperations().exec(command, process.cwd(), {
		onData: (data) => {
			output += data.toString();
		},
	});
	expect(exitCode).toBe(0);
	const argv = JSON.parse(output) as string[];
	expect(argv.slice(0, -1)).toEqual([...POWERSHELL_ARGS]);
	return argv.at(-1) ?? "";
}

const posixOnly = process.platform === "win32";

test.skipIf(posixOnly)("appends the exit-code suffix after the user's command for powershell.exe (#4610)", async () => {
	expect(await spawnedScript("powershell.exe", "git push 2>&1")).toBe(`${UTF8_PREFIX}git push 2>&1${EXIT_SUFFIX}`);
});

test.skipIf(posixOnly)("matches the powershell.exe file name case-insensitively (#4610)", async () => {
	expect(await spawnedScript("PowerShell.EXE", "Write-Output hi")).toBe(`${UTF8_PREFIX}Write-Output hi${EXIT_SUFFIX}`);
});

test.skipIf(posixOnly)("leaves pwsh.exe commands unchanged (#4610)", async () => {
	expect(await spawnedScript("pwsh.exe", "git push 2>&1")).toBe(`${UTF8_PREFIX}git push 2>&1`);
});

test.skipIf(posixOnly)("adds no suffix when a powershell.exe command ends in a backtick (#4610)", async () => {
	expect(await spawnedScript("powershell.exe", "Write-Output done `")).toBe(`${UTF8_PREFIX}Write-Output done \``);
});

test.skipIf(posixOnly)("keeps a backtick that is not the final character before the suffix (#4610)", async () => {
	expect(await spawnedScript("powershell.exe", "Write-Output `a")).toBe(
		`${UTF8_PREFIX}Write-Output \`a${EXIT_SUFFIX}`,
	);
});

test("encoded PowerShell commands carry the suffix for powershell.exe only (#4610)", async () => {
	for (const [fileName, expectedSuffix] of [
		["powershell.exe", EXIT_SUFFIX],
		["pwsh.exe", ""],
	] as const) {
		vi.stubEnv("PI_NO_PTY", "");
		vi.stubEnv("ATOMIC_NO_PTY", "");
		shellOverride.path = join("C:\\tools", fileName);
		ptyCalls.length = 0;
		await createLocalPowerShellOperations().exec("git push 2>&1", process.cwd(), { onData: () => {}, pty: true });
		expect(ptyCalls).toHaveLength(1);
		const call = ptyCalls[0];
		expect(call.args?.at(-1)).toBe("-EncodedCommand");
		expect(Buffer.from(call.command, "base64").toString("utf16le")).toBe(
			`${UTF8_PREFIX}git push 2>&1${expectedSuffix}`,
		);
		expect(call.description).toBe("git push 2>&1");
	}
});
