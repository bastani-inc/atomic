import { sessionScopedExtensionState } from "@bastani/atomic";
import { getDurableBackendProcessOwner } from "../durable/backend-process-owner.js";
import { acquireDbosLease, flushDbos } from "../durable/dbos-lifecycle.js";
import { getDurableBackend } from "../durable/factory.js";
import { isLiveRunningWorkflow } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { settleAdmissionControls } from "../engine/run-durable-admission.js";
import { quitAllRuns } from "../runs/background/quit.js";
import { killAllRuns } from "../runs/background/status.js";
import { installCompactionHook } from "../shared/persistence-compaction-policy.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { clearForms } from "../tui/inline-form-store.js";
import { installStoreWidget } from "../tui/store-widget-installer.js";
import { currentWorkflowSessionRunState, type WorkflowSessionRunState } from "./adopt-session-run-state.js";
import type { WorkflowExtensionRuntimeState } from "./extension-runtime-state.js";
import { resetWorkflowHilAnswerNotificationState } from "./hil-answer-notifications.js";
import { resetWorkflowLifecycleNotificationState } from "./lifecycle-notifications.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import { formatStartupDiagnostics } from "./workflow-command-surfaces.js";
import { prepareWorkflowResumeCatalog } from "./workflow-durable-resume-command.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";

interface WorkflowLifetime {
	readonly generations: Set<(boundary?: "quit" | "switch") => Promise<void>>;
	release?: () => Promise<void>;
	closing?: Promise<void>;
	startupStarted?: boolean;
}

