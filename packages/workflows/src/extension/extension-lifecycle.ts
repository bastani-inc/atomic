import { registerExtensionContextRetirementEffect, sessionScopedExtensionState } from "@bastani/atomic";
import { releaseDurableBackendsHeldBy } from "../durable/backend-process-owner.js";
import { reclaimReleasedRunsOwnedBy, releasePausedRunsOwnedBy } from "../durable/sdk-owner-release.js";
import { canonicalDirectoryAsync, isSdkReleasedRunAdoptableAsync } from "../durable/sdk-recovery-scope.js";
import { availableStoreDurableBackend, requireStoreDurableBackend } from "../durable/store-backend.js";
import type { DurableWorkflowHandle, ResumableWorkflowEntry } from "../durable/types.js";
import { settleEndedRuns } from "../runs/background/ended-run-settlement.js";
import { quitAllRuns } from "../runs/background/quit.js";
import { killAllRuns } from "../runs/background/status.js";
import { installCompactionHook } from "../shared/persistence-compaction-policy.js";
import { normalizeSessionEntries } from "../shared/persistence-restore.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { currentWorkflowSessionRunState, type WorkflowSessionRunState } from "./adopt-session-run-state.js";
import { WORKFLOW_CONFIG_DEFAULTS } from "./config-loader.js";
import type { WorkflowExtensionRuntimeState } from "./extension-runtime-state.js";
import { resetWorkflowHilAnswerNotificationState } from "./hil-answer-notifications.js";
import { resetWorkflowLifecycleNotificationState } from "./lifecycle-notifications.js";
import type { ExtensionAPI, PiCommandContext, PiEventContext } from "./public-types.js";
import { formatStartupDiagnostics } from "./workflow-command-surfaces.js";
import { prepareWorkflowResumeCatalog } from "./workflow-durable-resume-command.js";
import { workflowCaller } from "./workflow-instance-owner.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";

interface WorkflowLifetime {
	readonly generations: Set<QuitGenerationRuns>;
	/** The run-scoped instances each generation's quit acts on. */
	generationRunStates?: WeakMap<QuitGenerationRuns, GenerationRunState>;
	closing?: Promise<void>;
	startupStarted?: boolean;
	/** Runs the departing session released on a session switch, until the successor announces them. */
	releasedRunIds?: readonly string[];
	/**
	 * Released runs the current session has not been told about. A run stays owed until a notice names it or a
	 * finished check finds that it cannot be adopted; the next reload or session switch announces it.
	 */
	owedRunIds?: ReadonlySet<string>;
	/** Counts session starts: only the newest start announces released runs or drops them. */
	sessionStarts?: number;
	/** Adoptability checks in flight, by run release and directory, which overlapping session starts share. */
	releasedRunChecks?: Map<string, ReleasedRunCheck>;
	/** The most recently started generation's quit-and-release handoff; a successor completes it before starting. */
	pendingSwitchHandoff?: () => Promise<void>;
	/** A handoff already running, so that closing the lifetime never overlaps it. */
	activeSwitchHandoff?: Promise<void>;
}

/** One adoptability check, and the starts waiting for it, each for at most {@link RELEASED_RUN_CHECK_WAIT_MS}. */
interface ReleasedRunCheck {
	settled: boolean;
	adoptable?: boolean;
	readonly waiters: Set<() => void>;
}

type QuitGenerationRuns = (boundary?: "quit" | "switch") => Promise<void>;
type GenerationRunState = Pick<
	WorkflowSessionRunState,
	"store" | "stageControlRegistry" | "toolControlRegistry" | "jobs"
>;

function sameRunState(left: GenerationRunState, right: GenerationRunState): boolean {
	return (
		left.store === right.store &&
		left.stageControlRegistry === right.stageControlRegistry &&
		left.toolControlRegistry === right.toolControlRegistry &&
		left.jobs === right.jobs
	);
}

/**
 * Keep one quit per set of run-scoped instances. A `/reload` evaluates this module again and starts a new generation
 * over the same instances, and the departing generation's quit, which closes over its whole extension API, would
 * otherwise stay in the lifetime for as long as the session runs, one more per reload. What each quit acts on is kept
 * on the lifetime, which every generation of the session shares. A generation over other instances is still kept.
 */
