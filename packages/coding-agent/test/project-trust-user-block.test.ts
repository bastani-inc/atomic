import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { emitProjectTrustEvent } from "../src/core/extensions/runner-project-trust.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type {
	LoadExtensionsResult,
	ProjectTrustContext,
	ProjectTrustHandler,
	UserBlockChange,
} from "../src/core/extensions/types.ts";
import { getOpenUserBlocks, subscribeUserBlocks } from "../src/core/extensions/user-blocks.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { captureRejection } from "./error-capture.ts";

const tempDirs: string[] = [];

function createUntrustedProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-trust-block-test-"));
	tempDirs.push(dir);
	// A context file is enough to make the trust prompt required.
	writeFileSync(join(dir, "AGENTS.md"), "# project\n");
	mkdirSync(join(dir, "agent"), { recursive: true });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	assert.deepEqual(getOpenUserBlocks(), []);
});

describe("project trust prompt block", () => {
	it("mints a project_trust block for the duration of the prompt", async () => {
		const cwd = createUntrustedProject();
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		let openDuringPrompt = -1;
		let reasonDuringPrompt: string | undefined;

		const projectTrustContext: ProjectTrustContext = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: async (_title, options) => {
					openDuringPrompt = getOpenUserBlocks().length;
					reasonDuringPrompt = getOpenUserBlocks()[0]?.reason;
					return options[0];
				},
				confirm: noOpUIContext.confirm,
				input: noOpUIContext.input,
				notify: noOpUIContext.notify,
			},
		};

		try {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext,
			});
		} finally {
			unsubscribe();
		}

		assert.equal(openDuringPrompt, 1, "the prompt runs with exactly one open block");
		assert.equal(reasonDuringPrompt, "project_trust");
		assert.deepEqual(
			changes.map((change) => [change.type, change.label, change.reason]),
			[
				["agent_blocked", "Trust project folder?", "project_trust"],
				["agent_unblocked", "Trust project folder?", "project_trust"],
			],
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("releases the block when the prompt throws", async () => {
		const cwd = createUntrustedProject();
		const failure = new Error("host closed the prompt");
		const projectTrustContext: ProjectTrustContext = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: () => Promise.reject(failure),
				confirm: noOpUIContext.confirm,
				input: noOpUIContext.input,
				notify: noOpUIContext.notify,
			},
		};

		const thrown = await captureRejection(async () => {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext,
			});
		});
		assert.equal(thrown, failure);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("opens no block when trust is already decided and no prompt is shown", async () => {
		const cwd = createUntrustedProject();
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		const trustStore = new ProjectTrustStore(join(cwd, "agent"));
		trustStore.set(cwd, true);

		try {
			const trusted = await resolveProjectTrusted({
				cwd,
				trustStore,
				projectTrustContext: {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						select: async () => {
							throw new Error("the prompt must not be shown");
						},
						confirm: noOpUIContext.confirm,
						input: noOpUIContext.input,
						notify: noOpUIContext.notify,
					},
				},
			});
			assert.equal(trusted, true);
		} finally {
			unsubscribe();
		}
		assert.deepEqual(changes, []);
	});
});

/**
 * The startup trust prompt mints a block, and no subscriber exists to hear it.
 *
 * This pins the boundary the Herdr docs describe rather than leaving it as
 * prose. `resolveProjectTrusted()` runs during resource loading, before any
 * `ExtensionRunner` is built — and under isolated interactive mode, in a
 * different process from the reporter entirely. Closing it needs pre-session
 * reporting or a host-to-child ownership handoff, neither of which Phase 1
 * defines. If a later phase adds one, this test is the one that should fail.
 */
