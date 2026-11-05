import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import {
	AgentRehydrateError,
	type AgentReleaseConfigError,
	isAgentRehydrateError,
	isAgentReleaseConfigError,
	isRetryableAgentRehydrateError,
	TEAM_JOIN_COMMAND,
} from "../src/core/agent-rehydrate-errors.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import {
	armedIdleSessionCount,
	disarmIdleRelease,
	enableReleaseWhenIdle,
	onSessionClose,
	parseReleaseWhenIdle,
	type ReleasedAgentSession,
	sessionClosing,
} from "../src/core/agent-session-release.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeOptions,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { type AgentWakeClock, AgentWakeDispatcher } from "../src/core/agent-wake-dispatcher.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import type { ResourceAdmission } from "../src/core/sdk-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { SessionStore, StorageDescriptor } from "../src/core/storage/session/types.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/** Delegates to a memory store and counts every operation, so tests prove a failure happened before any work. */
function countingStore(inner: SessionStore = new MemorySessionStore(), adapter?: StorageDescriptor["adapter"]) {
	const counts = new Map<string, number>();
	const count = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
	const counted =
		<T extends unknown[], R>(name: string, operation: (...args: T) => R) =>
		(...args: T): R => {
			count(name);
			return operation(...args);
		};
	const store: SessionStore = {
		get descriptor() {
			return adapter === undefined ? inner.descriptor : { ...inner.descriptor, adapter };
		},
		create: counted("create", inner.create.bind(inner)),
		append: counted("append", inner.append.bind(inner)),
		replace: counted("replace", inner.replace.bind(inner)),
		load: counted("load", inner.load.bind(inner)),
		readHeader: counted("readHeader", inner.readHeader.bind(inner)),
		delete: counted("delete", inner.delete.bind(inner)),
		list: counted("list", inner.list.bind(inner)),
		findMostRecent: counted("findMostRecent", inner.findMostRecent.bind(inner)),
		close: counted("close", inner.close.bind(inner)),
	};
	return {
		store,
		total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
		get: (name: string) => counts.get(name) ?? 0,
		reset: () => counts.clear(),
	};
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(customTools: ToolDefinition[] = []): Promise<Harness> {
	const created = await createHarness({
		customTools,
		sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd()),
	});
	cleanups.push(() => created.cleanup());
	return created;
}

function internal(session: AgentSession): AgentSessionInternalSurface {
	return session as unknown as AgentSessionInternalSurface;
}

function manualClock() {
	let now = 0;
	let pending: { readonly at: number; readonly callback: () => void } | undefined;
	const clock: AgentWakeClock = {
		now: () => now,
		setTimer(callback, delayMs) {
			pending = { at: now + delayMs, callback };
			return {};
		},
		clearTimer() {
			pending = undefined;
		},
	};
	return {
		clock,
		async advance(ms: number) {
			now += ms;
			const due = pending !== undefined && pending.at <= now ? pending : undefined;
			if (due !== undefined) {
				pending = undefined;
				due.callback();
			}
			for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
		},
		get armed() {
			return pending !== undefined;
		},
	};
}

