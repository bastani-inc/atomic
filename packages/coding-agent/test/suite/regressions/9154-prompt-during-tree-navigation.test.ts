import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import type { AgentSessionInternalSurface } from "../../../src/core/agent-session-methods.js";
import { assistantMsg, userMsg } from "../../utilities.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seedHistory(harness: Harness): Promise<string> {
	await harness.sessionManager.appendMessage(userMsg("first prompt"));
	const targetId = await harness.sessionManager.appendMessage(assistantMsg("first response"));
	await harness.sessionManager.appendMessage(userMsg("second prompt"));
	await harness.sessionManager.appendMessage(assistantMsg("second response"));
	harness.session.refreshContext();
	return targetId;
}

describe("pi #9154: prompt during tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	// The inverse order also loses the completed prompt when navigation rebuilds the context.
	it.each(["input", "before_agent_start"] as const)("rejects navigation during an awaited %s hook", async (hook) => {
		const promptStarted = deferred();
		const promptReleased = deferred();
		const treeStarted = deferred();
		const treeReleased = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const pause = async () => {
						promptStarted.resolve();
						await promptReleased.promise;
					};
					if (hook === "input") pi.on("input", pause);
					else pi.on("before_agent_start", pause);
					pi.on("session_before_tree", async () => {
						treeStarted.resolve();
						await treeReleased.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = await seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("response to racing prompt")]);
		const prompt = harness.session.prompt("racing prompt", { source: "rpc" });
		await promptStarted.promise;
		const navigation = harness.session.navigateTree(targetId).then(
			() => undefined,
			(error: unknown) => error,
		);
		await Promise.race([treeStarted.promise, navigation]);
		try {
			promptReleased.resolve();
			await prompt;
		} finally {
			promptReleased.resolve();
			treeReleased.resolve();
		}
		const navigationError = await navigation;
		assert.ok(navigationError instanceof Error);
		assert.equal(
			navigationError.message,
			"Wait for the current response to finish before navigating the session tree.",
		);
		assert.ok(getUserTexts(harness).includes("racing prompt"));
		assert.ok(harness.session.messages.map(getMessageText).includes("response to racing prompt"));
		assert.equal((await harness.session.navigateTree(targetId)).cancelled, false);
	});

	it.each(["handled", "rejected"] as const)(
		"allows navigation after a prompt is %s during preflight",
		async (outcome) => {
			const harness = await createHarness({
				withConfiguredAuth: outcome !== "rejected",
				extensionFactories: [
					(pi) => {
						if (outcome === "handled") pi.on("input", async () => ({ action: "handled" }));
					},
				],
			});
			harnesses.push(harness);
			const targetId = await seedHistory(harness);
			const prompt = harness.session.prompt("not sent to the model");
			if (outcome === "handled") await prompt;
			else await assert.rejects(prompt, /No API key/);
			assert.equal((await harness.session.navigateTree(targetId)).cancelled, false);
		},
	);

	it("keeps navigation blocked when another prompt finishes preflight first", async () => {
		const started = deferred();
		const released = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "waiting prompt") {
							started.resolve();
							await released.promise;
						}
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = await seedHistory(harness);
		const waiting = harness.session.prompt("waiting prompt");
		await started.promise;
		try {
			await harness.session.prompt("handled immediately");
			await assert.rejects(
				harness.session.navigateTree(targetId),
				/Wait for the current response to finish before navigating the session tree\./,
			);
		} finally {
			released.resolve();
			await waiting;
		}
		assert.equal((await harness.session.navigateTree(targetId)).cancelled, false);
	});

	it.each(["completed prompt", "extension command"] as const)(
		"keeps navigation blocked during a prompt's preflight after an earlier %s",
		async (earlier) => {
			const started = deferred();
			const released = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("noop", { handler: async () => {} });
						pi.on("input", async (event) => {
							if (event.text !== "waiting prompt") return { action: "continue" };
							started.resolve();
							await released.promise;
							return { action: "handled" };
						});
					},
				],
			});
			harnesses.push(harness);
			const targetId = await seedHistory(harness);
			harness.setResponses([fauxAssistantMessage("earlier response")]);
			await harness.session.prompt(earlier === "completed prompt" ? "earlier prompt" : "/noop");
			const waiting = harness.session.prompt("waiting prompt");
			await started.promise;
			try {
				await assert.rejects(
					harness.session.navigateTree(targetId),
					/Wait for the current response to finish before navigating the session tree\./,
				);
			} finally {
				released.resolve();
				await waiting;
			}
			assert.equal((await harness.session.navigateTree(targetId)).cancelled, false);
		},
	);

	it("allows a prompt from session_tree after the selected context is installed", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async () => {
						await harness.session.sendUserMessage("continue on the selected branch");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		const targetId = await seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);
		await harness.session.navigateTree(targetId);
		assert.deepEqual(errors, []);
		assert.deepEqual(getUserTexts(harness), ["first prompt", "continue on the selected branch"]);
		assert.equal(harness.session.getLastAssistantText(), "continued");
	});

	it("does not clear a new navigation started from session_tree", async () => {
		const started = deferred();
		const released = deferred();
		let nextTargetId = "";
		let continuation: Promise<unknown> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async (event) => {
						if (event.preparation.targetId === nextTargetId) {
							started.resolve();
							await released.promise;
						}
					});
					pi.on("session_tree", () => {
						continuation ??= harness.session.navigateTree(nextTargetId).then(
							() => undefined,
							(error: unknown) => error,
						);
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = await seedHistory(harness);
		nextTargetId = harness.sessionManager.getLeafId()!;
		try {
			await harness.session.navigateTree(targetId);
			assert.notEqual(continuation, undefined);
			await Promise.race([started.promise, continuation]);
			assert.equal(harness.session.isCompacting, true);
			assert.equal(harness.session.compactionReason, "branchSummary");
		} finally {
			released.resolve();
			await continuation;
		}
		assert.equal(await continuation, undefined);
		assert.equal(harness.sessionManager.getLeafId(), nextTargetId);
		assert.equal(harness.session.isCompacting, false);
		assert.equal(harness.session.compactionReason, undefined);
	});

	it("settles its compaction state when an extension cancels the navigation", async () => {
		const reasonsDuringNavigation: Array<string | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						reasonsDuringNavigation.push(harness.session.compactionReason);
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = await seedHistory(harness);
		assert.equal((await harness.session.navigateTree(targetId)).cancelled, true);
		assert.deepEqual(reasonsDuringNavigation, ["branchSummary"]);
		assert.equal(harness.session.isCompacting, false);
		assert.equal(harness.session.compactionReason, undefined);
	});

	it("leaves a compaction reason set by another operation alone", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetId = await seedHistory(harness);
		(harness.session as AgentSessionInternalSurface)._compactionReason = "threshold";
		assert.equal((await harness.session.navigateTree(targetId)).cancelled, false);
		assert.equal(harness.session.compactionReason, "threshold");
	});

	it.each(["command", "agent_settled"] as const)("allows navigation from an extension %s", async (event) => {
		let targetId = "";
		let navigated = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const navigate = async () => {
						await harness.session.navigateTree(targetId);
						navigated = true;
					};
					if (event === "command") pi.registerCommand("rewind", { handler: navigate });
					else pi.on("agent_settled", navigate);
				},
			],
		});
		harnesses.push(harness);
		targetId = await seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt(event === "command" ? "/rewind" : "finish then rewind");
		assert.equal(navigated, true);
		assert.equal(harness.sessionManager.getLeafId(), targetId);
	});
});
