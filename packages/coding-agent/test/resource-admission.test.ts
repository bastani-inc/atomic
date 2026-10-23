import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSession, withResourceAdmission } from "../src/core/sdk.js";
import type {
	CreateAgentSessionOptions,
	ResourceAdmission,
	ResourceAdmissionRequest,
	ResourcePermit,
	ResourceProcessIdentity,
} from "../src/core/sdk-types.js";
import { ownedSessionManagerStores } from "../src/core/session-lifecycle-work.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import type { OperationId } from "../src/core/tasks/contracts.js";
import type { TaskSupervisor } from "../src/core/tasks/supervisor.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { createTestResourceLoader } from "./utilities.js";

type Kind = "session" | "process";

function groupAlive(identity: ResourceProcessIdentity): boolean {
	try {
		process.kill(-identity.id, 0);
		return true;
	} catch {
		return false;
	}
}

class FakeAdmission implements ResourceAdmission {
	readonly held: Record<Kind, number> = { session: 0, process: 0 };
	readonly releaseCalls: Kind[] = [];
	readonly acquired: Kind[] = [];
	readonly requests: Array<ResourceAdmissionRequest | undefined> = [];
	readonly bound: ResourceProcessIdentity[] = [];
	readonly aliveAtRelease: boolean[] = [];
	bindFailure: Error | undefined;
	private readonly waiters: Array<{ kind: Kind; grant: () => void }> = [];
	constructor(private readonly caps: Partial<Record<Kind, number>> = {}) {}
	acquire(kind: Kind, signal?: AbortSignal, request?: ResourceAdmissionRequest): Promise<ResourcePermit> {
		this.requests.push(request);
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (request?.delegated && this.held[kind] >= (this.caps[kind] ?? Number.POSITIVE_INFINITY))
			return Promise.reject(new Error(`no ${kind} headroom for a delegated launch`));
		return new Promise((resolve, reject) => {
			const grant = () => {
				this.held[kind]++;
				this.acquired.push(kind);
				let released = false;
				let identity: ResourceProcessIdentity | undefined;
				const permit: ResourcePermit = async () => {
					this.releaseCalls.push(kind);
					if (released) return;
					released = true;
					if (identity) this.aliveAtRelease.push(groupAlive(identity));
					this.held[kind]--;
					this.drain();
				};
				permit.bindProcess = async (bound) => {
					identity = bound;
					if (this.bindFailure) throw this.bindFailure;
					this.bound.push(bound);
				};
				resolve(permit);
			};
			const waiter = { kind, grant };
			if (this.held[kind] < (this.caps[kind] ?? Number.POSITIVE_INFINITY)) grant();
			else {
				this.waiters.push(waiter);
				signal?.addEventListener(
					"abort",
					() => {
						const index = this.waiters.indexOf(waiter);
						if (index < 0) return;
						this.waiters.splice(index, 1);
						reject(signal.reason);
					},
					{ once: true },
				);
			}
		});
	}
	private drain(): void {
		for (const waiter of [...this.waiters]) {
			if (this.held[waiter.kind] >= (this.caps[waiter.kind] ?? Number.POSITIVE_INFINITY)) continue;
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.grant();
		}
	}
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-resource-admission-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function sessionOptions(root: string, options: CreateAgentSessionOptions = {}): CreateAgentSessionOptions {
	return {
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ bashInterceptor: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash"],
		...options,
	};
}

async function open(root: string, options: CreateAgentSessionOptions = {}): Promise<AgentSession> {
	const { session } = await createAgentSession(sessionOptions(root, options));
	session.pauseQueuedMessages();
	cleanups.push(() => session.dispose());
	return session;
}

const holdCommand = process.platform === "win32" ? "$null = [Console]::ReadLine()" : "read value";

test("a session holds one session permit from creation until confirmed disposal (#3869)", async () => {
	const admission = new FakeAdmission();
	const session = await open(tempRoot(), { resourceAdmission: admission });
	assert.deepEqual(admission.acquired, ["session"]);
	assert.equal(admission.held.session, 1);

	await session.dispose();
	await session.dispose();

	assert.equal(admission.held.session, 0);
	assert.deepEqual(admission.releaseCalls, ["session"], "disposal releases exactly once");
});

test("a failed session startup releases its permit after rollback (#3869)", async () => {
	const admission = new FakeAdmission();
	const root = tempRoot();
	const loader = createTestResourceLoader();
	loader.getExtensions = () => {
		throw new Error("extension discovery failed");
	};

	await assert.rejects(
		createAgentSession(sessionOptions(root, { resourceAdmission: admission, resourceLoader: loader })),
		/extension discovery failed/,
	);

	assert.deepEqual(admission.acquired, ["session"]);
	assert.equal(admission.held.session, 0);
	assert.deepEqual(admission.releaseCalls, ["session"]);
});

test("a cancelled session waiter never creates a session or leaks a permit (#3869)", async () => {
	const admission = new FakeAdmission({ session: 1 });
	const root = tempRoot();
	const first = await open(root, { resourceAdmission: admission });
	const controller = new AbortController();

	const waiting = createAgentSession(
		sessionOptions(root, { resourceAdmission: admission, resourceAdmissionSignal: controller.signal }),
	);
	controller.abort(new Error("waiter cancelled"));
	await assert.rejects(waiting, /waiter cancelled/);

	assert.equal(admission.held.session, 1);
	await first.dispose();
	assert.equal(admission.held.session, 0);
	assert.deepEqual(admission.acquired, ["session"], "the cancelled waiter was never granted a permit");
});

test("delegated child sessions and their commands draw on the parent's admission (#3869)", async () => {
	const admission = new FakeAdmission({ session: 2 });
	const root = tempRoot();
	const parent = await open(root, { resourceAdmission: admission });

	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	assert.equal(inherited.resourceAdmission, admission);
	assert.equal(inherited.resourceAdmissionSignal, undefined, "a creation signal is never inherited");

	const child = await open(root, { ...inherited, sessionManager: SessionManager.inMemory(root) });
	assert.equal(admission.held.session, 2);
	assert.deepEqual(admission.requests, [undefined, { delegated: true }]);

	await child.dispose();
	assert.equal(admission.held.session, 1);
});

const NO_HEADROOM = /no session headroom for a delegated launch/;

function delegatedOptions(parent: AgentSession, root: string): CreateAgentSessionOptions {
	return {
		...parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root }),
		sessionManager: SessionManager.inMemory(root),
		// Without a rejection the launch would wait on its parent forever; bound the red run.
		resourceAdmissionSignal: AbortSignal.timeout(500),
	};
}

