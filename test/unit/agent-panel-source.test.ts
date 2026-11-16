import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
	stopAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";

const healthyItem: AgentPanelItem = {
	id: "run:healthy",
	kind: "workflow",
	state: "running",
	name: "healthy",
	task: "implement",
};

function panelFixture() {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	hub.register({ items: () => [healthyItem], subscribe: () => () => {} });
	return { hub, session };
}

test("a throwing source reporter cannot discard healthy rows or escape the host (#5239)", () => {
	const { hub, session } = panelFixture();
	hub.register({
		items() {
			throw new Error("source exploded");
		},
		subscribe: () => () => {},
	});
	let reports = 0;
	const read = () =>
		agentPanelItems(session, () => {
			reports++;
			throw new Error("notification failed");
		});
	assert.deepEqual(
		read().map((item) => item.id),
		[healthyItem.id],
	);
	assert.deepEqual(
		read().map((item) => item.id),
		[healthyItem.id],
	);
	assert.equal(reports, 1);
});

for (const failure of [
	{ name: "unprintable value", value: Object.create(null) },
	{
		name: "error with a throwing message getter",
		value: Object.defineProperty(new Error(), "message", {
			get() {
				throw new Error("message failed");
			},
		}),
	},
]) {
	test(`a source throwing an ${failure.name} is reported safely without losing healthy rows (#5239)`, () => {
		const { hub, session } = panelFixture();
		hub.register({
			items() {
				throw failure.value;
			},
			subscribe: () => () => {},
		});
		const reports: string[] = [];
		assert.deepEqual(
			agentPanelItems(session, (error) => reports.push(error.message)).map((item) => item.id),
			[healthyItem.id],
		);
		assert.equal(reports.length, 1);
		assert.equal(typeof reports[0], "string");
		assert.ok(reports[0]!.length > 0);
	});
}

for (const field of ["id", "name", "progress", "choices"] as const) {
	test(`a throwing source item's ${field} getter cannot escape a panel read or later render (#5239)`, () => {
		const { hub, session } = panelFixture();
		const broken = Object.defineProperty({ ...healthyItem, id: "run:broken" }, field, {
			get() {
				throw new Error(`${field} failed`);
			},
		});
		hub.register({ items: () => [broken], subscribe: () => () => {} });
		const reports: string[] = [];
		const items = agentPanelItems(session, (error) => reports.push(error.message));
		assert.deepEqual(
			items.map((item) => item.name),
			[healthyItem.name],
		);
		assert.deepEqual(reports, [`${field} failed`]);
	});
}

test("a source that throws while subscribing cannot interrupt registration or leave broken rows (#5239)", () => {
	const { hub, session } = panelFixture();
	let changes = 0;
	hub.subscribe(() => changes++);
	assert.doesNotThrow(() =>
		hub.register({
			items: () => [{ ...healthyItem, id: "run:broken" }],
			subscribe() {
				throw new Error("subscribe failed");
			},
		}),
	);
	assert.deepEqual(
		agentPanelItems(session).map((item) => item.id),
		[healthyItem.id],
	);
	hub.register({ items: () => [], subscribe: () => () => {} });
	assert.equal(changes, 1);
});

test("throwing source cleanup cannot block removal, other cleanups or later panel updates (#5239)", () => {
	const { hub, session } = panelFixture();
	let changes = 0;
	let cleanups = 0;
	let emit = () => {};
	hub.subscribe(() => changes++);
	const registration = hub.register({
		items: () => [{ ...healthyItem, id: "run:broken" }],
		subscribe(listener) {
			emit = listener;
			return () => {
				cleanups++;
				throw new Error("unsubscribe failed");
			};
		},
	});
	assert.doesNotThrow(() => registration.dispose());
	assert.equal(changes, 2);
	assert.deepEqual(
		agentPanelItems(session).map((item) => item.id),
		[healthyItem.id],
	);
	emit();
	registration.dispose();
	assert.equal(changes, 2);
	assert.equal(cleanups, 1);
	hub.register({
		items: () => [],
		subscribe: () => () => {
			cleanups++;
			throw new Error("cleanup failed");
		},
	});
	hub.register({
		items: () => [],
		subscribe: () => () => {
			cleanups++;
		},
	});
	assert.doesNotThrow(() => hub.dispose());
	assert.equal(cleanups, 3);
	assert.deepEqual(agentPanelItems(session), []);
	hub.dispose();
	assert.equal(cleanups, 3);
});

