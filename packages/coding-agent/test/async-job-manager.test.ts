import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../src/core/async/job-manager.ts";
import { createSessionAsyncDeliveryHandler, createSessionAsyncJobManager, disposeSessionAsyncJobManager } from "../src/core/async/session-manager.ts";
import type { AsyncJobDeliveryMessage } from "../src/core/async/types.ts";
import type { SendMessageOptions } from "../src/core/extensions/index.ts";
import { listManagedBashJobIds, type ManagedBashJob } from "../src/core/tools/bash-async-jobs.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

function requireJobId(value: string | undefined): string {
	if (!value) throw new Error("Expected async job id");
	return value;
}


interface CapturedCustomMessage {
	message: AsyncJobDeliveryMessage;
	options: SendMessageOptions | undefined;
}

function createCapturedSession(captured: CapturedCustomMessage[], options?: { isStreaming?: boolean }): {
	readonly isStreaming?: boolean;
	sendCustomMessage: (message: AsyncJobDeliveryMessage, options?: SendMessageOptions) => Promise<void>;
} {
	return {
		get isStreaming() { return options?.isStreaming; },
		sendCustomMessage: async (message, options) => {
			captured.push({ message, options });
		},
	};
}

afterEach(() => {
	AsyncJobManager.instance()?.dispose();
	AsyncJobManager.resetForTests();
});

