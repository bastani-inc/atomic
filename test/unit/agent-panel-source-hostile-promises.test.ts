import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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

const THEN_METHOD = "then";
let recursiveDepth = 0;
function recursiveThen(): object {
	recursiveDepth++;
	return Object.defineProperty({}, THEN_METHOD, {
		get() {
			throw recursiveThen();
		},
	});
}

let syncResolveDepth = 0;
function syncInfiniteResolve(): object {
	syncResolveDepth++;
	return Object.defineProperty({}, THEN_METHOD, {
		value(resolve: (value: unknown) => void) {
			resolve(syncInfiniteResolve());
		},
	});
}

function deepThrowChainEndingInRejectedPromise(depth: number, label: string): object {
	let current: unknown = Promise.reject(new Error(`rejected:${label}`));
	for (let index = 0; index < depth; index++) {
		const next = current;
		current = Object.defineProperty({}, THEN_METHOD, {
			get() {
				throw next;
			},
		});
	}
	return current as object;
}

async function exercise(source: Partial<AgentPanelSource>) {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	hub.register({ items: () => [row("ok")], subscribe: () => () => {}, ...source } as AgentPanelSource);
	const warnings: string[] = [];
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, factory: unknown) {
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

test("stop and answer settle as failures when a source returns a thenable that synchronously resolves with a fresh thenable without end (#5239)", async () => {
	syncResolveDepth = 0;
	const { stopped, answered } = await exercise({
		stop: () => syncInfiniteResolve() as never,
		answer: () => syncInfiniteResolve() as never,
	});
	assert.notEqual(stopped, "pending", "stop settles instead of hanging after synchronous thenable overflow");
	assert.notEqual(answered, "pending", "answer settles instead of hanging after synchronous thenable overflow");
	assert.equal((stopped as { ok: boolean }).ok, false);
	assert.equal((answered as { ok: boolean }).ok, false);
	assert.ok(syncResolveDepth < 10_000, `unwrapped to a bound, read ${syncResolveDepth} thenables`);
	assert.deepEqual(unhandled, []);
});

test("draining 35 nested throwing then-getters ending in a rejected native promise attaches a handler and leaks no unhandled rejection (#5239)", async () => {
	const { items, stopped, answered, opened } = await exercise({
		items: () => {
			throw deepThrowChainEndingInRejectedPromise(35, "items-deep-promise");
		},
		stop: () => {
			throw deepThrowChainEndingInRejectedPromise(35, "stop-deep-promise");
		},
		answer: () => {
			throw deepThrowChainEndingInRejectedPromise(35, "answer-deep-promise");
		},
		open: () => {
			throw deepThrowChainEndingInRejectedPromise(35, "open-deep-promise");
		},
		subscribe: () => () => {
			throw deepThrowChainEndingInRejectedPromise(35, "unsubscribe-deep-promise");
		},
	});
	assert.deepEqual(items, []);
	assert.equal((stopped as { ok: boolean }).ok, false);
	assert.equal((answered as { ok: boolean }).ok, false);
	assert.equal(opened, false);
	assert.deepEqual(unhandled, []);
});

test("strict Bun child contains frozen species, non-configurable constructor getters, and species getters throwing promises without swallowing unrelated rejections (#5239)", () => {
	const script = `
		const mode = process.argv[1];
		const {
			AgentPanelSourceHub,
			agentPanelItems,
			answerAgentPanelItem,
			openAgentPanelItem,
			stopAgentPanelItem,
		} = await import("./packages/coding-agent/src/core/tasks/agent-panel-source.ts");

		class Bad extends Promise {
			static get [Symbol.species]() {
				throw new Error("species getter");
			}
		}
		class Worse extends Promise {
			static get [Symbol.species]() {
				throw Promise.reject(new Error("rejected:inner-species-throw"));
			}
		}

		const factories = {
			frozen_species: () => Object.freeze(Bad.reject(new Error("rejected:frozen-species"))),
			nonconfig_ctor_getter: () => {
				const p = Promise.reject(new Error("rejected:nonconfig-ctor"));
				Object.defineProperty(p, "constructor", {
					get() {
						throw new Error("ctor getter");
					},
					configurable: false,
				});
				return p;
			},
			own_ctor_getter: () => {
				const p = Promise.reject(new Error("rejected:own-ctor"));
				Object.defineProperty(p, "constructor", {
					get() {
						throw new Error("ctor getter");
					},
					configurable: true,
				});
				return p;
			},
			frozen_species_throws_promise: () => Object.freeze(Worse.reject(new Error("rejected:outer-frozen"))),
			species_throws_promise: () => Worse.reject(new Error("rejected:outer-extensible")),
			delayed_frozen_species: () =>
				Object.freeze(
					new Bad((_resolve, reject) => {
						setTimeout(() => {
							setTimeout(() => reject(new Error("rejected:delayed-frozen-species")), 10);
						}, 10);
					}),
				),
		};

		if (mode === "contain_all") {
			for (const [name, make] of Object.entries(factories)) {
				const hub = new AgentPanelSourceHub();
				const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
				hub.register({
					items: () => [
						{ id: "ok", kind: "agent", state: "running", name: "ok", task: "t", question: "q?", promptId: "p1" },
						make(),
					],
					subscribe: () => () => {},
					open: () => make(),
					stop: () => make(),
					answer: () => make(),
				});
				hub.register({
					items: () => {
						throw make();
					},
					subscribe: () => () => {},
				});
				const items = agentPanelItems(session);
				if (items.length !== 1 || items[0].id !== "ok") {
					throw new Error("Unexpected items for " + name);
				}
				openAgentPanelItem(session, "ok");
				const stopRes = await Promise.race([
					stopAgentPanelItem(session, "ok"),
					new Promise((r) => setTimeout(() => r({ ok: false }), 40)),
				]);
				const answerRes = await Promise.race([
					answerAgentPanelItem(session, "ok", "yes", { promptId: "p1" }),
					new Promise((r) => setTimeout(() => r({ ok: false }), 40)),
				]);
				if (stopRes.ok !== false || answerRes.ok !== false) {
					throw new Error("Expected failure result for " + name);
				}
			}
			await new Promise((r) => setTimeout(r, 80));
			console.log("CONTAINED_ALL");
		} else if (mode === "unrelated_same_turn") {
			void Promise.reject(new Error("UNRELATED_SAME_TURN"));
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					throw factories.frozen_species();
				},
				subscribe: () => () => {},
			});
			agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
			await new Promise((r) => setTimeout(r, 80));
		} else if (mode === "generic_scoped_listener_unrelated") {
			const owned = new WeakSet();
			const customGuard = () => {};
			Reflect.defineProperty(customGuard, Symbol.for("atomic.unhandled-rejection-owner"), {
				value: (p) => p !== undefined && owned.has(p),
			});
			process.on("unhandledRejection", customGuard);
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					throw factories.frozen_species();
				},
				subscribe: () => () => {},
			});
			agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
			const ownedPromise = Promise.reject(new Error("OWNED_BY_CUSTOM_GUARD"));
			owned.add(ownedPromise);
			await new Promise((r) => setTimeout(r, 20));
			void Promise.reject(new Error("UNOWNED_BY_BOTH_SCOPED_GUARDS"));
			await new Promise((r) => setTimeout(r, 60));
		} else if (mode === "untagged_user_listener") {
			const seen = [];
			process.on("unhandledRejection", (reason) => {
				seen.push(String(reason?.message ?? reason));
			});
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					throw factories.frozen_species();
				},
				subscribe: () => () => {},
			});
			agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
			void Promise.reject(new Error("USER_HANDLED_REJECTION"));
			await new Promise((r) => setTimeout(r, 40));
			if (!seen.includes("USER_HANDLED_REJECTION")) {
				throw new Error("Expected user listener to receive USER_HANDLED_REJECTION");
			}
			console.log("UNTAGGED_USER_OK");
		} else if (mode === "warn_mode_hostile_reason") {
			let warningCalls = 0;
			let getterRuns = 0;
			process.on("warning", (warning) => {
				if (warning.name === "UnhandledPromiseRejectionWarning") warningCalls++;
			});
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					throw factories.frozen_species();
				},
				subscribe: () => () => {},
			});
			agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
			await new Promise((r) => setTimeout(r, 20));
			warningCalls = 0;
			const hostileReason = new Proxy(
				Object.defineProperty(
					{
						get message() {
							getterRuns++;
							throw Promise.reject(new Error("HOSTILE_MESSAGE_GETTER"));
						},
						toString() {
							getterRuns++;
							throw new Error("HOSTILE_TOSTRING");
						},
						[Symbol.toPrimitive]() {
							getterRuns++;
							throw new Error("HOSTILE_TOPRIMITIVE");
						},
					},
					"then",
					{
						enumerable: true,
						get() {
							getterRuns++;
							throw new Error("HOSTILE_THEN_GETTER");
						},
					},
				),
				{
					getPrototypeOf() {
						getterRuns++;
						throw new Error("HOSTILE_PROTOTYPE");
					},
				},
			);
			void Promise.reject(hostileReason);
			await new Promise((r) => setTimeout(r, 40));
			if (getterRuns !== 0) {
				throw new Error("Expected 0 hostile getter/coercion runs in warn mode, got " + getterRuns);
			}
			if (warningCalls > 2) {
				throw new Error("Expected no duplicate guard warning in warn mode, got " + warningCalls);
			}
			console.log("WARN_HOSTILE_OK");
		} else if (mode === "warn_with_error_code_hostile_reason") {
			let warningCalls = 0;
			let getterRuns = 0;
			process.on("warning", (warning) => {
				if (warning.name === "UnhandledPromiseRejectionWarning") warningCalls++;
			});
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					throw factories.frozen_species();
				},
				subscribe: () => () => {},
			});
			agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
			const hostileReason = Object.defineProperty(
				{
					get message() {
						getterRuns++;
						throw new Error("HOSTILE_MESSAGE_GETTER");
					},
					toString() {
						getterRuns++;
						throw new Error("HOSTILE_TOSTRING");
					},
				},
				"then",
				{
					enumerable: true,
					get() {
						getterRuns++;
						throw new Error("HOSTILE_THEN_GETTER");
					},
				},
			);
			void Promise.reject(hostileReason);
			await new Promise((r) => setTimeout(r, 40));
			if (getterRuns !== 0 || warningCalls !== 1) {
				process.exit(2);
			}
			console.log("WARN_ERROR_CODE_HOSTILE_OK");
		}
	`;

	const contain = spawnSyncCollect([bunExecutable(), "-e", script, "contain_all"], { cwd: REPO_ROOT });
	assert.equal(contain.exitCode, 0, contain.stderr.toString());
	assert.match(contain.stdout.toString(), /CONTAINED_ALL/u);

	const userListener = spawnSyncCollect([bunExecutable(), "-e", script, "untagged_user_listener"], { cwd: REPO_ROOT });
	assert.equal(userListener.exitCode, 0, userListener.stderr.toString());
	assert.match(userListener.stdout.toString(), /UNTAGGED_USER_OK/u);

	const warnHostile = spawnSyncCollect(
		[bunExecutable(), "--unhandled-rejections=warn", "-e", script, "warn_mode_hostile_reason"],
		{
			cwd: REPO_ROOT,
			env: { ...process.env, NODE_OPTIONS: "--unhandled-rejections=warn" },
		},
	);
	assert.equal(warnHostile.exitCode, 0, warnHostile.stderr.toString());
	assert.match(warnHostile.stdout.toString(), /WARN_HOSTILE_OK/u);

	const warnErrorCodeHostile = spawnSyncCollect(
		[bunExecutable(), "-e", script, "warn_with_error_code_hostile_reason"],
		{
			cwd: REPO_ROOT,
			env: { ...process.env, NODE_OPTIONS: "--unhandled-rejections=warn-with-error-code" },
		},
	);
	assert.equal(warnErrorCodeHostile.exitCode, 1, warnErrorCodeHostile.stderr.toString());
	assert.match(warnErrorCodeHostile.stdout.toString(), /WARN_ERROR_CODE_HOSTILE_OK/u);

	for (const unrelatedMode of ["unrelated_same_turn", "generic_scoped_listener_unrelated"]) {
		const res = spawnSyncCollect([bunExecutable(), "-e", script, unrelatedMode], { cwd: REPO_ROOT });
		assert.notEqual(res.exitCode, 0, `expected non-zero exit for ${unrelatedMode}, stderr=${res.stderr.toString()}`);
	}
});

test("strict Bun child contains rejected promises, species-hostile promises, and throwing getters in promptId and every row field (#5239)", () => {
	const script = `
		const {
			AgentPanelSourceHub,
			agentPanelItems,
		} = await import("./packages/coding-agent/src/core/tasks/agent-panel-source.ts");

		class Bad extends Promise {
			static get [Symbol.species]() {
				throw new Error("species getter");
			}
		}

		const fields = [
			"id",
			"kind",
			"state",
			"name",
			"task",
			"elapsedMs",
			"tokens",
			"progress",
			"question",
			"choices",
			"promptId",
			"reason",
			"queued",
			"endedAt",
		];

		for (const field of fields) {
			for (const kind of ["rejected", "species", "frozen_species", "getter_throws_promise"]) {
				const base = {
					id: "bad-" + field,
					kind: "agent",
					state: "input",
					name: "n",
					task: "t",
					question: "q?",
					promptId: "p1",
				};
				let badRow;
				if (kind === "getter_throws_promise") {
					badRow = { ...base };
					Object.defineProperty(badRow, field, {
						enumerable: true,
						get() {
							throw Promise.reject(new Error("getter:" + field));
						},
					});
				} else {
					const val =
						kind === "rejected"
							? Promise.reject(new Error("rejected:" + field))
							: kind === "species"
								? Bad.reject(new Error("species:" + field))
								: Object.freeze(Bad.reject(new Error("frozen:" + field)));
					badRow = { ...base, [field]: val };
				}
				const hub = new AgentPanelSourceHub();
				hub.register({
					items: () => [{ id: "ok", kind: "agent", state: "running", name: "ok", task: "t" }, badRow],
					subscribe: () => () => {},
				});
				const errors = [];
				const rows = agentPanelItems(
					{ extensionRunner: { getAgentPanelSourceHub: () => hub } },
					(err) => errors.push(err.message),
				);
				if (rows.length !== 1 || rows[0].id !== "ok" || errors.length !== 1) {
					throw new Error("Failed containment check for " + field + " (" + kind + ")");
				}
			}
		}
		await new Promise((r) => setTimeout(r, 60));
		console.log("FIELD_SWEEP_OK");
	`;

	const result = spawnSyncCollect([bunExecutable(), "-e", script], { cwd: REPO_ROOT });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.match(result.stdout.toString(), /FIELD_SWEEP_OK/u);
});

test("the panel's rejection guard keeps an --unhandled-rejections mode that NODE_OPTIONS spells as Node reads it", () => {
	// A source that throws a promise the panel cannot attach to installs the guard; the unrelated rejection after it
	// is the guard's to report as the mode says.
	const script = `
		const { AgentPanelSourceHub, agentPanelItems } = await import("./packages/coding-agent/src/core/tasks/agent-panel-source.ts");
		class Bad extends Promise {
			static get [Symbol.species]() {
				throw new Error("species getter");
			}
		}
		const hub = new AgentPanelSourceHub();
		hub.register({
			items: () => {
				throw Object.freeze(Bad.reject(new Error("rejected:frozen-species")));
			},
			subscribe: () => () => {},
		});
		agentPanelItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } });
		await new Promise((r) => setTimeout(r, 20));
		void Promise.reject(new Error("UNRELATED_REJECTION"));
		await new Promise((r) => setTimeout(r, 40));
		console.log("SURVIVED");
	`;
	for (const nodeOptions of [
		'"--unhandled-rejections=warn"',
		"--unhandled_rejections=none",
		"--unhandled-rejections none",
	]) {
		const result = spawnSyncCollect([bunExecutable(), "-e", script], {
			cwd: REPO_ROOT,
			env: { ...process.env, NODE_OPTIONS: nodeOptions },
		});
		assert.equal(result.exitCode, 0, `NODE_OPTIONS=${nodeOptions}: ${result.stderr.toString()}`);
		assert.match(result.stdout.toString(), /SURVIVED/u);
	}
	const thrown = spawnSyncCollect([bunExecutable(), "-e", script], { cwd: REPO_ROOT });
	assert.notEqual(thrown.exitCode, 0, "the guard throws an unrelated rejection by default");
	assert.match(thrown.stderr.toString(), /UNRELATED_REJECTION/u);
});
