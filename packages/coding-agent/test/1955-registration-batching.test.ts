import { expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionAPI } from "../src/core/extensions/loader-api.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { resolveRegisteredCommands } from "../src/core/extensions/runner-registries.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import { resolveInheritedExtensionOverlaps } from "../src/core/resource-loader-extensions.ts";

function extension(path: string, origin: "atomic" | "bundled" | "inherited-pi"): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "user", origin: "top-level", configurationOrigin: origin },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

for (const origin of ["inherited-pi", "bundled"] as const) {
	test(`keeps unique ${origin} registrations synchronous`, async () => {
		const runtime = createExtensionRuntime();
		const candidate = extension(origin, origin);
		runtime.getAllTools = () => [...candidate.tools.values()].map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo }));
		runtime.getCommands = () => [...candidate.commands.values()].map((command) => ({ ...command, source: "extension" }));
		let activeTools: string[] = [];
		const registryTools = new Set<string>();
		runtime.getActiveTools = () => [...activeTools];
		runtime.setActiveTools = (names) => { activeTools = [...names]; };
		runtime.refreshTools = () => {
			const additions = [...candidate.tools.keys()].filter((name) => !registryTools.has(name));
			for (const name of candidate.tools.keys()) registryTools.add(name);
			activeTools = [...new Set([...activeTools, ...additions])];
		};
		const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());
		let sawTool = false;
		let sawCommand = false;
		let sawActiveTool = false;
		pi.on("session_start", async () => {
			pi.registerFlag("unique-flag", { type: "string", default: "ready" });
			pi.registerTool({ name: "unique-tool", parameters: {} as never, execute: async () => ({ content: [] }) });
			pi.registerCommand("unique-command", { handler: async () => {} });
			sawTool = pi.getAllTools().some((tool) => tool.name === "unique-tool");
			sawCommand = pi.getCommands().some((command) => command.name === "unique-command");
			sawActiveTool = pi.getActiveTools().includes("unique-tool");
			pi.setActiveTools([]);
			pi.registerTool({ name: "tool-after-selection", parameters: {} as never, execute: async () => ({ content: [] }) });
			sawActiveTool = sawActiveTool && pi.getActiveTools().includes("tool-after-selection");
			if (pi.getFlag("unique-flag") === "ready") pi.registerCommand("conditional-command", { handler: async () => {} });
		});
		const result = { extensions: [candidate], errors: [], runtime };
		resolveInheritedExtensionOverlaps(result);
		const runner = new ExtensionRunner(result.extensions, runtime, "/tmp", {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(runtime.flagValues.get("unique-flag")).toBe("ready");
		expect([sawTool, sawCommand, sawActiveTool]).toEqual([true, true, true]);
		expect(activeTools).toEqual(["tool-after-selection"]);
		expect(candidate.commands.has("conditional-command")).toBe(true);
		expect(result.overlaps).toEqual([]);
	});
}

test("keeps original event order while committing only the bundled collision winner", async () => {
	const runtime = createExtensionRuntime();
	const inherited = extension("inherited", "inherited-pi");
	const bundled = extension("bundled", "bundled");
	const trace: string[] = [];
	let inheritedObserved: boolean | string | undefined;
	for (const candidate of [inherited, bundled]) {
		const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());
		pi.on("session_start", async () => {
			trace.push(candidate.sourceInfo.configurationOrigin ?? "missing");
			pi.registerFlag("shared", { type: "string", default: candidate.path });
			if (candidate === inherited) inheritedObserved = pi.getFlag("shared");
			pi.registerCommand("shared", { handler: async () => {} });
		});
	}
	const result = { extensions: [inherited, bundled], errors: [], runtime };
	resolveInheritedExtensionOverlaps(result);
	const runner = new ExtensionRunner(result.extensions, runtime, "/tmp", {} as never, {} as never);
	await runner.emit({ type: "session_start", reason: "startup" });
	expect(trace).toEqual(["inherited-pi", "bundled"]);
	expect(inheritedObserved).toBe("inherited");
	expect(inherited.flags.has("shared")).toBe(false);
	expect(inherited.commands.has("shared")).toBe(false);
	expect(runtime.flagValues.get("shared")).toBe("bundled");
	expect(result.overlaps?.map((overlap) => overlap.resourceType).sort()).toEqual(["command", "flag"]);
});