test("a throwing panel subscriber cannot block healthy listeners or escape a source notification (#5239)", () => {
	const { hub } = panelFixture();
	let changes = 0;
	let emit = () => {};
	hub.subscribe(() => {
		throw new Error("listener failed");
	});
	hub.subscribe(() => changes++);
	let dispose = () => {};
	assert.doesNotThrow(() => {
		dispose = hub.register({
			items: () => [],
			subscribe(listener) {
				emit = listener;
				return () => {};
			},
		}).dispose;
	});
	assert.doesNotThrow(emit);
	assert.doesNotThrow(dispose);
	assert.doesNotThrow(() => hub.dispose());
	assert.equal(changes, 4);
});

for (const failure of ["method", "getter"] as const) {
	test(`throwing source action ${failure}s cannot crash navigation or reject stop and answer (#5239)`, async () => {
		const { hub, session } = panelFixture();
		const fail = () => {
			throw new Error("action failed");
		};
		const source = { items: () => [{ ...healthyItem, id: "run:broken" }], subscribe: () => () => {} };
		for (const action of ["open", "stop", "answer"]) {
			Object.defineProperty(source, action, failure === "getter" ? { get: fail } : { value: fail });
		}
		hub.register(source);
		assert.equal(openAgentPanelItem(session, "run:broken"), false);
		assert.deepEqual(await stopAgentPanelItem(session, "run:broken"), { ok: false, reason: "action failed" });
		assert.deepEqual(await answerAgentPanelItem(session, "run:broken", "yes"), {
			ok: false,
			reason: "action failed",
		});
		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			[healthyItem.id, "run:broken"],
		);
	});
}

for (const field of ["ok", "reason"] as const) {
	test(`a throwing source action result's ${field} getter never reaches the host (#5239)`, async () => {
		const { hub, session } = panelFixture();
		const result = Object.defineProperty({ ok: false as const, reason: "blocked" }, field, {
			get() {
				throw new Error(`${field} failed`);
			},
		});
		hub.register({
			items: () => [{ ...healthyItem, id: "run:result" }],
			subscribe: () => () => {},
			stop: async () => result,
			answer: async () => result,
		});
		assert.deepEqual(await stopAgentPanelItem(session, "run:result"), { ok: false, reason: `${field} failed` });
		assert.deepEqual(await answerAgentPanelItem(session, "run:result", "yes"), {
			ok: false,
			reason: `${field} failed`,
		});
	});
}

test("rejected source actions return failures and fire-and-forget callbacks never become unhandled rejections (#5239)", async () => {
	const { hub, session } = panelFixture();
	let calls = 0;
	const fail = async () => {
		calls++;
		throw Object.create(null);
	};
	hub.subscribe(fail);
	const registration = hub.register({
		items: () => [{ ...healthyItem, id: "run:async" }],
		subscribe: () => fail,
		open: fail,
		stop: fail,
		answer: fail,
	});
	assert.equal(openAgentPanelItem(session, "run:async"), true);
	assert.deepEqual(await stopAgentPanelItem(session, "run:async"), {
		ok: false,
		reason: "Agent panel source failed.",
	});
	assert.deepEqual(await answerAgentPanelItem(session, "run:async", "yes"), {
		ok: false,
		reason: "Agent panel source failed.",
	});
	hub.register({
		items() {
			throw new Error("items failed");
		},
		subscribe: () => () => {},
	});
	agentPanelItems(session, fail);
	registration.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 8);
});

test("panel rows retain a safe snapshot when a source changes its returned objects (#5239)", () => {
	const { hub, session } = panelFixture();
	const item = { ...healthyItem, id: "run:snapshot", progress: { done: 1, total: 3 }, choices: ["yes"] };
	hub.register({ items: () => [item], subscribe: () => () => {} });
	const rows = agentPanelItems(session);
	item.progress.done = 2;
	item.choices.push("no");
	Object.defineProperty(item, "name", {
		get() {
			throw new Error("changed after reading");
		},
	});
	assert.equal(rows[1]?.name, healthyItem.name);
	assert.deepEqual(rows[1]?.progress, { done: 1, total: 3 });
	assert.deepEqual(rows[1]?.choices, ["yes"]);
});
