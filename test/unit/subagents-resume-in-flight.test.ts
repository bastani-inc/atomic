import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { loadConfig } from "../../packages/subagents/src/extension/config.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { sleep } from "../helpers/runtime.js";

const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";
const savedAgentDir = process.env[AGENT_DIR_ENV];
const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	if (savedAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDir;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function useSubagentConfig(config: string | undefined): void {
	const agentDir = tempRoot("subagent-resume-in-flight-agent-");
	process.env[AGENT_DIR_ENV] = agentDir;
	if (config === undefined) return;
	mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), config);
}

function errorMessages(spy: { mock: { calls: string[][] } }): string[] {
	return spy.mock.calls.map((call) => call.join(" "));
}

test("loadConfig accepts every resumeInFlight value without reporting (#3827)", () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	for (const mode of ["ask", "auto", "never"]) {
		useSubagentConfig(JSON.stringify({ resumeInFlight: mode }));
		assert.equal(loadConfig().resumeInFlight, mode);
	}
	assert.deepEqual(errors.mock.calls, []);
});

test("loadConfig leaves resumeInFlight unset when the config omits it (#3827)", () => {
	useSubagentConfig(JSON.stringify({ parallel: { maxTasks: 7 } }));
	assert.deepEqual(loadConfig(), { parallel: { maxTasks: 7 } });
});

test("loadConfig reports an invalid resumeInFlight and ignores only that setting (#3827)", () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	for (const invalid of ["sometimes", true, 1, null]) {
		useSubagentConfig(JSON.stringify({ resumeInFlight: invalid, parallel: { maxTasks: 7 } }));

		assert.deepEqual(loadConfig(), { parallel: { maxTasks: 7 } });
		assert.match(
			errorMessages(errors).at(-1) ?? "",
			new RegExp(
				`"resumeInFlight" must be "ask", "auto", or "never", got ${JSON.stringify(invalid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		);
	}
});

interface Startup {
	readonly confirms: string[];
	readonly notices: Array<{ message: string; type: string }>;
	start(reason: string): void;
}

async function registerWithQuitChild(options: { hasUI?: boolean } = {}): Promise<Startup> {
	const cwd = tempRoot("subagent-resume-in-flight-cwd-");
	const sessionManager = SessionManager.inMemory(cwd);
	const handlers = new Map<string, (event: { reason?: string }, ctx: ExtensionContext) => unknown>();
	const listeners = new Map<string, Set<(payload: object) => void>>();
	const pi = {
		events: {
			on(channel: string, handler: (payload: object) => void) {
				const set = listeners.get(channel) ?? new Set();
				set.add(handler);
				listeners.set(channel, set);
				return () => set.delete(handler);
			},
			emit(channel: string, payload: object) {
				for (const handler of listeners.get(channel) ?? []) handler(payload);
			},
		},
		appendEntry: (customType: string, data?: SubagentChildRecord) =>
			sessionManager.appendCustomEntry(customType, data),
		getSessionName: () => "parent",
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: (event: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	registerSubagentExtension(pi);
	cleanups.push(() => {
		const shutdown = handlers.get("session_shutdown");
		shutdown?.({}, { sessionManager } as unknown as ExtensionContext);
	});
	const record: SubagentChildRecord = {
		version: 1,
		childId: "wiring1:0",
		runId: "wiring1",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: "quit",
		cwd,
		owner: { kind: "session", sessionId: sessionManager.getSessionId() },
		taskId: "task-1",
		childSessionId: "child-session",
	};
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	const confirms: string[] = [];
	const notices: Startup["notices"] = [];
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			confirm: async (_title: string, message: string) => {
				confirms.push(message);
				return false;
			},
			notify: (message: string, type: string) => notices.push({ message, type }),
		},
		sessionManager,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	return {
		confirms,
		notices,
		start(reason) {
			handlers.get("session_start")?.({ reason }, ctx);
		},
	};
}

async function settle(startup: Startup, expected: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (startup.notices.length + startup.confirms.length < expected && Date.now() < deadline) await sleep(10);
}

test("a quit subagent stays awaiting resume at startup when resumeInFlight is not configured (#3827)", async () => {
	useSubagentConfig(undefined);
	const startup = await registerWithQuitChild();

	startup.start("startup");
	await sleep(100);

	assert.deepEqual({ confirms: startup.confirms, notices: startup.notices }, { confirms: [], notices: [] });
});

test("resumeInFlight auto resumes a quit subagent at startup (#3827)", async () => {
	useSubagentConfig(JSON.stringify({ resumeInFlight: "auto" }));
	const startup = await registerWithQuitChild();

	startup.start("startup");
	await settle(startup, 1);

	assert.deepEqual(startup.confirms, []);
	assert.equal(startup.notices.length, 1);
	assert.match(startup.notices[0]?.message ?? "", /worker \(wiring1:0\) could not be resumed/);
});

test("resumeInFlight ask confirms once at startup and honours no (#3827)", async () => {
	useSubagentConfig(JSON.stringify({ resumeInFlight: "ask" }));
	const startup = await registerWithQuitChild();

	startup.start("startup");
	await settle(startup, 1);
	await sleep(100);

	assert.equal(startup.confirms.length, 1);
	assert.match(startup.confirms[0] ?? "", /^1 interrupted subagent\(s\) can resume from their own sessions\./);
	assert.deepEqual(startup.notices, []);
});

test("resumeInFlight ask does not prompt without a UI (#3827)", async () => {
	useSubagentConfig(JSON.stringify({ resumeInFlight: "ask" }));
	const startup = await registerWithQuitChild({ hasUI: false });

	startup.start("startup");
	await sleep(100);

	assert.deepEqual({ confirms: startup.confirms, notices: startup.notices }, { confirms: [], notices: [] });
});

test("resumeInFlight only recovers at process startup, not on reload or session switches (#3827)", async () => {
	useSubagentConfig(JSON.stringify({ resumeInFlight: "auto" }));
	const startup = await registerWithQuitChild();

	for (const reason of ["reload", "new", "resume", "fork"]) startup.start(reason);
	await sleep(100);

	assert.deepEqual({ confirms: startup.confirms, notices: startup.notices }, { confirms: [], notices: [] });
});

test("an invalid resumeInFlight behaves as never at startup (#3827)", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	useSubagentConfig(JSON.stringify({ resumeInFlight: "sometimes" }));
	const startup = await registerWithQuitChild();

	startup.start("startup");
	await sleep(100);

	assert.deepEqual({ confirms: startup.confirms, notices: startup.notices }, { confirms: [], notices: [] });
});