describe("AgentSession.release (#4326)", () => {
	test("an idle session releases to plain data, tells subscribers first, and is closed after", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("hello")]);
		await h.session.prompt("hi");
		const sessionId = h.session.sessionId;

		const released = await h.session.release();

		assert.deepEqual(released, { sessionId, cwd: h.sessionManager.getCwd() });
		assert.deepEqual(h.eventsOfType("session_released"), [{ type: "session_released", released }]);
		assert.equal(internal(h.session)._disposed, true);
		assert.equal(await h.session.release(), released);
		assert.equal(h.eventsOfType("session_released").length, 1);
		await assert.rejects(
			h.session.prompt("again"),
			(error: Error & { code?: string }) => error.code === "SessionClosed",
		);
	});

	test("a close that fails rejects as release-failed, naming the fix and keeping the failure as its cause", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("hello")]);
		await h.session.prompt("hi");
		const failure = new Error("close failed");
		const dispose = h.session.dispose.bind(h.session);
		Object.defineProperty(h.session, "dispose", {
			configurable: true,
			value: async () => {
				throw failure;
			},
		});
		cleanups.push(() => {
			Object.defineProperty(h.session, "dispose", { configurable: true, value: dispose });
		});
		let reported: AgentRehydrateError | undefined;

		await assert.rejects(h.session.release(), (error: AgentRehydrateError) => {
			assert.ok(isAgentRehydrateError(error));
			assert.equal(error.code, "release-failed");
			assert.deepEqual(error.fields, { sessionId: h.session.sessionId, storage: "memory" });
			assert.equal(error.retryable, false);
			assert.equal(error.cause, failure);
			assert.match(error.hint, /rehydrate\(sessionId\)/);
			reported = error;
			return true;
		});
		await assert.rejects(h.session.release(), (error: AgentRehydrateError) => error === reported);
	});

	test("a session with a run in flight is refused as retryable session-busy and keeps running", async () => {
		const h = await harness();
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		h.setResponses([
			async () => {
				await blocked;
				return fauxAssistantMessage("done");
			},
		]);
		const turn = h.session.prompt("work");
		while (!h.session.isStreaming) await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(h.session.release(), (error: AgentRehydrateError) => {
			assert.ok(error instanceof AgentRehydrateError);
			assert.equal(error.code, "session-busy");
			assert.deepEqual(error.fields, { sessionId: h.session.sessionId, activity: "streaming" });
			assert.ok(isRetryableAgentRehydrateError(error));
			return true;
		});
		assert.equal(internal(h.session)._disposed, false);
		finish();
		await turn;
		assert.equal(getMessageText(h.session.messages.at(-1)), "done");
		await h.session.release();
	});

	test("queued messages, a prompt being prepared, compaction and shell work each keep a session busy", async () => {
		const h = await harness();
		const session = internal(h.session);
		const refusedAs = async (activity: string) =>
			assert.rejects(h.session.release(), (error: AgentRehydrateError) => error.fields.activity === activity);
		session._activePromptCount = 1;
		await refusedAs("prompt");
		session._activePromptCount = 0;
		session._compactionAbortController = new AbortController();
		await refusedAs("compaction");
		session._compactionAbortController = undefined;
		session._pendingBashMessages.push({
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		await refusedAs("shell");
		session._pendingBashMessages.length = 0;
		session._followUpMessages.push("later");
		await refusedAs("queued-messages");
		session._followUpMessages.length = 0;
		await h.session.release();
	});
});

describe("releaseWhenIdle (#4326)", () => {
	test("invalid values fail at the entry point before any store, admission or session work", async () => {
		const counted = countingStore();
		let admissions = 0;
		const resourceAdmission: ResourceAdmission = {
			acquire: async () => {
				admissions += 1;
				return async () => {};
			},
		};
		const invalid: Array<[unknown, string, string]> = [
			[{ afterMs: -1 }, "releaseWhenIdle.afterMs", "-1"],
			[{ afterMs: Number.NaN }, "releaseWhenIdle.afterMs", "NaN"],
			[{ afterMs: Number.POSITIVE_INFINITY }, "releaseWhenIdle.afterMs", "Infinity"],
			[{ afterMs: "5" }, "releaseWhenIdle.afterMs", '"5"'],
			[{}, "releaseWhenIdle.afterMs", "undefined"],
			[5, "releaseWhenIdle", "5"],
			["soon", "releaseWhenIdle", '"soon"'],
			[null, "releaseWhenIdle", "null"],
			[[1], "releaseWhenIdle", "an array"],
		];
		for (const [value, field, shown] of invalid) {
			await assert.rejects(
				createAgentSession({
					sessionStore: counted.store,
					resourceAdmission,
					releaseWhenIdle: value as { afterMs: number },
				}),
				(error: AgentReleaseConfigError) => {
					assert.ok(isAgentReleaseConfigError(error));
					assert.equal(error.code, "invalid-release-policy");
					assert.deepEqual([error.source, error.field, error.value], ["sdk", field, shown]);
					assert.ok(error.hint.includes("afterMs"));
					return true;
				},
			);
		}
		assert.equal(counted.total(), 0);
		assert.equal(admissions, 0);
	});

	test("settings-sourced values name their source; unset and zero are valid", () => {
		assert.equal(parseReleaseWhenIdle(undefined), undefined);
		assert.deepEqual(parseReleaseWhenIdle({ afterMs: 0 }), { afterMs: 0 });
		assert.throws(
			() => parseReleaseWhenIdle({ afterMs: -2 }, "settings"),
			(error: AgentReleaseConfigError) => error.source === "settings",
		);
	});

	test("an idle session is released after afterMs through one shared timer, and a run starting disarms it", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 1_000 }, dispatcher);
		assert.equal(dispatcher.stats().scheduled, 1);
		assert.equal(armedIdleSessionCount(), 1);

		await time.advance(999);
		await h.session.prompt("first");
		assert.equal(internal(h.session)._disposed, false);
		await time.advance(999);
		assert.equal(internal(h.session)._disposed, false);
		const released = new Promise<ReleasedAgentSession>((resolve) => {
			h.session.subscribe((event) => {
				if (event.type === "session_released") resolve(event.released);
			});
		});
		await time.advance(1);

		assert.equal((await released).sessionId, h.session.sessionId);
		assert.equal(internal(h.session)._disposed, true);
		assert.equal(armedIdleSessionCount(), 0);
		assert.deepEqual(dispatcher.stats(), {
			keys: 0,
			queued: 0,
			running: 0,
			scheduled: 0,
			timers: 0,
			handlers: 1,
			namespaces: 1,
			unobservedFailures: 0,
		});
		assert.equal(time.armed, false);
	});

	test("a session busy when its idle wake fires is checked again after afterMs", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		internal(h.session)._followUpMessages.push("queued");
		await time.advance(100);
		assert.equal(internal(h.session)._disposed, false);
		assert.equal(dispatcher.stats().scheduled, 1);
		internal(h.session)._followUpMessages.length = 0;
		await time.advance(100);
		assert.equal(internal(h.session)._disposed, true);
	});

	test("disposing a session disarms it, and arming twice keeps one entry", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		assert.equal(armedIdleSessionCount(), 1);
		assert.equal(dispatcher.stats().scheduled, 1);
		await h.session.dispose();
		assert.equal(armedIdleSessionCount(), 0);
		assert.equal(dispatcher.stats().scheduled, 0);
		await time.advance(100);
		assert.equal(h.eventsOfType("session_released").length, 0);
	});
});

