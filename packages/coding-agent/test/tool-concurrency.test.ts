import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import { resolveToolConcurrency, ToolExecutionScheduler } from "../src/core/tools/tool-concurrency.ts";
import { createHarness } from "./suite/harness.js";

function deferred() {
	return Promise.withResolvers<void>();
}

describe("tool execution scheduler", () => {
	test("shared calls overlap and an exclusive call waits for every earlier call", async () => {
		const scheduler = new ToolExecutionScheduler();
		const log: string[] = [];
		const slow = deferred();
		const fast = deferred();
		const first = scheduler.schedule("shared", async () => {
			log.push("slow:start");
			await slow.promise;
			log.push("slow:end");
		});
		const second = scheduler.schedule("shared", async () => {
			log.push("fast:start");
			await fast.promise;
			log.push("fast:end");
		});
		const exclusive = scheduler.schedule("exclusive", async () => {
			log.push("exclusive");
		});
		const after = scheduler.schedule("shared", async () => {
			log.push("after");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["slow:start", "fast:start"]);
		fast.resolve();
		await second;
		expect(log).toEqual(["slow:start", "fast:start", "fast:end"]);
		slow.resolve();
		await Promise.all([first, exclusive, after]);
		expect(log).toEqual(["slow:start", "fast:start", "fast:end", "slow:end", "exclusive", "after"]);
	});

	test("an unblocked call starts synchronously so its abort listener is attached at once", () => {
		const scheduler = new ToolExecutionScheduler();
		const started: string[] = [];
		void scheduler.schedule("exclusive", async () => {
			started.push("exclusive");
		});
		expect(started).toEqual(["exclusive"]);
		void scheduler.schedule("shared", async () => {
			started.push("blocked");
		});
		expect(started).toEqual(["exclusive"]);
	});

	test("a failed exclusive call still releases later calls", async () => {
		const scheduler = new ToolExecutionScheduler();
		const failed = scheduler.schedule("exclusive", async () => {
			throw new Error("boom");
		});
		const later = scheduler.schedule("shared", async () => "ran");
		await expect(failed).rejects.toThrow("boom");
		await expect(later).resolves.toBe("ran");
	});

	test("a throwing concurrency resolver runs the call exclusively", () => {
		expect(resolveToolConcurrency(undefined, {})).toBe("shared");
		expect(
			resolveToolConcurrency<{ pty: boolean }>(
				() => {
					throw new Error("bad args");
				},
				{ pty: true },
			),
		).toBe("exclusive");
	});
});

describe("session tool batches", () => {
	test("a read after a write in the same assistant message sees the written file", async () => {
		const harness = await createHarness();
		try {
			const file = join(harness.tempDir, "note.txt");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: file, content: "after\n" }), fauxToolCall("read", { path: file })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("update the note");
			const readResult = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "read",
			);
			expect(readResult?.role === "toolResult" && JSON.stringify(readResult.content)).toContain("after");
			expect(readFileSync(file, "utf8")).toBe("after\n");
		} finally {
			await harness.cleanup();
		}
	});

	test("an extension tool's declared concurrency orders its calls", async () => {
		const log: string[] = [];
		const release = deferred();
		const probe: AgentTool = {
			name: "probe",
			label: "probe",
			description: "records ordering",
			parameters: Type.Object({ id: Type.String(), exclusive: Type.Optional(Type.Boolean()) }),
			concurrency: (args) => (args.exclusive === true ? "exclusive" : "shared"),
			execute: async (_id, params) => {
				const { id } = params as { id: string };
				log.push(`${id}:start`);
				if (id === "slow") await release.promise;
				log.push(`${id}:end`);
				return { content: [{ type: "text", text: id }], details: undefined };
			},
		};
		const harness = await createHarness({ tools: [probe], initialActiveToolNames: ["probe"] });
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("probe", { id: "slow" }),
						fauxToolCall("probe", { id: "fast" }),
						fauxToolCall("probe", { id: "last", exclusive: true }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const prompt = harness.session.prompt("probe");
			await vi.waitFor(() => expect(log).toEqual(["slow:start", "fast:start", "fast:end"]));
			release.resolve();
			await prompt;
			expect(log).toEqual(["slow:start", "fast:start", "fast:end", "slow:end", "last:start", "last:end"]);
		} finally {
			release.resolve();
			await harness.cleanup();
		}
	});
});
