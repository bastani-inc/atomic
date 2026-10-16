import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";

const builtins = { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } as const;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(extensionFactories: ExtensionFactory[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-review-f-"));
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories,
	});
	await loader.reload();
	const options = {
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins,
	};
	return { options, loader, remove: () => rmSync(cwd, { recursive: true, force: true }) };
}

// #3105: every public user queue door drains its input hook before retiring its generation.
for (const method of ["steer", "followUp", "sendUserMessage"] as const) {
	for (const action of ["continue", "handled", "transform"] as const) {
		test(`review F ${method} seals and drains suspended ${action} input`, async () => {
			const entered = deferred();
			const release = deferred();
			let calls = 0;
			const f = await fixture([
				(pi) => {
					pi.on("input", async () => {
						calls++;
						entered.resolve();
						await release.promise;
						return action === "transform" ? { action, text: "retired transform" } : { action };
					});
				},
			]);
			const { session } = await createAgentSession(f.options);
			try {
				const result = session[method]("  preserved text  ").catch((error: unknown) => error);
				await entered.promise;
				let closed = false;
				const closing = session.dispose().then(() => {
					closed = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 20));
				const closedBeforeRelease = closed;
				release.resolve();
				const error = await result;
				await closing;
				assert.equal(closedBeforeRelease, false);
				assert.equal((error as { code?: string }).code, "SessionClosed");
				await assert.rejects(session[method]("late"), { code: "SessionClosed" });
				assert.equal(calls, 1);
				assert.deepEqual(session.getSteeringMessages(), []);
				assert.deepEqual(session.getFollowUpMessages(), []);
			} finally {
				release.resolve();
				await session.dispose();
				f.remove();
			}
		});
	}
}

// #3105: persisted storage is borrowed, not the native execution owner.
test("review F shared storage keeps sibling shell ownership independent", async () => {
	const f = await fixture();
	const { session: a } = await createAgentSession(f.options);
	const { session: b } = await createAgentSession(f.options);
	const run = (session: typeof a, id: string, command: string) =>
		session.agent.state.tools
			.find((tool) => tool.name === "bash")!
			.execute(id, { command, wait: { kind: "foreground" } });
	try {
		assert.equal(a.sessionId, b.sessionId);
		assert.equal(a.sessionManager, b.sessionManager);
		await run(a, "a", "printf A");
		await run(b, "b", "printf B");
		await a.dispose();
		assert.match(JSON.stringify(await run(b, "c", "printf SURVIVED")), /SURVIVED/);
		await b.reload();
		assert.match(JSON.stringify(await run(b, "d", "printf RELOADED")), /RELOADED/);
		assert.equal(b.sessionId, f.options.sessionManager.getSessionId());
	} finally {
		await Promise.allSettled([a.dispose(), b.dispose()]);
		f.remove();
	}
});

