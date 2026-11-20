import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelItem,
	type AgentPanelSource,
	AgentPanelSourceHub,
	agentPanelItems,
	agentPanelTaskId,
	answerAgentPanelItem,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	sourceError,
	stopAgentPanelItem,
	subscribeAgentPanel,
	taskPanelItems,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore, setTaskTurnInterrupted } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { dismissedTasks } from "../../packages/coding-agent/src/modes/interactive/components/task-dismissal.js";
import { agentPanelCounts, agentPanelRows } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

const healthyItem: AgentPanelItem = {
	id: "run:healthy",
	kind: "agent",
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
		kind: "agent",
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

for (const tokenPayload of [
	{ label: "CSI escape", value: "\x1b[2J\x1b[H" },
	{ label: "OSC escape", value: "\x1b]0;pwned\x07" },
] as const) {
	test(`isolated ${tokenPayload.label} token payload is rejected and reported once (#5224, #5239)`, () => {
		const isolatedHub = new AgentPanelSourceHub();
		const isolatedSession = { extensionRunner: { getAgentPanelSourceHub: () => isolatedHub } };
		isolatedHub.register({
			items: () => [{ ...healthyItem, id: "run:isolated-token", tokens: tokenPayload.value as unknown as number }],
			subscribe: () => () => {},
		});
		const tokenReports: string[] = [];
		assert.deepEqual(
			agentPanelItems(isolatedSession, (error) => tokenReports.push(error.message)),
			[],
		);
		assert.equal(tokenReports.length, 1);
	});
}

test("isolated newline queued payload is rejected and reported once (#5224, #5239)", () => {
	const isolatedHub = new AgentPanelSourceHub();
	const isolatedSession = { extensionRunner: { getAgentPanelSourceHub: () => isolatedHub } };
	isolatedHub.register({
		items: () => [{ ...healthyItem, id: "run:isolated-queued", queued: "1\n2" as unknown as number }],
		subscribe: () => () => {},
	});
	const queuedReports: string[] = [];
	assert.deepEqual(
		agentPanelItems(isolatedSession, (error) => queuedReports.push(error.message)),
		[],
	);
	assert.equal(queuedReports.length, 1);
});

test("non-integer token counts are rejected while integer token counts are kept (#5224, #5239)", () => {
	const tokenHub = new AgentPanelSourceHub();
	const tokenSession = { extensionRunner: { getAgentPanelSourceHub: () => tokenHub } };
	tokenHub.register({
		items: () => [
			{ ...healthyItem, id: "ext:float-tokens", tokens: 0.1 + 0.2 },
			{ ...healthyItem, id: "ext:exp-tokens", tokens: 1e-7 },
			{ ...healthyItem, id: "ext:int-tokens", tokens: 812 },
		],
		subscribe: () => () => {},
	});
	const tokenReports: string[] = [];
	assert.deepEqual(
		agentPanelItems(tokenSession, (error) => tokenReports.push(error.message)).map((item) => item.id),
		["ext:int-tokens"],
	);
	assert.equal(tokenReports.length, 1);
});

test("a malformed or throwing item only hides that row while keeping valid neighbors and indexing array choices (#5224, #5239)", () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const arrayWithoutIterator = ["yes", "no"];
	Object.defineProperty(arrayWithoutIterator, Symbol.iterator, {
		value() {
			throw new Error("choices iterator must not be called");
		},
	});
	const mutatingLengthChoices: string[] = ["first", "second"];
	Object.defineProperty(mutatingLengthChoices, 0, {
		enumerable: true,
		get() {
			if (mutatingLengthChoices.length < 10) mutatingLengthChoices.push("extra");
			return "first";
		},
	});
	const infiniteChoices = {
		*[Symbol.iterator]() {
			while (true) yield "forever";
		},
	};
	const throwingProgressItem = Object.defineProperty({ ...healthyItem, id: "ext:throw-progress" }, "progress", {
		get() {
			throw new Error("progress getter boom");
		},
	});
	const throwingDoneItem = {
		...healthyItem,
		id: "ext:throw-done",
		progress: Object.defineProperty({ done: 0, total: 2 }, "done", {
			get() {
				throw new Error("done getter boom");
			},
		}),
	};
	const throwingChoiceElem = ["ok", "bad"];
	Object.defineProperty(throwingChoiceElem, 1, {
		enumerable: true,
		get() {
			throw new Error("choice element boom");
		},
	});
	hub.register({
		items: () => [
			{ ...healthyItem, id: "ext:first", name: "first" },
			{ ...healthyItem, id: "ext:obj-choices", state: "input", choices: {} as unknown as readonly string[] },
			{
				...healthyItem,
				id: "ext:inf-choices",
				state: "input",
				choices: infiniteChoices as unknown as readonly string[],
			},
			throwingProgressItem,
			throwingDoneItem,
			{ ...healthyItem, id: "ext:throw-choice", state: "input", choices: throwingChoiceElem },
			{
				...healthyItem,
				id: "ext:no-iter",
				state: "input",
				tokens: 812,
				choices: arrayWithoutIterator,
			},
			{
				...healthyItem,
				id: "ext:mut-len",
				state: "input",
				choices: mutatingLengthChoices,
			},
			{ ...healthyItem, id: "ext:last", name: "last" },
		],
		subscribe: () => () => {},
	});
	const reports: string[] = [];
	const items = agentPanelItems(session, (error) => reports.push(error.message));
	assert.deepEqual(
		items.map((item) => item.id),
		["ext:first", "ext:no-iter", "ext:mut-len", "ext:last"],
	);
	assert.deepEqual(items[1]?.choices, ["yes", "no"]);
	assert.equal(items[1]?.tokens, 812);
	assert.deepEqual(items[2]?.choices, ["first", "second"]);
	assert.equal(reports.length, 1);
});

