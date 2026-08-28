import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
	bashResultFromExecOutcome,
	createRunEnvironmentExecTransport,
	type RemoteOperatingSystem,
	type RunEnvironmentProcess,
	type RunEnvironmentProcessResult,
	type RunEnvironmentProcessRunner,
} from "../../packages/workflows/src/runs/shared/run-environment-exec.js";

interface RecordedProcess {
	readonly command: string;
	readonly args: readonly string[];
	readonly process: ScriptedProcess;
}

class ScriptedProcess implements RunEnvironmentProcess {
	private readonly events = new EventEmitter();
	private readonly resultPromise: Promise<RunEnvironmentProcessResult>;
	private resolveResult!: (result: RunEnvironmentProcessResult) => void;
	private settled = false;
	killed = false;
	get finished(): boolean {
		return this.settled;
	}

	constructor() {
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
	}

	onStdout(listener: (chunk: Buffer) => void): void {
		this.events.on("stdout", listener);
	}

	onStderr(listener: (chunk: Buffer) => void): void {
		this.events.on("stderr", listener);
	}

	writeStdout(value: string): void {
		this.events.emit("stdout", Buffer.from(value));
	}

	writeStderr(value: string): void {
		this.events.emit("stderr", Buffer.from(value));
	}

	wait(): Promise<RunEnvironmentProcessResult> {
		return this.resultPromise;
	}

	kill(): void {
		this.killed = true;
	}

	finish(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveResult({ code, signal });
	}
}

class ScriptedRunner implements RunEnvironmentProcessRunner {
	readonly processes: RecordedProcess[] = [];
	readonly master = new ScriptedProcess();
	executeStarted?: (process: ScriptedProcess) => void;
	checkMaster?: (process: ScriptedProcess, checkNumber: number) => void;
	private masterStarted = false;
	private checkCount = 0;

	start(command: string, args: readonly string[]): RunEnvironmentProcess {
		const isMaster = args.includes("-M");
		const process = isMaster ? this.master : new ScriptedProcess();
		this.processes.push({ command, args: [...args], process });
		if (command === "/pinned/coder") {
			queueMicrotask(() => process.finish(0));
		} else if (isMaster) {
			this.masterStarted = true;
		} else if (args.includes("check")) {
			this.checkCount += 1;
			const checkNumber = this.checkCount;
			queueMicrotask(() => {
				if (this.checkMaster !== undefined) this.checkMaster(process, checkNumber);
				else process.finish(this.masterStarted && !this.master.finished ? 0 : 255);
			});
		} else if (args.includes("exit")) {
			queueMicrotask(() => {
				process.finish(this.masterStarted ? 0 : 255);
				this.master.finish(0);
			});
		} else {
			const controlPathIndex = args.indexOf("-S");
			const proxyCommand = args.find((arg) => arg.startsWith("ProxyCommand="));
			const usesMaster =
				this.masterStarted &&
				!this.master.finished &&
				((controlPathIndex >= 0 && args[controlPathIndex + 1]?.endsWith("master.sock") === true) ||
					proxyCommand?.includes("master.sock") === true);
			queueMicrotask(() => {
				if (usesMaster) this.executeStarted?.(process);
				else process.finish(255);
			});
		}
		return process;
	}
}