test("a delegated child is rejected instead of waiting on the single permit its parent holds (#3869)", async () => {
	const admission = new FakeAdmission({ session: 1 });
	const root = tempRoot();
	const parent = await open(root, { resourceAdmission: admission });

	await assert.rejects(createAgentSession(sessionOptions(root, delegatedOptions(parent, root))), NO_HEADROOM);

	assert.deepEqual(admission.requests, [undefined, { delegated: true }]);
	assert.equal(admission.held.session, 1, "the cap is never exceeded");
	assert.deepEqual(admission.acquired, ["session"]);
});

test("delegated children are rejected when parents hold every permit of a larger cap (#3869)", async () => {
	const admission = new FakeAdmission({ session: 2 });
	const root = tempRoot();
	const first = await open(root, { resourceAdmission: admission });
	await open(root, { resourceAdmission: admission });

	await assert.rejects(createAgentSession(sessionOptions(root, delegatedOptions(first, root))), NO_HEADROOM);
	assert.equal(admission.held.session, 2, "the cap is never exceeded");

	const direct = createAgentSession(
		sessionOptions(root, { resourceAdmission: admission, resourceAdmissionSignal: AbortSignal.timeout(100) }),
	);
	await assert.rejects(direct, (error: Error) => !NO_HEADROOM.test(error.message));
	assert.equal(admission.requests.at(-1), undefined, "an independent launch keeps waiting for capacity");
});

test("a background command keeps its process permit until native cleanup reaps it (#3869)", async () => {
	const admission = new FakeAdmission();
	const session = await open(tempRoot(), { resourceAdmission: admission });
	const bash = session.agent.state.tools.find((item) => item.name === "bash")!;

	const launched = await bash.execute("launch", {
		command: `${holdCommand}; exit 0`,
		wait: { kind: "background" },
		timeout: 30,
	});
	const observation = (launched.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	assert.equal(admission.held.process, 1, "yielding the observation wait keeps the process permit");

	const host = session.getAgentTaskHost();
	const task = host.resolveTask(observation.taskId);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("go\n"),
	});

	await vi.waitFor(() => assert.equal(admission.held.process, 0), { timeout: 10000 });
	assert.deepEqual(
		admission.releaseCalls.filter((kind) => kind === "process"),
		["process"],
	);
});

