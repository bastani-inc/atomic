import { APP_NAME } from "../../config.js";
import { getExtensionContextOwner, publishExtensionContextEffect } from "../../core/extensions/runner-context.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { sqliteSessionResumeArgs } from "../../core/session-resume-args.js";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
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
	enabled?: (ctx: ExtensionContext) => boolean | Promise<boolean>;
}

function resumeArgv(sessionManager: ExtensionContext["sessionManager"]): string[] | undefined {
	if (sessionManager.getSessionStore().descriptor.adapter === "memory") return undefined;
	const sessionId = sessionManager.getSessionId();
	const sessionDir =
		sessionManager.getSessionStore().descriptor.adapter === "jsonl"
			? ["--session-dir", sessionManager.getSessionDir()]
			: sqliteSessionResumeArgs(sessionManager.getSessionStore());
	return [APP_NAME, ...sessionDir, "--session", sessionId];
}

async function enabled(ctx: ExtensionContext): Promise<boolean> {
	const settings = await SettingsManager.createAsync(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	return (
		(settings.getProjectSettings().herdr?.enabled ??
			settings.getGlobalSettings().herdr?.enabled ??
			SETTINGS_DEFAULTS.herdr.enabled) !== false
	);
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
		let taskStore: OwnerTaskStore | undefined;
		let unsubscribeTasks: (() => void) | undefined;
		let agentRunning = false;
		let openPromptCount = 0;
		const seenDiagnostics = new Set<string>();
		let generation = 0;
		const stops = new WeakMap<object, number>();
		const diagnostic = (value: HerdrDiagnostic) => {
			const key = `${value.kind}:${value.owner ?? ""}`;
			if (seenDiagnostics.has(key)) return;
			seenDiagnostics.add(key);
			if (options.diagnostic) options.diagnostic(value);
			else console.error(`[Herdr] ${value.kind}${value.owner ? `: deferring to ${value.owner}` : ""}`);
		};
		const tasksRunning = () => taskStore?.ownerTasks.some((task) => task.execution.kind !== "settled") ?? false;
		const report = (skipUnchanged = false) => {
			if (!owner) return;
			const activity = deriveSessionActivity({
				agentRunning,
				tasksRunning: tasksRunning(),
				openPromptCount,
			});
			reportPaneActivity(owner, activity, skipUnchanged);
		};
		const start = async (ctx: ExtensionContext) => {
			const runner = getExtensionContextOwner(ctx);
			if (retiredRunners.has(runner)) return;
			if (boundSessionManager && ctx.sessionManager !== boundSessionManager) return;
			const environment = captureHerdrEnvironment(options.env ?? process.env);
			if (!environment || ctx.mode !== "tui" || !ctx.hasUI || ctx.subagentPolicy) return;
			const isEnabled = (options.enabled ?? enabled)(ctx);
			if (typeof isEnabled !== "boolean") {
				const stopped = stops.get(runner);
				if (!(await isEnabled) || stops.get(runner) !== stopped || retiredRunners.has(runner)) return;
				if (boundSessionManager && ctx.sessionManager !== boundSessionManager) return;
			} else if (!isEnabled) return;
			if (boundRunner && boundRunner !== runner) retiredRunners.add(boundRunner);
			boundRunner = runner;
			boundSessionManager = ctx.sessionManager;
			const current = ++generation;
			unsubscribeTasks?.();
			taskStore?.dispose();
			unsubscribeTasks = undefined;
			taskStore = undefined;
			openPromptCount = 0;
			const claimed = await claimPaneReporting(
				environment,
				{
					id: ctx.sessionManager.getSessionId(),
					path: ctx.sessionManager.getSessionFile(),
					resume: resumeArgv(ctx.sessionManager),
				},
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
			report(true);
		};
		pi.on("session_start", (_event, ctx) => publishExtensionContextEffect(ctx, () => start(ctx)));
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
			const stopping = getExtensionContextOwner(ctx);
			stops.set(stopping, (stops.get(stopping) ?? 0) + 1);
			if (!ownsBinding(ctx)) return;
			// A non-quit stop may restart this runner, unless a successor supersedes it first.
			if (event.reason === "quit") retiredRunners.add(boundRunner!);
			generation++;
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
				// A host signal ends the process, not the conversation: keep the registration Herdr restores from.
				if (event.reason === "quit" && !event.fromSignal) await releasePaneReporting(previous);
				else await retirePaneReporting(previous);
			}
		});
	};
}

export default function herdrExtension(pi: ExtensionAPI): void {
	createHerdrExtension()(pi);
}
