// @ts-nocheck
import { describe, test } from "vitest";
import type { PiCommandContext, WorkflowDefinition } from "./slash-dispatch-utils.js";
import {
	assert,
	buildCtx,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	parseWorkflowArgs,
	Type,
	workflow,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("slash /workflow <name> dispatch", () => {
	test.sequential("/workflow <known-name> dispatches run, not unknown subcommand", async () => {
		const wf = workflow({
			name: "test-wf",
			description: "",
			inputs: {
				prompt: Type.Optional(Type.String()),
			},
			outputs: {
				done: Type.Optional(Type.Any()),
			},
			run: async (_ctx) => ({ done: true }),
		}) as WorkflowDefinition;

		const registry = createRegistry([wf]);
		const runtime = createExtensionRuntime({ registry });

		const { ctx, messages } = buildCtx();

		let dispatchCalled = false;
		let dispatchedArgs: {
			name: string;
			inputs: Record<string, unknown>;
			action: string;
		} | null = null;

		const execute = async (args: string, execCtx: PiCommandContext) => {
			const print = (msg: string): void => execCtx.ui.notify(msg, "info");
			const rawParts = args.trim().split(/\s+/);
			const parts = rawParts[0] === "" ? [] : rawParts;
			const subcommand = parts[0] ?? "";

			const ADMIN = new Set(["list", "status", "interrupt", "quit", "resume", "inputs"]);

			if (!subcommand || subcommand === "list") {
				print(`Registered workflows: ${runtime.registry.names().join(", ")}`);
				return;
			}

			if (!ADMIN.has(subcommand)) {
				dispatchCalled = true;
				const inputTokens = parts.slice(1);
				const inputs = parseWorkflowArgs(inputTokens);
				dispatchedArgs = { name: subcommand, inputs, action: "run" };
				const result = await runtime.dispatch({
					workflow: subcommand,
					inputs,
					action: "run",
				});
				if (result.action === "run" && "runId" in result) {
					const r = result as {
						action: "run";
						runId: string;
						status: string;
						error?: string;
					};
					if (r.status === "failed" && r.runId === "") {
						const available = runtime.registry.names();
						print(`Workflow not found: ${subcommand}\nAvailable: ${available.join(", ")}`);
					} else {
						print(`Workflow "${subcommand}" completed (runId: ${r.runId})`);
					}
				}
				return;
			}
			print(`unknown subcommand: ${subcommand}`);
		};

		await execute("test-wf prompt=hello", ctx);

		assert.equal(dispatchCalled, true);
		const d = dispatchedArgs as {
			name: string;
			inputs: Record<string, unknown>;
			action: string;
		} | null;
		assert.equal(d?.name, "test-wf");
		assert.deepEqual(d?.inputs, { prompt: "hello" });
		assert.equal(d?.action, "run");
		assert.equal(
			messages.some((m) => m.includes("completed")),
			true,
		);
		// Must NOT print unknown subcommand
		assert.equal(
			messages.some((m) => m.includes("unknown subcommand")),
			false,
		);
	});

	test.sequential("/workflow <unknown-name> prints 'Workflow not found: <name>'", async () => {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		const { ctx, messages } = buildCtx();

		const ADMIN = new Set(["list", "status", "interrupt", "quit", "resume", "inputs"]);
		const execute = async (args: string, execCtx: PiCommandContext) => {
			const print = (msg: string): void => execCtx.ui.notify(msg, "info");
			const rawParts = args.trim().split(/\s+/);
			const parts = rawParts[0] === "" ? [] : rawParts;
			const subcommand = parts[0] ?? "";
			if (!ADMIN.has(subcommand) && subcommand) {
				const result = await runtime.dispatch({
					workflow: subcommand,
					inputs: {},
					action: "run",
				});
				if (result.action === "run" && "runId" in result) {
					const r = result as {
						action: "run";
						runId: string;
						status: string;
					};
					if (r.status === "failed" && r.runId === "") {
						const available = runtime.registry.names();
						print(
							`Workflow not found: ${subcommand}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
						);
					}
				}
			}
		};

		await execute("ghost-workflow", ctx);

		assert.ok(messages[0].includes("Workflow not found: ghost-workflow"));
		assert.ok(!messages[0].includes("unknown subcommand"));
	});
});

// ---------------------------------------------------------------------------
// Factory command registration + completion integration tests (using real factory)
// ---------------------------------------------------------------------------