test("array sources read rows by index and keep valid neighbors around a throwing row getter (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const rows = [
		{ ...healthyItem, id: "ext:first" },
		{ ...healthyItem, id: "ext:broken" },
		{ ...healthyItem, id: "ext:last" },
	];
	Object.defineProperty(rows, 1, {
		get() {
			throw new Error("row getter failed");
		},
	});
	Object.defineProperty(rows, Symbol.iterator, {
		value() {
			throw new Error("array iterator must not run");
		},
	});
	hub.register({ items: () => rows, subscribe: () => () => {} });
	const warnings: string[] = [];
	assert.deepEqual(
		agentPanelItems(session, (error) => warnings.push(error.message)).map((item) => item.id),
		["ext:first", "ext:last"],
	);
	assert.deepEqual(warnings, ["row getter failed"]);
	hub.dispose();
});

test("extension items with task: ids are rejected and never routed to source actions (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const calls: string[] = [];
	hub.register({
		items: () => [
			{ ...healthyItem, id: "task:forged", name: "forged" },
			{ ...healthyItem, id: "ext:real", name: "real" },
		],
		subscribe: () => () => {},
		open(id) {
			calls.push(`open:${id}`);
		},
		stop: async (id) => {
			calls.push(`stop:${id}`);
			return { ok: true };
		},
		answer: async (id, text) => {
			calls.push(`answer:${id}:${text}`);
			return { ok: true };
		},
	});
	const reports: string[] = [];
	const items = agentPanelItems(session, (error) => reports.push(error.message));
	assert.deepEqual(
		items.map((item) => item.id),
		["ext:real"],
	);
	assert.equal(reports.length, 1);
	assert.equal(openAgentPanelItem(session, "task:forged"), false);
	assert.equal((await stopAgentPanelItem(session, "task:forged")).ok, false);
	assert.equal((await answerAgentPanelItem(session, "task:forged", "hi")).ok, false);
	assert.deepEqual(calls, []);
});

