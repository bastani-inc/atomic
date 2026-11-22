import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { prepareAgentSessionServices } from "../../packages/coding-agent/src/core/agent-session-services.ts";
import { isSessionQuitting } from "../../packages/coding-agent/src/core/agent-session-events.ts";
import {
	AuthStorage,
	createAgentSessionFromServices,
	ModelRuntime,
	SessionManager,
} from "../../packages/coding-agent/src/index.ts";

const scenario = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "atomic-command-scope-"));
const NativeController = globalThis.AbortController;
const scope = new AsyncLocalStorage();
const controllers = [];
const cleanups = [];
let retired = false;
let reads = 0;
let session;
try {
	const loaded = [];
	const names = ["first", "second", "third"];
	let completed = false;
	let completeTrust;
	const prepare = await prepareAgentSessionServices(
		{
			cwd,
			agentDir: cwd,
			modelRuntime: await ModelRuntime.create({
				credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false,
			}),
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				additionalExtensionPaths: [...names, "llama.cpp"].map((name) => `builtin:${name}`),
				extensionFactories: [
					(atomic) => atomic.registerCommand("inspect", {
						description: "inspect",
						handler: async () => { completed = true; },
					}),
					...names.map((name) => ({ name, builtin: true, factory() { loaded.push(name); } })),
				],
			},
			resourceLoaderReloadOptions: {
				deferProjectTrust: (complete) => { completeTrust = complete; },
				resolveProjectTrust: () => false,
			},
		},
		() => session !== undefined && isSessionQuitting(session),
	);
	({ session } = await createAgentSessionFromServices({
		services: await prepare(),
		model: getModel("anthropic", "claude-sonnet-4-5"),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	}));

	// Only controllers created inside this host request have a command-scoped signal.
	globalThis.AbortController = class extends NativeController {
		constructor() {
			super();
			if (!scope.getStore()) return;
			controllers.push(this);
			const signal = super.signal;
			if (scenario === "revoked") {
				const view = Proxy.revocable(signal, {
					get(target, key) {
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				Object.defineProperty(this, "signal", { configurable: true, value: view.proxy });
				cleanups.push(view.revoke);
			} else if (scenario === "metered") {
				Object.defineProperty(this, "signal", {
					configurable: true,
					get() {
						if (retired) {
							reads++;
							Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
						}
						return signal;
					},
				});
			} else {
				assert.equal(scenario, "aborted");
				cleanups.push(() => this.abort());
			}
		}
	};
	await scope.run(true, () => session.prompt("/inspect"));
	assert.ok(completed && controllers.length > 0, "the registered command ran in the host scope");
	retired = true;
	for (const cleanup of cleanups) cleanup();
	await completeTrust();
	assert.deepEqual(loaded, names, "command cleanup must not prevent the remaining builtins from loading");
	const finalServices = await prepare();
	assert.ok(finalServices.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("llama")));
	assert.equal(reads, 0, "discovery must not reacquire the command's signal");
} finally {
	globalThis.AbortController = NativeController;
	for (const controller of controllers) delete controller.signal;
	await session?.dispose();
	rmSync(cwd, { recursive: true, force: true });
}