describe("AsyncJobManager", () => {
	it("delivers bash completions through session sendCustomMessage as a follow-up turn", async () => {
		const captured: CapturedCustomMessage[] = [];
		const session = createCapturedSession(captured);
		const { manager } = createSessionAsyncJobManager(session);
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(session),
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("session done\n")); return { exitCode: 0 }; } },
		});

		await bash.execute("bash-session-async", { command: "echo session done", async: true });

		await waitFor(() => captured.length === 1);
		expect(captured[0]?.message.customType).toBe("async-job-result");
		expect(captured[0]?.message.display).toBe(true);
		expect(captured[0]?.message.content).toContain("session done");
		expect(captured[0]?.options).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
			stageAdmissionKey: `async-job:${captured[0]?.message.details.jobId}`,
		});
	});

	it("routes shared singleton jobs to the session that started each job", async () => {
		const ownerCaptured: CapturedCustomMessage[] = [];
		const laterCaptured: CapturedCustomMessage[] = [];
		const ownerSession = createCapturedSession(ownerCaptured);
		const laterSession = createCapturedSession(laterCaptured);
		const { manager, owns } = createSessionAsyncJobManager(ownerSession);
		const laterHandle = createSessionAsyncJobManager(laterSession);
		expect(owns).toBe(true);
		expect(laterHandle.manager).toBe(manager);
		expect(laterHandle.owns).toBe(false);
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: laterHandle.manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(laterSession),
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("later session\n")); return { exitCode: 0 }; } },
		});

		await bash.execute("bash-later-session", { command: "echo later session", async: true });

		await waitFor(() => laterCaptured.length === 1);
		expect(ownerCaptured).toHaveLength(0);
		expect(laterCaptured[0]?.message.content).toContain("later session");
	});


	it("keeps the shared manager alive when the owner disposes while a later session has an active job", async () => {
		const ownerCaptured: CapturedCustomMessage[] = [];
		const laterCaptured: CapturedCustomMessage[] = [];
		const ownerSession = createCapturedSession(ownerCaptured);
		const laterSession = createCapturedSession(laterCaptured);
		const ownerHandle = createSessionAsyncJobManager(ownerSession);
		const laterHandle = createSessionAsyncJobManager(laterSession);
		let releaseExec: (() => void) | undefined;
		const execFinished = new Promise<void>((resolve) => { releaseExec = resolve; });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: laterHandle.manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(laterSession, laterHandle.manager, laterHandle.sessionId),
			asyncJobSessionId: laterHandle.sessionId,
			operations: { exec: async (_command, _cwd, { onData }) => { await execFinished; onData(Buffer.from("later active\n")); return { exitCode: 0 }; } },
		});

		await bash.execute("bash-later-active", { command: "echo later active", async: true });
		disposeSessionAsyncJobManager(ownerHandle.manager, ownerHandle.sessionId);
		expect(laterHandle.manager.disposed).toBe(false);
		expect(AsyncJobManager.instance()).toBe(laterHandle.manager);
		releaseExec?.();

		await waitFor(() => laterCaptured.length === 1);
		expect(ownerCaptured).toHaveLength(0);
		expect(laterCaptured[0]?.message.content).toContain("later active");
		disposeSessionAsyncJobManager(laterHandle.manager, laterHandle.sessionId);
		expect(laterHandle.manager.disposed).toBe(true);
		expect(AsyncJobManager.instance()).toBeUndefined();
	});

	it("preserves a streaming delivery admitted before its session is disposed without blocking other sessions", async () => {
		const staleCaptured: CapturedCustomMessage[] = [];
		const liveCaptured: CapturedCustomMessage[] = [];
		const ownerSession = createCapturedSession([]);
		const staleSession = createCapturedSession(staleCaptured, { isStreaming: true });
		const liveSession = createCapturedSession(liveCaptured);
		const ownerHandle = createSessionAsyncJobManager(ownerSession);
		const staleHandle = createSessionAsyncJobManager(staleSession);
		const liveHandle = createSessionAsyncJobManager(liveSession);
		const makeBash = (textValue: string, handle: typeof staleHandle, session: typeof staleSession) => createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: handle.manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(session, handle.manager, handle.sessionId),
			asyncJobSessionId: handle.sessionId,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from(`${textValue}\n`)); return { exitCode: 0 }; } },
		});

		await makeBash("stale", staleHandle, staleSession).execute("bash-stale", { command: "echo stale", async: true });
		await waitFor(() => staleCaptured.length === 1);
		disposeSessionAsyncJobManager(staleHandle.manager, staleHandle.sessionId);
		await waitFor(() => staleHandle.manager.deliveryState().delivering === false);
		await makeBash("live", liveHandle, liveSession).execute("bash-live", { command: "echo live", async: true });

		await waitFor(() => liveCaptured.length === 1);
		expect(staleCaptured[0]?.message.content).toContain("stale");
		expect(liveCaptured[0]?.message.content).toContain("live");
		expect(ownerHandle.manager.disposed).toBe(false);
		disposeSessionAsyncJobManager(ownerHandle.manager, ownerHandle.sessionId);
		disposeSessionAsyncJobManager(liveHandle.manager, liveHandle.sessionId);
		await waitFor(() => ownerHandle.manager.disposed);
	});

	it("does not let one live streaming session block unrelated async delivery", async () => {
		const streamingCaptured: CapturedCustomMessage[] = [];
		const liveCaptured: CapturedCustomMessage[] = [];
		const ownerSession = createCapturedSession([]);
		const streamingSession = createCapturedSession(streamingCaptured, { isStreaming: true });
		const liveSession = createCapturedSession(liveCaptured);
		const ownerHandle = createSessionAsyncJobManager(ownerSession);
		const streamingHandle = createSessionAsyncJobManager(streamingSession);
		const liveHandle = createSessionAsyncJobManager(liveSession);
		const makeBash = (textValue: string, handle: typeof streamingHandle, session: typeof streamingSession) => createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: handle.manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(session, handle.manager, handle.sessionId),
			asyncJobSessionId: handle.sessionId,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from(`${textValue}\n`)); return { exitCode: 0 }; } },
		});

		await makeBash("streaming blocks", streamingHandle, streamingSession).execute("bash-streaming-blocker", { command: "echo streaming blocks", async: true });
		await waitFor(() => streamingCaptured.length === 1);
		await makeBash("live proceeds", liveHandle, liveSession).execute("bash-live-proceeds", { command: "echo live proceeds", async: true });

		await waitFor(() => liveCaptured.length === 1);
		expect(streamingCaptured[0]?.message.content).toContain("streaming blocks");
		expect(liveCaptured[0]?.message.content).toContain("live proceeds");
		disposeSessionAsyncJobManager(streamingHandle.manager, streamingHandle.sessionId);
		disposeSessionAsyncJobManager(liveHandle.manager, liveHandle.sessionId);
		disposeSessionAsyncJobManager(ownerHandle.manager, ownerHandle.sessionId);
	});

	it("keeps disposed running job suppression until completion so fallback delivery cannot occur", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); }, completedJobTtlMs: 20 });
		const ownerSessionId = manager.registerSession();
		const disposedSessionId = manager.registerSession();
		const disposedSession = createCapturedSession([]);
		let releaseExec: (() => void) | undefined;
		const execFinished = new Promise<void>((resolve) => { releaseExec = resolve; });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(disposedSession, manager, disposedSessionId),
			asyncJobSessionId: disposedSessionId,
			operations: { exec: async (_command, _cwd, { onData }) => { await execFinished; onData(Buffer.from("disposed complete\n")); return { exitCode: 0 }; } },
		});

		const started = await bash.execute("bash-disposed-running", { command: "echo disposed complete", async: true });
		const jobId = requireJobId(started.details?.async?.jobId);
		manager.releaseSession(disposedSessionId);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		releaseExec?.();
		await waitFor(async () => text(await bash.execute("bash-disposed-poll", { command: `__atomic_bash_job ${jobId}` })).includes("disposed complete"));
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(delivered).toHaveLength(0);
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		manager.releaseSession(ownerSessionId);
	});

	it("delivers completed bash jobs as async-job-result custom messages", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("done\n")); return { exitCode: 0 }; } },
		});
		const started = await bash.execute("bash-async", { command: "echo done", async: true });
		expect(started.details?.async?.status).toBe("running");
		await waitFor(() => delivered.length === 1);
		expect(delivered[0]?.customType).toBe("async-job-result");
		expect(delivered[0]?.display).toBe(true);
		expect(delivered[0]?.content).toContain("Async bash job");
		expect(delivered[0]?.content).toContain("done");
		expect(delivered[0]?.details.status).toBe("completed");
		manager.dispose();
	});

	it("polling after receipt does not duplicate an admitted delivery", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		let releaseExec: (() => void) | undefined;
		const execFinished = new Promise<void>((resolve) => { releaseExec = resolve; });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { onData }) => { await execFinished; onData(Buffer.from("polled\n")); return { exitCode: 0 }; } },
		});
		const started = await bash.execute("bash-async", { command: "echo polled", async: true });
		const jobId = requireJobId(started.details?.async?.jobId);
		releaseExec?.();
		await waitFor(() => delivered.length === 1);
		const polled = await bash.execute("bash-poll", { command: `__atomic_bash_job ${jobId}` });
		expect(text(polled)).toContain("polled");
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(delivered).toHaveLength(1);
		manager.dispose();
	});

	it("polling cannot retract a streaming delivery admitted at receipt", async () => {
		const captured: CapturedCustomMessage[] = [];
		const session = createCapturedSession(captured, { isStreaming: true });
		const manager = new AsyncJobManager({ onJobComplete: createSessionAsyncDeliveryHandler(session) });
		const handler = createSessionAsyncDeliveryHandler(session, manager);
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			asyncJobDeliveryHandler: handler,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("queued then polled\n")); return { exitCode: 0 }; } },
		});
		const started = await bash.execute("bash-stream-stale", { command: "echo queued then polled", async: true });
		const jobId = requireJobId(started.details?.async?.jobId);
		await waitFor(() => captured.length === 1);
		const polled = await bash.execute("bash-poll", { command: `__atomic_bash_job ${jobId}` });
		expect(text(polled)).toContain("queued then polled");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(captured).toHaveLength(1);
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		manager.dispose();
	});

	it("a delivery admitted before manager disposal still settles exactly once", async () => {
		const captured: CapturedCustomMessage[] = [];
		const session = createCapturedSession(captured, { isStreaming: true });
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const handler = createSessionAsyncDeliveryHandler(session, manager);
		const message: AsyncJobDeliveryMessage = {
			customType: "async-job-result",
			content: "Async bash job job-disposed completed: echo disposed\n\ndisposed",
			display: true,
			details: { jobId: "job-disposed", type: "bash", status: "completed", command: "echo disposed", exitCode: 0 },
		};
		let settled = false;
		const delivery = Promise.resolve(handler(message)).then(() => { settled = true; });

		manager.dispose();
		await Promise.race([
			delivery,
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("delivery wait did not settle after dispose")), 100)),
		]);

		expect(settled).toBe(true);
		expect(manager.disposed).toBe(true);
		expect(captured).toHaveLength(1);
	});
	it("retries delivery failures", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: (message) => {
				attempts += 1;
				if (attempts === 1) throw new Error("temporary failure");
				delivered.push(message);
			},
		});
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("retry\n")); return { exitCode: 0 }; } },
		});
		await bash.execute("bash-async", { command: "echo retry", async: true });
		await waitFor(() => delivered.length === 1, 1_500);
		expect(attempts).toBe(2);
		manager.dispose();
	});

	it("enforces the running job bound", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined, maxRunningJobs: 1 });
		let releaseExec: (() => void) | undefined;
		const execFinished = new Promise<void>((resolve) => { releaseExec = resolve; });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async () => { await execFinished; return { exitCode: 0 }; } },
		});
		await bash.execute("bash-async-1", { command: "sleep", async: true });
		await expect(bash.execute("bash-async-2", { command: "sleep", async: true })).rejects.toThrow(/Background job limit reached/);
		releaseExec?.();
		manager.dispose();
	});

	it("discards the managed job when async registration fails on a disposed manager/session", async () => {
		const captured: CapturedCustomMessage[] = [];
		const session = createCapturedSession(captured);
		const handle = createSessionAsyncJobManager(session);
		let execStarted = false;
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: handle.manager,
			asyncJobDeliveryHandler: createSessionAsyncDeliveryHandler(session, handle.manager, handle.sessionId),
			asyncJobSessionId: handle.sessionId,
			operations: { exec: async () => { execStarted = true; return { exitCode: 0 }; } },
		});
		disposeSessionAsyncJobManager(handle.manager, handle.sessionId);
		const before = listManagedBashJobIds();
		await expect(bash.execute("bash-zombie", { command: "echo zombie", async: true })).rejects.toThrow(/disposed/);
		const leaked = listManagedBashJobIds().filter((jobId) => !before.includes(jobId));
		expect(leaked).toEqual([]);
		expect(execStarted).toBe(false);
	});

	it("suppresses auto-delivery after explicit async bash cancellation while preserving pollability", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { signal }) => new Promise<{ exitCode: number | null }>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}) },
		});
		const started = await bash.execute("bash-cancel-start", { command: "sleep", async: true });
		const jobId = requireJobId(started.details?.async?.jobId);
		await bash.execute("bash-cancel", { command: `__atomic_bash_job_cancel ${jobId}` });
		await waitFor(async () => text(await bash.execute("bash-poll", { command: `__atomic_bash_job ${jobId}` })).includes("failed"));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(delivered).toHaveLength(0);
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		manager.dispose();
	});

	it("suppresses auto-delivery when the parent tool signal aborts an async bash job", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		const controller = new AbortController();
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { signal }) => new Promise<{ exitCode: number | null }>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}) },
		});
		const started = await bash.execute("bash-parent-abort", { command: "sleep", async: true }, controller.signal);
		const jobId = requireJobId(started.details?.async?.jobId);
		controller.abort();
		await waitFor(async () => text(await bash.execute("bash-poll", { command: `__atomic_bash_job ${jobId}` })).includes("failed"));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(delivered).toHaveLength(0);
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		manager.dispose();
	});

	it("bounds retained jobs, suppressions, handlers, and queued deliveries", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined, maxRetainedJobs: 2, completedJobTtlMs: 60_000 });
		const now = Date.now();
		for (let index = 0; index < 4; index += 1) {
			const job: ManagedBashJob = { jobId: `job-${index}`, command: "echo", cwd: process.cwd(), status: "completed", output: `${index}`, startedAt: now + index, endedAt: now + index + 1 };
			manager.registerBashJob(job, () => undefined);
			manager.completeBashJob(job);
			manager.acknowledgeDeliveries([job.jobId]);
		}
		await waitFor(() => manager.retentionState().queued === 0);
		expect(manager.retentionState()).toEqual({ jobs: 2, suppressions: 2, handlers: 0, queued: 0, sessions: 0 });
		manager.dispose();
	});

	it("keeps just-under-threshold async follow-up output inline when formatted text exceeds preview limit", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		const output = "y".repeat(11_980);
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from(output)); return { exitCode: 0 }; } },
		});

		await bash.execute("bash-boundary", { command: "boundary", async: true });
		await waitFor(() => delivered.length === 1);
		expect(delivered[0]?.details.fullOutputPath).toBeUndefined();
		expect(delivered[0]?.content).toContain(output);
		expect(delivered[0]?.content).not.toContain("Output truncated for async follow-up");
		expect(delivered[0]?.content.length).toBeGreaterThan(12_000);
		manager.dispose();
	});

	it("persists full output for 12KB-50KB async follow-up truncation without changing poll output", async () => {
		const delivered: AsyncJobDeliveryMessage[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (message) => { delivered.push(message); } });
		const output = "x".repeat(20_000);
		const bash = createBashToolDefinition(process.cwd(), {
			asyncEnabled: true,
			asyncJobManager: manager,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from(output)); return { exitCode: 0 }; } },
		});
		const started = await bash.execute("bash-large", { command: "large", async: true });
		const jobId = requireJobId(started.details?.async?.jobId);
		await waitFor(() => delivered.length === 1);
		const path = delivered[0]?.details.fullOutputPath;
		expect(path).toBeDefined();
		expect(path && existsSync(path)).toBe(true);
		expect(path ? readFileSync(path, "utf8") : "").toHaveLength(output.length);
		expect(delivered[0]?.content).toContain("Output truncated for async follow-up");
		expect(delivered[0]?.content).toContain(`Full output: ${path}`);
		expect(delivered[0]?.content.length).toBeLessThan(output.length);
		const polled = await bash.execute("bash-large-poll", { command: `__atomic_bash_job ${jobId}` });
		expect(text(polled)).toContain(output);
		manager.dispose();
	});
});
