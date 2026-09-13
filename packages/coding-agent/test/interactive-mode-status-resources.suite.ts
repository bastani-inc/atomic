import { homedir } from "node:os";
import * as path from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { INSTALLED_EXTENSION_ENTRIES, SOURCE_EXTENSION_ENTRIES } from "../src/core/builtin-install-layout.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { attachInteractiveEngineResourceExtensionRefresh } from "../src/modes/interactive/interactive-startup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcResourceExtension } from "../src/modes/rpc/rpc-types.ts";
import { type ExtensionFixture, normalizeRenderedOutput, renderAll } from "./interactive-mode-status-helpers.ts";
import {
	createExtensionFixtures,
	createShowLoadedResourcesThis,
	createSourceInfo,
} from "./interactive-mode-status-resources-helpers.ts";
import { createHarness } from "./suite/harness.ts";

function createBuiltinExtensionFixtures(entryKind: "source" | "installed" = "source"): ExtensionFixture[] {
	const entries = entryKind === "source" ? SOURCE_EXTENSION_ENTRIES : INSTALLED_EXTENSION_ENTRIES;
	return getBuiltinPackageLocations().map(({ distDirName, packageDir }) => ({
		path: path.resolve(packageDir, entries[distDirName]),
	}));
}

const BUILTIN_EXTENSION_LABELS = ["feedback", "intercom", "mcp", "subagents", "web-access", "workflows"];

function createLocalExtensionFixture(
	extensionPath: string,
	scope: "user" | "project",
): ExtensionFixture & { sourceInfo: NonNullable<ExtensionFixture["sourceInfo"]> } {
	return {
		path: extensionPath,
		sourceInfo: createSourceInfo(extensionPath, {
			source: "local",
			scope,
			origin: "top-level",
		}),
	};
}

function renderCompactExtensionLabels(extensions: ExtensionFixture[]): string[] {
	const fakeThis = createShowLoadedResourcesThis({ quietStartup: false });
	(InteractiveMode as any).prototype.addResourceDisclosure.call(fakeThis, {
		contextFiles: [],
		skills: [],
		prompts: [],
		extensions,
		themes: [],
		expandedSections: {},
	});
	const output = normalizeRenderedOutput(fakeThis.chatContainer);
	const extensionsRow = output.match(/\[Extensions\]\n {2}([^\n]+)/)?.[1];
	if (!extensionsRow) throw new Error("Expected a compact Extensions row");
	return extensionsRow.split(", ");
}

