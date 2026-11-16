import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelItems,
	agentPanelTaskId,
	answerAgentPanelItem,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	sourceError,
	stopAgentPanelItem,
	subscribeAgentPanel,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { taskFixture } from "../helpers/task-projection.js";

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

test("stop and answer normalize non-string reasons and non-string ids without throwing or rejecting (#5239)", async () => {
	const { hub, session } = panelFixture();
	const reasons: unknown[] = [
		Symbol("stop-symbol"),
		Object.create(null),
		{
			toString() {
				throw new Error("toString boom");
			},
		},
		{
			toString() {
				throw Object.create(null);
			},
		},
		42,
		null,
		undefined,
	];
	let currentReason: unknown = reasons[0];
	hub.register({
		items: () => [{ ...healthyItem, id: "run:reason" }],
		subscribe: () => () => {},
		stop: async () => ({ ok: false, reason: currentReason as string }),
		answer: async () => ({ ok: false, reason: currentReason as string }),
	});
	for (const reason of reasons) {
		currentReason = reason;
		const stopped = await stopAgentPanelItem(session, "run:reason");
		const answered = await answerAgentPanelItem(session, "run:reason", "ok");
		assert.equal(stopped.ok, false);
		assert.equal(answered.ok, false);
		if (!stopped.ok) {
			assert.equal(typeof stopped.reason, "string");
			assert.ok(stopped.reason.length > 0);
			assert.doesNotThrow(() => `Could not stop: ${stopped.reason}`);
		}
		if (!answered.ok) {
			assert.equal(typeof answered.reason, "string");
			assert.ok(answered.reason.length > 0);
			assert.doesNotThrow(() => `Could not answer: ${answered.reason}`);
		}
	}
	for (const badId of [
		42,
		undefined,
		null,
		"",
		{
			startsWith() {
				throw Object.create(null);
			},
		},
	]) {
		assert.equal(agentPanelTaskId(badId as never), undefined);
		assert.equal(openAgentPanelItem(session, badId as never), false);
		const stopped = await stopAgentPanelItem(session, badId as never);
		const answered = await answerAgentPanelItem(session, badId as never, "yes");
		assert.equal(stopped.ok, false);
		assert.equal(answered.ok, false);
	}
});

test("sourceError normalizes arbitrary thrown values and hostile error getters without throwing (#5239)", () => {
	for (const input of [
		new Error("plain"),
		new Error(""),
		"",
		"text",
		Symbol("sym"),
		Object.create(null),
		null,
		undefined,
		{
			toString() {
				throw new Error("inner boom");
			},
		},
		{
			toString() {
				throw Object.create(null);
			},
		},
		Object.defineProperty(new Error("ignored"), "message", {
			get() {
				throw Object.create(null);
			},
		}),
	]) {
		const err = sourceError(input);
		assert.ok(err instanceof Error);
		assert.equal(typeof err.message, "string");
		assert.ok(err.message.length > 0);
	}
});

test("malformed source items and non-iterable item lists are dropped and reported once while keeping valid rows (#5239)", () => {
	const { hub, session } = panelFixture();
	const validSibling: AgentPanelItem = {
		id: "run:sibling",
		kind: "workflow",
		state: "input",
		name: "sibling",
		task: "stage ask",
		elapsedMs: 1000,
		tokens: 500,
		progress: { done: 1, total: 3 },
		question: "Proceed?",
		choices: ["yes", "no"],
		reason: "waiting",
		queued: 2,
		endedAt: 2000,
	};
	const malformedItems: unknown[] = [
		null,
		undefined,
		"not-an-object",
		42,
		{ ...healthyItem, id: 42 },
		{ ...healthyItem, id: "" },
		{ ...healthyItem, id: "main" },
		{ ...healthyItem, id: "run:bad-kind", kind: "other" },
		{ ...healthyItem, id: "run:bad-state", state: "other" },
		{ ...healthyItem, id: "run:bad-name", name: undefined },
		{ ...healthyItem, id: "run:bad-task", task: undefined },
		{ ...healthyItem, id: "run:bad-elapsed-neg", elapsedMs: -1 },
		{ ...healthyItem, id: "run:bad-elapsed-nan", elapsedMs: Number.NaN },
		{
			...healthyItem,
			id: "run:bad-elapsed-obj",
			elapsedMs: {
				valueOf() {
					throw Object.create(null);
				},
			},
		},
		{ ...healthyItem, id: "run:bad-tokens-esc", tokens: "\x1b[2J\x1b[H" },
		{ ...healthyItem, id: "run:bad-tokens-title", tokens: "\x1b]0;pwned\x07" },
		{ ...healthyItem, id: "run:bad-queued-str", queued: "1\n2" },
		{ ...healthyItem, id: "run:bad-queued-float", queued: 1.5 },
		{ ...healthyItem, id: "run:bad-queued-neg", queued: -1 },
		{ ...healthyItem, id: "run:bad-ended", endedAt: Number.POSITIVE_INFINITY },
		{ ...healthyItem, id: "run:bad-progress-neg", progress: { done: -1, total: 3 } },
		{ ...healthyItem, id: "run:bad-progress-null", progress: null },
		{ ...healthyItem, id: "run:bad-question", question: 123 },
		{ ...healthyItem, id: "run:bad-reason", reason: {} },
		{ ...healthyItem, id: "run:bad-choices-str", choices: "ab" },
		{ ...healthyItem, id: "run:bad-choices-elem", choices: ["ok", 123] },
	];
	hub.register({
		items: () => [...(malformedItems as AgentPanelItem[]), validSibling],
		subscribe: () => () => {},
	});
	for (const badReturn of [undefined, null, "string-items", 123, {}]) {
		hub.register({
			items: () => badReturn as never,
			subscribe: () => () => {},
		});
	}
	const reports: string[] = [];
	const first = agentPanelItems(session, (error) => reports.push(error.message));
	const second = agentPanelItems(session, (error) => reports.push(error.message));
	assert.deepEqual(
		first.map((item) => item.id),
		[healthyItem.id, validSibling.id],
	);
	assert.deepEqual(
		second.map((item) => item.id),
		[healthyItem.id, validSibling.id],
	);
	assert.equal(reports.length, 6);
});