interface RuntimeHost {
	readonly runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	readonly faux: ReturnType<typeof registerFauxProvider>;
	readonly store: ReturnType<typeof countingStore>;
	readonly factoryCalls: CreateAgentSessionRuntimeOptions[];
}

async function runtimeHost(
	options: {
		readonly releaseWhenIdle?: { afterMs: number };
		readonly tools?: ToolDefinition[];
		readonly adapter?: StorageDescriptor["adapter"];
	} = {},
): Promise<RuntimeHost> {
	const tempDir = join(tmpdir(), `atomic-release-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(tempDir, "models.json"),
	});
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const store = countingStore(undefined, options.adapter);
	const factoryCalls: CreateAgentSessionRuntimeOptions[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		factoryCalls.push(runtimeOptions);
		const services =
			runtimeOptions.services ??
			(await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					builtinPackagePaths: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			}));
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: runtimeOptions.sessionManager,
				sessionStartEvent: runtimeOptions.sessionStartEvent,
				model,
				...(options.tools === undefined ? {} : { customTools: options.tools }),
				...(options.releaseWhenIdle === undefined ? {} : { releaseWhenIdle: options.releaseWhenIdle }),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: await SessionManager.create(store.store, tempDir),
	});
	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});
	return { runtime, faux, store, factoryCalls };
}

describe("AgentSessionRuntime.rehydrate (#4326)", () => {
	test("a released session comes back from storage with its history, sharing the runtime's services", async () => {
		const host = await runtimeHost();
		const { runtime, faux } = host;
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const original = runtime.session;
		await original.prompt("first question");
		const released = await original.release();
		assert.equal(host.factoryCalls.length, 1);
		host.store.reset();

		const woken = await runtime.rehydrate(released.sessionId);

		assert.notEqual(woken, original);
		assert.equal(woken.sessionId, released.sessionId);
		assert.deepEqual(
			woken.messages.filter((message) => message.role !== "system").map((message) => message.role),
			["user", "assistant"],
		);
		assert.equal(host.factoryCalls.length, 2);
		assert.equal(host.factoryCalls[1]?.services, runtime.services);
		assert.deepEqual(host.factoryCalls[1]?.sessionStartEvent, { type: "session_start", reason: "resume" });
		assert.equal(host.store.get("readHeader"), 1);
		assert.equal(host.store.get("load"), 1);
		assert.equal(runtime.rehydratedSessionCount, 1);

		await woken.prompt("second question");
		assert.equal(getMessageText(woken.messages.at(-1)), "second answer");
		await woken.release();
		assert.equal(runtime.rehydratedSessionCount, 0);
	});

	test("a session not in this node's local-only storage fails at once, naming the team join command", async () => {
		const host = await runtimeHost({ adapter: "node-sqlite" });
		host.store.reset();
		const calls = host.factoryCalls.length;

		await assert.rejects(host.runtime.rehydrate("missing-session"), (error: AgentRehydrateError) => {
			assert.ok(error instanceof AgentRehydrateError);
			assert.equal(error.code, "session-not-found");
			assert.deepEqual(error.fields, { sessionId: "missing-session", storage: "node-sqlite", localOnly: true });
			assert.ok(error.hint.includes(TEAM_JOIN_COMMAND));
			assert.equal(error.retryable, false);
			return true;
		});
		assert.equal(host.store.total(), 1);
		assert.equal(host.store.get("readHeader"), 1);
		assert.equal(host.factoryCalls.length, calls);
	});

	test("the live session, or one rehydrating, is returned instead of a second copy", async () => {
		const host = await runtimeHost();
		const { runtime, faux } = host;
		faux.setResponses([fauxAssistantMessage("a")]);
		assert.equal(await runtime.rehydrate(runtime.session.sessionId), runtime.session);
		const other = await SessionManager.create(host.store.store, runtime.cwd);
		await other.appendMessage({ role: "user", content: "stored elsewhere", timestamp: 1 });
		const [first, second] = await Promise.all([
			runtime.rehydrate(other.getSessionId()),
			runtime.rehydrate(other.getSessionId()),
		]);
		assert.equal(first, second);
		assert.equal(await runtime.rehydrate(other.getSessionId()), first);
		assert.equal(host.factoryCalls.length, 2);
	});

	test("disposing the runtime closes the sessions it rehydrated", async () => {
		const host = await runtimeHost();
		const other = await SessionManager.create(host.store.store, host.runtime.cwd);
		await other.appendMessage({ role: "user", content: "x", timestamp: 1 });
		const woken = await host.runtime.rehydrate(other.getSessionId());
		await host.runtime.dispose();
		assert.equal(internal(woken)._disposed, true);
		assert.equal(host.runtime.rehydratedSessionCount, 0);
		await assert.rejects(
			host.runtime.rehydrate(other.getSessionId()),
			(error: Error & { code?: string }) => error.code === "SessionClosed",
		);
	});

	test("createAgentSession({ releaseWhenIdle }) releases the session once idle, and rehydrate brings it back", async () => {
		const host = await runtimeHost({ releaseWhenIdle: { afterMs: 0 } });
		const { runtime, faux } = host;
		faux.setResponses([fauxAssistantMessage("again")]);
		const session = runtime.session;
		const released = await new Promise<ReleasedAgentSession>((resolve) => {
			if (internal(session)._disposed) resolve({ sessionId: session.sessionId, cwd: runtime.cwd });
			session.subscribe((event) => {
				if (event.type === "session_released") resolve(event.released);
			});
		});
		while (!internal(session)._disposed) await new Promise((resolve) => setImmediate(resolve));
		const woken = await runtime.rehydrate(released.sessionId);
		assert.equal(woken.sessionId, session.sessionId);
		assert.equal(internal(woken)._disposed, false);
	});

	test("a detached tool call survives release: its result rehydrates the session and finishes the turn", async () => {
		const waitTool: ToolDefinition = {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for CI",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: () => new Promise(() => {}),
		};
		const host = await runtimeHost({ tools: [waitTool] });
		const { runtime, faux } = host;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ci passed, done"),
		]);
		const session = runtime.session;
		session.setToolDetachment({ afterMs: 0 });
		await session.prompt("watch ci");
		const detached = session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["ci-1"],
		);
		const released = await session.release();

		const woken = await runtime.rehydrate(released.sessionId);
		await woken.resumeDetachedTurn([
			{
				toolCallId: "ci-1",
				toolName: "wait_for_ci",
				result: { content: [{ type: "text", text: "green" }], details: undefined },
				isError: false,
			},
		]);

		assert.deepEqual(
			woken.messages.filter((message) => message.role !== "system").map((message) => message.role),
			["user", "assistant", "toolResult", "assistant"],
		);
		assert.equal(getMessageText(woken.messages.at(-1)), "ci passed, done");
	});
});

describe("release and idle release details (#4326)", () => {
	test("a file-backed session's release names its session file", async () => {
		const dir = join(tmpdir(), `atomic-release-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = await SessionManager.create(dir, join(dir, "sessions"));
		const h = await createHarness({ sessionManager });
		cleanups.push(() => h.cleanup());
		const file = sessionManager.getSessionFile();
		assert.ok(file);
		assert.deepEqual(await h.session.release(), {
			sessionId: sessionManager.getSessionId(),
			cwd: sessionManager.getCwd(),
			sessionFile: file,
		});
	});

	test("a timed wake for a session no longer armed does nothing", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		enableReleaseWhenIdle(internal(h.session), { afterMs: 10 }, dispatcher);
		await dispatcher.deliver("session-idle:not-armed", { id: "idle-release", kind: "timer" });
		assert.equal(internal(h.session)._disposed, false);
	});

	test("a run starting cancels the idle wake, and only a settled run arms it again", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		h.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		const run = h.session.prompt("work");
		while (!h.session.isStreaming) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(dispatcher.stats().scheduled, 0, "a running session has no idle wake");
		await time.advance(500);
		assert.equal(dispatcher.stats().scheduled, 0, "nothing re-armed it while it ran");
		finish();
		await run;
		assert.equal(dispatcher.stats().scheduled, 1);
		assert.equal(internal(h.session)._disposed, false);
	});

	test("a busy session's idle wake is re-armed under the same wake, so the next run still cancels it", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		h.setResponses([fauxAssistantMessage("one")]);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		internal(h.session)._followUpMessages.push("queued");
		await time.advance(100);
		assert.equal(dispatcher.stats().scheduled, 1);
		internal(h.session)._followUpMessages.length = 0;
		await h.session.prompt("go");
		assert.equal(dispatcher.stats().scheduled, 1, "the run replaced the re-armed wake instead of adding one");
	});

	test("arming twice and disarming leaves no subscription that could arm it again", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const h = await harness();
		h.setResponses([fauxAssistantMessage("one")]);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		enableReleaseWhenIdle(internal(h.session), { afterMs: 100 }, dispatcher);
		disarmIdleRelease(internal(h.session));
		disarmIdleRelease(internal(h.session));
		assert.equal(dispatcher.stats().scheduled, 0);
		await h.session.prompt("go");
		assert.equal(dispatcher.stats().scheduled, 0);
		assert.equal(armedIdleSessionCount(), 0);
	});

	test("closing one live instance of a stored session leaves another instance's idle release armed", async () => {
		const time = manualClock();
		const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
		const first = await createHarness({
			sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd(), { id: "shared" }),
		});
		cleanups.push(() => first.cleanup());
		const second = await createHarness({
			sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd(), { id: "shared" }),
		});
		cleanups.push(() => second.cleanup());
		enableReleaseWhenIdle(internal(first.session), { afterMs: 100 }, dispatcher);
		enableReleaseWhenIdle(internal(second.session), { afterMs: 100 }, dispatcher);
		await first.session.dispose();
		assert.equal(armedIdleSessionCount(), 1);
		assert.equal(dispatcher.stats().scheduled, 1);
		await time.advance(100);
		assert.equal(internal(second.session)._disposed, true);
		assert.equal(armedIdleSessionCount(), 0);
	});

	test("every close listener runs once, however often closing is reported", async () => {
		const h = await harness();
		const calls: string[] = [];
		onSessionClose(internal(h.session), () => calls.push("first"));
		onSessionClose(internal(h.session), () => calls.push("second"));
		sessionClosing(internal(h.session));
		sessionClosing(internal(h.session));
		assert.deepEqual(calls, ["first", "second"]);
	});
});