test("closing the owner releases a still-running command's permit once its process is reaped (#3869)", async () => {
	const admission = new FakeAdmission();
	const session = await open(tempRoot(), { resourceAdmission: admission });
	const bash = session.agent.state.tools.find((item) => item.name === "bash")!;
	await bash.execute("launch", { command: `${holdCommand}; exit 0`, wait: { kind: "background" }, timeout: 30 });
	assert.equal(admission.held.process, 1);

	await session.dispose();

	assert.equal(admission.held.process, 0);
	assert.equal(admission.held.session, 0);
	assert.deepEqual(
		admission.releaseCalls.filter((kind) => kind === "process"),
		["process"],
	);
});

test.skipIf(process.platform === "win32")(
	"a command's permit is bound to its process group before the launch returns (#3869)",
	async () => {
		const admission = new FakeAdmission();
		const session = await open(tempRoot(), { resourceAdmission: admission });
		const bash = session.agent.state.tools.find((item) => item.name === "bash")!;

		await bash.execute("launch", { command: `${holdCommand}; exit 0`, wait: { kind: "background" }, timeout: 30 });

		assert.equal(admission.bound.length, 1);
		const [identity] = admission.bound;
		assert.equal(identity!.kind, "unix-process-group");
		assert.ok(Number.isSafeInteger(identity!.id) && identity!.id > 0);
		assert.ok(groupAlive(identity!), "the identity names the live command group");
		assert.equal(admission.held.process, 1);

		await session.dispose();
		assert.deepEqual(admission.aliveAtRelease, [false], "release follows confirmed group cleanup");
		assert.equal(admission.held.process, 0);
	},
);

test.skipIf(process.platform === "win32")(
	"a failed process binding cancels the command and releases only after its group is gone (#3869)",
	async () => {
		const admission = new FakeAdmission();
		admission.bindFailure = new Error("binding unavailable");
		const root = tempRoot();
		const session = await open(root, { resourceAdmission: admission });
		const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;

		await assert.rejects(
			supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: `${holdCommand}; exit 0`,
					description: "unbound",
					cwd: root,
					env: {},
					terminal: { kind: "pipe" },
				},
				crypto.randomUUID() as OperationId,
			),
			/binding unavailable/,
		);

		await vi.waitFor(() => assert.equal(admission.held.process, 0), { timeout: 10000 });
		assert.deepEqual(admission.aliveAtRelease, [false]);
		assert.deepEqual(
			admission.releaseCalls.filter((kind) => kind === "process"),
			["process"],
		);
	},
);

test("a command that fails to spawn releases its permit immediately (#3869)", async () => {
	const admission = new FakeAdmission();
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;

	const started = await supervisor.startCommandTask(
		owner,
		{
			kind: "command",
			command: "exit 0",
			description: "missing cwd",
			cwd: join(root, "does-not-exist"),
			env: {},
			terminal: { kind: "pipe" },
		},
		crypto.randomUUID() as OperationId,
	);

	assert.equal(started.ok, false);
	assert.deepEqual(
		admission.acquired.filter((kind) => kind === "process"),
		["process"],
	);
	assert.equal(admission.held.process, 0);
	assert.deepEqual(
		admission.releaseCalls.filter((kind) => kind === "process"),
		["process"],
	);
});

test("a cancelled process waiter never launches a command (#3869)", async () => {
	const admission = new FakeAdmission({ process: 1 });
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const bash = session.agent.state.tools.find((item) => item.name === "bash")!;
	await bash.execute("hold", { command: `${holdCommand}; exit 0`, wait: { kind: "background" }, timeout: 30 });

	const controller = new AbortController();
	const waiting = bash.execute(
		"queued",
		{ command: `echo ran > ${JSON.stringify(join(root, "ran"))}`, wait: { kind: "background" }, timeout: 30 },
		controller.signal,
	);
	controller.abort();
	await assert.rejects(waiting);

	assert.equal(admission.held.process, 1);
	assert.deepEqual(
		admission.acquired.filter((kind) => kind === "process"),
		["process"],
	);
});

