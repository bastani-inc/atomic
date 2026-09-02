import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import intercom from "../../packages/intercom/index.js";

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ConsoleErrorCall = [message?: unknown, ...optionalParams: unknown[]];
type ImportResult = { error: unknown } | { module: HeavyModule };

const originalConsoleError = console.error;
let consoleErrorCalls: ConsoleErrorCall[] = [];

beforeEach(() => {
	consoleErrorCalls = [];
	console.error = (...args: ConsoleErrorCall) => {
		consoleErrorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
});

function fixture(importResults: ImportResult[]) {
	const tools = new Map<string, ToolDefinition>();
	let imports = 0;
	const pi = {
		on() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		events: { on() {} },
	};
	intercom(pi as never, {
		async importHeavy() {
			const result = importResults[imports++];
			assert.ok(result, "each heavy initialization attempt needs a fixture result");
			if ("error" in result) throw result.error;
			return result.module;
		},
	});
	const ctx = { hasUI: true };
	return {
		get imports() {
			return imports;
		},
		executeIntercom() {
			const tool = tools.get("intercom");
			assert.ok(tool, "intercom tool should be registered");
			return tool.execute("tool-call", { action: "list" }, new AbortController().signal, undefined, ctx as never);
		},
	};
}

function successfulHeavyModule(): HeavyModule {
	return {
		default(heavyPi) {
			heavyPi.registerTool({
				name: "intercom",
				label: "Intercom",
				description: "test intercom",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "connected" }], details: {} };
				},
			});
		},
	};
}

describe("Intercom lazy heavy-initialization diagnostics", () => {
	test("keeps a recoverable client disconnect out of console output while rejecting the caller", async () => {
		const disconnectError = new Error("Client disconnected");
		const current = fixture([{ error: disconnectError }]);

		await assert.rejects(current.executeIntercom(), disconnectError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, []);
	});

	test("retries successfully after a silent recoverable client disconnect", async () => {
		const disconnectError = new Error("Client disconnected");
		const current = fixture([{ error: disconnectError }, { module: successfulHeavyModule() }]);

		await assert.rejects(current.executeIntercom(), disconnectError);
		const result = await current.executeIntercom();
		await Promise.resolve();

		assert.equal(current.imports, 2);
		assert.deepEqual(result, { content: [{ type: "text", text: "connected" }], details: {} });
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("diagnoses a non-recoverable heavy-module import failure", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		await assert.rejects(current.executeIntercom(), importError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, [
			[
				"Intercom heavy initialization failed; a later call will retry: Cannot import Intercom heavy module",
				importError,
			],
		]);
	});

	test("keeps neighboring client failures actionable", async () => {
		const disconnectingError = new Error("Client disconnecting");
		const current = fixture([{ error: disconnectingError }]);

		await assert.rejects(current.executeIntercom(), disconnectingError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, [
			["Intercom heavy initialization failed; a later call will retry: Client disconnecting", disconnectingError],
		]);
	});

	test("keeps ambiguous and non-Error failures actionable", async () => {
		const failures: unknown[] = [
			new Error("Configuration failed after Client disconnected unexpectedly"),
			"Client disconnected",
			{ reason: "Client disconnected" },
			undefined,
		];

		for (const failure of failures) {
			const current = fixture([{ error: failure }]);
			await assert.rejects(current.executeIntercom());
			await Promise.resolve();
		}

		assert.deepEqual(
			consoleErrorCalls.map(([message, error]) => [message, error]),
			failures.map((failure) => [
				`Intercom heavy initialization failed; a later call will retry: ${failure instanceof Error ? failure.message : String(failure)}`,
				failure,
			]),
		);
	});
});
