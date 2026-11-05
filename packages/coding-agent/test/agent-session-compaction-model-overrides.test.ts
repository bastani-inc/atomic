import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, it } from "vitest";
import { convertToLlm } from "../src/core/messages.js";
import { createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.js";

const longPrompt = Array.from({ length: 24 }, (_, i) => `context line ${i}`).join("\n");

// Upstream #8133: resolve against the active session model, not the planner model.
describe("session compaction model overrides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("uses the current model's exact tail for manual compaction after a switch", async () => {
		const tails: number[] = [];
		const harness = await createHarnessWithExtensions({
			settings: {
				compaction: {
					enabled: false,
					preserve_recent: 2,
					modelOverrides: { "faux/faux-1": { preserve_recent: 0 }, "faux/faux-2": { preserve_recent: 1 } },
				},
			},
			responses: ["first response", "second response"],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						tails.push(event.parameters.preserve_recent);
						return { compactedText: "[User]: retained" };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt(longPrompt);
		const first = await harness.session.compact();
		assert.equal(first.parameters.preserve_recent, 0);
		await harness.session.setModel({ ...fauxModel, id: "faux-2" });
		await harness.session.prompt(longPrompt);
		const second = await harness.session.compact();
		assert.equal(second.parameters.preserve_recent, 1);
		assert.deepEqual(tails, [0, 1]);
	});

	for (const reserveTokens of [0, 200]) {
		it(`uses reserve ${reserveTokens} for actual end-of-turn threshold decisions`, async () => {
			const tails: number[] = [];
			const harness = await createHarnessWithExtensions({
				contextWindow: 1000,
				settings: {
					compaction: {
						background: false,
						reserveTokens: reserveTokens === 0 ? 200 : 0,
						preserve_recent: 2,
						modelOverrides: { "faux/faux-1": { reserveTokens, preserve_recent: 0 } },
					},
				},
				responses: [{ text: "complete", usage: { input: 850, output: 10, totalTokens: 860 } }],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							tails.push(event.parameters.preserve_recent);
							return { compactedText: "[User]: retained" };
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			await harness.session.prompt(longPrompt);
			assert.deepEqual(tails, reserveTokens === 0 ? [] : [0]);
			assert.equal(harness.eventsOfType("compaction_start").length, reserveTokens === 0 ? 0 : 1);
		});

		it(`uses reserve ${reserveTokens} before the next post-tool request`, async () => {
			const tool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Controlled result",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "x".repeat(480) }], details: {} }),
			};
			const harness = await createHarnessWithExtensions({
				contextWindow: 1000,
				settings: {
					compaction: {
						background: false,
						reserveTokens: reserveTokens === 0 ? 200 : 0,
						modelOverrides: { "faux/faux-1": { reserveTokens, preserve_recent: 0 } },
					},
				},
				responses: [
					{
						toolCalls: [{ id: "call-1", name: "large_result", args: {} }],
						usage: { input: 700, output: 20, totalTokens: 720 },
					},
					"complete",
				],
				baseToolsOverride: { large_result: tool },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							assert.equal(event.parameters.preserve_recent, 0);
							return { compactedText: "[User]: retained" };
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			harness.session.setActiveToolsByName(["large_result"]);
			harness.agent.convertToLlm = convertToLlm;
			await harness.session.prompt(longPrompt);
			assert.equal(harness.faux.callCount, 2);
			assert.equal(
				harness.eventsOfType("compaction_start").filter((event) => event.midTurn).length,
				reserveTokens === 0 ? 0 : 1,
			);
		});
	}
});
