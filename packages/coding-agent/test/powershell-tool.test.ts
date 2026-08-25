import { expect, test } from "vitest";
import { allToolNames, getDefaultToolNames } from "../src/core/tools/index.ts";
import { createLocalPowerShellOperations } from "../src/core/tools/powershell.ts";
import { isPowerShellAvailable } from "../src/utils/shell.ts";

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
