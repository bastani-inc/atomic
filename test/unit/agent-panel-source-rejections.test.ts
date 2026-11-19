import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelActionResult,
	type AgentPanelItem,
	type AgentPanelSource,
	AgentPanelSourceHub,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
	stopAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";

const thenProperty = "then";
const healthyItem: AgentPanelItem = {
	id: "run:healthy",
	kind: "agent",
	state: "running",
	name: "healthy",
	task: "implement",
};

const failureFactories = [
	{
		name: "a rejected message getter",
		create: () =>
			Object.defineProperty(new Error(), "message", {
				get: () => Promise.reject(new Error("message rejected")),
			}),
	},
	{
		name: "a message object with a rejected coercion",
		create: () =>
			Object.defineProperty(new Error(), "message", {
				value: { toString: () => Promise.reject(new Error("message coercion rejected")) },
			}),
	},
	{
		name: "a rejected toString result",
		create: () => ({ toString: () => Promise.reject(new Error("coercion rejected")) }),
	},
	{
		name: "a rejected primitive-conversion getter",
		create: () => ({
			get [Symbol.toPrimitive]() {
				return Promise.reject(new Error("primitive rejected"));
			},
		}),
	},
	{
		name: "a side-effecting prototype trap",
		create: () =>
			new Proxy(
				{},
				{
					getPrototypeOf() {
						void Promise.reject(new Error("prototype rejected"));
						return null;
					},
				},
			),
	},
	{
		name: "a message getter throwing a promise",
		create: () =>
			Object.defineProperty(new Error(), "message", {
				get() {
					throw Promise.reject(new Error("message throw rejected"));
				},
			}),
	},
] as const;

function rejectedLater(): Promise<never> {
	return new Promise((_resolve, reject) => queueMicrotask(() => reject(new Error("source promise rejected"))));
}

