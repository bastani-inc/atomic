/**
 * Focused regressions for the Pi v0.82.1..v0.83.0 coding-agent port.
 *
 * Each test names the upstream commit it covers; see
 * `research/pi-0.83.0-port-matrix.md` for the full classification.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionContext, type ExtensionContextSource } from "../src/core/extensions/runner-context.ts";
import type { ExtensionScopedModels, ScopedModel as PublicScopedModel } from "../src/core/extensions/types.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader-context-files.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { LlamaModelInfo } from "../src/extensions/llama/client.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createHarness } from "./suite/harness.ts";
import "../src/modes/interactive/interactive-editor-actions.ts";
import "../src/modes/interactive/interactive-session-runtime.ts";

const tempDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("Pi 0.83.0 direct coding-agent parity", () => {
	it("0c32e83a: reports llama.cpp models as supporting usage in streaming", () => {
		const controller = createLlamaProvider();
		const model = {
			id: "qwen3",
			status: { value: "loaded" },
			meta: { n_ctx: 8192 },
		} as unknown as LlamaModelInfo;

		controller.setCatalog([model], "http://127.0.0.1:8080");

		const models = controller.provider.getModels?.() ?? [];
		expect(models).toHaveLength(1);
		expect(models[0].compat?.supportsUsageInStreaming).toBe(true);
	});

	it("f1ea6c0d: moves the model selector to the top row when a filter query is applied", () => {
		const filterModels = Reflect.get(ModelSelectorComponent.prototype, "filterModels") as (
			this: {
				activeModels: unknown[];
				filteredModels: unknown[];
				selectedIndex: number;
				updateList: () => void;
			},
			query: string,
		) => void;
		const activeModels = [
			{ id: "alpha", provider: "p", model: { name: "alpha" } },
			{ id: "beta", provider: "p", model: { name: "beta" } },
			{ id: "gamma", provider: "p", model: { name: "gamma" } },
		];
		const context = { activeModels, filteredModels: activeModels, selectedIndex: 2, updateList: () => {} };

		filterModels.call(context, "beta");
		expect(context.selectedIndex).toBe(0);

		// Clearing the query restores the full list and keeps the clamped position.
		context.selectedIndex = 2;
		filterModels.call(context, "");
		expect(context.filteredModels).toHaveLength(3);
		expect(context.selectedIndex).toBe(2);
	});

	it("0d008b74: applies tool-output expansion without emitting a status line", () => {
		const statuses: string[] = [];
		let renders = 0;
		const setToolsExpanded = Reflect.get(InteractiveModeBase.prototype, "setToolsExpanded") as (
			this: object,
			expanded: boolean,
		) => void;
		const context = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: undefined,
			chatContainer: { children: [] as unknown[] },
			ui: {
				requestRender: () => {
					renders += 1;
				},
			},
			showStatus: (message: string) => statuses.push(message),
		};

		setToolsExpanded.call(context, true);
		expect(context.toolOutputExpanded).toBe(true);
		setToolsExpanded.call(context, false);
		expect(context.toolOutputExpanded).toBe(false);

		// Atomic drops upstream's `Tool output: expanded/collapsed` status: the toggle is
		// already visible in the chat, so the line was pure noise. The re-render is not.
		expect(statuses).toEqual([]);
		expect(renders).toBe(2);
	});

	it("c2275d67: does not subscribe from a startup rebind the session switch superseded", async () => {
		const startupSession = {};
		const replacementSession = {};
		let resolveStartupBind!: () => void;
		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});

		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context = {
			session: startupSession as object,
			unsubscribe: undefined as (() => void) | undefined,
			applyRuntimeSettings: () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : Promise.resolve();
			},
			subscribeToAgent,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const rebind = Reflect.get(InteractiveModeBase.prototype, "rebindCurrentSession") as (
			this: typeof context,
		) => Promise<void>;

		const startupRebind = rebind.call(context);
		context.session = replacementSession;
		await rebind.call(context);

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		// The stale rebind returns without a second subscription: that duplicate is
		// what rendered every agent event twice on a startup session switch.
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});

	it("04b15259/b6fb91e5: exposes the session's scoped models to extensions", () => {
		const scopedModels: ScopedModel[] = [
			{ model: { id: "gpt-5.5", provider: "openai" } as never, thinkingLevel: "high" },
		];
		let active = true;
		const source = {
			assertActive: () => {
				if (!active) throw new Error("inactive");
			},
			getScopedModels: () => scopedModels,
		} as unknown as ExtensionContextSource;

		const ctx = createExtensionContext(source);
		expect(ctx.scopedModels).toEqual(scopedModels);

		// The public extension import path names both the accessor's type and its
		// element type, so an extension never reaches into an internal module to
		// describe what it just read.
		const publicScope: ExtensionScopedModels = scopedModels satisfies PublicScopedModel[];
		expect(ctx.scopedModels).toEqual(publicScope);

		active = false;
		expect(() => ctx.scopedModels).toThrow("inactive");
	});

	it("04b15259/b6fb91e5: hands extensions a copy, so the accessor cannot widen the scope", () => {
		const scopedModels: ScopedModel[] = [
			{ model: { id: "gpt-5.5", provider: "openai" } as never, thinkingLevel: "high" },
		];
		const source = {
			assertActive: () => {},
			getScopedModels: () => scopedModels,
		} as unknown as ExtensionContextSource;

		const ctx = createExtensionContext(source);

		// `readonly ScopedModel[]` is a compile-time claim only. A JavaScript
		// extension, or one asserting the readonly away as below, reaches the same
		// object; if that object were the session's backing array the pushed entry
		// would become an in-scope model that `cycleModel()` would switch to. The
		// returned array is a frozen copy, so the attempt throws instead.
		expect(() =>
			(ctx.scopedModels as ScopedModel[]).push({
				model: { id: "out-of-scope", provider: "openai" } as never,
			}),
		).toThrow();

		expect(scopedModels).toHaveLength(1);
		expect(ctx.scopedModels).toHaveLength(1);
		expect(ctx.scopedModels.map(({ model }) => model.id)).toEqual(["gpt-5.5"]);
		// Each read is its own copy, so one reader cannot poison the next.
		expect(ctx.scopedModels).not.toBe(ctx.scopedModels);
	});

	it("04b15259/b6fb91e5: mutating an entry in place cannot change the scope either", () => {
		// Copying only the array leaves the entries shared, and `cycleModel()` reads
		// those same objects — so swapping `entry.model` or `entry.thinkingLevel` in
		// place changes which model the session selects without ever touching the
		// array the copy protects.
		const scopedModels: ScopedModel[] = [
			{ model: { id: "gpt-5.5", provider: "openai" } as never, thinkingLevel: "high" },
		];
		const source = {
			assertActive: () => {},
			getScopedModels: () => scopedModels,
		} as unknown as ExtensionContextSource;

		const ctx = createExtensionContext(source);
		const [entry] = ctx.scopedModels as ScopedModel[];

		expect(entry).not.toBe(scopedModels[0]);
		expect(entry.model).not.toBe(scopedModels[0].model);

		// Frozen, so the attempt throws here rather than silently succeeding.
		expect(() => {
			(entry as { thinkingLevel?: string }).thinkingLevel = "low";
		}).toThrow();
		expect(() => {
			(entry.model as { id: string }).id = "out-of-scope";
		}).toThrow();

		expect(scopedModels[0].thinkingLevel).toBe("high");
		expect(scopedModels[0].model.id).toBe("gpt-5.5");
	});

	it("04b15259/b6fb91e5: a nested value inside the model cannot change the scope either", () => {
		// A spread and `Object.freeze` both stop at the first level, so copying the
		// entry and its model still handed out the session's own `headers`, `input`,
		// `cost.tiers`, `thinkingLevelMap` and `compat`. Writing through any of them
		// changed the model used for selection and request composition, and the
		// freeze reported nothing, because it never reached them.
		const sessionModel = {
			id: "gpt-5.5",
			provider: "openai",
			input: ["text"],
			headers: { "x-scope": "session" },
			cost: { input: 1, output: 2, tiers: [{ inputTokensAbove: 100, input: 3 }] },
			thinkingLevelMap: { high: "high" },
			compat: { toolCalls: true },
		};
		const scopedModels: ScopedModel[] = [{ model: sessionModel as never, thinkingLevel: "high" }];
		const source = {
			assertActive: () => {},
			getScopedModels: () => scopedModels,
		} as unknown as ExtensionContextSource;

		const ctx = createExtensionContext(source);
		const [entry] = ctx.scopedModels as ScopedModel[];
		const exposed = entry.model as unknown as typeof sessionModel;

		// Every nested container is the copy's own, not the session's.
		expect(exposed.headers).not.toBe(sessionModel.headers);
		expect(exposed.input).not.toBe(sessionModel.input);
		expect(exposed.cost).not.toBe(sessionModel.cost);
		expect(exposed.cost.tiers).not.toBe(sessionModel.cost.tiers);
		expect(exposed.cost.tiers[0]).not.toBe(sessionModel.cost.tiers[0]);
		expect(exposed.thinkingLevelMap).not.toBe(sessionModel.thinkingLevelMap);
		expect(exposed.compat).not.toBe(sessionModel.compat);

		// And frozen all the way down, so each attempt throws rather than landing.
		expect(() => {
			exposed.headers["x-scope"] = "extension";
		}).toThrow();
		expect(() => {
			exposed.input.push("image");
		}).toThrow();
		expect(() => {
			exposed.cost.tiers[0].input = 999;
		}).toThrow();
		expect(() => {
			exposed.thinkingLevelMap.high = "low";
		}).toThrow();
		expect(() => {
			exposed.compat.toolCalls = false;
		}).toThrow();

		expect(sessionModel.headers).toEqual({ "x-scope": "session" });
		expect(sessionModel.input).toEqual(["text"]);
		expect(sessionModel.cost.tiers).toEqual([{ inputTokensAbove: 100, input: 3 }]);
		expect(sessionModel.thinkingLevelMap).toEqual({ high: "high" });
		expect(sessionModel.compat).toEqual({ toolCalls: true });
	});

	it("04b15259/b6fb91e5: the shortcut context copies the scope too, not just the runner's", () => {
		// Shortcut handlers get a context built by hand in
		// interactive-extension-runtime.ts rather than by createExtensionContext, so
		// the copy has to exist on both paths or the guarantee has a second door.
		const scopedModels: ScopedModel[] = [
			{ model: { id: "gpt-5.5", provider: "openai" } as never, thinkingLevel: "high" },
		];
		let handlerContext: { scopedModels: readonly ScopedModel[] } | undefined;
		let onExtensionShortcut: ((data: string) => boolean) | undefined;

		const context = {
			keybindings: { getEffectiveConfig: () => ({}) },
			sessionManager: { getCwd: () => "/tmp/shortcut-scope" },
			session: {
				scopedModels,
				model: undefined,
				modelRuntime: {},
				isStreaming: false,
				settingsManager: { isProjectTrusted: () => true },
				agent: { signal: new AbortController().signal },
				pendingMessageCount: 0,
				systemPrompt: "",
				abort: () => {},
				getContextUsage: () => undefined,
				compact: async () => undefined,
			},
			createExtensionExtensionUIContext: () => ({}),
			createExtensionUIContext: () => ({}),
			get defaultEditor() {
				return {
					set onExtensionShortcut(handler: (data: string) => boolean) {
						onExtensionShortcut = handler;
					},
				};
			},
			showError: () => {},
		};

		const setup = Reflect.get(InteractiveModeBase.prototype, "setupExtensionShortcuts") as (
			this: typeof context,
			runner: { getShortcuts: () => Map<string, { handler: (ctx: unknown) => void }> },
		) => void;

		setup.call(context, {
			getShortcuts: () =>
				new Map([
					[
						"ctrl+g",
						{
							handler: (ctx: unknown) => {
								handlerContext = ctx as { scopedModels: readonly ScopedModel[] };
							},
						},
					],
				]),
		});

		expect(onExtensionShortcut).toBeTypeOf("function");
		// The control byte the terminal sends for ctrl+g, which is what the editor
		// hands the shortcut dispatcher.
		onExtensionShortcut?.("\x07");

		expect(handlerContext).toBeDefined();
		const received = handlerContext as { scopedModels: readonly ScopedModel[] };
		expect(received.scopedModels).toEqual(scopedModels);
		expect(received.scopedModels).not.toBe(scopedModels);
		expect(() =>
			(received.scopedModels as ScopedModel[]).push({
				model: { id: "out-of-scope", provider: "openai" } as never,
			}),
		).toThrow();
		// The entries are copies too, so an in-place swap cannot reach the session.
		expect(() => {
			(received.scopedModels[0] as { thinkingLevel?: string }).thinkingLevel = "low";
		}).toThrow();
		expect(scopedModels).toHaveLength(1);
		expect(scopedModels[0].thinkingLevel).toBe("high");
	});

	it("cced6a21: loads a nested linked worktree's context file once, not twice", () => {
		const root = tempDir("atomic-nested-worktree-");
		const mainRepo = join(root, "repo");
		const gitDir = join(mainRepo, ".git");
		const worktree = join(mainRepo, "feature-checkout");
		const worktreeGitDir = join(gitDir, "worktrees", "feature");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
		writeFileSync(join(mainRepo, "AGENTS.md"), "main copy");
		writeFileSync(join(worktree, "AGENTS.md"), "worktree copy");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });

		const files = loadProjectContextFiles({ cwd: worktree, agentDir });

		expect(files.map((file) => file.content)).toEqual(["worktree copy"]);
	});

	it("cced6a21: still inherits an ancestor context file outside a linked worktree", () => {
		const root = tempDir("atomic-plain-repo-");
		const repo = join(root, "repo");
		const nested = join(repo, "nested");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });

		const files = loadProjectContextFiles({ cwd: nested, agentDir });

		expect(files.map((file) => file.content)).toEqual(["repo instructions"]);
	});

	it("0563a7c0: removes a half-written clone and its empty parents when a git install fails", async () => {
		const root = tempDir("atomic-git-install-fail-");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const packageManager = new DefaultPackageManager({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		const targetDir = join(agentDir, "git", "github.com", "user", "repo");

		vi.spyOn(packageManager as unknown as PackageManagerCommandInternals, "runCommand").mockImplementation(
			async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					throw new Error("simulated git clone failure");
				}
			},
		);

		await expect(packageManager.install("git:github.com/user/repo")).rejects.toThrow("simulated git clone failure");

		expect(existsSync(targetDir)).toBe(false);
		expect(existsSync(join(agentDir, "git", "github.com"))).toBe(false);
	});

	it("0563a7c0: removes a cloned checkout when its dependency install fails", async () => {
		const root = tempDir("atomic-git-deps-fail-");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const packageManager = new DefaultPackageManager({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		const targetDir = join(agentDir, "git", "github.com", "user", "repo");

		vi.spyOn(packageManager as unknown as PackageManagerCommandInternals, "runCommand").mockImplementation(
			async (command, args) => {
				if (command === "git" && args[0] === "clone") {
					mkdirSync(targetDir, { recursive: true });
					writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					return;
				}
				if (command === "npm") throw new Error("simulated dependency install failure");
			},
		);

		await expect(packageManager.install("git:github.com/user/repo")).rejects.toThrow(
			"simulated dependency install failure",
		);

		expect(existsSync(targetDir)).toBe(false);
	});

	it("cefa40ed: refuses tree navigation while a response is still streaming", async () => {
		const harness = await createHarness();
		try {
			const targetId = harness.sessionManager.appendMessage({ role: "user", content: "first" } as never);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const activeLeafId = harness.sessionManager.getLeafId();

			await expect(harness.session.navigateTree(targetId, { summarize: false })).rejects.toThrow(
				"Wait for the current response to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(activeLeafId);
		} finally {
			harness.cleanup();
		}
	});

	it("5d548ae9: routes the plain RPC bash command through user_bash handlers", async () => {
		const commands: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async (event) => {
						commands.push(event.command);
						return { result: { output: "intercepted", exitCode: 0, cancelled: false, truncated: false } };
					});
				},
			],
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		try {
			const handle = createRpcCommandHandler({
				runtimeHost: { session: harness.session, services: { agentDir: "/tmp/unused" } } as never,
				getSession: () => harness.session,
				rebindSession: async () => {},
				output: () => {},
			});

			const response = await handle({ id: "rpc-bash", type: "bash", command: "echo hi" });

			expect(commands).toEqual(["echo hi"]);
			expect(response).toMatchObject({ success: true, data: { output: "intercepted", exitCode: 0 } });
		} finally {
			harness.cleanup();
		}
	});
});

interface PackageManagerCommandInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}