describe("startup project trust reaches no extension subscriber", () => {
	it("mints the block but delivers no lifecycle event, because no runner exists yet", async () => {
		const cwd = createUntrustedProject();
		const registryChanges: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => registryChanges.push(change));
		let openDuringPrompt = 0;

		try {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext: {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						select: async (_title, options) => {
							openDuringPrompt = getOpenUserBlocks().length;
							return options[0];
						},
						confirm: noOpUIContext.confirm,
						input: noOpUIContext.input,
						notify: noOpUIContext.notify,
					},
				},
			});
		} finally {
			unsubscribe();
		}

		// B4 holds: the prompt really does open a project_trust block.
		assert.equal(openDuringPrompt, 1);
		assert.deepEqual(
			registryChanges.map((change) => [change.type, change.reason]),
			[
				["agent_blocked", "project_trust"],
				["agent_unblocked", "project_trust"],
			],
		);

		// And the boundary: the registry is the only observer. Nothing routed the
		// change to a `pi.on("agent_blocked")` handler, because extensions are not
		// bound until a session exists.
		assert.deepEqual(getOpenUserBlocks(), []);
	});
});

/**
 * An extension's own `project_trust` prompt is a wait too.
 *
 * Handlers run before the built-in fallback and receive the same restricted UI,
 * so a prompt one of them opens stops the agent exactly like Atomic's does.
 * Only the handler path is wrapped — the fallback opens its own block, and
 * wrapping both would count one wait twice.
 */
describe("extension project_trust prompts mint a block", () => {
	async function extensionWith(handler: ProjectTrustHandler): Promise<LoadExtensionsResult> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("project_trust", handler);
			},
			tmpdir(),
			createEventBus(),
			runtime,
			"<inline:trust>",
		);
		return { extensions: [extension], errors: [], runtime };
	}

	function trustContext(ui: Partial<ProjectTrustContext["ui"]>): ProjectTrustContext {
		return {
			cwd: "/tmp/does-not-matter",
			mode: "tui",
			hasUI: true,
			ui: {
				select: noOpUIContext.select,
				confirm: noOpUIContext.confirm,
				input: noOpUIContext.input,
				notify: noOpUIContext.notify,
				...ui,
			},
		};
	}

	it("holds a project_trust block while a handler's confirm is open", async () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		let openDuringPrompt = 0;
		let reasonDuringPrompt: string | undefined;

		try {
			const result = await emitProjectTrustEvent(
				await extensionWith(async (_event, ctx) => {
					const trusted = await ctx.ui.confirm("Trust this workspace?", "from an extension");
					return { trusted: trusted ? "yes" : "no" };
				}),
				{ type: "project_trust", cwd: "/tmp/does-not-matter" },
				trustContext({
					confirm: async () => {
						openDuringPrompt = getOpenUserBlocks().length;
						reasonDuringPrompt = getOpenUserBlocks()[0]?.reason;
						return true;
					},
				}),
			);
			assert.deepEqual(result.errors, []);
			assert.equal(result.result?.trusted, "yes", "the handler's decision is preserved");
		} finally {
			unsubscribe();
		}

		assert.equal(openDuringPrompt, 1);
		assert.equal(reasonDuringPrompt, "project_trust");
		assert.deepEqual(
			changes.map((change) => [change.type, change.label, change.reason]),
			[
				["agent_blocked", "Trust this workspace?", "project_trust"],
				["agent_unblocked", "Trust this workspace?", "project_trust"],
			],
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("releases the block when a handler's prompt rejects", async () => {
		const failure = new Error("host closed the prompt");
		const result = await emitProjectTrustEvent(
			await extensionWith(async (_event, ctx) => {
				await ctx.ui.select("Pick one", ["a"]);
				return { trusted: "yes" };
			}),
			{ type: "project_trust", cwd: "/tmp/does-not-matter" },
			trustContext({ select: () => Promise.reject(failure) }),
		);

		// The runner reports a handler error rather than propagating it.
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0]?.error, failure.message);
		assert.deepEqual(getOpenUserBlocks(), [], "the block did not outlive the rejected prompt");
	});

	it("leaves notify unwrapped", async () => {
		const notified: string[] = [];
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			await emitProjectTrustEvent(
				await extensionWith((_event, ctx) => {
					ctx.ui.notify("just telling you");
					return { trusted: "undecided" };
				}),
				{ type: "project_trust", cwd: "/tmp/does-not-matter" },
				trustContext({ notify: (message) => notified.push(message) }),
			);
		} finally {
			unsubscribe();
		}
		assert.deepEqual(notified, ["just telling you"]);
		assert.deepEqual(changes, [], "a notification is not a wait");
	});
});