function addGeneration(lifetime: WorkflowLifetime, quit: QuitGenerationRuns, runState: GenerationRunState): void {
	lifetime.generationRunStates ??= new WeakMap();
	for (const earlier of lifetime.generations) {
		const earlierState = lifetime.generationRunStates.get(earlier);
		if (earlierState !== undefined && sameRunState(earlierState, runState)) lifetime.generations.delete(earlier);
	}
	lifetime.generationRunStates.set(quit, runState);
	lifetime.generations.add(quit);
}

/** How long a session start waits for one released run's adoptability check before leaving that run pending. */
const RELEASED_RUN_CHECK_WAIT_MS = 2_000;

const startupRecoveries = new Set<Promise<void>>();

function trackStartupRecovery(recovery: Promise<void>): void {
	const tracked = recovery.catch(() => undefined).finally(() => startupRecoveries.delete(tracked));
	startupRecoveries.add(tracked);
}

export async function settleStartupWorkflowRecoveries(): Promise<void> {
	while (startupRecoveries.size > 0) await Promise.all([...startupRecoveries]);
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
		message: `Continuing quits ${runs} now. ${pronoun} stops at its last checkpoint and can be resumed later with /resume.`,
	};
}

/** The departing session's checkpointed runs become adoptable; a crash never gets here. */
async function releasePausedRunsOfSession(sessionCaller: string | undefined, store: Store): Promise<readonly string[]> {
	const backend = availableStoreDurableBackend(store);
	return sessionCaller !== undefined && backend !== undefined ? releasePausedRunsOwnedBy(backend, sessionCaller) : [];
}

function releasedRunsNotice(runs: readonly { readonly id: string; readonly name: string }[]): string {
	const count = runs.length === 1 ? "1 workflow run" : `${runs.length} workflow runs`;
	return [
		`Released ${count} from the previous session. Resume ${runs.length === 1 ? "it" : "any"} here:`,
		...runs.map((run) => `  /resume ${run.id}  (${run.name})`),
	].join("\n");
}

function blockedAtRest(
	run: { readonly endedAt?: number; readonly blockedAt?: number; readonly failureDisposition?: string } | undefined,
): boolean {
	return (
		run !== undefined &&
		run.endedAt === undefined &&
		(run.blockedAt !== undefined || run.failureDisposition === "active_blocked")
	);
}

function eventReason(event: unknown): string | undefined {
	return typeof event === "object" && event !== null && "reason" in event
		? (event as { readonly reason?: string }).reason
		: undefined;
}