test("sources that notify synchronously inside items() or before throwing quiesce without microtask livelock (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let returningCalls = 0;
	let throwingCalls = 0;
	let emitReturning = () => {};
	let emitThrowing = () => {};
	hub.register({
		items() {
			returningCalls++;
			emitReturning();
			return [{ ...healthyItem, id: "ext:self-notify" }];
		},
		subscribe(listener) {
			emitReturning = listener;
			return () => {};
		},
	});
	hub.register({
		items() {
			throwingCalls++;
			emitThrowing();
			throw new Error("notify then fail");
		},
		subscribe(listener) {
			emitThrowing = listener;
			return () => {};
		},
	});
	let scheduled = false;
	let refreshes = 0;
	const unsub = subscribeAgentPanel(session, () => {
		if (scheduled || refreshes >= 25) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			refreshes++;
			agentPanelItems(session);
		});
	});
	try {
		const initial = agentPanelItems(session);
		assert.deepEqual(
			initial.map((item) => item.id),
			["ext:self-notify"],
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(returningCalls, 2);
		assert.equal(throwingCalls, 2);
		assert.equal(refreshes, 1);
	} finally {
		unsub();
	}
});

test("source notifications do not poll hub watchers across subscribed sessions (#5224, #5239)", () => {
	const hub = new AgentPanelSourceHub();
	let hubLookups = 0;
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub() {
				hubLookups++;
				return hub;
			},
		},
	};
	let emit = () => {};
	hub.register({
		items: () => [healthyItem],
		subscribe(listener) {
			emit = listener;
			return () => {};
		},
	});
	const unsub = subscribeAgentPanel(session, () => {});
	try {
		hubLookups = 0;
		for (let i = 0; i < 50; i++) emit();
		assert.equal(hubLookups, 0);
	} finally {
		unsub();
	}
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
	const choices = ["alpha", "beta"];
	Object.defineProperty(choices, 0, {
		enumerable: true,
		get() {
			choiceReads++;
			return "alpha";
		},
	});
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
		const thenProperty = "then";
		hub.register({
			items: () => [
				Promise.reject(new Error("async item element")) as unknown as AgentPanelItem,
				Object.assign(Promise.reject(new Error("async valid-looking row")), healthyItem, {
					id: "run:async-valid-row",
				}) as unknown as AgentPanelItem,
				{
					...healthyItem,
					id: "run:async-valid-progress",
					progress: Object.assign(Promise.reject(new Error("async valid-looking progress")), {
						done: 0,
						total: 1,
					}) as unknown as { done: number; total: number },
				},
				{
					...healthyItem,
					id: "run:async-valid-choices",
					choices: Object.defineProperty(["yes", "no"], thenProperty, {
						get() {
							throw new Error("choices then getter failed");
						},
					}),
				},
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
		assert.equal(
			reports.length,
			3,
			"the failed subscription, the failed items and one bad row are each reported once",
		);
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a throwing iterable drains each yielded rejection before advancing (#5224)", async () => {
	const { hub, session } = panelFixture();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		hub.register({
			items: (() => ({
				*[Symbol.iterator]() {
					yield { ...healthyItem, id: "run:before-throw" };
					yield Promise.reject(new Error("yielded row rejected"));
					throw new Error("iterator failed");
				},
			})) as unknown as () => readonly AgentPanelItem[],
			subscribe: () => () => {},
		});
		const reports: string[] = [];
		for (let read = 0; read < 2; read++) {
			assert.deepEqual(
				agentPanelItems(session, (error) => reports.push(error.message)).map((item) => item.id),
				[healthyItem.id],
			);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
		assert.deepEqual(reports, ["iterator failed"]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

for (const location of ["item", "progress", "rows length"] as const) {
	test(`a rejected ${location} getter is drained before another getter throws (#5224)`, async () => {
		const { hub, session } = panelFixture();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			hub.register({
				items: () => {
					const broken =
						location === "item"
							? {
									get id() {
										return Promise.reject(new Error("id rejected"));
									},
									get kind() {
										throw new Error("kind failed");
									},
								}
							: {
									...healthyItem,
									id: "run:broken",
									progress: {
										get done() {
											return Promise.reject(new Error("done rejected"));
										},
										get total() {
											throw new Error("total failed");
										},
									},
								};
					if (location === "rows length") {
						return new Proxy([], {
							get(target, key, receiver) {
								return key === "length"
									? Promise.reject(new Error("length rejected"))
									: Reflect.get(target, key, receiver);
							},
						});
					}
					return [
						{ ...healthyItem, id: "run:before" },
						broken as unknown as AgentPanelItem,
						{ ...healthyItem, id: "run:after" },
					];
				},
				subscribe: () => () => {},
			});
			const reports: string[] = [];
			const ids = agentPanelItems(session, (error) => reports.push(error.message)).map((item) => item.id);
			assert.deepEqual(
				ids,
				location === "rows length" ? [healthyItem.id] : [healthyItem.id, "run:before", "run:after"],
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(reports.length, 1);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

test("validated extension rows contain only supplied optional fields and no symbols (#5224)", () => {
	const { session } = panelFixture();
	const row = agentPanelItems(session)[0]!;
	assert.deepEqual(Object.getOwnPropertySymbols(row), []);
	assert.deepEqual(Object.keys(row).sort(), ["id", "kind", "name", "state", "task"]);
});

for (const field of ["tokens", "queued"] as const) {
	test(`unsafe ${field} counts are rejected without losing safe neighbours (#5224)`, () => {
		const { hub, session } = panelFixture();
		hub.register({
			items: () => [
				{ ...healthyItem, id: "run:rounded", [field]: 999950000000000000 },
				{ ...healthyItem, id: "run:exponential", [field]: 1e36 },
				{ ...healthyItem, id: "run:safe", [field]: Number.MAX_SAFE_INTEGER },
			],
			subscribe: () => () => {},
		});
		const reports: string[] = [];
		const items = agentPanelItems(session, (error) => reports.push(error.message));
		assert.deepEqual(
			items.map((item) => item.id),
			[healthyItem.id, "run:safe"],
		);
		assert.equal(items[1]?.[field], Number.MAX_SAFE_INTEGER);
		assert.equal(reports.length, 1);
	});
}

test("oversized choices and source arrays cannot monopolize a panel read (#5224)", () => {
	const { hub, session } = panelFixture();
	let choiceReads = 0;
	const choices = new Proxy(new Array<string>(2 ** 32 - 1), {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) choiceReads++;
			return Reflect.get(target, key, receiver);
		},
	});
	hub.register({
		items: () => [
			{ ...healthyItem, id: "run:before" },
			{ ...healthyItem, id: "run:oversized", choices },
			{ ...healthyItem, id: "run:after" },
		],
		subscribe: () => () => {},
	});
	const reports: string[] = [];
	const items = agentPanelItems(session, (error) => reports.push(error.message));
	assert.deepEqual(
		items.map((item) => item.id),
		[healthyItem.id, "run:before", "run:after"],
	);
	assert.ok(choiceReads <= 128);
	let rowReads = 0;
	const rows = new Proxy(new Array<AgentPanelItem>(2 ** 32 - 1), {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) {
				rowReads++;
				return { ...healthyItem, id: `run:bounded-${key}` };
			}
			return Reflect.get(target, key, receiver);
		},
	});
	hub.register({ items: () => rows, subscribe: () => () => {} });
	const bounded = agentPanelItems(session, (error) => reports.push(error.message));
	assert.ok(rowReads <= 10_000);
	assert.equal(bounded.length, items.length + 10_000);
	assert.equal(reports.length, 2);
});
for (const method of ["subscribe", "items", "open", "stop", "answer"] as const) {
	test(`rejected panel source ${method} getters cannot leak a rejection (#5224)`, async () => {
		const { hub, session } = panelFixture();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const source = {
				items: () => [{ ...healthyItem, id: "run:method" }],
				subscribe: () => () => {},
			};
			Object.defineProperty(source, method, {
				get: () => Promise.reject(new Error(`${method} getter rejected`)),
			});
			hub.register(source);
			const warnings: string[] = [];
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			if (method === "subscribe" || method === "items") {
				assert.deepEqual(
					rows.map((item) => item.id),
					[healthyItem.id],
				);
			} else if (method === "open") {
				assert.equal(openAgentPanelItem(session, "run:method"), false);
			} else if (method === "stop") {
				assert.equal((await stopAgentPanelItem(session, "run:method")).ok, false);
			} else {
				assert.equal((await answerAgentPanelItem(session, "run:method", "yes")).ok, false);
			}
			if (method === "items") assert.equal(warnings.length, 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
}
for (const location of ["next", "step", "done"] as const) {
	test(`rejected iterator ${location} values cannot leak from panel sources (#5224)`, async () => {
		const { hub, session } = panelFixture();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			hub.register({
				items: (() => ({
					[Symbol.iterator]() {
						let calls = 0;
						const iterator = {
							next() {
								if (calls++ > 0) return { done: true };
								if (location === "step") return Promise.reject(new Error("step rejected"));
								return {
									get done() {
										return Promise.reject(new Error("done rejected"));
									},
								};
							},
						};
						if (location === "next") {
							Object.defineProperty(iterator, "next", {
								get: () => Promise.reject(new Error("next rejected")),
							});
						}
						return iterator;
					},
				})) as unknown as () => readonly AgentPanelItem[],
				subscribe: () => () => {},
			});
			const warnings: string[] = [];
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(
				rows.map((item) => item.id),
				[healthyItem.id],
			);
			assert.equal(warnings.length, 1);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

test("resumed extension agents and removed extension items are pruned from dismissedAgentPanelItems without restoring dismissed native tasks (#5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("settled background task");
		await fixture.settle(0);
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const taskRowId = `task:${taskId}`;

		const hub = new AgentPanelSourceHub();
		let currentItems: AgentPanelItem[] = [
			{ id: "run:r1", kind: "agent", state: "stopped", name: "ralph", task: "stage implement" },
			{ id: "run:gone", kind: "agent", state: "done", name: "cleanup", task: "stage finish" },
		];
		let notify = () => {};
		hub.register({
			items: () => currentItems,
			subscribe: (listener) => {
				notify = listener;
				return () => {};
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);

		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			["run:r1", "run:gone", taskRowId],
		);

		dismissedAgentPanelItems(session).add("run:r1");
		dismissedAgentPanelItems(session).add("run:gone");
		dismissedAgentPanelItems(session).add(taskRowId);
		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			[],
		);

		// Resume run:r1 (stopped -> running) and drop run:gone from the source; taskRowId stays settled in the store.
		currentItems = [{ id: "run:r1", kind: "agent", state: "running", name: "ralph", task: "stage implement" }];
		notify();

		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			["run:r1"],
			"resumed extension agent is visible again while dismissed settled native task stays hidden",
		);
		assert.equal(dismissedAgentPanelItems(session).has("run:r1"), false, "resumed run is removed from dismissed set");
		assert.equal(
			dismissedAgentPanelItems(session).has("run:gone"),
			false,
			"absent extension id is pruned from dismissed set",
		);
		assert.equal(
			dismissedAgentPanelItems(session).has(taskRowId),
			true,
			"native task id is preserved in dismissed set",
		);
	} finally {
		await fixture.dispose();
	}
});

test("well-behaved Promise subclasses returned by stop and answer keep their constructor and species (#5239)", async () => {
	class CancelablePromise<T> extends Promise<T> {
		cancelled = false;
		cancel(): void {
			this.cancelled = true;
		}
	}
	const stopPromise = CancelablePromise.resolve({ ok: true as const }) as CancelablePromise<{ readonly ok: true }>;
	const answerPromise = CancelablePromise.resolve({ ok: true as const }) as CancelablePromise<{ readonly ok: true }>;
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [
			{
				id: "run:sub",
				kind: "agent",
				state: "input",
				name: "ralph",
				task: "Approve?",
				question: "Approve?",
				promptId: "p1",
			},
		],
		subscribe: () => () => {},
		stop: () => stopPromise,
		answer: () => answerPromise,
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	assert.deepEqual(await stopAgentPanelItem(session, "run:sub"), { ok: true });
	assert.deepEqual(await answerAgentPanelItem(session, "run:sub", "yes", { promptId: "p1" }), { ok: true });

	for (const candidate of [stopPromise, answerPromise]) {
		assert.equal(candidate.constructor, CancelablePromise, "instance constructor remains CancelablePromise");
		assert.equal(Object.hasOwn(candidate, "constructor"), false, "no own constructor property was defined");
		const derived = candidate.then(() => 1);
		assert.equal(derived instanceof CancelablePromise, true, "chained .then() still produces CancelablePromise");
		assert.equal(typeof (derived as CancelablePromise<number>).cancel, "function");
	}
});

test("duplicate item id errors strip terminal control sequences before reaching emitError or onError (#5239)", () => {
	const hostileId = "dup\x1b]52;c;QUJD\x07\x1b[2J\u009b31m\u202e\u2028tail";
	const row = (): AgentPanelItem => ({
		id: hostileId,
		kind: "agent",
		state: "running",
		name: "worker",
		task: "check",
	});

	const emittedSingle: string[] = [];
	const hubSingle = new AgentPanelSourceHub();
	hubSingle.register({ items: () => [row(), row()], subscribe: () => () => {} });
	agentPanelItems({
		extensionRunner: {
			getAgentPanelSourceHub: () => hubSingle,
			emitError: (err) => emittedSingle.push(err.error),
		},
	});
	assert.equal(emittedSingle.length, 1);
	assert.equal(/[\x00-\x1f\x7f-\x9f\u202e\u2028\u2029]/u.test(emittedSingle[0]!), false, emittedSingle[0]);

	const emittedCross: string[] = [];
	const hubCross = new AgentPanelSourceHub();
	hubCross.register({ items: () => [row()], subscribe: () => () => {} });
	hubCross.register({ items: () => [row()], subscribe: () => () => {} });
	agentPanelItems({
		extensionRunner: {
			getAgentPanelSourceHub: () => hubCross,
			emitError: (err) => emittedCross.push(err.error),
		},
	});
	assert.equal(emittedCross.length, 1);
	assert.equal(/[\x00-\x1f\x7f-\x9f\u202e\u2028\u2029]/u.test(emittedCross[0]!), false, emittedCross[0]);
});

test("validateItem rejects non-string promptId while keeping valid sibling rows (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () =>
			[
				{
					id: "run:valid-before",
					kind: "agent",
					state: "input",
					name: "a",
					task: "t",
					promptId: "p-ok",
				},
				{ id: "run:bad-prompt-num", kind: "agent", state: "input", name: "b", task: "t", promptId: 42 },
				{ id: "run:valid-after", kind: "agent", state: "done", name: "d", task: "t" },
			] as unknown as readonly AgentPanelItem[],
		subscribe: () => () => {},
	});
	const errors: string[] = [];
	const rows = agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } }, (error) =>
		errors.push(error.message),
	);
	assert.deepEqual(
		rows.map((item) => ({ id: item.id, promptId: item.promptId })),
		[
			{ id: "run:valid-before", promptId: "p-ok" },
			{ id: "run:valid-after", promptId: undefined },
		],
	);
	assert.deepEqual(errors, ["Invalid agent panel item."]);
});

test("openAgentPanelItem notifies subscribeAgentPanel listeners after opening the item (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "run:quiet-open", kind: "agent", state: "done", name: "release", task: "ship" }],
		subscribe: () => () => {},
		open: () => true,
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let notifications = 0;
	const unsubscribe = subscribeAgentPanel(session, () => {
		notifications++;
	});
	try {
		assert.equal(openAgentPanelItem(session, "run:quiet-open"), true);
		assert.equal(notifications, 1);
	} finally {
		unsubscribe();
		hub.dispose();
	}
});

test("non-function subscribe is reported as a hub failure and replayed to late error subscribers (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	const badSource = {
		items: () => [healthyItem],
		subscribe: "invalid" as unknown as AgentPanelSource["subscribe"],
	};
	hub.register(badSource);
	const replayed: string[] = [];
	const unsub = hub.subscribe(
		() => {},
		(_source, error) => replayed.push(error.message),
	);
	unsub();
	assert.deepEqual(replayed, ["Invalid agent panel source subscription."]);
});

