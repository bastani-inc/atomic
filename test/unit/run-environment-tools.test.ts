import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import type { CoderAgentMetadata } from "../../packages/workflows/src/runs/shared/run-environment-coder.js";
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
	type RunEnvironmentToolOperationsOptions,
} from "../../packages/workflows/src/runs/shared/run-environment-tools.js";
import { reportedCoderAgent } from "../helpers/coder-agent.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

interface ScriptedExecution {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly outcome?: ExecOutcome;
}

class ScriptedTransport implements RunEnvironmentExecTransport {
	readonly commands: RemoteCommand[] = [];
	agent: CoderAgentMetadata = reportedAgents.linux;
	private readonly executions: ScriptedExecution[];

	constructor(...executions: ScriptedExecution[]) {
		this.executions = [...executions];
	}

	async execute(command: RemoteCommand, sink: OutputSink): Promise<ExecOutcome> {
		this.commands.push(command);
		const execution = this.executions.shift() ?? {};
		if (execution.stdout !== undefined) sink.write(Buffer.from(execution.stdout), "stdout");
		if (execution.stderr !== undefined) sink.write(Buffer.from(execution.stderr), "stderr");
		return execution.outcome ?? { kind: "exited", code: 0 };
	}

	async close(): Promise<void> {}
}

class LocalCommandTransport implements RunEnvironmentExecTransport {
	readonly commands: RemoteCommand[] = [];
	agent: CoderAgentMetadata = reportedAgents.linux;

	async execute(command: RemoteCommand, sink: OutputSink): Promise<ExecOutcome> {
		this.commands.push(command);
		const result = spawnSyncCollect(command.argv, { cwd: command.cwd, stdin: command.stdin });
		if (result.stdout.length > 0) sink.write(result.stdout, "stdout");
		if (result.stderr.length > 0) sink.write(result.stderr, "stderr");
		return { kind: "exited", code: result.exitCode };
	}

	async close(): Promise<void> {}
}

class WindowsEditTransport implements RunEnvironmentExecTransport {
	readonly commands: RemoteCommand[] = [];
	agent: CoderAgentMetadata = reportedAgents.windows;
	private readCompleted = false;

	constructor(
		private readonly localCwd: string,
		private readonly content: Buffer,
	) {}

	async execute(command: RemoteCommand, sink: OutputSink): Promise<ExecOutcome> {
		this.commands.push(command);
		if (!this.readCompleted) {
			this.readCompleted = true;
			sink.write(Buffer.concat([Buffer.from("F\0"), this.content]), "stdout");
			return { kind: "exited", code: 0 };
		}
		const argv = command.argv[0] === "git.exe" ? ["git", ...command.argv.slice(1)] : command.argv;
		const result = spawnSyncCollect(argv, { cwd: this.localCwd, stdin: command.stdin });
		if (result.stdout.length > 0) sink.write(result.stdout, "stdout");
		if (result.stderr.length > 0) sink.write(result.stderr, "stderr");
		return { kind: "exited", code: result.exitCode };
	}

	async close(): Promise<void> {}
}

const reportedAgents = {
	linux: await reportedCoderAgent("linux"),
	darwin: await reportedCoderAgent("darwin"),
	windows: await reportedCoderAgent("windows"),
};

function options(
	transport: ScriptedTransport | LocalCommandTransport | WindowsEditTransport,
	operatingSystem: keyof typeof reportedAgents = "linux",
): RunEnvironmentToolOperationsOptions {
	transport.agent = reportedAgents[operatingSystem];
	return { transport };
}

function withFixture(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = makeTempDirectory("atomic-remote-file-tools-");
	return run(cwd).finally(() => removeTempDirectory(cwd));
}

const posixTest = process.platform === "win32" ? test.skip : test;
const windowsTest = process.platform === "win32" ? test : test.skip;
const nativeOperatingSystem = process.platform === "darwin" ? "darwin" : "linux";
const signal = new AbortController().signal;

async function execute(
	tool: {
		execute: (...args: never[]) => Promise<{
			content: Array<{ type: string; text?: string }>;
			details?: { isDirectory?: boolean; madeExecutable?: boolean };
		}>;
	},
	input: object,
) {
	return tool.execute("call" as never, input as never, signal as never, undefined as never, {} as never);
}