// #3105: a failed factory owns its registered cleanup, but not discovery's resources.
for (const failCleanup of [false, true]) {
	test(`review F factory acquisition rollback preserves all causes (${failCleanup})`, async () => {
		let attempts = 0;
		const active = new Set<number>();
		const released: number[] = [];
		const f = await fixture([
			(pi) => {
				const id = ++attempts;
				active.add(id);
				pi.on("session_shutdown", () => {
					active.delete(id);
					released.push(id);
					if (failCleanup && id > 2) throw new Error(`cleanup ${id}`);
				});
			},
			(pi) => {
				const id = ++attempts;
				active.add(id);
				pi.on("session_shutdown", () => {
					active.delete(id);
					released.push(id);
					if (failCleanup && id > 2) throw new Error(`cleanup ${id}`);
				});
				if (id > 2) throw new Error("factory failed");
			},
		]);
		// A forwarding loader preserves caller policy and borrows the discovery result.
		const resourceLoader = new Proxy(f.loader, {
			get(target, key) {
				if (key === "constructor") return Object;
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		try {
			await assert.rejects(createAgentSession({ ...f.options, resourceLoader }), (error: unknown) => {
				const messages = (value: unknown): string =>
					value instanceof AggregateError ? value.errors.map(messages).join(";") : String(value);
				assert.match(messages(error), /factory failed/);
				if (failCleanup) {
					assert.match(messages(error), /cleanup 3/);
					assert.match(messages(error), /cleanup 4/);
				}
				return true;
			});
			assert.deepEqual([...active], [1, 2]);
			assert.deepEqual(released.sort(), [3, 4]);
		} finally {
			f.remove();
		}
	});
}

// #3105: copied/edited registrations keep their actual behavior and session-local APIs.
test("review F transformed registrations bind the invoking sibling across awaits", async () => {
	const f = await fixture();
	class HostLoader extends DefaultResourceLoader {
		getSystemPrompt() {
			return "caller policy";
		}
	}
	let factories = 0;
	let capturedAPI!: ExtensionAPI;
	const gates = [deferred(), deferred()];
	let entered = 0;
	const eventBus = createEventBus();
	const loader = new HostLoader({
		...f.options,
		eventBus,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				capturedAPI = pi;
				const instance = ++factories;
				let calls = 0;
				pi.registerCommand("probe", {
					description: "original",
					handler: async () => {
						await gates[entered++]!.promise;
						await pi.appendEntry("probe", { instance, calls: ++calls });
					},
				});
				pi.registerCommand("removed", {
					handler: async () => {
						await pi.appendEntry("removed", {});
					},
				});
			},
		],
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.map((extension) => {
				const overrideAPI = capturedAPI;
				const commands = new Map(extension.commands);
				const probe = commands.get("probe")!;
				commands.delete("removed");
				commands.set("probe", {
					...probe,
					description: "caller override",
					handler: async (args, ctx) => {
						await probe.handler(args, ctx);
						await overrideAPI.appendEntry("wrapped", "caller behavior");
					},
				});
				commands.set("added", {
					...probe,
					name: "added",
					handler: async () => {
						await Promise.resolve();
						await overrideAPI.appendEntry("added", "caller behavior");
						overrideAPI.registerCommand("dynamic", {
							handler: async () => {
								await overrideAPI.appendEntry("dynamic", true);
							},
						});
						overrideAPI.events.on("review:event", async () => {
							await overrideAPI.appendEntry("event", true);
						});
					},
				});
				return { ...extension, commands };
			}),
		}),
	});
	await loader.reload();
	const errors: string[] = [];
	const options = {
		...f.options,
		resourceLoader: loader,
		extensionBindings: {
			onError: (error: { error: string }) => {
				errors.push(error.error);
			},
		},
	};
	const { session: a } = await createAgentSession(options);
	const { session: b } = await createAgentSession({
		...options,
		sessionManager: SessionManager.inMemory(f.options.cwd),
	});
	try {
		const first = a.prompt("/probe");
		const second = b.prompt("/probe");
		while (entered < 2) await new Promise((resolve) => setTimeout(resolve, 1));
		gates[1]!.resolve();
		await second;
		gates[0]!.resolve();
		await first;
		assert.deepEqual(errors, []);
		const entries = [a, b].map((session) =>
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "probe"),
		);
		assert.deepEqual(
			entries.map((items) => items.length),
			[1, 1],
		);
		assert.notDeepEqual(entries[0]![0]!.data, entries[1]![0]!.data);
		for (const session of [a, b])
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "wrapped"),
			);
		for (const session of [a, b]) {
			assert.equal(session.extensionRunner.getCommand("removed"), undefined);
			assert.equal(session.extensionRunner.getCommand("probe")!.description, "caller override");
			await session.prompt("/added");
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "added"),
			);
			await session.prompt("/dynamic");
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "dynamic"),
			);
		}
		eventBus.emit("review:event", undefined);
		await vi.waitFor(() => {
			for (const session of [a, b])
				assert.ok(
					session.sessionManager
						.getEntries()
						.some((entry) => entry.type === "custom" && entry.customType === "event"),
				);
		});
		await a.dispose();
		await b.prompt("/added");
		assert.deepEqual(errors, []);
	} finally {
		for (const gate of gates) gate.resolve();
		await Promise.allSettled([a.dispose(), b.dispose()]);
		f.remove();
	}
});

// #3105: extension send doors must not enqueue or persist new work after closing.
test("review F custom send doors seal after disposal", async () => {
	const f = await fixture();
	const { session } = await createAgentSession(f.options);
	try {
		await session.dispose();
		const message = { customType: "late", content: "raw", display: true };
		await assert.rejects(session.sendCustomMessage(message, { deliverAs: "nextTurn" }), { code: "SessionClosed" });
		await assert.rejects(session.sendCustomMessages([message], { deliverAs: "nextTurn" }), { code: "SessionClosed" });
	} finally {
		await session.dispose();
		f.remove();
	}
});

// #3105: ordinary live queues keep raw payloads, transformation, handling and order.
for (const method of ["steer", "followUp"] as const) {
	test(`review F ${method} preserves live behavior across reload`, async () => {
		const f = await fixture([
			(pi) => {
				pi.on("input", (event) =>
					event.text === "handled"
						? { action: "handled" }
						: event.text === "transform"
							? { action: "transform", text: " transformed  " }
							: { action: "continue" },
				);
			},
		]);
		const { session } = await createAgentSession(f.options);
		try {
			await session[method]("  raw text  ");
			await session[method]("handled");
			await session[method]("transform");
			const read = () => (method === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages());
			assert.deepEqual(read(), ["  raw text  ", " transformed  "]);
			session.clearQueue();
			await session.reload();
			await session[method]("  fresh  ");
			assert.deepEqual(read(), ["  fresh  "]);
		} finally {
			await session.dispose();
			f.remove();
		}
	});
}