test("duplicate item ids and reserved task ids are deduplicated, reported once, and never hijack actions (#5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("real task");
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const hub = new AgentPanelSourceHub();
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);
		const stoppedBySource: string[] = [];
		hub.register({
			items: () => [
				{ ...healthyItem, id: "ext:a", name: "first-a" },
				{ ...healthyItem, id: "ext:a", name: "dup-a" },
				{ ...healthyItem, id: "ext:b", name: "first-b" },
			],
			subscribe: () => () => {},
			stop: async (id) => {
				stoppedBySource.push(`s1:${id}`);
				return { ok: true };
			},
		});
		hub.register({
			items: () => [
				{ ...healthyItem, id: "ext:a", name: "second-source-a" },
				{ ...healthyItem, id: `task:${taskId}`, name: "shadow-task" },
				{ ...healthyItem, id: "main", name: "shadow-main" },
				{ ...healthyItem, id: "ext:c", name: "first-c" },
			],
			subscribe: () => () => {},
			stop: async (id) => {
				stoppedBySource.push(`s2:${id}`);
				return { ok: true };
			},
		});
		const reports: string[] = [];
		const items = agentPanelItems(session, (error) => reports.push(error.message));
		assert.deepEqual(
			items.map((item) => `${item.id}:${item.name}`),
			["ext:a:first-a", "ext:b:first-b", "ext:c:first-c", `task:${taskId}:worker`],
		);
		assert.equal(reports.length, 2);
		agentPanelItems(session, (error) => reports.push(error.message));
		assert.equal(reports.length, 2);

		dismissedAgentPanelItems(session).add("ext:a");
		assert.deepEqual(await stopAgentPanelItem(session, "ext:a"), { ok: true });
		assert.deepEqual(stoppedBySource, ["s1:ext:a"]);

		const missingTaskStop = await stopAgentPanelItem(session, "task:missing-task");
		assert.deepEqual(missingTaskStop, { ok: false, reason: "UnknownTask" });
	} finally {
		await fixture.dispose();
	}
});

test("re-registering a source inside its own unsubscribe runs each cleanup once and keeps the new subscription (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	const counts = [0, 0, 0];
	let call = 0;
	const emits: Array<() => void> = [];
	const source = {
		items: () => [healthyItem],
		subscribe(listener: () => void) {
			const index = call++;
			emits[index] = listener;
			return () => {
				counts[index]!++;
				if (index === 0) hub.register(source);
			};
		},
	};
	hub.register(source);
	hub.register(source);
	assert.deepEqual(counts, [1, 1, 0]);
	let notifications = 0;
	hub.subscribe(() => notifications++);
	emits[2]?.();
	assert.equal(notifications, 1);
	hub.dispose();
	assert.deepEqual(counts, [1, 1, 1]);

	const disposeHub = new AgentPanelSourceHub();
	const disposeCounts = [0, 0];
	let disposeCall = 0;
	const disposeSource = {
		items: () => [healthyItem],
		subscribe() {
			const index = disposeCall++;
			return () => {
				disposeCounts[index]!++;
				if (index === 0) disposeHub.register(disposeSource);
			};
		},
	};
	disposeHub.register(disposeSource);
	disposeHub.dispose();
	assert.deepEqual(disposeCounts, [1, 0]);
	assert.deepEqual(disposeHub.all(), []);
});