async function attemptAll(actions: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
	const errors: unknown[] = [];
	for (const action of actions) {
		try {
			await action();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, errors.map(String).join("; "));
}

/**
 * `/reload`, `/fork`, `/new`, and `/resume` replace the host session inside
 * one process that keeps its workflow state and durable backend. Those reasons
 * must not tear down the workflow lifetime. `startup` and any reason this code
 * does not recognise still clear: neither names a predecessor that handed
 * anything over. `/reload` reuses the host bus; the others do not.
 */
function replacementStopsWorkflows(reason: string | undefined): boolean {
	return reason !== "reload" && reason !== "fork" && reason !== "new" && reason !== "resume";
}

type SessionSwitchReason = "new" | "resume" | "fork";

/**
 * Switching to another session quits in-flight runs at a resumable checkpoint
 * (#3203). Only `/reload` keeps them executing, because it stays on the same
 * session.
 */
function isSessionSwitch(reason: string | undefined): reason is SessionSwitchReason {
	return reason === "new" || reason === "resume" || reason === "fork";
}

const SESSION_SWITCH_COPY: Record<SessionSwitchReason, { action: string; cancelled: string }> = {
	new: { action: "start a new session", cancelled: "New session" },
	resume: { action: "resume another session", cancelled: "Resume" },
	fork: { action: "fork this session", cancelled: "Fork" },
};

export function sessionSwitchQuitConfirmation(
	reason: SessionSwitchReason,
	inFlightWorkflowCount: number,
): { title: string; message: string } {
	const runs = inFlightWorkflowCount === 1 ? "1 running workflow" : `${inFlightWorkflowCount} running workflows`;
	const pronoun = inFlightWorkflowCount === 1 ? "It" : "Each";
	return {
		title: `Quit ${runs} and ${SESSION_SWITCH_COPY[reason].action}?`,
		message: `Continuing quits ${runs} now. ${pronoun} stops at its last checkpoint and can be resumed later with /workflow resume.`,
	};
}

function eventReason(event: unknown): string | undefined {
	return typeof event === "object" && event !== null && "reason" in event
		? (event as { readonly reason?: string }).reason
		: undefined;
}

export interface WorkflowLifecycleRegistrationDeps {
	runtimeState: WorkflowExtensionRuntimeState;
	storeWidgetRef: { current: (() => void) | null };
	intercomControlRef: { current: (() => void) | null };
	disposeObservation?: () => void;
	/** The owning session's run-scoped instances; defaults to the current ones. */
	runState?: WorkflowSessionRunState;
}

export function registerWorkflowLifecycleHandlers(pi: ExtensionAPI, deps: WorkflowLifecycleRegistrationDeps): void {
	if (typeof pi.on !== "function") return;
	const { store, cancellationRegistry, stageControlRegistry, toolControlRegistry, jobs } =
		deps.runState ?? currentWorkflowSessionRunState();
	const lifetime = sessionScopedExtensionState<WorkflowLifetime>(
		pi.lifecycleScope ?? pi.events ?? pi,
		"workflows:lifecycle:v1",
		() => ({
			generations: new Set(),
			// Discovery is borrowed. Acquire durability only when a session starts.
		}),
	);
	const quitAndCheckpointRuns = (boundary: "quit" | "switch" = "quit") =>
		attemptAll([
			async () => {
				const results = await quitAllRuns({
					store,
					stageControlRegistry,
					toolControlRegistry,
					jobs,
					awaitSettlement: true,
				});
				const abandoned = results.flatMap((result) => (result.ok ? result.abandonedTools : []));
				if (abandoned.length > 0)
					throw new Error(
						`Workflow cleanup left uncooperative tools: ${abandoned.map((tool) => `${tool.runId}/${tool.nodeId}`).join(", ")}`,
					);
				const failures = results
					.flatMap((result) => (result.ok ? [] : [result]))
					.filter((result) => !(boundary === "switch" && result.reason === "no_active_stages"));
				if (failures.length > 0)
					throw new Error(
						failures
							.map(
								(result) =>
									`${result.runId}: ${result.reason}${"message" in result ? ` (${result.message})` : ""}`,
							)
							.join("; "),
					);
			},
			async () => {
				if (store.runs().length === 0) return;
				const backend = getDurableBackend();
				const runIds = store.runs().map((run) => run.id);
				await attemptAll([
					() => settleAdmissionControls(backend, runIds),
					...runIds.map((runId) => () => backend.flush(runId)),
				]);
			},
			() => stageControlRegistry.clear(),
		]);
	lifetime.generations.add(quitAndCheckpointRuns);
	const { runtimeState } = deps;
	const confirmSessionSwitch = async (
		reason: SessionSwitchReason,
		ctx: PiCommandContext | undefined,
	): Promise<{ cancel: true } | undefined> => {
		const inFlightWorkflowCount = topLevelWorkflowRuns(store.runs()).filter(
			(run) => run.endedAt === undefined,
		).length;
		if (inFlightWorkflowCount === 0) return undefined;
		const confirm = ctx?.ui?.confirm;
		if (ctx?.hasUI === false || typeof confirm !== "function") return undefined;
		const { title, message } = sessionSwitchQuitConfirmation(reason, inFlightWorkflowCount);
		const confirmed = await Promise.resolve(confirm(title, message)).catch(() => false);
		if (confirmed) return undefined;
		ctx?.ui?.notify?.(`${SESSION_SWITCH_COPY[reason].cancelled} cancelled; running workflows keep running.`, "info");
		return { cancel: true };
	};
	pi.on("session_before_switch", async (event, ctx) => {
		const reason = eventReason(event);
		if (reason !== "new" && reason !== "resume") return undefined;
		return confirmSessionSwitch(reason, ctx);
	});
	pi.on("session_before_fork", async (_event, ctx) => confirmSessionSwitch("fork", ctx));

	const notifyDiscoveryDiagnostics = (ctx: PiCommandContext | undefined): void => {
		if (!ctx?.ui) return;
		const diagnostics = formatStartupDiagnostics(null, runtimeState.discoveryRef.current);
		if (diagnostics !== null) ctx.ui.notify?.(diagnostics, "warning");
	};
	const warmWorkflowDiscovery = (ctx: PiCommandContext | undefined): void => {
		runtimeState.startWorkflowDiscoveryWarmup(() => notifyDiscoveryDiagnostics(ctx));
	};
	let startupResourcesDiscovered = false;

	const resumeInFlight = async (ctx: PiCommandContext | undefined): Promise<void> => {
		if (ctx?.isPresentationOnly === true) return;
		const mode = runtimeState.configLoadRef.current?.config?.resumeInFlight ?? "ask";
		if (mode === "never" || (mode === "ask" && (ctx?.hasUI === false || typeof ctx?.ui?.confirm !== "function")))
			return;
		try {
			const catalog = await runtimeState.runtimeForContext(ctx).prepareDurableResumable();
			const backend = getDurableBackend();
			const isInterrupted = (entry: ResumableWorkflowEntry): boolean =>
				entry.status === "running" &&
				entry.pendingPrompts === 0 &&
				!isLiveRunningWorkflow(backend.getWorkflow(entry.workflowId) ?? entry);
			const interrupted = catalog.filter(isInterrupted);
			if (interrupted.length === 0) return;
			if (
				mode === "ask" &&
				!(await ctx?.ui?.confirm?.(
					"Resume interrupted workflows?",
					`${interrupted.length} interrupted workflow(s) can resume from their durable checkpoints. Resume now? Choose No to leave them available through /workflow resume.`,
				))
			)
				return;
			await runtimeState.ensureWorkflowResourcesLoaded();
			const runtime = runtimeState.runtimeForContext(ctx);
			const prepared = await prepareWorkflowResumeCatalog(runtime, new Set(store.runs().map((run) => run.id)));
			const eligibleIds = new Set(interrupted.map((entry) => entry.workflowId));
			const availableIds = new Set(prepared.resumable.map((entry) => entry.workflowId));
			for (const entry of interrupted) {
				if (availableIds.has(entry.workflowId)) continue;
				ctx?.ui?.notify?.(
					`Workflow ${entry.workflowId} is not available for startup recovery. Enable its workflow resources, then use /workflow resume ${entry.workflowId}.`,
					"warning",
				);
			}
			for (const entry of prepared.resumable) {
				if (!eligibleIds.has(entry.workflowId) || !isInterrupted(entry)) continue;
				const result = await runtime.resumeDurableWorkflow(entry.workflowId, {
					policy: workflowPolicyFromContext(ctx),
					actor: "user",
				});
				ctx?.ui?.notify?.(result.message, result.ok ? "info" : "warning");
			}
		} catch (error) {
			ctx?.ui?.notify?.(
				`Workflow startup resume failed: ${String(error)}. Use /workflow resume to retry.`,
				"warning",
			);
		}
	};

	pi.on("session_start", async (event, ctx) => {
		// Injected backends remain borrowed; each started lifetime owns one lease.
		lifetime.release ??=
			getDurableBackendProcessOwner().injectedBackend === undefined ? acquireDbosLease() : async () => {};
		const reason =
			typeof event === "object" && event !== null && "reason" in event
				? (event as { readonly reason?: string }).reason
				: undefined;
		const stopsWorkflows = replacementStopsWorkflows(reason) && !(reason === "startup" && lifetime.startupStarted);
		if (reason === "startup") lifetime.startupStarted = true;
		startupResourcesDiscovered = false;
		runtimeState.resetWorkflowDiscoveryForSession();
		await runtimeState.ensureWorkflowConfigLoaded();
		if (stopsWorkflows) {
			killAllRuns({ store, cancellation: cancellationRegistry, persistence: runtimeState.persistenceRef.current });
			store.clear();
		}
		clearForms();
		resetWorkflowLifecycleNotificationState(runtimeState.lifecycleNotificationState);
		resetWorkflowHilAnswerNotificationState(runtimeState.hilAnswerNotificationState);
		if (stopsWorkflows) await stageControlRegistry.clear();
		else await stageControlRegistry.clearDetached();
		// Named workflows publish lifecycle notices through the normal notification path.
		runtimeState.setNotificationsActive(true);
		warmWorkflowDiscovery(ctx);
		if (ctx?.ui) {
			const diagnostics = formatStartupDiagnostics(runtimeState.configLoadRef.current, null);
			if (diagnostics !== null) ctx.ui.notify?.(diagnostics, "warning");
			deps.storeWidgetRef.current?.();
			deps.storeWidgetRef.current = installStoreWidget({ ui: ctx.ui }, store);
		}
		runtimeState.updateHostStageSessionDir(ctx?.sessionManager ?? pi.sessionManager);
		if (stopsWorkflows) await resumeInFlight(ctx);
	});
	// A second startup discovery in one session means deferred startup (such as
	// project trust) published a changed package set after session_start (#3354).
	pi.on("resources_discover", (event, ctx) => {
		if (eventReason(event) !== "startup") return undefined;
		if (!startupResourcesDiscovered) {
			startupResourcesDiscovered = true;
			return undefined;
		}
		runtimeState.refreshWorkflowDiscovery(() => notifyDiscoveryDiagnostics(ctx));
		return undefined;
	});

	installCompactionHook(pi, store);
	pi.on("session_shutdown", async (event) => {
		const reason = eventReason(event);
		const closeGeneration = () =>
			attemptAll([
				() => {
					deps.intercomControlRef.current?.();
					deps.intercomControlRef.current = null;
				},
				() => {
					deps.storeWidgetRef.current?.();
					deps.storeWidgetRef.current = null;
				},
				() => runtimeState.resetWorkflowDiscoveryForSession(),
				() => runtimeState.setNotificationsActive(false),
				() => deps.disposeObservation?.(),
			]);
		if (replacementStopsWorkflows(reason)) {
			lifetime.closing ??= attemptAll([
				closeGeneration,
				...lifetime.generations,
				() => {
					lifetime.generations.clear();
				},
				() => lifetime.release?.(),
			]);
			await lifetime.closing;
		} else if (isSessionSwitch(reason)) {
			await attemptAll([
				closeGeneration,
				...[...lifetime.generations].map((quitRuns) => () => quitRuns("switch")),
				flushDbos,
			]);
		} else {
			await attemptAll([closeGeneration, () => stageControlRegistry.clearDetached(), flushDbos]);
		}
	});
}