// #3105: failed cleanup cannot skip remaining subscriptions acquired by a failed creation.
test("review F factory rollback attempts every subscription release", async () => {
	const f = await fixture();
	const released: string[] = [];
	let generations = 0;
	class HostLoader extends DefaultResourceLoader {}
	const loader = new HostLoader({
		...f.options,
		noExtensions: true,
		eventBus: {
			emit() {},
			on(channel) {
				return () => {
					released.push(channel);
					throw new Error(`release ${channel}`);
				};
			},
		},
		extensionFactories: [
			(pi) => {
				const generation = ++generations;
				pi.events.on(`${generation}:first`, () => {});
				pi.events.on(`${generation}:second`, () => {});
				pi.events.on(`${generation}:third`, () => {});
				if (generation > 1) throw new Error("subscription factory failed");
			},
		],
	});
	await loader.reload();
	try {
		await assert.rejects(createAgentSession({ ...f.options, resourceLoader: loader }));
		assert.deepEqual(released.sort(), ["2:first", "2:second", "2:third"]);
	} finally {
		f.remove();
	}
});

// #3105: retiring reload generations drain queues but cannot deliver into the successor.
for (const method of ["steer", "followUp"] as const) {
	test(`review F ${method} captures its admitted generation during reload`, async () => {
		const entered = deferred();
		const release = deferred();
		const f = await fixture([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "suspended") {
						entered.resolve();
						await release.promise;
					}
					return { action: "continue" };
				});
			},
		]);
		const { session } = await createAgentSession(f.options);
		try {
			const queued = session[method]("suspended").catch((error: unknown) => error);
			await entered.promise;
			let reloaded = false;
			const reload = session.reload().then(() => {
				reloaded = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			const prematurelyReloaded = reloaded;
			release.resolve();
			assert.equal(((await queued) as { code: string }).code, "SessionClosed");
			await reload;
			assert.equal(prematurelyReloaded, false);
			await session[method]("fresh");
			assert.deepEqual(method === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages(), [
				"fresh",
			]);
		} finally {
			release.resolve();
			await session.dispose();
			f.remove();
		}
	});
}

// #3105: caller correlation IDs are not operation identities.
for (const cancel of ["dispose", "id", "settled-peer"] as const) {
	test(`review F duplicate shell IDs cancel every operation (${cancel})`, async () => {
		const f = await fixture();
		const { session } = await createAgentSession(f.options);
		const signals: AbortSignal[] = [];
		const finish: Array<() => void> = [];
		const operations = {
			exec: async (_command: string, _cwd: string, { signal }: { signal?: AbortSignal }) =>
				new Promise<{ exitCode: number }>((resolve) => {
					assert.ok(signal);
					signals.push(signal);
					finish.push(() => resolve({ exitCode: 0 }));
					signal.addEventListener("abort", () => resolve({ exitCode: 0 }), { once: true });
				}),
		};
		const id = "  same raw id  ";
		const first = session.executeBash("first", undefined, { id, operations });
		const second = session.executeBash("second", undefined, { id, operations });
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (cancel === "settled-peer") {
				finish[0]!();
				await first;
			}
			if (cancel === "dispose") void session.dispose();
			else session.abortBash(id);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.deepEqual(
				signals.map((signal) => signal.aborted),
				[cancel !== "settled-peer", true],
			);
		} finally {
			for (const done of finish) done();
			await Promise.all([first, second]);
			await session.dispose();
			f.remove();
		}
	});
}

// #3105: ownership begins at acquisition, not at AgentSession construction.
for (const failCleanup of [false, true]) {
	test(`review F preconstructor setup rolls back only owned acquisitions (${failCleanup})`, async () => {
		let acquired = 0;
		const active = new Set<number>();
		const f = await fixture([
			(pi) => {
				const id = ++acquired;
				active.add(id);
				pi.on("session_shutdown", () => {
					active.delete(id);
					if (failCleanup) throw new Error("owned cleanup failed");
				});
			},
		]);
		const cause = new Error("context transform failed");
		try {
			await assert.rejects(
				createAgentSession({
					...f.options,
					initialContextTransform: () => {
						throw cause;
					},
				}),
				(error: unknown) =>
					failCleanup ? error instanceof AggregateError && error.errors.includes(cause) : error === cause,
			);
			assert.deepEqual([...active], [1]);
		} finally {
			f.remove();
		}
	});
}