test("an execution-scoped admission gates commands on a host owner with no binding, without bleeding across scopes (#3869)", async () => {
	const root = tempRoot();
	const session = await open(root);
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const launch = () =>
		supervisor.startCommandTask(
			owner,
			{
				kind: "command",
				command: `${holdCommand}; exit 0`,
				description: "scoped",
				cwd: root,
				env: {},
				terminal: { kind: "pipe" },
			},
			crypto.randomUUID() as OperationId,
		);
	const first = new FakeAdmission();
	const second = new FakeAdmission();

	const [a, b] = await Promise.all([
		withResourceAdmission(first, launch),
		withResourceAdmission(second, async () => {
			await Promise.resolve();
			return launch();
		}),
	]);
	assert.ok(a.ok && b.ok);
	assert.deepEqual([first.held.process, second.held.process], [1, 1]);

	const unscoped = await launch();
	assert.ok(unscoped.ok);
	assert.deepEqual([first.acquired, second.acquired], [["process"], ["process"]]);

	const nested = new FakeAdmission();
	const created = await withResourceAdmission(nested, () => open(root));
	assert.deepEqual(nested.acquired, ["session"], "a session created inside the scope draws on it");
	await created.dispose();
	assert.equal(nested.held.session, 0);
});

test("a failing process-permit release fails session teardown instead of being swallowed (#3869)", async () => {
	const admission = new FakeAdmission();
	const acquire = admission.acquire.bind(admission);
	admission.acquire = async (kind, signal) => {
		const release = await acquire(kind, signal);
		return kind === "process"
			? async () => {
					await release();
					throw new Error("accounting store unavailable");
				}
			: release;
	};
	const { session } = await createAgentSession(sessionOptions(tempRoot(), { resourceAdmission: admission }));
	session.pauseQueuedMessages();
	const bash = session.agent.state.tools.find((item) => item.name === "bash")!;
	await bash.execute("launch", { command: `${holdCommand}; exit 0`, wait: { kind: "background" }, timeout: 30 });

	await assert.rejects(session.dispose(), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		const [tasks] = error.errors as Error[];
		assert.ok(tasks);
		assert.equal(tasks.message, "tasks");
		assert.match((tasks.cause as Error).message, /accounting store unavailable/);
		return true;
	});
	assert.equal(admission.held.session, 1, "the session permit stays held when teardown could not be proven");
	assert.equal(admission.held.process, 0);
});

function holdIntent(root: string, description: string): Parameters<TaskSupervisor["startCommandTask"]>[1] {
	return {
		kind: "command",
		command: `${holdCommand}; exit 0`,
		description,
		cwd: root,
		env: {},
		terminal: { kind: "pipe" },
	};
}

test("a repeated command operation returns the same task without a second permit, pending or completed (#3869)", async () => {
	const admission = new FakeAdmission({ process: 1 });
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const operation = crypto.randomUUID() as OperationId;

	const [first, concurrent] = await Promise.all([
		supervisor.startCommandTask(owner, holdIntent(root, "same"), operation),
		supervisor.startCommandTask(owner, holdIntent(root, "same"), operation),
	]);
	assert.ok(first.ok && concurrent.ok);
	assert.equal(concurrent.value, first.value);

	const completed = await supervisor.startCommandTask(owner, holdIntent(root, "same"), operation);
	assert.ok(completed.ok);
	assert.equal(completed.value, first.value);
	assert.deepEqual(admission.acquired, ["session", "process"]);
	assert.equal(admission.held.process, 1);
});

test("a repeated command operation with a different payload conflicts without taking a permit (#3869)", async () => {
	const admission = new FakeAdmission({ process: 1 });
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const operation = crypto.randomUUID() as OperationId;

	const [first, conflicting] = await Promise.all([
		supervisor.startCommandTask(owner, holdIntent(root, "original"), operation),
		supervisor.startCommandTask(owner, holdIntent(root, "changed"), operation),
	]);

	assert.ok(first.ok);
	assert.ok(!conflicting.ok);
	assert.equal(conflicting.error.code, "OperationConflict");
	assert.deepEqual(admission.acquired, ["session", "process"]);
});

