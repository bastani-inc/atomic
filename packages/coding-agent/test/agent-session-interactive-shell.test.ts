import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import type { BashOperations } from "../src/core/tools/bash.js";

const shells = vi.hoisted(() => {
	const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, options) => {
		options.onData(Buffer.from("shell output"), "stdout");
		return { exitCode: 0 };
	});
	return { bash: vi.fn(() => ({ exec })), powershell: vi.fn(() => ({ exec })), exec };
});
vi.mock("../src/core/tools/bash.js", () => ({ createLocalBashOperations: shells.bash }));
vi.mock("../src/core/tools/powershell.ts", () => ({ createLocalPowerShellOperations: shells.powershell }));
vi.mock("../src/core/tools/bash-session-environment.ts", () => ({
	applyBashSessionEnvironment: vi.fn(),
	snapshotBashSessionEnvironment: vi.fn(),
}));

import { abortBash, executeBash } from "../src/core/agent-session-bash.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.clearAllMocks();
});

function session() {
	return {
		_bashAbortControllers: new Map(),
		settingsManager: { getShellCommandPrefix: () => "prefix", getShellPath: () => "/custom/bash" },
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionId: () => "interactive-shell-test",
			getWorktreeRootMappings: () => [],
		},
		_emit: vi.fn(),
		recordBashResult: vi.fn(),
	};
}

test.each(["win32", "linux"])(
	"interactive shell selects the native adapter on %s and preserves prefix/context",
	async (platform) => {
		Object.defineProperty(process, "platform", { configurable: true, value: platform });
		const owner = session();
		const result = await executeBash.call(owner as AgentSessionInternalSurface, "command", undefined, {
			excludeFromContext: true,
		});
		expect(platform === "win32" ? shells.powershell : shells.bash).toHaveBeenCalledOnce();
		expect(platform === "win32" ? shells.bash : shells.powershell).not.toHaveBeenCalled();
		expect(shells.exec.mock.calls[0][0]).toBe("prefix\ncommand");
		expect(owner.recordBashResult).toHaveBeenCalledWith("command", result, { excludeFromContext: true });
		expect(owner._bashAbortControllers.size).toBe(0);
	},
);

test("custom operations override the Windows adapter", async () => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	const owner = session();
	await executeBash.call(owner as AgentSessionInternalSurface, "command", undefined, {
		operations: { exec: shells.exec },
	});
	expect(shells.bash).not.toHaveBeenCalled();
	expect(shells.powershell).not.toHaveBeenCalled();
});

test("Windows interactive cancellation reaches the selected operations and clears its request", async () => {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	shells.exec.mockImplementationOnce(async (_command, _cwd, options) => {
		await new Promise<void>((_resolve, reject) => {
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		return { exitCode: 0 };
	});
	const owner = session();
	const run = executeBash.call(owner as AgentSessionInternalSurface, "command", undefined, { id: "cancel-me" });
	abortBash.call(owner as AgentSessionInternalSurface, "cancel-me");
	expect((await run).cancelled).toBe(true);
	expect(owner._bashAbortControllers.size).toBe(0);
});