test("dismissed finished items stay dismissed across a failed source read (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	let fail = false;
	let notify = () => {};
	const item: AgentPanelItem = {
		id: "run:done1",
		kind: "agent",
		state: "done",
		name: "release",
		task: "t",
		elapsedMs: 5000,
	};
	hub.register({
		items: () => {
			if (fail) throw new Error("transient store read failure");
			return [item];
		},
		subscribe: (listener) => {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		assert.deepEqual(
			agentPanelItems(session).map((row) => row.id),
			["run:done1"],
		);
		dismissedAgentPanelItems(session).add("run:done1");
		assert.deepEqual(agentPanelItems(session), []);
		fail = true;
		notify();
		assert.deepEqual(agentPanelItems(session), []);
		assert.deepEqual([...dismissedAgentPanelItems(session)], ["run:done1"]);
		fail = false;
		notify();
		assert.deepEqual(agentPanelItems(session), []);
	} finally {
		hub.dispose();
	}
});

test("native task projection preserves the caller's dismissed ids while showing live tasks (#5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("worker one");
		const id = fixture.store.tasks[0]!.ref.taskId;
		const dismissed = new Set([id]);
		const source = ownerTaskViewSource(fixture.store);
		assert.deepEqual(
			taskPanelItems(source, dismissed).map((item) => item.id),
			[`task:${id}`],
		);
		assert.deepEqual([...dismissed], [id]);
		await fixture.settle();
		assert.deepEqual(taskPanelItems(source, dismissed), []);
		assert.deepEqual([...dismissed], [id]);
	} finally {
		await fixture.dispose();
	}
});