describe("AgentSessionRuntime.rehydrate details (#4326)", () => {
	test("a session released after a rehydration is rehydrated again as a new live session", async () => {
		const host = await runtimeHost();
		const other = await SessionManager.create(host.store.store, host.runtime.cwd);
		await other.appendMessage({ role: "user", content: "x", timestamp: 1 });
		const first = await host.runtime.rehydrate(other.getSessionId());
		await first.release();
		const second = await host.runtime.rehydrate(other.getSessionId());
		assert.notEqual(second, first);
		assert.equal(internal(second)._disposed, false);
		assert.equal(host.factoryCalls.length, 3);
	});

	test("a session saved in another cwd is built without the runtime's services", async () => {
		const host = await runtimeHost();
		const elsewhere = join(host.runtime.cwd, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		const other = await SessionManager.create(host.store.store, elsewhere);
		await other.appendMessage({ role: "user", content: "x", timestamp: 1 });
		const woken = await host.runtime.rehydrate(other.getSessionId());
		assert.equal(woken.sessionManager.getCwd(), elsewhere);
		assert.equal(host.factoryCalls.at(-1)?.services, undefined);
		assert.equal(host.factoryCalls.at(-1)?.cwd, elsewhere);
	});

	test("a runtime disposed while it rehydrates closes the new session and refuses", async () => {
		const host = await runtimeHost();
		const other = await SessionManager.create(host.store.store, host.runtime.cwd);
		await other.appendMessage({ role: "user", content: "x", timestamp: 1 });
		const rehydrating = host.runtime.rehydrate(other.getSessionId());
		const disposing = host.runtime.dispose();
		await assert.rejects(rehydrating, (error: Error & { code?: string }) => error.code === "SessionClosed");
		await disposing;
		assert.equal(host.runtime.rehydratedSessionCount, 0);
	});

	test("a rehydrated session that fails to close is reported by the runtime's dispose", async () => {
		const host = await runtimeHost();
		const other = await SessionManager.create(host.store.store, host.runtime.cwd);
		await other.appendMessage({ role: "user", content: "x", timestamp: 1 });
		const woken = await host.runtime.rehydrate(other.getSessionId());
		const failure = new Error("close failed");
		const dispose = woken.dispose.bind(woken);
		Object.defineProperty(woken, "dispose", {
			configurable: true,
			value: async () => {
				throw failure;
			},
		});
		await assert.rejects(host.runtime.dispose(), (error: AggregateError & { code?: string }) => {
			assert.equal(error.code, "ShutdownFailed");
			assert.ok(error.errors.includes(failure));
			return true;
		});
		assert.equal(host.runtime.rehydratedSessionCount, 0, "the runtime forgets a session that failed to close");
		await dispose();
		Object.defineProperty(host.runtime, "dispose", { configurable: true, value: async () => {} });
	});
});

describe("a session whose history could not be reopened is not released (#4326)", () => {
	test("release() refuses before anything happens, naming the store and how to fix it", async () => {
		const h = await createHarness();
		cleanups.push(() => h.cleanup());
		const events: string[] = [];
		h.session.subscribe((event) => events.push(event.type));
		await assert.rejects(h.session.release(), (error: AgentRehydrateError) => {
			assert.ok(isAgentRehydrateError(error));
			assert.equal(error.code, "not-reopenable");
			assert.deepEqual(error.fields, { sessionId: h.session.sessionId, storage: "memory" });
			assert.equal(error.retryable, false);
			assert.match(error.hint, /MemorySessionStore the host keeps/);
			return true;
		});
		assert.equal(events.includes("session_released"), false);
		assert.equal(internal(h.session)._disposed, false, "nothing was closed");
		await h.session.prompt("still works").catch(() => {});
	});

	test("a store the host keeps is reopenable: its sessions release", async () => {
		const host = await runtimeHost();
		assert.equal((await host.runtime.session.release()).sessionId, host.runtime.session.sessionId);
	});

	test("createAgentSession({ releaseWhenIdle }) over a private in-memory manager fails before any admission", async () => {
		let admissions = 0;
		const resourceAdmission: ResourceAdmission = {
			acquire: async () => {
				admissions += 1;
				return async () => {};
			},
		};
		const sessionManager = SessionManager.inMemory();
		await assert.rejects(
			createAgentSession({ sessionManager, resourceAdmission, releaseWhenIdle: { afterMs: 10 } }),
			(error: AgentRehydrateError) => {
				assert.ok(isAgentRehydrateError(error));
				assert.deepEqual(
					[error.code, error.fields],
					["not-reopenable", { sessionId: sessionManager.getSessionId(), storage: "memory" }],
				);
				return true;
			},
		);
		assert.equal(admissions, 0);
		assert.equal(armedIdleSessionCount(), 0);
	});

	test("a miss in memory storage points at the store, not at team join", () => {
		const error = new AgentRehydrateError("session-not-found", {
			sessionId: "s",
			storage: "memory",
			localOnly: true,
		});
		assert.match(error.hint, /MemorySessionStore/);
		assert.ok(!error.hint.includes(TEAM_JOIN_COMMAND));
	});
});