async function createInventoryRuntime(resourceExtensions: RpcResourceExtension[]) {
	const harness = await createHarness();
	const local = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		local,
		async () => {
			throw new Error("unused runtime factory");
		},
		{
			onEvent: () => () => {},
			onGenerationEnded: () => () => {},
			getGeneration: () => 1,
			getState: async () => ({
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "engine",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
				queuedMessagesPaused: false,
				resourceExtensions,
			}),
			requestInternal: async () => ({ models: [], scopedModels: [] }),
			getCommands: async () => [],
			stop: async () => {},
		} as never,
	);
	return { harness, runtime };
}

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows installed resource names by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			contextFiles: [{ path: "/tmp/project/AGENTS.md" }],
			prompts: [
				{ filePath: "/tmp/prompts/review.md", name: "review" },
				{ filePath: "/tmp/prompts/explain.md", name: "explain" },
			],
			extensions: [{ path: "/tmp/extensions/answer.ts" }],
			themes: [{ name: "solarized", sourcePath: "/tmp/themes/solarized.json" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Context]");
		expect(output).toContain("AGENTS.md");
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).toContain("[Prompts]");
		expect(output).toContain("/explain, /review");
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts");
		expect(output).toContain("[Themes]");
		expect(output).toContain("solarized");
		expect(output).not.toContain("/tmp/skill/SKILL.md");
	});

	test("lists each prompt once and keeps slash-prefixed labels when expanded", () => {
		const prompts = [{ filePath: "/tmp/prompts/review.md", name: "review" }];
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			promptTemplates: prompts,
			prompts,
			useRealScopeGroups: true,
		});

		InteractiveMode.prototype.showLoadedResources.call(fakeThis, { force: false });

		const collapsedOutput = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(collapsedOutput.match(/\/review/g)).toHaveLength(1);
		expect(collapsedOutput).not.toContain("review, review");

		fakeThis.chatContainer.children.forEach((child: object) => {
			if ("setExpanded" in child && typeof child.setExpanded === "function") child.setExpanded(true);
		});
		const expandedOutput = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(expandedOutput.match(/\/review/g)).toHaveLength(1);
		expect(expandedOutput).not.toContain("/tmp/prompts/review.md");
	});

	test("Ctrl+O expands and collapses startup resource sections nested in the disclosure container", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			useRealScopeGroups: true,
		});
		fakeThis.resourceDisclosureContainer = new Container();
		fakeThis.chatContainer.addChild(fakeThis.resourceDisclosureContainer);
		fakeThis.customHeader = undefined;
		fakeThis.builtInHeader = undefined;
		fakeThis.ui = { requestRender: () => {} };

		InteractiveMode.prototype.showLoadedResources.call(fakeThis, {
			force: false,
			targetContainer: fakeThis.resourceDisclosureContainer,
		});
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toContain("commit");
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).not.toContain("/tmp/skill/SKILL.md");

		InteractiveMode.prototype.setToolsExpanded.call(fakeThis, true);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toContain("/tmp/skill/SKILL.md");

		InteractiveMode.prototype.setToolsExpanded.call(fakeThis, false);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toContain("commit");
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).not.toContain("/tmp/skill/SKILL.md");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("/tmp/skill/SKILL.md");
		expect(output).not.toContain("  commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("/tmp/skill/SKILL.md");
		expect(output).not.toContain("  commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		// Compact extension rows show the shortest unique labels.
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("labels verified bundled extensions by exact package names in compact source and installed layouts", () => {
		for (const entryKind of ["source", "installed"] as const) {
			expect(renderCompactExtensionLabels(createBuiltinExtensionFixtures(entryKind))).toEqual(
				BUILTIN_EXTENSION_LABELS,
			);
		}
	});

	test("rejects malformed SourceInfo test fixtures at runtime", () => {
		expect(() => createSourceInfo("/tmp/user/extensions/workflows/index.ts", "user" as never)).toThrow(
			"createSourceInfo options must include source, scope, and origin",
		);
	});

	test("models colliding user and project extensions with complete SourceInfo", () => {
		const user = createLocalExtensionFixture("/tmp/user/extensions/workflows/index.ts", "user");
		const project = createLocalExtensionFixture("/tmp/project/extensions/mcp/index.ts", "project");

		expect(user.sourceInfo).toMatchObject({ source: "local", scope: "user", origin: "top-level" });
		expect(project.sourceInfo).toMatchObject({ source: "local", scope: "project", origin: "top-level" });
		expect(renderCompactExtensionLabels([...createBuiltinExtensionFixtures(), user])).toContain(
			"extensions/workflows",
		);
	});

	test.each([
		[`${homedir()}/workflows/index.ts`, "~/workflows/index.ts", "workflows"],
		[`${homedir()}/workflows`, "~/workflows", "workflows"],
		["/workflows/index.ts", "/workflows/index.ts", "workflows"],
		[`${homedir()}/mcp/index.ts`, "~/mcp/index.ts", "mcp"],
	])(
		"uses the full display path for exhausted builtin collision %s",
		(extensionPath, expectedLocalLabel, builtinLabel) => {
			const labels = renderCompactExtensionLabels([
				...createBuiltinExtensionFixtures(),
				createLocalExtensionFixture(extensionPath, "user"),
			]);

			expect(labels).toContain(builtinLabel);
			expect(labels).toContain(expectedLocalLabel);
			expect(new Set(labels).size).toBe(labels.length);
		},
	);

	test("keeps every builtin exact and every local distinct across simultaneous exhausted collisions", () => {
		const localPaths = [
			`${homedir()}/workflows/index.ts`,
			`${homedir()}/workflows`,
			"/workflows/index.ts",
			`${homedir()}/mcp/index.ts`,
		];
		const labels = renderCompactExtensionLabels([
			...createBuiltinExtensionFixtures(),
			...localPaths.map((extensionPath) => createLocalExtensionFixture(extensionPath, "user")),
		]);

		expect(new Set(labels).size).toBe(labels.length);
		for (const builtinLabel of BUILTIN_EXTENSION_LABELS) expect(labels).toContain(builtinLabel);
		expect(labels).toEqual(
			[
				"/workflows/index.ts",
				"~/mcp/index.ts",
				"~/workflows",
				"~/workflows/index.ts",
				...BUILTIN_EXTENSION_LABELS,
			].sort((left, right) => left.localeCompare(right)),
		);
	});

	test("prefers parent segments before full display paths for local builtin collisions", () => {
		const labels = renderCompactExtensionLabels([
			...createBuiltinExtensionFixtures(),
			createLocalExtensionFixture("/tmp/a/workflows/index.ts", "project"),
			createLocalExtensionFixture("/tmp/b/workflows/index.ts", "project"),
			createLocalExtensionFixture("/tmp/extensions/answer.ts", "project"),
		]);

		expect(labels).toContain("a/workflows");
		expect(labels).toContain("b/workflows");
		expect(labels).toContain("answer.ts");
	});

	test("uses deterministic numeric tiebreaks only when the terminal display path is also taken", () => {
		expect(
			renderCompactExtensionLabels([
				...createBuiltinExtensionFixtures(),
				createLocalExtensionFixture("workflows", "project"),
				createLocalExtensionFixture("workflows", "user"),
			]),
		).toEqual(
			[...BUILTIN_EXTENSION_LABELS, "workflows (2)", "workflows (3)"].sort((left, right) =>
				left.localeCompare(right),
			),
		);
		expect(renderCompactExtensionLabels([createLocalExtensionFixture("workflows", "project")])).toEqual([
			"workflows",
		]);
	});

	test("keeps local and builtin full source paths in the expanded listing", () => {
		const local = createLocalExtensionFixture(`${homedir()}/workflows/index.ts`, "user");
		const extensions = [...createBuiltinExtensionFixtures(), local];
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });
		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		for (const extension of extensions) {
			const expectedPath = fakeThis.formatExtensionDisplayPath(extension.path).replace(/\\/g, "/");
			expect(output).toContain(expectedPath);
		}
	});

	test("strips index entry names from Windows extension display paths", () => {
		const fakeThis = createShowLoadedResourcesThis({ quietStartup: false });

		expect(fakeThis.formatExtensionDisplayPath("C:\\atomic\\extensions\\example\\index.ts")).toBe(
			"C:\\atomic\\extensions\\example",
		);
		expect(fakeThis.formatExtensionDisplayPath("C:\\atomic\\extensions\\example\\index.js")).toBe(
			"C:\\atomic\\extensions\\example",
		);
	});

	test("keeps verified bundled extension source paths in the expanded listing", () => {
		const extensions = createBuiltinExtensionFixtures();
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		for (const extension of extensions) {
			const expectedPath = fakeThis.formatExtensionDisplayPath(extension.path).replace(/\\/g, "/");
			expect(output).toContain(expectedPath);
		}
	});

	test("does not relabel a local extension with a builtin-shaped source path", () => {
		const localPath = "/tmp/project/.atomic/extensions/local/src/extension/index.ts";
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: false,
			extensions: [{ path: localPath }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toContain("[Extensions]\n  extension");
		expect(output).not.toContain("[Extensions]\n  local");
	});

	test("merges the engine inventory once and hides identities hidden by either side", async () => {
		const { harness, runtime } = await createInventoryRuntime([
			{ path: "/builtin/workflows/index.ts", hidden: false },
			{ path: "/builtin/subagents/index.ts", hidden: false },
			{ path: "/builtin/mcp/index.ts", hidden: false },
			{ path: "/builtin/web-access/index.ts", hidden: false },
			{ path: "/builtin/intercom/index.ts", hidden: false },
			{ path: "/builtin/feedback/index.ts", hidden: false },
			{ path: "/builtin/internal/index.ts", hidden: true },
			{ path: "/builtin/host-hidden/index.ts", hidden: false },
			{ path: "/builtin/engine-hidden/index.ts", hidden: true },
		]);

		try {
			await runtime.initializeFromEngine();
			const fakeThis = createShowLoadedResourcesThis({
				quietStartup: false,
				runtimeHost: runtime,
				extensions: [
					{ path: "/builtin/intercom" },
					{ path: "/builtin/host-hidden/index.ts", hidden: true },
					{ path: "/builtin/engine-hidden/index.ts" },
				],
			});

			(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });
			const output = normalizeRenderedOutput(fakeThis.chatContainer);
			for (const name of ["workflows", "subagents", "mcp", "web-access", "intercom", "feedback"]) {
				expect(output).toContain(name);
			}
			expect(output.match(/intercom/g)).toHaveLength(1);
			expect(output).not.toContain("internal");
			expect(output).not.toContain("host-hidden");
			expect(output).not.toContain("engine-hidden");
		} finally {
			await runtime.dispose();
			harness.cleanup();
		}
	});

	test("refreshes a rendered disclosure when the engine publishes its extension inventory", async () => {
		const { harness, runtime } = await createInventoryRuntime([
			{ path: "/builtin/workflows/index.ts", hidden: false },
			{ path: "/builtin/intercom/index.ts", hidden: false },
		]);
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			runtimeHost: runtime,
			extensions: [{ path: "/builtin/intercom" }],
		});
		fakeThis.resourceDisclosureContainer = new Container();
		fakeThis.chatContainer.addChild(fakeThis.resourceDisclosureContainer);
		fakeThis.showLoadedResources = (options: Parameters<InteractiveMode["showLoadedResources"]>[0]) =>
			InteractiveMode.prototype.showLoadedResources.call(fakeThis, options);
		fakeThis.ui = { requestRender: () => {} };

		InteractiveMode.prototype.showLoadedResources.call(fakeThis, {
			force: true,
			targetContainer: fakeThis.resourceDisclosureContainer,
		});
		const disposeRefresh = attachInteractiveEngineResourceExtensionRefresh(fakeThis);
		try {
			await runtime.initializeFromEngine();
			const output = normalizeRenderedOutput(fakeThis.resourceDisclosureContainer);
			expect(output).toContain("workflows");
			expect(output.match(/intercom/g)).toHaveLength(1);
			expect(output.match(/workflows/g)).toHaveLength(1);
		} finally {
			disposeRefresh();
			await runtime.dispose();
			harness.cleanup();
		}
	});

	test("does not refresh before the startup disclosure has rendered", async () => {
		const { harness, runtime } = await createInventoryRuntime([
			{ path: "/builtin/workflows/index.ts", hidden: false },
		]);
		const fakeThis = createShowLoadedResourcesThis({ quietStartup: false, runtimeHost: runtime });
		fakeThis.resourceDisclosureContainer = new Container();
		let renderCount = 0;
		fakeThis.showLoadedResources = () => {
			renderCount += 1;
		};
		const disposeRefresh = attachInteractiveEngineResourceExtensionRefresh(fakeThis);
		try {
			await runtime.initializeFromEngine();
			expect(renderCount).toBe(0);
			expect(fakeThis.resourceDisclosureContainer.children).toHaveLength(0);
		} finally {
			disposeRefresh();
			await runtime.dispose();
			harness.cleanup();
		}
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"
		`,
		);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  alpha/one, beta/one, gamma/one"
		`,
		);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  plan-mode"
		`,
		);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  plan-mode"
		`,
		);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  plan-mode, webfetch.ts"
		`,
		);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  bar, foo"
		`,
		);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  alpha/tools, beta/tools"
		`,
		);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  main.ts"
		`,
		);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(
			`
			"[Extensions]
			  pi-markdown-preview"
		`,
		);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
			"[Extensions]
			  project
			    /tmp/project/.pi/extensions/answer.ts
			    /tmp/project/.pi/extensions/local-index
			    git:github.com/HazAT/pi-interactive-subagents
			      extensions
			      extensions/subagents
			    npm:@scope/pi-scoped
			      extensions
			    npm:pi-markdown-preview
			      extensions
			  user
			    /tmp/agent/extensions/user-index
			  path
			    /tmp/temp/cli-extension.ts"
		`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
		expect(output).not.toContain("~/Development/pi-mono/AGENTS.md");
	});

	test("lists system prompt sources before project context files", () => {
		const cwd = path.join(homedir(), "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			systemPromptSource: { path: path.join(cwd, ".atomic", "SYSTEM.md") },
			appendSystemPromptSources: [{ path: path.join(cwd, ".atomic", "APPEND_SYSTEM.md") }],
			contextFiles: [{ path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain(".atomic/SYSTEM.md, .atomic/APPEND_SYSTEM.md, AGENTS.md");
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});

	test("shows one consolidated overlap notice derived from inherited source metadata", () => {
		const inherited = {
			...createSourceInfo("/tmp/pi-subagents/extensions/index.ts", {
				source: "npm:pi-subagents",
				scope: "user",
				origin: "package",
			}),
			configurationOrigin: "inherited-pi" as const,
		};
		const bundled = {
			...createSourceInfo("/tmp/atomic-subagents/index.ts", {
				source: "@bastani/subagents",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [
				{ resourceType: "tool", name: "subagent", inherited, bundled },
				{ resourceType: "command", name: "agents", inherited, bundled },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		const noticePrefix = "Extension overlap detected:";
		expect(output.split(noticePrefix)).toHaveLength(2);
		expect(output).toContain("`pi-subagents` provides resources already bundled with Atomic.");
		expect(output).toContain(
			"Atomic kept its bundled versions; non-conflicting extension features remain available.",
		);
		expect(output).not.toContain("[Prompt conflicts]");
		expect(output).not.toContain("[Extension issues]");
	});

	test("keeps one overlap notice when the startup disclosure is rebuilt", () => {
		const inherited = {
			...createSourceInfo("/tmp/pi-subagents/extensions/index.ts", {
				source: "npm:pi-subagents",
				scope: "user",
				origin: "package",
			}),
			configurationOrigin: "inherited-pi" as const,
		};
		const bundled = {
			...createSourceInfo("/tmp/atomic-subagents/index.ts", {
				source: "@bastani/subagents",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [{ resourceType: "tool", name: "subagent", inherited, bundled }],
		});
		fakeThis.resourceDisclosureContainer = new Container();
		fakeThis.chatContainer.addChild(fakeThis.resourceDisclosureContainer);

		for (let render = 0; render < 2; render += 1) {
			InteractiveMode.prototype.showLoadedResources.call(fakeThis, {
				force: true,
				showDiagnosticsWhenQuiet: true,
				targetContainer: fakeThis.resourceDisclosureContainer,
			});
		}

		const output = normalizeRenderedOutput(fakeThis.resourceDisclosureContainer);
		expect(output.match(/Extension overlap detected:/g)).toHaveLength(1);
		expect(output).toContain("`pi-subagents` provides resources already bundled with Atomic.");

		fakeThis.resourceDisclosureContainer.clear();
		InteractiveMode.prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		const rebuiltOutput = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(rebuiltOutput.match(/Extension overlap detected:/g)).toHaveLength(1);
	});
});