// #3105: real storage faults remain attributable without consuming shared errors.
for (const borrowed of [false, true]) {
	for (const recover of [false, true]) {
		test(`review F real settings persistence failure borrowed=${borrowed} recovery=${recover}`, async () => {
			const f = await fixture();
			const manager = SettingsManager.create(f.options.cwd, f.options.agentDir);
			const { session } = await createAgentSession({
				...f.options,
				settingsManager: borrowed ? manager : undefined,
			});
			const { session: sibling } = await createAgentSession({
				...f.options,
				settingsManager: session.settingsManager,
			});
			const path = join(f.options.agentDir, "settings.json");
			try {
				await session.settingsManager.flush();
				rmSync(path, { force: true });
				mkdirSync(path, { recursive: true });
				await session.setThinkingLevel("off", { persist: true });
				await session.settingsManager.flush();
				if (recover) {
					rmSync(path, { recursive: true });
					await session.setThinkingLevel("off", { persist: true });
				}
				await sibling.dispose();
				if (recover) await session.dispose();
				else await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
				assert.ok(session.settingsManager.drainErrors().some(({ error }) => /EISDIR/.test(error.message)));
			} finally {
				await Promise.allSettled([session.dispose(), sibling.dispose()]);
				f.remove();
			}
		});
	}
}

// #3105: a delegated resource getter can fail during construction, after acquisition.
test("review F resource setup failure rolls back owned factory and subscriptions", async () => {
	let acquired = 0;
	const active = new Set<number>();
	const cause = new Error("resource policy failed");
	const f = await fixture([
		(pi) => {
			const id = ++acquired;
			active.add(id);
			pi.on("session_shutdown", () => {
				active.delete(id);
			});
		},
	]);
	f.loader.getSkills = () => {
		throw cause;
	};
	try {
		await assert.rejects(createAgentSession(f.options), (error) => error === cause);
		assert.deepEqual([...active], [1]);
	} finally {
		f.remove();
	}
});

// #3105: draining normal errors cannot hide lease failure; caller writes remain caller-owned.
for (const writer of ["session", "caller"] as const) {
	test(`review F borrowed settings error channel remains independent (${writer})`, async () => {
		const f = await fixture();
		const manager = SettingsManager.create(f.options.cwd, f.options.agentDir);
		const { session } = await createAgentSession({ ...f.options, settingsManager: manager });
		const path = join(f.options.agentDir, "settings.json");
		try {
			mkdirSync(path, { recursive: true });
			if (writer === "session") await session.setThinkingLevel("off", { persist: true });
			else manager.setDefaultThinkingLevel("off");
			await manager.flush();
			assert.ok(manager.drainErrors().some(({ error }) => /EISDIR/.test(error.message)));
			if (writer === "session") await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
			else await session.dispose();
			assert.deepEqual(manager.drainErrors(), []);
		} finally {
			await Promise.allSettled([session.dispose()]);
			f.remove();
		}
	});
}

// #3105: constructor cleanup must not replace the setup cause or skip remaining releases.
test("review F constructor failure retains setup and every cleanup cause", async () => {
	const f = await fixture();
	const cause = new Error("constructor setup failed");
	let generations = 0;
	const released: string[] = [];
	const active = new Set<number>();
	class HostLoader extends DefaultResourceLoader {}
	const loader = new HostLoader({
		...f.options,
		noExtensions: true,
		eventBus: {
			emit() {},
			on(channel) {
				return () => {
					released.push(channel);
					throw new Error(`release ${channel}`);
				};
			},
		},
		extensionFactories: [
			(pi) => {
				const id = ++generations;
				active.add(id);
				pi.events.on(`${id}:first`, () => {});
				pi.events.on(`${id}:second`, () => {});
				pi.on("session_shutdown", () => {
					active.delete(id);
					throw new Error(`shutdown ${id}`);
				});
			},
		],
	});
	await loader.reload();
	const errors = (error: unknown): unknown[] =>
		error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
	try {
		await assert.rejects(
			createAgentSession({
				...f.options,
				resourceLoader: loader,
				systemPromptTransform() {
					throw cause;
				},
			}),
			(error) => {
				const causes = errors(error);
				assert.ok(causes.includes(cause));
				assert.match(String(causes), /release 2:first/);
				assert.match(String(causes), /release 2:second/);
				assert.match(String(causes), /shutdown 2/);
				return true;
			},
		);
		assert.deepEqual([...active], [1]);
		assert.deepEqual(released.sort(), ["2:first", "2:second"]);
	} finally {
		f.remove();
	}
});
