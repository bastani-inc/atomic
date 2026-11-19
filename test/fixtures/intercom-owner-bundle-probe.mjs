import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Inputs are independently built host and builtin modules, not source imports.
const { ExtensionRunner } = await import(pathToFileURL(process.argv[2]).href);
const { default: intercom } = await import(pathToFileURL(process.argv[3]).href);
// Node emits import-time warnings (including node:sqlite's experimental warning)
// on the next turn. Let startup finish before capturing operation diagnostics.
await tick();
const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
const rows = [];
function owner(mode, unowned = false) {
	const notifications = [];
	const runner = new ExtensionRunner(
		[], { invalidate() {} }, ".", {}, {},
	);
	runner.setUIContext(
		mode === "tui" || mode === "rpc" ? { notify: (message, level) => notifications.push({ message, level }) } : undefined,
		mode,
	);
	// Plain compatibility contexts deliberately have no host registration. Lazy
	// descriptors retain real guards, but must keep fallback object identity.
	const plain = Object.defineProperties({}, Object.getOwnPropertyDescriptors(runner.createContext()));
	return {
		notifications,
		context: (command = false) => unowned ? plain : command ? runner.createCommandContext() : runner.createContext(),
		invalidate: () => runner.invalidate(),
	};
}
for (const mode of ["print", "json", "rpc", "tui"]) {
	for (const phase of ["import", "factory"]) {
		for (const dispatch of ["tool", "command"]) {
			for (const transition of ["same", "new-live", "new-stale", "unknown-same", "unknown-new-stale"]) {
				const unowned = transition.startsWith("unknown");
				const changesOwner = transition.includes("new");
				const caller = owner(mode, unowned);
				const targetMode = changesOwner ? mode === "tui" ? "print" : "tui" : mode;
				const target = changesOwner ? owner(targetMode, unowned) : caller;
				const startup = caller.context();
				const invocation = caller.context(dispatch === "command");
				if (!unowned) assert.notEqual(startup, invocation);
				const replayContext = changesOwner ? target.context() : startup;
				const gate = Promise.withResolvers();
				const entered = Promise.withResolvers();
				const failure = new Error("Connection closen");
				const success = { content: [{ type: "text", text: "connected" }], details: {} };
				const tools = new Map(), commands = new Map(), handlers = new Map();
				let imports = 0, commandRetries = 0;
				intercom({
					on: (name, handler) => handlers.set(name, handler),
					registerTool: (tool) => tools.set(tool.name, tool),
					registerCommand: (name, command) => commands.set(name, command),
					registerShortcut() {}, events: { on() {} },
				}, { importHeavy: async () => {
					if (++imports > 1) return { default(pi) {
						pi.registerTool({ name: "intercom", execute: async () => success });
						pi.registerCommand("intercom", { handler() { commandRetries++; } });
					} };
					entered.resolve(); await gate.promise;
					return { default(pi) {
						if (phase === "factory" && transition !== "new-live") queueMicrotask(target.invalidate);
						pi.on("session_start", (_event, ctx) => {
							assert.equal(ctx, replayContext);
							if (transition !== "new-live") assert.throws(() => ctx.mode, /extension ctx is stale/);
							throw failure;
						});
					} };
				} });
				const start = (ctx) => handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
				const execute = (ctx) => dispatch === "command" ? commands.get("intercom").handler("", ctx)
					: tools.get("intercom").execute("bundle", { action: "list" }, undefined, undefined, ctx);
				const saved = { error: console.error, log: console.log, warn: console.warn };
				const errors = [], otherWrites = [];
				console.error = (...args) => errors.push(args);
				console.log = console.warn = (...args) => otherWrites.push(args);
				try {
					await start(startup);
					const rejected = assert.rejects(execute(invocation), (error) => error === failure);
					await entered.promise;
					if (changesOwner) await start(replayContext);
					if (phase === "import" && transition !== "new-live") target.invalidate();
					gate.resolve(); await rejected; await tick();
					const consoleExpected = targetMode !== "tui" && !transition.includes("new-stale");
					assert.deepEqual(errors, consoleExpected ? [[message, failure]] : []);
					if (consoleExpected) assert.equal(errors[0][1], failure);
					assert.deepEqual(otherWrites, []);
					assert.deepEqual(target.notifications, transition === "new-live" && targetMode === "tui" ? [{ message, level: "warning" }] : []);
					if (changesOwner) assert.deepEqual(caller.notifications, []);
					const replacement = owner(mode);
					await start(replacement.context());
					const result = await execute(replacement.context(dispatch === "command"));
					if (dispatch === "tool") assert.equal(result, success);
					else assert.equal(commandRetries, 1);
					assert.equal(imports, 2);
					assert.deepEqual(replacement.notifications, []);
					rows.push({ mode, phase, dispatch, transition });
				} finally { Object.assign(console, saved); }
			}
		}
	}
}
assert.equal(rows.length, 80);
console.log(JSON.stringify({ passed: rows.length, runtime: typeof Bun === "undefined" ? "node" : "bun", rows }));