test("dismissed native task ids are pruned when the task is seen in a non-finished state (#5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("worker one");
		// A second subagent keeps running, so the first stays listed while its turn is interrupted.
		await fixture.start("worker two");
		const session = {};
		bindOwnerTaskStore(session, fixture.store);
		const id = fixture.store.tasks[0]!.ref.taskId;
		const rowsOf = () => agentPanelRows(session).filter((row) => row.id === `task:${id}`);
		assert.deepEqual(
			rowsOf().map((row) => [row.id, row.state]),
			[[`task:${id}`, "running"]],
		);
		setTaskTurnInterrupted(fixture.store, id, true);
		assert.deepEqual(
			rowsOf().map((row) => [row.id, row.state]),
			[[`task:${id}`, "paused"]],
		);
		dismissedAgentPanelItems(session).add(`task:${id}`);
		dismissedTasks(ownerTaskViewSource(fixture.store)).add(id);
		assert.deepEqual(
			rowsOf().map((row) => [row.id, row.state]),
			[[`task:${id}`, "paused"]],
		);
		assert.equal(dismissedAgentPanelItems(session).has(`task:${id}`), false);
		assert.equal(dismissedTasks(ownerTaskViewSource(fixture.store)).has(id), false);
		dismissedAgentPanelItems(session).add(`task:${id}`);
		dismissedTasks(ownerTaskViewSource(fixture.store)).add(id);
		setTaskTurnInterrupted(fixture.store, id, false);
		assert.deepEqual(
			rowsOf().map((row) => [row.id, row.state]),
			[[`task:${id}`, "running"]],
		);
		assert.deepEqual(agentPanelCounts(session), { total: 2, agents: 2, needsInput: 0, shells: 0, subagents: 2 });
		assert.equal(dismissedAgentPanelItems(session).has(`task:${id}`), false);
		assert.equal(dismissedTasks(ownerTaskViewSource(fixture.store)).has(id), false);
		assert.deepEqual(
			agentPanelItems(session)
				.filter((item) => item.id === `task:${id}`)
				.map((item) => [item.id, item.state]),
			[[`task:${id}`, "running"]],
		);
	} finally {
		await fixture.dispose();
	}
});
