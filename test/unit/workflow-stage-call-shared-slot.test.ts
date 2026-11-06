import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

/** Event-loop turns given to a stage that has a free slot to start its prompt; far more than it needs. */
const START_TURNS = 50;

async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Sessions whose prompts record which stage entered them, then wait for the gate of that stage's nth prompt. */
function gatedSessions(
	entered: string[],
	gateFor: (stageName: string, prompt: number) => Promise<void> | undefined,
): StageAdapters {
	const prompts = new Map<string, number>();
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(options, meta) {
				const stageName = meta?.stageName ?? "stage";
				return {
					...mockSession(options.sessionManager as SessionManager),
					async prompt() {
						const prompt = prompts.get(stageName) ?? 0;
						prompts.set(stageName, prompt + 1);
						entered.push(stageName);
						await gateFor(stageName, prompt);
					},
				};
			},
		},
	};
}

const CONFIG = {
	defaultConcurrency: 2,
	maxDepth: 10,
	persistRuns: false,
	statusFile: false,
	resumeInFlight: "never",
} as const;

test("concurrent messages to one stage hold one slot and give it back, so later stages still run in parallel (#4309)", async () => {
	const entered: string[] = [];
	const aGate = Promise.withResolvers<void>();
	const laterGate = Promise.withResolvers<void>();
	const gates = new Map([
		["a", aGate.promise],
		["b", laterGate.promise],
		["c", laterGate.promise],
	]);
	let laterStagesStartedTogether = false;
	const result = await run(
		workflow({
			name: "stage-call-slots",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const a = ctx.stage("a");
				// Two messages to the idle stage, both in flight before either is delivered.
				const first = a.sendUserMessage("first");
				const second = a.sendUserMessage("second");
				await turns(START_TURNS);
				aGate.resolve();
				await Promise.all([first, second]);

				// With every slot given back, both later stages start before either ends.
				const b = ctx.stage("b").prompt("plan b");
				const c = ctx.stage("c").prompt("plan c");
				await turns(START_TURNS);
				laterStagesStartedTogether = entered.includes("b") && entered.includes("c");
				laterGate.resolve();
				await Promise.all([b, c]);
				return {};
			},
		}),
		{},
		{
			store: createStore(),
			adapters: gatedSessions(entered, (stageName) => gates.get(stageName)),
			config: CONFIG,
		},
	);

	assert.equal(result.status, "completed", result.error);
	assert.equal(laterStagesStartedTogether, true);
});

test("the stage's slot stays held until its last overlapping message ends (#4309)", async () => {
	const entered: string[] = [];
	const firstGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	const laterGate = Promise.withResolvers<void>();
	const gateFor = (stageName: string, prompt: number): Promise<void> => {
		if (stageName !== "a") return laterGate.promise;
		return prompt === 0 ? firstGate.promise : secondGate.promise;
	};
	const later = (): string[] => entered.filter((stageName) => stageName !== "a");
	let startedWhileSecondRan: string[] = [];
	let startedAfterBothEnded: string[] = [];
	const result = await run(
		workflow({
			name: "stage-call-slot-owner",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const a = ctx.stage("a");
				const first = a.sendUserMessage("first");
				const second = a.sendUserMessage("second");
				await turns(START_TURNS);
				// The first message ends while the second is still in flight.
				firstGate.resolve();
				await first;
				await turns(START_TURNS);

				// Stage a still holds its one slot, so of two later stages only one fits under the limit of 2.
				const b = ctx.stage("b").prompt("plan b");
				const c = ctx.stage("c").prompt("plan c");
				await turns(START_TURNS);
				startedWhileSecondRan = later();

				// Once the last message ends, the slot is free and the other later stage starts. Whether the second message
				// is delivered after the first ended the stage is not what this checks, only that its end frees the slot.
				secondGate.resolve();
				await second.then(
					() => undefined,
					() => undefined,
				);
				await turns(START_TURNS);
				startedAfterBothEnded = later();
				laterGate.resolve();
				await Promise.all([b, c]);
				return {};
			},
		}),
		{},
		{ store: createStore(), adapters: gatedSessions(entered, gateFor), config: CONFIG },
	);

	assert.equal(result.status, "completed", result.error);
	assert.equal(startedWhileSecondRan.length, 1);
	assert.deepEqual([...startedAfterBothEnded].sort(), ["b", "c"]);
});