posixTest("read, write, edit, and ls operate on one remote checkout with one command per call", async () => {
	await withFixture(async (cwd) => {
		spawnSyncCollect(["git", "init", "-q"], { cwd });
		const transport = new LocalCommandTransport();
		const toolOptions = options(transport, nativeOperatingSystem);
		const write = createRunEnvironmentWriteToolDefinition(cwd, toolOptions);
		const read = createRunEnvironmentReadToolDefinition(cwd, toolOptions);
		const edit = createRunEnvironmentEditToolDefinition(cwd, toolOptions);
		const ls = createRunEnvironmentLsToolDefinition(cwd, toolOptions);

		await execute(write as never, { path: "src/nested/a.ts", content: "before\nsecond\n" });
		assert.equal(transport.commands.length, 1);
		assert.equal(readTextSync(join(cwd, "src", "nested", "a.ts"), "utf8"), "before\nsecond\n");

		const readResult = await execute(read as never, { path: "src/nested/a.ts" });
		assert.equal(transport.commands.length, 2);
		const header = /\[src\/nested\/a\.ts#[0-9A-F]{4}\]/u.exec(readResult.content[0]?.text ?? "")?.[0];
		assert.ok(header);

		await execute(edit as never, { input: `${header}\nreplace 1..1:\n+after` });
		assert.equal(transport.commands.length, 3);
		assert.equal(readTextSync(join(cwd, "src", "nested", "a.ts"), "utf8"), "after\nsecond\n");

		const lsResult = await execute(ls as never, { path: "src" });
		assert.equal(transport.commands.length, 4);
		assert.equal(lsResult.content[0]?.text, "nested/");
	});
});

test("each public remote read refreshes content with one command", async () => {
	const transport = new ScriptedTransport({ stdout: "F\0first\n" }, { stdout: "F\0second\n" });
	const read = createRunEnvironmentReadToolDefinition("/work", options(transport));

	const first = await execute(read as never, { path: "a.txt" });
	assert.equal(transport.commands.length, 1);
	const second = await execute(read as never, { path: "a.txt" });
	assert.equal(transport.commands.length, 2);
	assert.match(first.content[0]?.text ?? "", /first/u);
	assert.match(second.content[0]?.text ?? "", /second/u);
});

posixTest("remote read renders a directory tree from one command", async () => {
	await withFixture(async (cwd) => {
		makeDirectorySync(join(cwd, "src"));
		makeDirectorySync(join(cwd, "src", "nested"));
		writeTextSync(join(cwd, "README.md"), "readme");
		writeTextSync(join(cwd, "src", "a.ts"), "export {};");
		writeTextSync(join(cwd, "src", "nested", "too-deep.ts"), "export {};");
		const transport = new LocalCommandTransport();
		const read = createRunEnvironmentReadToolDefinition(cwd, options(transport, nativeOperatingSystem));

		const result = await execute(read as never, { path: "." });

		assert.equal(transport.commands.length, 1);
		assert.equal(result.details?.isDirectory, true);
		assert.match(result.content[0]?.text ?? "", /README\.md/u);
		assert.match(result.content[0]?.text ?? "", /src\//u);
		assert.match(result.content[0]?.text ?? "", /a\.ts/u);
		assert.doesNotMatch(result.content[0]?.text ?? "", /too-deep\.ts/u);
	});
});

posixTest("remote write preserves generated files through its one command", async () => {
	await withFixture(async (cwd) => {
		const filePath = join(cwd, "generated.ts");
		writeTextSync(filePath, "// @generated\nexport const old = true;\n");
		const transport = new LocalCommandTransport();
		const write = createRunEnvironmentWriteToolDefinition(cwd, options(transport, nativeOperatingSystem));

		await assert.rejects(execute(write as never, { path: "generated.ts", content: "replacement\n" }), /generated/u);

		assert.equal(transport.commands.length, 1);
		assert.equal(readTextSync(filePath, "utf8"), "// @generated\nexport const old = true;\n");
	});
});

posixTest("remote write makes a shebang executable through its one command", async () => {
	await withFixture(async (cwd) => {
		const transport = new LocalCommandTransport();
		const write = createRunEnvironmentWriteToolDefinition(cwd, options(transport, nativeOperatingSystem));

		const result = await execute(write as never, { path: "bin/tool", content: "#!/bin/sh\necho ok\n" });

		assert.equal(transport.commands.length, 1);
		assert.equal(spawnSyncCollect(["test", "-x", join(cwd, "bin", "tool")]).exitCode, 0);
		assert.equal(result.details?.madeExecutable, true);
	});
});

test("remote selector refusals never issue a command", async () => {
	const readTransport = new ScriptedTransport();
	const writeTransport = new ScriptedTransport();
	const editTransport = new ScriptedTransport();
	const read = createRunEnvironmentReadToolDefinition("/work", options(readTransport));
	const write = createRunEnvironmentWriteToolDefinition("/work", options(writeTransport));
	const edit = createRunEnvironmentEditToolDefinition("/work", options(editTransport));

	await assert.rejects(execute(read as never, { path: "fixture.zip:member.txt" }), /remote archive/u);
	await assert.rejects(execute(write as never, { path: "fixture.sqlite:rows", content: "data" }), /remote sqlite/u);
	await assert.rejects(
		execute(edit as never, { input: "[remote.ipynb#ABCD]\nreplace 1..1:\n+changed" }),
		/remote notebook/u,
	);

	assert.equal(readTransport.commands.length, 0);
	assert.equal(writeTransport.commands.length, 0);
	assert.equal(editTransport.commands.length, 0);
});

test("Windows agent metadata drives functional read, write, edit, and ls calls", async () => {
	const readTransport = new ScriptedTransport({ stdout: "F\0before\r\n" });
	const writeTransport = new ScriptedTransport();
	const editTransport = new ScriptedTransport({ stdout: "F\0before\r\n" }, {});
	const lsTransport = new ScriptedTransport({ stdout: "f\0a.ts\0d\0nested\0" });

	const readResult = await execute(
		createRunEnvironmentReadToolDefinition("C:\\work", options(readTransport, "windows")) as never,
		{ path: "a.txt" },
	);
	await execute(createRunEnvironmentWriteToolDefinition("C:\\work", options(writeTransport, "windows")) as never, {
		path: "nested\\a.txt",
		content: "after\r\n",
	});
	const editRead = createRunEnvironmentReadToolDefinition("C:\\work", options(editTransport, "windows"));
	const editSnapshot = await execute(editRead as never, { path: "nested\\a.txt" });
	const header = /\[nested\/a\.txt#[0-9A-F]{4}\]/u.exec(editSnapshot.content[0]?.text ?? "")?.[0];
	assert.ok(header);
	const edit = createRunEnvironmentEditToolDefinition("C:\\work", { transport: editTransport });
	await execute(edit as never, { input: `${header}\nreplace 1..1:\n+after` });
	const lsResult = await execute(
		createRunEnvironmentLsToolDefinition("C:\\work", options(lsTransport, "windows")) as never,
		{ path: "." },
	);

	assert.match(readResult.content[0]?.text ?? "", /before/u);
	assert.equal(lsResult.content[0]?.text, "a.ts\nnested/");
	assert.equal(readTransport.commands.length, 1);
	assert.equal(writeTransport.commands.length, 1);
	assert.equal(editTransport.commands.length, 2);
	assert.equal(lsTransport.commands.length, 1);
});

test("Windows edit preserves a UTF-8 BOM and CRLF through one remote command", async () => {
	await withFixture(async (cwd) => {
		makeDirectorySync(join(cwd, "src"));
		const filePath = join(cwd, "src", "bom-crlf.txt");
		const original = Buffer.from("\uFEFFbefore\r\nsecond\r\n", "utf8");
		writeTextSync(filePath, original);
		spawnSyncCollect(["git", "init", "-q"], { cwd });
		spawnSyncCollect(["git", "config", "core.autocrlf", "false"], { cwd });
		const transport = new WindowsEditTransport(cwd, original);
		const toolOptions = options(transport, "windows");
		const read = createRunEnvironmentReadToolDefinition("C:\\work", toolOptions);
		const edit = createRunEnvironmentEditToolDefinition("C:\\work", toolOptions);
		const readResult = await execute(read as never, { path: "src\\bom-crlf.txt" });
		const header = /\[src\/bom-crlf\.txt#[0-9A-F]{4}\]/u.exec(readResult.content[0]?.text ?? "")?.[0];
		assert.ok(header);
		transport.commands.length = 0;

		await execute(edit as never, { input: `${header}\nreplace 1..1:\n+after` });

		assert.equal(transport.commands.length, 1);
		assert.deepEqual(readTextSync(filePath), Buffer.from("\uFEFFafter\r\nsecond\r\n"));
	});
});

test("Windows edit preserves mixed endings and an unterminated final line with one remote command", async () => {
	for (const [name, original, line, expected] of [
		["crlf", "before\r\nsecond", 1, "after\r\nsecond"],
		["mixed", "before\r\nsecond\nthird", 2, "before\r\nafter\nthird"],
	] as const) {
		await withFixture(async (cwd) => {
			makeDirectorySync(join(cwd, "src"));
			const filePath = join(cwd, "src", `${name}.txt`);
			writeTextSync(filePath, original);
			spawnSyncCollect(["git", "init", "-q"], { cwd });
			spawnSyncCollect(["git", "config", "core.autocrlf", "false"], { cwd });
			const transport = new WindowsEditTransport(cwd, Buffer.from(original));
			const toolOptions = options(transport, "windows");
			const read = createRunEnvironmentReadToolDefinition("C:\\work", toolOptions);
			const edit = createRunEnvironmentEditToolDefinition("C:\\work", toolOptions);
			const readResult = await execute(read as never, { path: `src\\${name}.txt` });
			const header = new RegExp(`\\[src/${name}\\.txt#[0-9A-F]{4}\\]`, "u").exec(
				readResult.content[0]?.text ?? "",
			)?.[0];
			assert.ok(header);
			transport.commands.length = 0;

			await execute(edit as never, { input: `${header}\nreplace ${line}..${line}:\n+after` });

			assert.equal(transport.commands.length, 1);
			assert.equal(readTextSync(filePath, "utf8"), expected);
		});
	}
});

windowsTest("Windows read, write, edit, and ls operate on one checkout with one command per call", async () => {
	await withFixture(async (cwd) => {
		spawnSyncCollect(["git", "init", "-q"], { cwd });
		spawnSyncCollect(["git", "config", "core.autocrlf", "false"], { cwd });
		const transport = new LocalCommandTransport();
		const toolOptions = options(transport, "windows");
		const write = createRunEnvironmentWriteToolDefinition(cwd, toolOptions);
		const read = createRunEnvironmentReadToolDefinition(cwd, toolOptions);
		const edit = createRunEnvironmentEditToolDefinition(cwd, toolOptions);
		const ls = createRunEnvironmentLsToolDefinition(cwd, toolOptions);

		await execute(write as never, { path: "src\\nested\\crlf.txt", content: "before\r\nsecond\r\n" });
		assert.equal(transport.commands.length, 1);
		assert.equal(readTextSync(join(cwd, "src", "nested", "crlf.txt"), "utf8"), "before\r\nsecond\r\n");

		const readResult = await execute(read as never, { path: "src\\nested\\crlf.txt" });
		assert.equal(transport.commands.length, 2);
		assert.match(readResult.content[0]?.text ?? "", /before\r?$/mu);
		const header = /\[src\/nested\/crlf\.txt#[0-9A-F]{4}\]/u.exec(readResult.content[0]?.text ?? "")?.[0];
		assert.ok(header);

		await execute(edit as never, { input: `${header}\nreplace 1..1:\n+after` });
		assert.equal(transport.commands.length, 3);
		assert.equal(readTextSync(join(cwd, "src", "nested", "crlf.txt"), "utf8"), "after\r\nsecond\r\n");

		const lsResult = await execute(ls as never, { path: "src\\nested" });
		assert.equal(transport.commands.length, 4);
		assert.equal(lsResult.content[0]?.text, "crlf.txt");
	});
});