for (const location of [
	"subscription",
	"subscription getter",
	"items",
	"items getter",
	"row",
	"later row",
	"then getter",
	"cleanup",
	"listener",
	"open",
	"open getter",
	"return callback",
	"hub lookup",
	"iterator return",
	"stop",
	"stop getter",
	"answer",
	"answer getter",
	"stop rejection",
	"answer rejection",
	"stop result",
	"answer result",
] as const) {
	test(`a promise thrown from ${location} is drained without escaping the panel boundary (#5239)`, async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const hub = new AgentPanelSourceHub();
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		const fail = (): never => {
			throw rejectedLater();
		};
		const source: AgentPanelSource = {
			items: () => [{ ...healthyItem, id: "run:source" }],
			subscribe: () => () => {},
			open() {},
			stop: async () => ({ ok: true }),
			answer: async () => ({ ok: true }),
		};
		try {
			hub.register({ items: () => [healthyItem], subscribe: () => () => {} });
			switch (location) {
				case "subscription":
					source.subscribe = fail;
					break;
				case "subscription getter":
					Object.defineProperty(source, "subscribe", { get: fail });
					break;
				case "items":
					source.items = fail;
					break;
				case "items getter":
					Object.defineProperty(source, "items", { get: fail });
					break;
				case "row":
				case "later row":
					source.items = () => [
						...(location === "later row" ? [null as unknown as AgentPanelItem] : []),
						Object.defineProperty({}, "id", { get: fail }) as AgentPanelItem,
						{ ...healthyItem, id: "run:source" },
					];
					break;
				case "then getter":
					source.items = () => [Object.defineProperty({}, thenProperty, { get: fail }) as AgentPanelItem];
					break;
				case "cleanup":
					source.subscribe = () => fail;
					break;
				case "listener":
					hub.subscribe(fail);
					break;
				case "open":
					source.open = fail;
					break;
				case "open getter":
					Object.defineProperty(source, "open", { get: fail });
					break;
				case "return callback":
					source.open = (_id, options) => options?.onReturn?.();
					break;
				case "iterator return":
					source.items = (() => ({
						[Symbol.iterator]() {
							let index = 0;
							return {
								next: () => ({ value: { ...healthyItem, id: `run:${index++}` }, done: false }),
								return: fail,
							};
						},
					})) as unknown as AgentPanelSource["items"];
					break;
				case "stop":
					source.stop = fail;
					break;
				case "stop getter":
					Object.defineProperty(source, "stop", { get: fail });
					break;
				case "answer":
					source.answer = fail;
					break;
				case "answer getter":
					Object.defineProperty(source, "answer", { get: fail });
					break;
				case "stop rejection":
					source.stop = () => Promise.reject(rejectedLater());
					break;
				case "answer rejection":
					source.answer = () => Promise.reject(rejectedLater());
					break;
				case "stop result":
					source.stop = async () => Object.defineProperty({}, "ok", { get: fail }) as never;
					break;
				case "answer result":
					source.answer = async () => Object.defineProperty({}, "reason", { get: fail }) as never;
					break;
			}
			const registration = hub.register(source);
			const warnings: string[] = [];
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			assert.equal(rows[0]?.id, healthyItem.id);
			if (["items", "items getter", "row", "later row", "then getter", "iterator return"].includes(location)) {
				assert.equal(warnings.length, 1);
			}
			if (location === "open" || location === "open getter" || location === "return callback") {
				assert.equal(openAgentPanelItem(session, "run:source", { onReturn: fail }), location === "return callback");
			}
			if (location.startsWith("stop")) assert.equal((await stopAgentPanelItem(session, "run:source")).ok, false);
			if (location.startsWith("answer"))
				assert.equal((await answerAgentPanelItem(session, "run:source", "yes")).ok, false);
			if (location === "hub lookup") {
				session.extensionRunner.getAgentPanelSourceHub = fail;
				assert.deepEqual(agentPanelItems(session), []);
				session.extensionRunner.getAgentPanelSourceHub = () => hub;
			}
			registration.dispose();
			hub.dispose();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			hub.dispose();
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

for (const mode of ["then value", "shadowed promise", "throwing promise", "changing then"] as const) {
	test(`panel rows drain ${mode} without reading a thenable twice (#5239)`, async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const hub = new AgentPanelSourceHub();
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		let thenReads = 0;
		try {
			let raw: object = { ...healthyItem, id: "run:then" };
			if (mode === "shadowed promise" || mode === "throwing promise") raw = rejectedLater();
			Object.defineProperty(raw, thenProperty, {
				get() {
					thenReads++;
					if (mode === "throwing promise") throw rejectedLater();
					if (mode === "shadowed promise") return undefined;
					if (mode === "changing then" && thenReads === 1) {
						return (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
							reject(rejectedLater());
							return rejectedLater();
						};
					}
					return rejectedLater();
				},
			});
			hub.register({ items: () => [healthyItem, raw as AgentPanelItem], subscribe: () => () => {} });
			const warnings: string[] = [];
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			assert.deepEqual(
				rows.map((item) => item.id),
				mode === "then value" ? [healthyItem.id, "run:then"] : [healthyItem.id],
			);
			assert.equal(warnings.length, mode === "then value" ? 0 : 1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
			assert.equal(thenReads, mode === "shadowed promise" || mode === "throwing promise" ? 0 : 1);
		} finally {
			hub.dispose();
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

for (const action of ["stop", "answer"] as const) {
	for (const mode of [
		"then value",
		"shadowed promise",
		"throwing promise",
		"changing then",
		"double reject",
		"double resolve",
	] as const) {
		test(`${action} settles ${mode} once and drains every discarded settlement (#5239)`, async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			let thenReads = 0;
			try {
				const perform = () => {
					const raw =
						mode === "shadowed promise" || mode === "throwing promise"
							? Promise.resolve({ ok: true })
							: { ok: true };
					Object.defineProperty(raw, thenProperty, {
						get() {
							thenReads++;
							if (mode === "throwing promise") throw rejectedLater();
							if (mode === "shadowed promise") return undefined;
							if (mode === "then value" || (mode === "changing then" && thenReads > 1)) return rejectedLater();
							return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
								if (mode === "double reject") {
									reject(new Error("first rejection"));
									reject(rejectedLater());
								} else {
									resolve({ ok: true });
									if (mode === "double resolve") resolve(rejectedLater());
								}
								return rejectedLater();
							};
						},
					});
					return raw as Promise<AgentPanelActionResult>;
				};
				hub.register({ items: () => [healthyItem], subscribe: () => () => {}, [action]: perform });
				const result =
					action === "stop"
						? await stopAgentPanelItem(session, healthyItem.id)
						: await answerAgentPanelItem(session, healthyItem.id, "yes");
				assert.deepEqual(
					result,
					mode === "double reject" ? { ok: false, reason: "first rejection" } : { ok: true },
				);
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.deepEqual(unhandled, []);
				assert.equal(thenReads, mode === "shadowed promise" || mode === "throwing promise" ? 0 : 1);
			} finally {
				hub.dispose();
				process.off("unhandledRejection", onUnhandled);
			}
		});
	}
}

for (const method of ["items", "subscribe", "open", "stop", "answer"] as const) {
	test(`source ${method} invocation does not consult a hostile call property (#5239)`, async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const hub = new AgentPanelSourceHub();
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		const source: AgentPanelSource = {
			items: () => [healthyItem],
			subscribe: () => () => {},
			open() {},
			stop: async () => ({ ok: true }),
			answer: async () => ({ ok: true }),
		};
		let callReads = 0;
		Object.defineProperty(source[method], "call", {
			get() {
				callReads++;
				return rejectedLater();
			},
		});
		try {
			hub.register(source);
			const rows = agentPanelItems(session);
			const opened = openAgentPanelItem(session, healthyItem.id);
			const stopped = await stopAgentPanelItem(session, healthyItem.id);
			const answered = await answerAgentPanelItem(session, healthyItem.id, "yes");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
			assert.equal(callReads, 0);
			assert.deepEqual(rows, [healthyItem]);
			assert.equal(opened, true);
			assert.deepEqual(stopped, { ok: true });
			assert.deepEqual(answered, { ok: true });
		} finally {
			hub.dispose();
			process.off("unhandledRejection", onUnhandled);
		}
	});
}

for (const failure of failureFactories) {
	test(`panel reads and actions contain ${failure.name} without coercing source objects (#5239)`, async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const hub = new AgentPanelSourceHub();
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		try {
			hub.register({ items: () => [healthyItem], subscribe: () => () => {} });
			hub.register({
				items() {
					throw failure.create();
				},
				subscribe: () => () => {},
			});
			const warnings: string[] = [];
			for (let read = 0; read < 2; read++) {
				assert.deepEqual(
					agentPanelItems(session, (error) => warnings.push(error.message)),
					[healthyItem],
				);
			}
			assert.deepEqual(warnings, ["Agent panel source failed."]);
			for (const mode of ["rejection", "reason"] as const) {
				const action = () =>
					mode === "rejection"
						? Promise.reject(failure.create())
						: Promise.resolve({ ok: false as const, reason: failure.create() as string });
				hub.register({
					items: () => [{ ...healthyItem, id: `run:${mode}` }],
					subscribe: () => () => {},
					stop: action,
					answer: action,
				});
				assert.deepEqual(await stopAgentPanelItem(session, `run:${mode}`), {
					ok: false,
					reason: "Agent panel source failed.",
				});
				assert.deepEqual(await answerAgentPanelItem(session, `run:${mode}`, "yes"), {
					ok: false,
					reason: "Agent panel source failed.",
				});
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			hub.dispose();
			process.off("unhandledRejection", onUnhandled);
		}
	});
}