export interface WorkflowLifecycleRegistrationDeps {
	runtimeState: WorkflowExtensionRuntimeState;
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
					.filter(
						(result) =>
							!(
								result.reason === "no_active_stages" &&
								(boundary === "switch" || blockedAtRest(store.run(result.runId)))
							),
					);
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
				if (boundary !== "quit") return;
				const failures = await settleEndedRuns({ store, jobs });
				if (failures.length > 0)
					throw new Error(
						failures
							.map((failure) => `${failure.runId}: ended but its ending was not recorded (${failure.message})`)
							.join("; "),
					);
			},
			() => stageControlRegistry.clear(),
		]);
	addGeneration(lifetime, quitAndCheckpointRuns, { store, stageControlRegistry, toolControlRegistry, jobs });
	const { runtimeState } = deps;
	const confirmSessionSwitch = async (
		reason: SessionSwitchReason,
		ctx: PiCommandContext | undefined,
	): Promise<{ cancel: true } | undefined> => {
		const inFlightWorkflowCount = topLevelWorkflowRuns(store.runs()).filter(
			(run) => !run.restored && run.endedAt === undefined,
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

	let notifiedDiscoveryDiagnostics: string | null = null;
	const notifyDiscoveryDiagnostics = (ctx: PiCommandContext | undefined): void => {
		if (!ctx?.ui) return;
		const diagnostics = formatStartupDiagnostics(null, runtimeState.discoveryRef.current);
		if (diagnostics === notifiedDiscoveryDiagnostics) return;
		notifiedDiscoveryDiagnostics = diagnostics;
		if (diagnostics !== null) ctx.ui.notify?.(diagnostics, "warning");
	};
	const warmWorkflowDiscovery = (ctx: PiCommandContext | undefined): void => {
		runtimeState.startWorkflowDiscoveryWarmup(() => notifyDiscoveryDiagnostics(ctx));
	};
	let startupResourcesDiscovered = false;

	let recoveryGeneration = 0;
	const resumeInFlight = async (ctx: PiEventContext | undefined, generation: number): Promise<void> => {
		const isCurrent = () => generation === recoveryGeneration;
		if (ctx?.isPresentationOnly === true) return;
		const mode =
			runtimeState.configLoadRef.current?.config?.resumeInFlight ?? WORKFLOW_CONFIG_DEFAULTS.resumeInFlight;
		if (mode === "never" || (mode === "ask" && (ctx?.hasUI === false || typeof ctx?.ui?.confirm !== "function")))
			return;
		try {
			const catalog = await runtimeState.runtimeForContext(ctx).prepareDurableResumable();
			if (!isCurrent()) return;
			const backend = requireStoreDurableBackend(store);
			const currentCwd = await canonicalDirectoryAsync(
				ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? runtimeState.resolveInvocationCwd(),
			);
			const isInterruptedInProject = async (entry: ResumableWorkflowEntry): Promise<boolean> => {
				const handle = backend.getWorkflow(entry.workflowId) ?? entry;
				return (
					handle.status === "running" &&
					store.run(entry.workflowId)?.blockedAt === undefined &&
					(handle.pendingPrompts ?? entry.pendingPrompts) === 0 &&
					(await backend.workflowOwnership(entry.workflowId)) === "available" &&
					handle.invocationCwd !== undefined &&
					(await canonicalDirectoryAsync(handle.invocationCwd)) === currentCwd
				);
			};
			const interrupted: ResumableWorkflowEntry[] = [];
			for (const entry of catalog) if (await isInterruptedInProject(entry)) interrupted.push(entry);
			if (interrupted.length === 0) return;
			if (
				mode === "ask" &&
				!(await ctx?.ui?.confirm?.(
					"Resume interrupted workflows?",
					`${interrupted.length} interrupted workflow(s) can resume from their durable checkpoints. Resume now? Choose No to leave them available through /resume.`,
				))
			)
				return;
			if (!isCurrent()) return;
			await runtimeState.ensureWorkflowResourcesLoaded();
			const runtime = runtimeState.runtimeForContext(ctx);
			const prepared = await prepareWorkflowResumeCatalog(runtime, new Set(store.runs().map((run) => run.id)));
			const eligibleIds = new Set(interrupted.map((entry) => entry.workflowId));
			const availableIds = new Set(prepared.resumable.map((entry) => entry.workflowId));
			for (const entry of interrupted) {
				if (availableIds.has(entry.workflowId)) continue;
				ctx?.ui?.notify?.(
					`Workflow ${entry.workflowId} is not available for startup recovery. Enable its workflow resources, then use /resume ${entry.workflowId}.`,
					"warning",
				);
			}
			for (const entry of prepared.resumable) {
				if (!isCurrent()) return;
				if (!eligibleIds.has(entry.workflowId)) continue;
				// #5149: a run paused or taken elsewhere while the dialog was open is skipped; a failed check warns below.
				if (!(await isInterruptedInProject(entry))) {
					ctx?.ui?.notify?.(
						`Workflow ${entry.workflowId} changed while startup recovery was pending, so it was not resumed. Use /resume ${entry.workflowId} if it should continue.`,
						"info",
					);
					continue;
				}
				const result = await runtime.resumeDurableWorkflow(entry.workflowId, {
					policy: workflowPolicyFromContext(ctx),
					actor: "user",
					...(ctx === undefined ? {} : { modelOwner: workflowCaller(ctx) }),
				});
				ctx?.ui?.notify?.(result.message, result.ok ? "info" : "warning");
			}
		} catch (error) {
			if (!isCurrent()) return;
			ctx?.ui?.notify?.(`Workflow startup resume failed: ${String(error)}. Use /resume to retry.`, "warning");
		}
	};

	const closeObservation = (): void => {
		const errors: unknown[] = [];
		for (const dispose of [
			() => {
				deps.intercomControlRef.current?.();
				deps.intercomControlRef.current = null;
			},
			() => runtimeState.resetWorkflowDiscoveryForSession(),
			() => runtimeState.setNotificationsActive(false),
			() => deps.disposeObservation?.(),
		]) {
			try {
				dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Workflow observation retirement failed");
	};
	// Captured while the context is live: a retiring generation's shutdown handler must not read it.
	let sessionCaller: string | undefined;
	let switchHandoff: Promise<void> | undefined;
	// A command that awaits `ctx.newSession()` (or switch/fork) starts the successor before this session's
	// `session_shutdown` handlers run, so the successor completes this same memoized handoff itself.
	const handOffRunsToSuccessor = (): Promise<void> => {
		switchHandoff ??= attemptAll([
			...[...lifetime.generations].map((quitRuns) => () => quitRuns("switch")),
			async () => {
				const released = await releasePausedRunsOfSession(sessionCaller, store);
				lifetime.releasedRunIds = [...new Set([...(lifetime.releasedRunIds ?? []), ...released])];
				lifetime.owedRunIds = new Set([...(lifetime.owedRunIds ?? []), ...released]);
			},
		]);
		lifetime.activeSwitchHandoff = switchHandoff;
		return switchHandoff;
	};
	const releaseIdentity = (handle: DurableWorkflowHandle, cwd: string | undefined): string =>
		JSON.stringify([
			handle.workflowId,
			cwd ?? null,
			handle.status,
			handle.modelOwner ?? null,
			handle.releasedModelOwner ?? null,
			handle.invocationCwd ?? null,
			handle.rootWorkflowId ?? null,
		]);
	const checkReleasedRunAdoptable = async (
		handle: DurableWorkflowHandle,
		cwd: string | undefined,
	): Promise<boolean | undefined> => {
		lifetime.releasedRunChecks ??= new Map();
		const checks = lifetime.releasedRunChecks;
		const key = releaseIdentity(handle, cwd);
		let check = checks.get(key);
		if (check === undefined) {
			const started: ReleasedRunCheck = { settled: false, waiters: new Set() };
			const settle = (adoptable: boolean | undefined) => {
				started.adoptable = adoptable;
				started.settled = true;
				if (checks.get(key) === started) checks.delete(key);
				for (const wake of [...started.waiters]) wake();
			};
			void isSdkReleasedRunAdoptableAsync(handle, cwd).then(settle, () => settle(undefined));
			checks.set(key, started);
			check = started;
		}
		const waiting = check;
		if (!waiting.settled) {
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					waiting.waiters.delete(wake);
					resolve();
				};
				const timer = setTimeout(wake, RELEASED_RUN_CHECK_WAIT_MS);
				timer.unref?.();
				waiting.waiters.add(wake);
			});
		}
		return waiting.settled ? waiting.adoptable : undefined;
	};
	const announceReleasedRuns = async (
		reason: string | undefined,
		ctx: PiEventContext | undefined,
		resolveCwd: () => string | undefined,
		isNewest: () => boolean,
	): Promise<void> => {
		if (!isNewest()) return;
		if (reason !== "reload" && !isSessionSwitch(reason)) {
			lifetime.releasedRunIds = undefined;
			lifetime.owedRunIds = undefined;
			return;
		}
		const pending = new Set(lifetime.releasedRunIds ?? []);
		const owed = [...(lifetime.owedRunIds ?? [])].filter((runId) => pending.has(runId));
		if (owed.length === 0) return;
		const cwd = resolveCwd();
		const backend = availableStoreDurableBackend(store);
		const checked = await Promise.all(
			owed.map(async (runId) => {
				const handle = backend?.getWorkflow(runId);
				if (handle === undefined) return { runId, name: runId, adoptable: false };
				const adoptable = await checkReleasedRunAdoptable(handle, cwd);
				const current = backend?.getWorkflow(runId);
				const unchanged = current !== undefined && releaseIdentity(current, cwd) === releaseIdentity(handle, cwd);
				return { runId, name: handle.name, adoptable: unchanged ? adoptable : undefined };
			}),
		);
		if (!isNewest()) return;
		// Runs nobody adopted stay announced to the next successor; a reload keeps them unannounced.
		const dropped = new Set(checked.filter((run) => run.adoptable === false).map((run) => run.runId));
		lifetime.releasedRunIds = (lifetime.releasedRunIds ?? []).filter((runId) => !dropped.has(runId));
		const adoptable = checked.filter((run) => run.adoptable === true);
		if (adoptable.length > 0)
			ctx?.ui?.notify?.(releasedRunsNotice(adoptable.map((run) => ({ id: run.runId, name: run.name }))), "info");
		const answered = new Set([...dropped, ...adoptable.map((run) => run.runId)]);
		lifetime.owedRunIds = new Set([...(lifetime.owedRunIds ?? [])].filter((runId) => !answered.has(runId)));
	};
	pi.on("session_start", async (event, ctx) => {
		const sessionStart = (lifetime.sessionStarts ?? 0) + 1;
		lifetime.sessionStarts = sessionStart;
		if (isSessionSwitch(eventReason(event)))
			lifetime.owedRunIds = new Set([...(lifetime.owedRunIds ?? []), ...(lifetime.releasedRunIds ?? [])]);
		let retired = false;
		const contextCwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.();
		const isNewest = () => !retired && lifetime.sessionStarts === sessionStart;
		const departingHandoff = lifetime.pendingSwitchHandoff;
		lifetime.pendingSwitchHandoff = handOffRunsToSuccessor;
		if (ctx) {
			registerExtensionContextRetirementEffect(ctx, closeObservation);
			registerExtensionContextRetirementEffect(ctx, () => {
				retired = true;
			});
			sessionCaller = workflowCaller(ctx);
		}
		if (isSessionSwitch(eventReason(event)) && departingHandoff !== undefined && lifetime.closing === undefined)
			await departingHandoff().catch(() => undefined);
		const reason =
			typeof event === "object" && event !== null && "reason" in event
				? (event as { readonly reason?: string }).reason
				: undefined;
		const stopsWorkflows = replacementStopsWorkflows(reason) && !(reason === "startup" && lifetime.startupStarted);
		if (reason === "startup") lifetime.startupStarted = true;
		startupResourcesDiscovered = false;
		notifiedDiscoveryDiagnostics = null;
		runtimeState.resetWorkflowDiscoveryForSession();
		await runtimeState.ensureWorkflowConfigLoaded();
		if (stopsWorkflows) {
			await killAllRuns({
				store,
				cancellation: cancellationRegistry,
				persistence: runtimeState.persistenceRef.current,
				...(pi.events?.emit ? { events: { emit: (event, payload) => pi.events?.emit?.(event, payload) } } : {}),
				...(ctx ? { context: ctx } : {}),
			});
			store.clear();
		}
		if (isSessionSwitch(reason)) {
			for (const run of [...store.runs()])
				if (run.restored && run.modelOwner !== sessionCaller) store.removeRun(run.id);
		}
		const manager = ctx?.sessionManager ?? pi.sessionManager;
		const owner = manager?.getSessionId?.();
		if (owner && ctx?.isPresentationOnly !== true && (stopsWorkflows || reason === "resume")) {
			const entries = manager?.getEntries?.() ?? [];
			const ids = new Set<string>();
			for (const { type, payload } of normalizeSessionEntries(entries)) {
				if (typeof payload.runId !== "string") continue;
				if (type === "workflow.run.blocked") ids.add(payload.runId);
				else if (type === "workflow.run.start" || type === "workflow.run.end") ids.delete(payload.runId);
			}
			if (ids.size) {
				try {
					await runtimeState.runtimeForContext(ctx).restoreSessionRuns?.(owner, entries, isNewest, [...ids]);
				} catch (error) {
					if (isNewest())
						ctx?.ui?.notify?.(
							`Could not restore workflow runs: ${String(error)}. Open /workflows to retry.`,
							"warning",
						);
				}
			}
		}
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
		}
		if (isSessionSwitch(reason) && sessionCaller !== undefined) {
			const backend = availableStoreDurableBackend(store);
			if (backend !== undefined) await reclaimReleasedRunsOwnedBy(backend, sessionCaller).catch(() => undefined);
		}
		await announceReleasedRuns(reason, ctx, () => contextCwd ?? runtimeState.resolveInvocationCwd(), isNewest);
		runtimeState.updateHostStageSessionDir(ctx?.sessionManager ?? pi.sessionManager);
		const generation = ++recoveryGeneration;
		if (stopsWorkflows) trackStartupRecovery(resumeInFlight(ctx, generation));
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
		recoveryGeneration += 1;
		const closeGeneration = closeObservation;
		if (replacementStopsWorkflows(reason)) {
			lifetime.closing ??= attemptAll([
				() => lifetime.activeSwitchHandoff?.catch(() => undefined),
				closeGeneration,
				...lifetime.generations,
				() => releasePausedRunsOfSession(sessionCaller, store),
				() => releaseDurableBackendsHeldBy(store),
				() => {
					lifetime.generations.clear();
				},
			]);
			// The lifetime outlives this session for as long as anything holds its scope; an ended session hands
			// nothing to a successor, so its handoff, and the session it closes over, go with it.
			if (lifetime.pendingSwitchHandoff === handOffRunsToSuccessor) lifetime.pendingSwitchHandoff = undefined;
			await lifetime.closing;
		} else if (isSessionSwitch(reason)) {
			await attemptAll([closeGeneration, handOffRunsToSuccessor]);
		} else {
			await attemptAll([closeGeneration, () => stageControlRegistry.clearDetached()]);
		}
	});
}
