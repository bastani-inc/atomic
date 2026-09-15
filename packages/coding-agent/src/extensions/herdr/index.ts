import { getExtensionContextOwner, publishExtensionContextEffect } from "../../core/extensions/runner-context.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { WorkflowRootActivity } from "../../core/extensions/workflow-events.js";
import { SettingsManager } from "../../core/settings-manager.ts";
import { OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { deriveSessionActivity } from "./activity.js";
import { captureHerdrEnvironment } from "./environment.js";
import {
	claimPaneReporting,
	type PaneOwner,
	type PaneReportingOptions,
	releasePaneReporting,
	reportPaneActivity,
	retirePaneReporting,
} from "./pane-owner.js";
import type { HerdrDiagnostic } from "./transport.js";

export interface HerdrExtensionOptions extends PaneReportingOptions {
	env?: NodeJS.ProcessEnv;
	enabled?: (ctx: ExtensionContext) => boolean;
}

function enabled(ctx: ExtensionContext): boolean {
	const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	return (settings.getProjectSettings().herdr?.enabled ?? settings.getGlobalSettings().herdr?.enabled) !== false;
}

export function createHerdrExtension(options: HerdrExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		if (!captureHerdrEnvironment(options.env ?? process.env)) return;
		let owner: PaneOwner | undefined;
		// Supplied loaders can share closures across sessions and overlapping reload runners.
		let boundSessionManager: ExtensionContext["sessionManager"] | undefined;
		let boundRunner: object | undefined;
		const retiredRunners = new WeakSet<object>();
		const ownsBinding = (ctx: ExtensionContext) =>
			boundSessionManager !== undefined && getExtensionContextOwner(ctx) === boundRunner;
		let lease: { dispose(): void } | undefined;
		let taskStore: OwnerTaskStore | undefined;
		let unsubscribeTasks: (() => void) | undefined;
		let agentRunning = false;
		let openPromptCount = 0;
		let availability: "ready" | "unavailable" | "recovering" = "unavailable";
		const roots = new Map<string, WorkflowRootActivity>();
		const acknowledgedBlocks = new Map<string, WorkflowRootActivity>();
		const updateRoot = (root: WorkflowRootActivity) => {
			const acknowledged = acknowledgedBlocks.get(root.rootRunId);
			if (
				acknowledged &&
				(root.state !== acknowledged.state ||
					root.reason !== acknowledged.reason ||
					root.actionableBlockCount !== acknowledged.actionableBlockCount ||
					root.activeExecutionCount !== acknowledged.activeExecutionCount ||
					root.needsAttention !== acknowledged.needsAttention)
			)
				acknowledgedBlocks.delete(root.rootRunId);
			roots.set(root.rootRunId, root);
		};
		const seenDiagnostics = new Set<string>();
		let generation = 0;
		const diagnostic = (value: HerdrDiagnostic) => {
			const key = `${value.kind}:${value.owner ?? ""}`;
			if (seenDiagnostics.has(key)) return;
			seenDiagnostics.add(key);
			if (options.diagnostic) options.diagnostic(value);
			else console.error(`[Herdr] ${value.kind}${value.owner ? `: deferring to ${value.owner}` : ""}`);
		};
		const tasksRunning = () => taskStore?.tasks.some((task) => task.execution.kind !== "settled") ?? false;
		const report = () => {
			if (!owner) return;
			const activity = deriveSessionActivity({
				agentRunning,
				tasksRunning: tasksRunning(),
				openPromptCount,
				roots: [...roots.values()].filter((root) => !acknowledgedBlocks.has(root.rootRunId)),
				availability,
			});
			if (activity) reportPaneActivity(owner, activity);
		};
		const start = async (ctx: ExtensionContext) => {
			const runner = getExtensionContextOwner(ctx);
			if (retiredRunners.has(runner)) return;
			if (boundSessionManager && ctx.sessionManager !== boundSessionManager) return;
			const environment = captureHerdrEnvironment(options.env ?? process.env);
			if (!environment || ctx.mode !== "tui" || !ctx.hasUI || ctx.subagentPolicy || ctx.orchestrationContext) return;
			if (!(options.enabled ?? enabled)(ctx)) return;
			if (boundRunner && boundRunner !== runner) retiredRunners.add(boundRunner);
			boundRunner = runner;
			boundSessionManager = ctx.sessionManager;
			const current = ++generation;
			lease?.dispose();
			lease = undefined;
			unsubscribeTasks?.();
			taskStore?.dispose();
			unsubscribeTasks = undefined;
			taskStore = undefined;
			openPromptCount = 0;
			roots.clear();
			acknowledgedBlocks.clear();
			availability = "unavailable";
			const claimed = await claimPaneReporting(
				environment,
				{ id: ctx.sessionManager.getSessionId(), path: ctx.sessionManager.getSessionFile() },
				{ ...options, diagnostic },
			);
			if (current !== generation) {
				await releasePaneReporting(claimed);
				return;
			}
			owner = claimed;
			agentRunning = !ctx.isIdle();
			const taskHost = ctx.getAgentTaskHost?.();
			if (taskHost) {
				const { supervisor, owner: taskOwner } = taskHost.ownerBinding;
				taskStore = new OwnerTaskStore(supervisor, taskOwner);
				taskStore.connect();
				let running = tasksRunning();
				unsubscribeTasks = taskStore.subscribe(() => {
					if (current !== generation) return;
					const next = tasksRunning();
					if (next === running) return;
					running = next;
					report();
				});
			}
			lease = ctx.observeWorkflowActivity((frame) => {
				if (current !== generation) return;
				if (frame.kind === "snapshot") {
					availability = frame.availability;
					roots.clear();
					if (frame.availability === "ready") {
						for (const root of frame.roots) updateRoot(root);
						for (const id of acknowledgedBlocks.keys()) if (!roots.has(id)) acknowledgedBlocks.delete(id);
					}
				} else if (frame.kind === "changed") updateRoot(frame.root);
				else {
					roots.delete(frame.rootRunId);
					acknowledgedBlocks.delete(frame.rootRunId);
				}
				report();
			});
		};
		pi.on("session_start", (_event, ctx) => publishExtensionContextEffect(ctx, () => start(ctx)));
		pi.on("input", (event, ctx) => {
			if (!ownsBinding(ctx) || event.source !== "interactive") return;
			let changed = false;
			for (const root of roots.values()) {
				if (root.state === "blocked" && !acknowledgedBlocks.has(root.rootRunId)) {
					acknowledgedBlocks.set(root.rootRunId, { ...root });
					changed = true;
				}
			}
			if (changed) report();
		});
		pi.on("workflow_lifecycle", (event, ctx) => {
			if (!ownsBinding(ctx) || event.delivery !== "live") return;
			const target = event.target;
			const newBlock =
				target.kind === "prompt"
					? target.status === "opened"
					: (target.kind === "run" || target.kind === "stage") &&
						(target.status === "blocked" || target.status === "awaiting_input") &&
						target.previousStatus !== target.status;
			if (newBlock && acknowledgedBlocks.delete(event.rootRunId)) report();
		});
		pi.on("agent_start", (_event, ctx) => {
			if (!ownsBinding(ctx)) return;
			agentRunning = true;
			report();
		});
		pi.on("agent_settled", (_event, ctx) => {
			if (!ownsBinding(ctx)) return;
			agentRunning = false;
			report();
		});
		pi.on("ui_prompt_start", (_event, ctx) => {
			if (!ownsBinding(ctx)) return;
			openPromptCount++;
			report();
		});
		pi.on("ui_prompt_end", (_event, ctx) => {
			if (!ownsBinding(ctx)) return;
			openPromptCount = Math.max(0, openPromptCount - 1);
			report();
		});
		pi.on("session_shutdown", async (event, ctx) => {
			if (!ownsBinding(ctx)) return;
			// A non-quit stop may restart this runner, unless a successor supersedes it first.
			if (event.reason === "quit") retiredRunners.add(boundRunner!);
			generation++;
			lease?.dispose();
			lease = undefined;
			unsubscribeTasks?.();
			taskStore?.dispose();
			unsubscribeTasks = undefined;
			taskStore = undefined;
			const previous = owner;
			owner = undefined;
			// Clear before awaiting transport: a successor can bind while retirement drains,
			// and this shutdown's completion must never clear that newer binding.
			boundSessionManager = undefined;
			if (previous) {
				if (event.reason === "quit") await releasePaneReporting(previous);
				else await retirePaneReporting(previous);
			}
		});
	};
}

export default function herdrExtension(pi: ExtensionAPI): void {
	createHerdrExtension()(pi);
}