async function withTransport(
	runner: ScriptedRunner,
	run: (transport: Awaited<ReturnType<typeof createRunEnvironmentExecTransport>>) => Promise<void>,
	operatingSystem: RemoteOperatingSystem = "linux",
	controlPlatform: NodeJS.Platform = "linux",
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-exec-test-"));
	const transport = await createRunEnvironmentExecTransport({
		coderPath: "/pinned/coder",
		sshPath: "/usr/bin/ssh",
		workspaceName: "run-123",
		operatingSystem,
		controlPlatform,
		runtimeDirectory: directory,
		processRunner: runner,
		masterReadyTimeoutMs: 1_000,
	});
	try {
		await run(transport);
	} finally {
		await transport.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function executionCalls(runner: ScriptedRunner): readonly RecordedProcess[] {
	return runner.processes.filter(
		({ command, args }) => command === "/usr/bin/ssh" && !args.includes("-M") && !args.includes("-O"),
	);
}

describe("run-environment execute transport", () => {
	test("configures Coder SSH once and multiplexes every command through one environment master", async () => {
		const runner = new ScriptedRunner();
		let execution = 0;
		runner.executeStarted = (process) => {
			execution += 1;
			process.writeStdout(`stdout-${execution}`);
			process.writeStderr(`stderr-${execution}`);
			process.finish(execution === 1 ? 0 : 7);
		};

		await withTransport(runner, async (transport) => {
			const output: Array<{ channel: string; text: string }> = [];
			const sink = {
				write(chunk: Buffer, channel: "stdout" | "stderr") {
					output.push({ channel, text: chunk.toString() });
				},
			};
			const first = await transport.execute(
				{ argv: ["printf", "%s", "first argument"], cwd: "/workspace", environment: { MODE: "test" } },
				sink,
				new AbortController().signal,
			);
			const second = await transport.execute({ argv: ["false"] }, sink, new AbortController().signal);

			assert.deepEqual(first, { kind: "exited", code: 0 });
			assert.deepEqual(second, { kind: "exited", code: 7 });
			assert.deepEqual(output, [
				{ channel: "stdout", text: "stdout-1" },
				{ channel: "stderr", text: "stderr-1" },
				{ channel: "stdout", text: "stdout-2" },
				{ channel: "stderr", text: "stderr-2" },
			]);
		});

		const coderCalls = runner.processes.filter(({ command }) => command === "/pinned/coder");
		assert.equal(coderCalls.length, 1);
		assert.equal(coderCalls[0]?.args[0], "config-ssh");
		assert.ok(coderCalls[0]?.args.includes("--yes"));
		assert.ok(coderCalls[0]?.args.includes("--ssh-config-file"));
		assert.equal(runner.processes.filter(({ args }) => args.includes("-M")).length, 1);
		assert.equal(executionCalls(runner).length, 2);
		for (const call of executionCalls(runner)) {
			assert.ok(call.args.includes("ControlMaster=no"));
			assert.ok(call.args.includes("ProxyCommand=none"));
			assert.ok(call.args.includes("HostName=127.0.0.1"));
		}
		assert.equal(
			executionCalls(runner)[0]?.args.at(-1),
			`cd -- '/workspace' && exec 'env' '--' 'MODE=test' 'printf' '%s' 'first argument'`,
		);
		assert.equal(
			runner.processes.some(({ command, args }) => command === "/pinned/coder" && args.includes("ssh")),
			false,
		);
	});

	test("selects PowerShell argv encoding for a Windows workspace agent", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);

		await withTransport(
			runner,
			async (transport) => {
				const outcome = await transport.execute(
					{ argv: ["tool.exe", "it's one argument"], cwd: "C:\\work tree", environment: { MODE: "test" } },
					{ write() {} },
					new AbortController().signal,
				);
				assert.deepEqual(outcome, { kind: "exited", code: 0 });
			},
			"windows",
		);

		const rendered = executionCalls(runner)[0]?.args.at(-1) ?? "";
		const encoded = rendered.split(" ").at(-1) ?? "";
		const script = Buffer.from(encoded, "base64").toString("utf16le");
		assert.match(script, /Set-Location -LiteralPath 'C:\\work tree'/u);
		assert.match(script, /Set-Item -LiteralPath 'Env:MODE' -Value 'test'/u);
		assert.match(script, /& 'tool\.exe' 'it''s one argument'/u);
	});
	test("selects Git for Windows SSH instead of native Win32 OpenSSH", async () => {
		const directory = await mkdtemp(join(tmpdir(), "atomic-exec-windows-test-"));
		const sshPath = join(directory, "Git", "usr", "bin", "ssh.exe");
		await mkdir(join(directory, "Git", "usr", "bin"), { recursive: true });
		await writeFile(sshPath, "");
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);
		const runtimeDirectory = join(directory, "runtime");
		try {
			const transport = await createRunEnvironmentExecTransport({
				coderPath: "/pinned/coder",
				workspaceName: "run-123",
				operatingSystem: "linux",
				controlPlatform: "win32",
				environment: { ProgramFiles: directory },
				runtimeDirectory,
				processRunner: runner,
				masterReadyTimeoutMs: 1_000,
			});
			await transport.close();
			assert.equal(runner.processes.find(({ args }) => args.includes("-M"))?.command, sshPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("uses proxy-mode multiplexing from a Windows control host", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);

		await withTransport(
			runner,
			async (transport) => {
				const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);
				assert.deepEqual(outcome, { kind: "exited", code: 0 });
			},
			"linux",
			"win32",
		);

		const execution = executionCalls(runner)[0];
		assert.ok(execution?.args.includes("ControlMaster=no"));
		const proxyCommand = execution?.args.find((arg) => arg.startsWith("ProxyCommand="));
		assert.match(proxyCommand ?? "", /\/usr\/bin\/ssh.*-O proxy/u);
	});

	test("preserves a remote exit code 255 while the control master is alive", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(255);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["exit", "255"] },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "exited", code: 255 });
		});
	});

	test("returns TransportLost when an exit 255 cannot reach the control master", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(255);
		runner.checkMaster = (process, checkNumber) => process.finish(checkNumber === 1 ? 0 : 255);

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.equal(outcome.kind, "transport_lost");
			if (outcome.kind === "transport_lost") assert.match(outcome.detail, /SSH transport lost/u);
		});
	});
	test("returns TimedOut and preserves the builtin bash timeout error", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = () => {};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute(
				{ argv: ["sleep", "30"], timeoutSeconds: 0.01 },
				{ write() {} },
				new AbortController().signal,
			);

			assert.deepEqual(outcome, { kind: "timed_out", seconds: 0.01 });
			assert.equal(executionCalls(runner)[0]?.process.killed, true);
			assert.throws(() => bashResultFromExecOutcome(outcome), /^Error: timeout:0\.01$/u);
		});
	});

	test("returns Aborted and preserves the builtin bash abort error", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = () => {};

		await withTransport(runner, async (transport) => {
			const controller = new AbortController();
			const pending = transport.execute({ argv: ["long-command"] }, { write() {} }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();
			const outcome = await pending;

			assert.deepEqual(outcome, { kind: "aborted" });
			assert.equal(executionCalls(runner)[0]?.process.killed, true);
			assert.throws(() => bashResultFromExecOutcome(outcome), /^Error: aborted$/u);
		});
	});

	test("an abort interrupts a hung post-command master probe", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => process.finish(0);
		runner.checkMaster = (process, checkNumber) => {
			if (checkNumber === 1) process.finish(0);
		};

		await withTransport(runner, async (transport) => {
			const controller = new AbortController();
			const pending = transport.execute({ argv: ["true"] }, { write() {} }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();
			const outcome = await Promise.race([
				pending,
				new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
			]);

			assert.notEqual(outcome, "hung");
			assert.deepEqual(outcome, { kind: "aborted" });
			const checks = runner.processes.filter(({ args }) => args.includes("check"));
			assert.equal(checks.at(-1)?.process.killed, true);
		});
	});

	test("reports a dropped control master as TransportLost even if the command client reports zero", async () => {
		const runner = new ScriptedRunner();
		runner.executeStarted = (process) => {
			runner.master.writeStderr("connection closed");
			runner.master.finish(255);
			process.finish(0);
		};

		await withTransport(runner, async (transport) => {
			const outcome = await transport.execute({ argv: ["true"] }, { write() {} }, new AbortController().signal);

			assert.equal(outcome.kind, "transport_lost");
			if (outcome.kind === "transport_lost") assert.match(outcome.detail, /connection closed/u);
		});
	});
});