test("a command reaped before its permit is registered still releases the permit (#3869)", async () => {
	const admission = new FakeAdmission();
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const binding = createRequire(import.meta.url)(
		"@bastani/atomic-natives",
	) as typeof import("@bastani/atomic-natives");
	const original = binding.TaskSupervisor.prototype.startCommandTask;
	const spy = vi.spyOn(binding.TaskSupervisor.prototype, "startCommandTask").mockImplementation(async function (
		this: unknown,
		...args: Parameters<typeof original>
	) {
		const lease = await original.apply(this as never, args);
		const watched = supervisor.watchOwnerTasks(owner);
		assert.ok(watched.ok);
		await vi.waitFor(
			() => {
				watched.value.drain();
				assert.ok(watched.value.snapshot.tasks.some((task) => task.cleanup.kind === "reaped"));
			},
			{ timeout: 10000 },
		);
		watched.value.dispose();
		await new Promise((resolve) => setTimeout(resolve, 200));
		return lease;
	});
	cleanups.push(() => spy.mockRestore());

	const started = await supervisor.startCommandTask(
		owner,
		{ ...holdIntent(root, "fast"), command: "exit 0" },
		crypto.randomUUID() as OperationId,
	);

	assert.ok(started.ok);
	await vi.waitFor(() => assert.equal(admission.held.process, 0), { timeout: 5000 });
	assert.deepEqual(
		admission.releaseCalls.filter((kind) => kind === "process"),
		["process"],
	);
});

test.each(["cleanup", "transport"])(
	"a native launch with unconfirmed %s keeps the process permit held (#3869)",
	async (failure) => {
		const admission = new FakeAdmission();
		const root = tempRoot();
		const session = await open(root, { resourceAdmission: admission });
		const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
		const binding = createRequire(import.meta.url)(
			"@bastani/atomic-natives",
		) as typeof import("@bastani/atomic-natives");
		const spy = vi.spyOn(binding.TaskSupervisor.prototype, "startCommandTask").mockImplementation(async () => {
			if (failure === "transport") throw new Error("lost launch response");
			return { ok: false, error: { code: "CleanupFailed", message: "group not confirmed gone" } };
		});
		cleanups.push(() => spy.mockRestore());

		await assert.rejects(
			supervisor.startCommandTask(owner, holdIntent(root, "unconfirmed"), crypto.randomUUID() as OperationId),
			failure === "transport"
				? /lost launch response/
				: /cleanup unconfirmed.*CleanupFailed: group not confirmed gone/,
		);

		assert.equal(admission.held.process, 1, "an unconfirmed cleanup keeps the capacity charged");
		assert.deepEqual(
			admission.releaseCalls.filter((kind) => kind === "process"),
			[],
		);
	},
);

test("a native launch that fails to spawn still releases the process permit (#3869)", async () => {
	const admission = new FakeAdmission();
	const root = tempRoot();
	const session = await open(root, { resourceAdmission: admission });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const binding = createRequire(import.meta.url)(
		"@bastani/atomic-natives",
	) as typeof import("@bastani/atomic-natives");
	const spy = vi
		.spyOn(binding.TaskSupervisor.prototype, "startCommandTask")
		.mockResolvedValue({ ok: false, error: { code: "SpawnFailed", message: "no such shell" } });
	cleanups.push(() => spy.mockRestore());

	const started = await supervisor.startCommandTask(
		owner,
		holdIntent(root, "refused"),
		crypto.randomUUID() as OperationId,
	);

	assert.equal(started.ok, false);
	assert.equal(admission.held.process, 0);
});

test("a rejected session acquire closes the session store it was handed and holds no permit (#3869)", async () => {
	const admission = new FakeAdmission({ session: 0 });
	const root = tempRoot();
	const controller = new AbortController();
	let closed = 0;
	const sessionManager = SessionManager.inMemory(root);
	const store = { close: async () => void closed++ } as unknown as SessionStore;
	ownedSessionManagerStores.set(sessionManager, store);

	const waiting = createAgentSession(
		sessionOptions(root, {
			resourceAdmission: admission,
			resourceAdmissionSignal: controller.signal,
			sessionManager,
		}),
	);
	controller.abort(new Error("acquire cancelled"));

	await assert.rejects(waiting, /acquire cancelled/);
	assert.equal(closed, 1);
	assert.deepEqual(admission.acquired, []);
});