test("preserves first-registration views across pending inherited duplicates", async () => {
	const runtime = createExtensionRuntime();
	const first = extension("first", "inherited-pi");
	const second = extension("second", "inherited-pi");
	const extensions = [first, second];
	runtime.getAllTools = () => [];
	runtime.getCommands = () => resolveRegisteredCommands(extensions).map((command) => ({
		name: command.invocationName,
		description: command.description,
		source: "extension",
		sourceInfo: command.sourceInfo,
	}));
	let secondView: Array<boolean | string | undefined> = [];
	let secondCommands: string[] = [];
	for (const candidate of extensions) {
		const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());
		pi.on("session_start", async () => {
			pi.registerFlag("shared", { type: "string", default: candidate.path });
			pi.registerTool({ name: "shared", description: candidate.path, parameters: {} as never, execute: async () => ({ content: [] }) });
			pi.registerCommand("shared", { description: candidate.path, handler: async () => {} });
			if (candidate === first) {
				pi.registerFlag("repeated", { type: "string", default: "first-default" });
				pi.registerFlag("repeated", { type: "string", default: "second-default" });
			} else {
				secondView = [
					pi.getFlag("shared"),
					pi.getAllTools().find((tool) => tool.name === "shared")?.description,
					pi.getCommands().find((command) => command.description === "first")?.description,
				];
				secondCommands = pi.getCommands().map((command) => `${command.name}:${command.description}`);
			}
		});
	}
	const result = { extensions, errors: [], runtime };
	resolveInheritedExtensionOverlaps(result);
	const runner = new ExtensionRunner(extensions, runtime, "/tmp", {} as never, {} as never);
	await runner.emit({ type: "session_start", reason: "startup" });
	expect(secondView).toEqual(["first", "first", "first"]);
	expect(secondCommands).toEqual(["shared:1:first", "shared:2:second"]);
	expect(runtime.flagValues.get("repeated")).toBe("first-default");
});


for (const origin of ["inherited-pi", "atomic"] as const) {
	test(`uses the first defined default across duplicate ${origin} flags`, async () => {
		const runtime = createExtensionRuntime();
		const first = extension(`${origin}-first`, origin);
		const second = extension(`${origin}-second`, origin);
		let observed: boolean | string | undefined;
		const firstApi = createExtensionAPI(first, runtime, "/tmp", createEventBus());
		const secondApi = createExtensionAPI(second, runtime, "/tmp", createEventBus());
		firstApi.on("session_start", async () => firstApi.registerFlag("later-default", { type: "string" }));
		secondApi.on("session_start", async () => {
			secondApi.registerFlag("later-default", { type: "string", default: "ready" });
			observed = secondApi.getFlag("later-default");
			if (observed === "ready") secondApi.registerCommand("conditional", { handler: async () => {} });
		});
		const result = { extensions: [first, second], errors: [], runtime };
		resolveInheritedExtensionOverlaps(result);
		const runner = new ExtensionRunner(result.extensions, runtime, "/tmp", {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect([observed, runtime.flagValues.get("later-default"), second.commands.has("conditional")])
			.toEqual(["ready", "ready", true]);
		expect(result.overlaps).toEqual([]);
	});
}
test("replays the latest mixed-origin active-tool selection after staged commit", async () => {
	const runtime = createExtensionRuntime();
	const inherited = extension("inherited-active", "inherited-pi");
	const bundled = extension("bundled-active", "bundled");
	const extensions = [inherited, bundled];
	let activeTools: string[] = [];
	runtime.getAllTools = () => extensions.flatMap((candidate) => [...candidate.tools.values()]
		.map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })));
	runtime.getActiveTools = () => [...activeTools];
	runtime.setActiveTools = (names) => { activeTools = [...names]; };
	runtime.refreshTools = () => {
		activeTools = [...new Set([...activeTools, ...extensions.flatMap((candidate) => [...candidate.tools.keys()])])];
	};
	const inheritedApi = createExtensionAPI(inherited, runtime, "/tmp", createEventBus());
	const bundledApi = createExtensionAPI(bundled, runtime, "/tmp", createEventBus());
	inheritedApi.on("session_start", async () => {
		inheritedApi.registerTool({ name: "inherited-tool", parameters: {} as never, execute: async () => ({ content: [] }) });
		inheritedApi.setActiveTools([]);
	});
	bundledApi.on("session_start", async () => {
		bundledApi.registerTool({ name: "bundled-tool", parameters: {} as never, execute: async () => ({ content: [] }) });
		bundledApi.setActiveTools(["bundled-tool"]);
	});
	const result = { extensions, errors: [], runtime };
	resolveInheritedExtensionOverlaps(result);
	const runner = new ExtensionRunner(extensions, runtime, "/tmp", {} as never, {} as never);
	await runner.emit({ type: "session_start", reason: "startup" });
	expect(activeTools).toEqual(["bundled-tool"]);
});
