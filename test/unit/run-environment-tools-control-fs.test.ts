import assert from "node:assert/strict";
import { test } from "vitest";
import type {
	ExecOutcome,
	OutputSink,
	RemoteCommand,
	RunEnvironmentExecTransport,
} from "../../packages/workflows/src/runs/shared/run-environment-exec.js";
import {
	createRunEnvironmentEditToolDefinition,
	createRunEnvironmentLsToolDefinition,
	createRunEnvironmentReadToolDefinition,
	createRunEnvironmentWriteToolDefinition,
} from "../../packages/workflows/src/runs/shared/run-environment-tools.js";
import { reportedCoderAgent } from "../helpers/coder-agent.js";
import { controlFilesystem } from "../helpers/control-filesystem.js";

interface Execution {
	readonly stdout?: string;
	readonly outcome?: ExecOutcome;
	readonly expectedPath?: string;
}

const windowsAgent = await reportedCoderAgent("windows");
class ScriptedTransport implements RunEnvironmentExecTransport {
	readonly agent = windowsAgent;
	readonly commands: RemoteCommand[] = [];

	constructor(private readonly executions: Execution[]) {}

	async execute(command: RemoteCommand, sink: OutputSink): Promise<ExecOutcome> {
		this.commands.push(command);
		const execution = this.executions.shift() ?? {};
		if (execution.expectedPath !== undefined && !command.argv.includes(execution.expectedPath)) {
			return { kind: "exited", code: 2 };
		}
		if (execution.stdout !== undefined) sink.write(Buffer.from(execution.stdout), "stdout");
		return execution.outcome ?? { kind: "exited", code: 0 };
	}

	async close(): Promise<void> {}
}

const signal = new AbortController().signal;

async function execute(tool: { execute: (...args: never[]) => Promise<object> }, input: object): Promise<object> {
	return tool.execute("call" as never, input as never, signal as never, undefined as never, {} as never);
}

test("every remote public file tool resolves target paths without the control-machine filesystem", async () => {
	const remoteFile = "C:\\remote\\~\\a.txt";
	const remoteDirectory = "C:\\remote\\~";
	const readTransport = new ScriptedTransport([{ stdout: "F\0before\r\n", expectedPath: remoteFile }]);
	const writeTransport = new ScriptedTransport([{ stdout: "N", expectedPath: remoteFile }]);
	const editTransport = new ScriptedTransport([{ stdout: "F\0before\r\n", expectedPath: remoteFile }, {}]);
	const lsTransport = new ScriptedTransport([{ stdout: "D\0f\0a.txt\0", expectedPath: remoteDirectory }]);
	const read = createRunEnvironmentReadToolDefinition("C:\\remote", { transport: readTransport });
	const write = createRunEnvironmentWriteToolDefinition("C:\\remote", { transport: writeTransport });
	const editRead = createRunEnvironmentReadToolDefinition("C:\\remote", { transport: editTransport });
	const edit = createRunEnvironmentEditToolDefinition("C:\\remote", { transport: editTransport });
	const ls = createRunEnvironmentLsToolDefinition("C:\\remote", { transport: lsTransport });

	controlFilesystem.arm();
	try {
		await execute(read as never, { path: "~\\a.txt" });
		await execute(write as never, { path: "~\\a.txt", content: "after\r\n" });
		const snapshot = await execute(editRead as never, { path: "~\\a.txt" });
		const text = (snapshot as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
		const header = /\[~\/a\.txt#[0-9A-F]{4}\]/u.exec(text)?.[0];
		assert.ok(header);
		await execute(edit as never, { input: `${header}\nreplace 1..1:\n+after` });
		await execute(ls as never, { path: "~" });
	} finally {
		controlFilesystem.disarm();
	}

	controlFilesystem.assertUntouched();
	assert.equal(readTransport.commands.length, 1);
	assert.equal(writeTransport.commands.length, 1);
	assert.equal(editTransport.commands.length, 2);
	assert.equal(lsTransport.commands.length, 1);
});
