import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineInputFormService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-input-form.ts";
import { InputFormHostController } from "../../packages/coding-agent/src/modes/interactive-engine/input-form-host.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.ts";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.ts";
import {
	parseWorkflowArgs,
	tokenizeWorkflowArgs,
} from "../../packages/workflows/src/extension/workflow-command-utils.ts";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.ts";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.ts";
import { deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import type { InlineFormState } from "../../packages/workflows/src/tui/inline-form-store.ts";

beforeAll(() => {
	initTheme("dark");
});

test("registered /workflow falls back to the custom picker and settles when the isolated host refuses hostInputForm and setEditorComponent is a stub (#5245)", async () => {
	const hostKb = new KeybindingsManager();
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const hostMessages: InteractiveEngineMessage[] = [];
	const commands: InteractiveEngineCommand[] = [];
	const hostMounts: unknown[] = [];
	const child = new EngineInputFormService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		hostMessages.push(message);
		for (const listener of [...listeners]) listener(message);
	});
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			commands.push(command);
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	};
	const hostUi = {
		requestRender() {},
		setWorkingVisible() {},
		custom: (factory: (tui: unknown, activeTheme: unknown, kb: unknown, done: (value: unknown) => void) => unknown) =>
			new Promise((resolve) => {
				hostMounts.push(
					factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, theme, hostKb, resolve),
				);
			}),
	};
	const controller = new InputFormHostController(runtime as never, hostUi as never);

	const rpcOut: unknown[] = [];
	const pickerMounts: Array<{ handleInput(data: string): void }> = [];
	const rpcUi = createRpcExtensionUIContext({
		output: ((event: unknown) => rpcOut.push(event)) as never,
		pendingExtensionRequests: new Map(),
		customUi: {
			custom: (
				factory: (
					tui: unknown,
					activeTheme: unknown,
					kb: unknown,
					done: (value: unknown) => void,
				) => { handleInput(data: string): void },
			) =>
				new Promise((resolve) => {
					pickerMounts.push(
						factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, theme, hostKb, resolve),
					);
				}),
			requestRender() {},
		} as never,
		inputForm: child,
	} as never);

	const store = createStore();
	const owner = {
		store,
		jobs: createJobTracker(),
		stageControlRegistry: createStageControlRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		stageUiBroker: new StageUiBroker(store),
	};
	const definition = { normalizedName: "deploy", name: "deploy", description: "d", inputs: {}, autoAttach: false };
	const dispatches: Array<{ action: string; inputs?: Record<string, unknown> }> = [];
	const runtimeProxy = {
		registry: { all: () => [definition], names: () => ["deploy"], get: () => definition },
		dispatch: async (args: { action: string; inputs?: Record<string, unknown> }) => {
			dispatches.push(args);
			if (args.action === "inputs") {
				return {
					action: "inputs",
					inputs: [{ name: "objective", type: "string", required: true, description: 7 as unknown as string }],
				};
			}
			return { action: "run", status: "completed", runId: "run-1", name: "deploy" };
		},
	};
	const sentMessages: Array<{ customType?: string }> = [];
	const notices: unknown[] = [];
	const pi = {
		registerCommand() {},
		sendMessage: (message: { customType?: string }) => sentMessages.push(message),
	};
	const handlers = new Map<string, (args: string, context: unknown) => Promise<void>>();
	registerWorkflowSlashCommand(
		pi as never,
		handlers as never,
		{
			owner,
			runtimeProxy,
			runtimeForContext: () => runtimeProxy,
			overlay: { open() {}, close() {}, toggle() {} },
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => {},
			runWithLifecycleSuppressedForPolicy: (_policy: unknown, fn: () => unknown) => fn(),
			runControl: {
				owner,
				pi,
				overlay: { open() {} },
				runtimeForContext: () => runtimeProxy,
				ensureWorkflowResourcesLoaded: () => {},
			},
		} as never,
	);

	try {
		const ctx = {
			hasUI: true,
			ui: { ...rpcUi, notify: (...args: unknown[]) => notices.push(args) },
		};
		const handler = handlers.get("workflow")!;
		let settled = false;
		const commandPromise = Promise.resolve(handler("deploy", ctx)).then(() => {
			settled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(hostMounts.length, 0);
		assert.deepEqual(
			hostMessages.map((message) => message.type),
			["engine_input_form_refused"],
		);
		assert.deepEqual(
			commands.map((command) => command.type),
			["engine_input_form_error"],
		);
		assert.equal(sentMessages.length, 0);
		assert.equal(pickerMounts.length, 1);

		pickerMounts[0]!.handleInput("\x1b");
		await Promise.race([commandPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
		assert.equal(settled, true);
		assert.deepEqual(
			dispatches.map((entry) => entry.action),
			["inputs"],
		);
	} finally {
		controller.dispose();
	}
});

test("submitted inline card commands preserve structured values and escaped strings through the argument parser (#5245)", () => {
	const graphTheme = deriveGraphTheme({});
	const fields = deriveInputFields({
		cfg: Type.Object({ a: Type.String() }),
		body: Type.String(),
		tags: Type.Array(Type.String()),
		eq: Type.String(),
		quoteOnly: Type.String(),
		plainStr: Type.String(),
	});
	const state: InlineFormState = {
		formId: "wf-ledger",
		workflowName: "demo",
		fields,
		rawText: {
			cfg: '{"a":"x y"}',
			body: 'say "hi" there',
			tags: '["a b","c"]',
			eq: "k=v",
			quoteOnly: 'a"b',
			plainStr: "simple",
		},
		focusedIdx: fields.length,
		caret: 0,
		status: "submitted",
		version: 0,
	};
	const line = stripVTControlCharacters(renderInlineCard({ width: 300, theme: graphTheme, state })[0]!);
	const args = line.slice(line.indexOf("/workflow demo ") + "/workflow demo ".length);
	assert.deepEqual(parseWorkflowArgs(tokenizeWorkflowArgs(args)), {
		cfg: { a: "x y" },
		body: 'say "hi" there',
		tags: ["a b", "c"],
		eq: "k=v",
		quoteOnly: 'a"b',
		plainStr: "simple",
	});
});

for (const value of [
	"1.0",
	"true",
	"null",
	"[1]",
	"1e9999",
	"don't split",
	'a" b',
	"ends\\",
	'a\\" b',
	"a\nb",
	"a\u0085b",
]) {
	test(`submitted inline card commands preserve the string ${JSON.stringify(value)} through the parser (#5245)`, () => {
		const state: InlineFormState = {
			formId: "string-ledger",
			workflowName: "demo",
			fields: deriveInputFields({ value: Type.String(), after: Type.String() }),
			rawText: { value, after: "tail" },
			focusedIdx: 2,
			caret: 0,
			status: "submitted",
			version: 0,
		};
		const line = stripVTControlCharacters(renderInlineCard({ width: 300, theme: deriveGraphTheme({}), state })[0]!);
		const args = line.slice(line.indexOf("/workflow demo ") + "/workflow demo ".length);
		assert.deepEqual(parseWorkflowArgs(tokenizeWorkflowArgs(args)), { value, after: "tail" });
	});
}