/**
 * A `ProjectTrustContext` may be a class instance, not a plain object.
 *
 * The type is structural and publicly exported, so nothing stops a host from
 * putting `notify`, `cwd`, `mode`, or `hasUI` on a prototype or behind a getter.
 * Building the handler context with a spread copied only enumerable own
 * properties and silently dropped every one of those — `ctx.ui.notify` came back
 * `undefined` inside a handler that had worked before.
 */
describe("prototype-backed project trust contexts survive wrapping", () => {
	class PrototypeUi {
		readonly notified: string[] = [];
		select(_title: string, options: string[]): Promise<string | undefined> {
			return Promise.resolve(options[0]);
		}
		confirm(): Promise<boolean> {
			return Promise.resolve(true);
		}
		input(): Promise<string | undefined> {
			return Promise.resolve("typed");
		}
		notify(message: string): void {
			this.notified.push(message);
		}
	}

	class PrototypeTrustContext {
		readonly ui = new PrototypeUi();
		get cwd(): string {
			return "/tmp/prototype-project";
		}
		get mode(): ProjectTrustContext["mode"] {
			return "tui";
		}
		get hasUI(): boolean {
			return true;
		}
	}

	async function extensionWith(handler: ProjectTrustHandler): Promise<LoadExtensionsResult> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("project_trust", handler);
			},
			tmpdir(),
			createEventBus(),
			runtime,
			"<inline:trust-prototype>",
		);
		return { extensions: [extension], errors: [], runtime };
	}

	it("keeps prototype methods and getter-backed context members visible", async () => {
		const host = new PrototypeTrustContext();
		const seen: Record<string, string | boolean | undefined> = {};

		const result = await emitProjectTrustEvent(
			await extensionWith(async (_event, ctx) => {
				seen.notifyKind = typeof ctx.ui.notify;
				seen.cwd = ctx.cwd;
				seen.mode = ctx.mode;
				seen.hasUI = ctx.hasUI;
				ctx.ui.notify("from the handler");
				const trusted = await ctx.ui.confirm("Trust it?", "prototype host");
				return { trusted: trusted ? "yes" : "no" };
			}),
			{ type: "project_trust", cwd: host.cwd },
			host,
		);

		assert.deepEqual(result.errors, [], "no handler error");
		assert.equal(result.result?.trusted, "yes");
		assert.equal(seen.notifyKind, "function", "a prototype notify must survive wrapping");
		assert.equal(seen.cwd, "/tmp/prototype-project");
		assert.equal(seen.mode, "tui");
		assert.equal(seen.hasUI, true);
		assert.deepEqual(host.ui.notified, ["from the handler"], "notify ran on the host object");
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("still blocks around a prototype-backed prompt", async () => {
		const host = new PrototypeTrustContext();
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			await emitProjectTrustEvent(
				await extensionWith(async (_event, ctx) => {
					await ctx.ui.select("Pick a trust option", ["always", "never"]);
					return { trusted: "yes" };
				}),
				{ type: "project_trust", cwd: host.cwd },
				host,
			);
		} finally {
			unsubscribe();
		}
		assert.deepEqual(
			changes.map((change) => [change.type, change.label, change.reason]),
			[
				["agent_blocked", "Pick a trust option", "project_trust"],
				["agent_unblocked", "Pick a trust option", "project_trust"],
			],
		);
	});
});
