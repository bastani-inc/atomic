import { isAbsolute, join } from "node:path";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "./runtime.js";

const REQUEST_TIMEOUT_MS = 30_000;

export class WorkflowProcess {
	private readonly child: SpawnedProcess;
	private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
	private readonly output: Promise<void>;
	private readonly errors: Promise<string>;
	private sequence = 0;
	private transportError: Error | undefined;
	private exited = false;

	constructor(home: string, extra: Record<string, string>, fixture: string) {
		const path = isAbsolute(fixture) ? fixture : join(moduleDir(import.meta.url), "../fixtures", fixture);
		this.child = spawnProcess([bunExecutable(), path], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				ATOMIC_FAULT_TEST_HOME: home,
				ATOMIC_WORKFLOW_JOURNAL_PATH: join(home, "journal.sqlite"),
				...extra,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child.stdin!.on("error", (error: Error) => this.fail(error));
		this.errors = new Response(this.child.stderr).text();
		this.output = this.drain();
	}

	private fail(error: Error): void {
		this.transportError ??= error;
		for (const request of this.pending.values()) request.reject(this.transportError);
	}

	private async drain(): Promise<void> {
		const reader = decodeStream(this.child.stdout!).getReader();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('{"id":')) continue;
					const message = JSON.parse(line) as { id: number; result: never; error?: string };
					const request = this.pending.get(message.id);
					if (message.error) request?.reject(new Error(message.error));
					else request?.resolve(message.result);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		} finally {
			reader.releaseLock();
			this.fail(new Error("Workflow fixture output closed"));
		}
	}

	async request<T = object>(command: string, value?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.transportError) throw this.transportError;
		const id = ++this.sequence;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<T>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				timer = setTimeout(() => reject(new Error(`Workflow fixture ${command} timed out`)), timeoutMs);
				this.child.stdin!.write(`${JSON.stringify({ id, command, sql: value })}\n`, (error) => {
					if (error) this.fail(error);
				});
			});
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}

	async waitForExit(): Promise<void> {
		await Promise.all([this.child.exited, this.output, this.errors]);
		this.exited = true;
	}

	async crash(): Promise<void> {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
		await this.waitForExit();
	}

	async exit(): Promise<void> {
		if (this.exited) return;
		try {
			if (this.child.exitCode === null && this.transportError === undefined) await this.request("exit");
		} finally {
			if (this.child.exitCode === null) this.child.kill("SIGKILL");
			await this.waitForExit();
		}
	}
}

export class WorkflowProcessHome {
	readonly path = makeTempDirectory("atomic-workflow-process-");
	private readonly clients: WorkflowProcess[] = [];

	client(extra: Record<string, string>, fixture: string): WorkflowProcess {
		const client = new WorkflowProcess(this.path, extra, fixture);
		this.clients.push(client);
		return client;
	}

	async cleanup(): Promise<void> {
		try {
			await Promise.all(this.clients.map((client) => client.exit()));
		} finally {
			removeTempDirectory(this.path);
		}
	}
}
