import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { allToolNames, getDefaultToolNames } from "../src/core/tools/index.ts";
import {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
} from "../src/core/tools/powershell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { getPowerShellConfig, isPowerShellAvailable, POWERSHELL_ARGS } from "../src/utils/shell.ts";

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
