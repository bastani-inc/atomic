import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import { registerSubagentReplyCapability } from "../../packages/intercom/subagent-reply-capability.js";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";

// Replace SDK construction/network discovery, not the actual runner's ownership/finally lifecycle.
vi.mock("@bastani/atomic", async (original) => ({
	...(await original<typeof import("@bastani/atomic")>()),
	createAgentSession: vi.fn(),
}));

for (const outcome of ["completed", "failed", "interrupted", "cancelled"] as const) {
	test(`runner publishes ${outcome} reply termination before disposal and terminal result`, async () => {
		const root = mkdtempSync(join(tmpdir(), "terminal-reply-"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const abort = new AbortController();
		const interrupt = new AbortController();
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => void>();
		const updates: string[] = [];
		const capability = registerSubagentReplyCapability(
			{
				on: (name: string, handler: (event: never, ctx: ExtensionContext) => void) => {
					handlers.set(name, handler);
					return () => {
						handlers.delete(name);
					};
				},
			} as Pick<ExtensionAPI, "on">,
			() => ({
				updatePresence: (update) => {
					updates.push(update.replyCapability ?? "missing");
					return true;
				},
			}),
		);
		let disposed = false;
		vi.spyOn(DefaultResourceLoader.prototype, "reload").mockResolvedValue(undefined);
		vi.mocked(createAgentSession).mockImplementation(async (options) => {
			assert.ok(options?.subagentPolicy?.executionEnded, "real SDK admission must carry the execution signal");
			const session = {
				extensionRunner: {
					emit: async () => {
						handlers.get("session_start")?.(
							{} as never,
							{ subagentPolicy: options.subagentPolicy } as ExtensionContext,
						);
					},
				},
				subscribe: () => () => {},
				prompt: async () => {
					entered.resolve();
					await release.promise;
					if (outcome === "failed") throw new Error("fixture failure");
					// A completed child's reply is in its own transcript, as a real session persists it.
					await options.sessionManager?.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: "result" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					});
				},
				abort: async () => {
					release.resolve();
				},
				getLastAssistantText: () => "result",
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
				dispose: () => {
					assert.equal(capability(), "terminal");
					disposed = true;
				},
			};
			// #3105: the SDK factory completes startup before returning the session.
			await session.extensionRunner.emit();
			return { session } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
		});
		try {
			const runtime = new SubagentControlRuntime({ path: `parent-${outcome}`, depth: 0 }, root);
			const agent = {
				name: "worker",
				description: "fixture",
				systemPrompt: "",
				systemPromptMode: "replace" as const,
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user" as const,
				filePath: join(root, "worker.md"),
			};
			runtime.registerAgents([agent]);
			const admission = runtime.admitChildSession({ taskName: "fixture", task: "fixture", agent, cwd: root });
			assert.ok(admission.admitted);
			const running = runtime.runChildAttempt(
				admission.admitted,
				{},
				{ abort: abort.signal, interrupt: interrupt.signal },
				undefined,
			);
			await Promise.race([
				entered.promise,
				running.then((result) => {
					throw new Error(`Ended before prompt: ${JSON.stringify(result)}`);
				}),
			]);
			assert.equal(capability(), "live");
			if (outcome === "cancelled") abort.abort();
			else if (outcome === "interrupted") interrupt.abort();
			else release.resolve();
			const result = await running;
			assert.equal(result.status, outcome === "completed" ? "ok" : outcome === "failed" ? "error" : "interrupted");
			assert.equal(capability(), "terminal");
			assert.deepEqual(updates, ["terminal"]);
			assert.equal(disposed, true);
		} finally {
			release.resolve();
			vi.restoreAllMocks();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
