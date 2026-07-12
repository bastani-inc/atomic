import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import intercom from "../../packages/intercom/index.js";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>;

const EmptyParams = Type.Object({});
type EmptyParams = Static<typeof EmptyParams>;

function fixture(options: { child?: boolean; childSessionName?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const sequence: string[] = [];
	const sessionNames: string[] = [];
	let imports = 0;
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		setSessionName(name: string) { sessionNames.push(name); },
		events: { on() {} },
	};
	const priorOrchestratorTarget = process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	const priorSessionName = process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	if (options.child) process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = "parent";
	else delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	if (options.childSessionName) process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME = options.childSessionName;
	else delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	intercom(pi as never, {
		async importHeavy() {
			imports += 1;
			sequence.push("heavy-loaded");
			return {
				default(heavyPi: ExtensionAPI) {
					heavyPi.on("session_start", () => { sequence.push("session-start-replayed"); });
					for (const name of ["intercom", "contact_supervisor"] as const) {
						heavyPi.registerTool({
							name,
							label: name,
							description: name,
							parameters: EmptyParams,
							async execute() {
								sequence.push(`${name}-connected`);
								return { content: [{ type: "text", text: "connected" }], details: {} };
							},
						});
					}
				},
			};
		},
	});
	if (priorOrchestratorTarget === undefined) delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	else process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = priorOrchestratorTarget;
	if (priorSessionName === undefined) delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME = priorSessionName;
	const ctx = { hasUI: true };
	async function emit(name: string, event: Record<string, unknown>, context = ctx): Promise<void> {
		for (const handler of handlers.get(name) ?? []) await handler(event, context);
	}
	async function executeTool(name: string): Promise<void> {
		const tool = tools.get(name);
		assert.ok(tool, `${name} tool should be registered`);
		await tool.execute("tool-call", {} as EmptyParams, new AbortController().signal, undefined, ctx as never);
	}
	return { sequence, sessionNames, get imports() { return imports; }, emit, executeTool };
}

describe("lightweight intercom tool-driven connection", () => {
	test("foreground subagent launch does not load or connect Intercom", async () => {
		const current = fixture();
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await current.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "child-1",
			toolName: "subagent",
			args: { agent: "worker", task: "work independently" },
		});
		assert.equal(current.imports, 0);
		assert.deepEqual(current.sequence, []);
	});

	test("intercom tool invocation lazily loads the runtime", async () => {
		const current = fixture();
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal(current.imports, 0);
		await current.executeTool("intercom");
		assert.equal(current.imports, 1);
		assert.deepEqual(current.sequence, ["heavy-loaded", "session-start-replayed", "intercom-connected"]);
	});

	test("bridged child remains disconnected until it uses its coordination tool", async () => {
		const child = fixture({ child: true, childSessionName: "subagent-worker-live-1" });
		await child.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
		assert.deepEqual(child.sessionNames, ["subagent-worker-live-1"]);
		assert.equal(child.imports, 0);
		await child.executeTool("contact_supervisor");
		assert.equal(child.imports, 1);
		assert.deepEqual(child.sequence, ["heavy-loaded", "session-start-replayed", "contact_supervisor-connected"]);
	});
});
