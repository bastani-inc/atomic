import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
	type AgentPanelSource,
	AgentPanelSourceHub,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
	stopAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";

const row = (id: string) => ({ id, kind: "agent" as const, state: "running" as const, name: id, task: "t" });

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
	unhandled.push(reason);
};

beforeEach(() => {
	initTheme("dark");
	unhandled = [];
	process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
});

class SpeciesThrows extends Promise<unknown> {
	static override get [Symbol.species](): PromiseConstructor {
		throw new Error("species getter");
	}
}

let recursiveDepth = 0;
function recursiveThen(): object {
	recursiveDepth++;
	return {
		get then() {
			throw recursiveThen();
		},
	};
}

async function exercise(source: Partial<AgentPanelSource>) {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	hub.register({ items: () => [row("ok")], subscribe: () => () => {}, ...source } as AgentPanelSource);
	const warnings: string[] = [];
	const dispose = bindAgentPanel(session, {
		setWidget(_key, factory) {
			if (typeof factory === "function") {
				const component = factory({ requestRender() {} } as never, {} as never) as {
					render(width: number): string[];
				};
				for (let index = 0; index < 3; index++) component.render(120);
			}
		},
		requestRender() {},
		notify(message: string) {
			warnings.push(message);
		},
	} as never);
	const reports: string[] = [];
	const items = agentPanelItems(session, (error) => reports.push(error.message));
	const bounded = <T>(promise: Promise<T>) =>
		Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 500))]);
	const stopped = await bounded(stopAgentPanelItem(session, "ok"));
	const answered = await bounded(answerAgentPanelItem(session, "ok", "yes"));
	const opened = openAgentPanelItem(session, "ok");
	dispose();
	hub.dispose();
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { items, reports, stopped, answered, opened };
}

test("a source that throws a promise whose species getter throws is contained, never an unhandled rejection (#5239)", async () => {
	const { items } = await exercise({
		items: () => {
			throw SpeciesThrows.reject(new Error("rejected:species"));
		},
	});
	assert.deepEqual(items, []);
	assert.deepEqual(unhandled, []);
});

test("stop and answer results that are species-hostile promises settle as failures (#5239)", async () => {
	const { stopped, answered } = await exercise({
		stop: () => SpeciesThrows.reject(new Error("rejected:stop-species")) as never,
		answer: () => SpeciesThrows.reject(new Error("rejected:answer-species")) as never,
	});
	assert.equal((stopped as { ok: boolean }).ok, false);
	assert.equal((answered as { ok: boolean }).ok, false);
	assert.deepEqual(unhandled, []);
});

test("a thenable whose then getter throws another such thenable without end is drained to a bound (#5239)", async () => {
	recursiveDepth = 0;
	const { items, stopped, answered, opened } = await exercise({
		items: () => {
			throw recursiveThen();
		},
		stop: async () => {
			throw recursiveThen();
		},
		answer: async () => recursiveThen() as never,
		open: () => {
			throw recursiveThen();
		},
	});
	assert.deepEqual(items, []);
	assert.notEqual(stopped, "pending", "stop settles");
	assert.notEqual(answered, "pending", "answer settles");
	assert.equal(opened, false);
	assert.ok(recursiveDepth < 10_000, `drained to a bound, read ${recursiveDepth} thenables`);
	assert.deepEqual(unhandled, []);
});
