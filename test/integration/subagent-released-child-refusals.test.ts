import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import {
	type AgentSession,
	type AgentWakeDispatcher,
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { linkSharedTranspileCache } from "../../packages/coding-agent/test/helpers/shared-transpile-cache.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** These tests load the shipped extension into an SDK session and exercise its real retirement hooks. */
const OWNER_SESSION_TIMEOUT_MS = 120_000;
const childId = "released-run:0";
const childName = "released-worker";

async function openOwner(waitingOn: { toolCallId: string; toolName: string }[] = []) {
	const cwd = makeTempDirectory("released-child-refusal-");
	const agentDir = join(cwd, "profile");
	linkSharedTranspileCache(agentDir);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	const store = await JsonlSessionStore.open(join(cwd, "sessions"), { exactDirectory: true, scanExisting: false });
	const manager = await SessionManager.create(store, cwd);
	const sessionId = manager.getSessionId();
	await manager.appendCustomEntry("subagent-child", {
		version: 1,
		childId,
		index: 0,
		runId: "released-run",
		agent: "worker",
		cwd,
		state: "terminal",
		terminalStatus: "released",
		intercomTarget: childName,
		taskId: "task-71",
		childSessionId: "missing-session",
		waitingOn,
		owner: { kind: "session", sessionId },
	});
	const bus = createEventBus();
	const notices: string[] = [];
	bus.on("subagent:complete", (data) => {
		const notice = data as { noticeLabel: string; summary: string };
		if (notice.noticeLabel === "Released subagent reservation") notices.push(notice.summary);
	});
	const extension = fileURLToPath(new URL("../../packages/subagents/src/extension/index.ts", import.meta.url));
	const probe = join(cwd, "dispatcher.ts");
	await writeFile(
		probe,
		`import { agentWakeDispatcher } from "@bastani/atomic";\nexport default pi => pi.events.on("test:dispatcher", r => { r.value = agentWakeDispatcher(); });\n`,
	);
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		eventBus: bus,
		builtinPackagePaths: [],
		additionalExtensionPaths: [extension, probe],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		sessionManager: manager,
		resourceLoader: loader,
		builtins: { subagents: true, intercom: false, mcp: false, workflows: false, "web-access": false },
	});
	assert.ok(session.extensionRunner.getToolDefinition("subagent"), JSON.stringify(loader.getExtensions().errors));
	return {
		bus,
		session,
		notices,
		probe,
		sessionId,
		async close() {
			await session.dispose();
			await store.close();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		},
	};
}

async function control(session: AgentSession, action: "pause" | "status") {
	const runner = session.extensionRunner;
	const tool = runner.getToolDefinition("subagent");
	assert.ok(tool);
	return tool.execute(
		action,
		{ action, id: childId },
		new AbortController().signal,
		undefined,
		runner.createToolContext(action, undefined),
	);
}

test.each(["released", "reloaded", "live"] as const)(
	"a wake confirmation refusal only notifies the generation that sent it: %s (#5609, #5551)",
	async (generation) => {
		const { bus, session, sessionId, notices, probe, close } = await openOwner();
		const requested = Promise.withResolvers<string>();
		const reply = Promise.withResolvers<void>();
		const auth = Promise.withResolvers<void>();
		bus.on("subagent:acknowledge-released-child-wake", (data) => {
			const request = data as { childName: string; completion?: Promise<void> };
			request.completion = reply.promise;
			requested.resolve(request.childName);
		});
		// Keep the same released task current until the broker answers, even across a reload.
		bus.on("subagent:supervisor-authorization", (data) => {
			(data as { completion?: Promise<void> }).completion = auth.promise;
		});
		const errors = vi.spyOn(console, "error");
		let wake: Promise<void> | undefined;
		try {
			const request: { value?: AgentWakeDispatcher } = {};
			bus.emit("test:dispatcher", request);
			assert.ok(request.value);
			wake = request.value
				.deliver(`subagents/${sessionId}:${childId}`, { id: "broker-wake", kind: "intercom" })
				.catch(() => undefined);
			assert.equal(
				await Promise.race([requested.promise, wake.then(() => assert.fail("wake ended before confirmation"))]),
				childName,
			);
			if (generation === "released") {
				auth.resolve();
				await wake;
				await session.release();
			} else if (generation === "reloaded") {
				const original = session.extensionRunner;
				await appendFile(probe, "\n// Replace this extension generation.\n");
				await session.reload({ failOnExtensionErrors: true });
				assert.notEqual(session.extensionRunner, original);
			}
			reply.reject(Object.assign(new Error("No released child"), { code: "unknown_released_child" }));
			await setImmediate();
			assert.deepEqual(
				errors.mock.calls.filter(([message]) => String(message).includes("no owner is listening")),
				[],
			);
			assert.equal(notices.length, generation === "live" ? 1 : 0);
			if (generation !== "released") {
				const status = await control(session, "status");
				assert.equal(JSON.stringify(status.content).includes("hold-failed"), generation === "live");
			}
		} finally {
			reply.resolve();
			auth.resolve();
			await wake;
			errors.mockRestore();
			await close();
		}
	},
	OWNER_SESSION_TIMEOUT_MS,
);

test(
	"a reconnect parks a paused child without reporting its superseded parking refusal (#5551)",
	async () => {
		const { bus, session, notices, close } = await openOwner([{ toolCallId: "call", toolName: "bash" }]);
		const first = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<void>();
		const recovered = Promise.withResolvers<void>();
		const parks: { childName: string; wake: boolean }[][] = [];
		bus.on("subagent:reserve-released-children", (data) => {
			const request = data as { children: { childName: string; wake: boolean }[]; completion?: Promise<void> };
			parks.push(request.children.map(({ childName, wake }) => ({ childName, wake })));
			request.completion = parks.length === 1 ? reply.promise : Promise.resolve();
			first.resolve();
		});
		bus.on("subagent:released-child-hold-recovered", () => {
			if (parks.length === 2) recovered.resolve();
		});
		const paused = control(session, "pause");
		try {
			await Promise.race([first.promise, paused.then(() => assert.fail("pause did not park the released child"))]);
			bus.emit("intercom:connected", {});
			await recovered.promise;
			reply.reject(Object.assign(new Error("Original park refused"), { code: "not_owner" }));
			assert.notEqual((await paused).isError, true);
			assert.deepEqual(parks, [[{ childName, wake: false }], [{ childName, wake: false }]]);
			assert.deepEqual(notices, []);
			const status = JSON.stringify((await control(session, "status")).content);
			assert.match(status, /paused/);
			assert.doesNotMatch(status, /hold-failed/);
		} finally {
			reply.resolve();
			await paused;
			await close();
		}
	},
	OWNER_SESSION_TIMEOUT_MS,
);