test("subscribeAgentPanel follows extension runner hub swaps across reload and contains throwing listeners (#5239)", async () => {
	const currentHub = new AgentPanelSourceHub();
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => currentHub,
		},
	};
	let notifications = 0;
	const unsubThrowing = subscribeAgentPanel(session, () => {
		throw Object.create(null);
	});
	const unsub = subscribeAgentPanel(session, () => {
		notifications++;
	});
	try {
		const oldHub = currentHub;
		const nextHub = new AgentPanelSourceHub();
		let emitReloaded = () => {};
		nextHub.register({
			items: () => [{ ...healthyItem, id: "run:reloaded" }],
			subscribe(listener) {
				emitReloaded = listener;
				return () => {};
			},
		});
		session.extensionRunner = { getAgentPanelSourceHub: () => nextHub };
		oldHub.dispose();
		const afterReload = notifications;
		assert.ok(afterReload >= 1);
		emitReloaded();
		assert.equal(notifications, afterReload + 1);
		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			["run:reloaded"],
		);
	} finally {
		unsubThrowing();
		unsub();
	}
});

test("source items are validated and copied once per source change version and invalidated on notify (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let itemCalls = 0;
	let choiceReads = 0;
	let notifySource = () => {};
	let label = "v1";
	const choices = {
		*[Symbol.iterator]() {
			choiceReads++;
			yield "alpha";
			yield "beta";
		},
	};
	hub.register({
		items() {
			itemCalls++;
			return [
				{
					...healthyItem,
					id: "run:cached",
					name: label,
					choices: choices as unknown as readonly string[],
				},
			];
		},
		subscribe(listener) {
			notifySource = listener;
			return () => {};
		},
	});
	assert.equal(openAgentPanelItem(session, "run:cached"), false);
	assert.equal(itemCalls, 1);
	assert.equal(choiceReads, 1);
	for (let i = 0; i < 50; i++) {
		const items = agentPanelItems(session);
		assert.equal(items[0]?.name, "v1");
		assert.deepEqual(items[0]?.choices, ["alpha", "beta"]);
	}
	assert.equal(itemCalls, 1);
	assert.equal(choiceReads, 1);
	label = "v2";
	notifySource();
	const updated = agentPanelItems(session);
	assert.equal(updated[0]?.name, "v2");
	assert.equal(itemCalls, 2);
	assert.equal(choiceReads, 2);
});

test("async items and subscribe callbacks that return rejected promises are drained and never cause unhandled rejections (#5239)", async () => {
	const { hub, session } = panelFixture();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		hub.register({
			items: () => [{ ...healthyItem, id: "run:async-sub" }],
			subscribe: (async () => {
				throw new Error("async subscribe failed");
			}) as unknown as () => () => void,
		});
		hub.register({
			items: (async () => {
				throw new Error("async items failed");
			}) as unknown as () => readonly AgentPanelItem[],
			subscribe: () => () => {},
		});
		hub.register({
			items: () => [
				Promise.reject(new Error("async item element")) as unknown as AgentPanelItem,
				{
					...healthyItem,
					id: "run:async-fields",
					progress: Promise.reject(new Error("async progress")) as unknown as {
						done: number;
						total: number;
					},
					choices: Array.from(
						{ length: 70 },
						() => Promise.reject(new Error("async choice")) as unknown as string,
					),
				},
			],
			subscribe: () => () => {},
		});
		const reports: string[] = [];
		const items = agentPanelItems(session, (error) => reports.push(error.message));
		hub.register({
			items: () => [{ ...healthyItem, id: "run:async-reason" }],
			subscribe: () => () => {},
			stop: async () => ({
				ok: false as const,
				reason: Promise.reject(new Error("async stop reason")) as unknown as string,
			}),
			answer: async () => ({
				ok: false as const,
				reason: Promise.reject(new Error("async answer reason")) as unknown as string,
			}),
		});
		const stopped = await stopAgentPanelItem(session, "run:async-reason");
		const answered = await answerAgentPanelItem(session, "run:async-reason", "ok");
		assert.equal(stopped.ok, false);
		assert.equal(answered.ok, false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(
			items.map((item) => item.id),
			[healthyItem.id],
		);
		assert.equal(reports.length, 2);
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
