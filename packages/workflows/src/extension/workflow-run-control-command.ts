import { getDurableBackend } from "../durable/factory.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { hasPendingDurableResumeTransition } from "../runs/background/durable-resume-transition.js";
import { quitAllRuns, quitRun } from "../runs/background/quit.js";
import { interruptAllRuns, interruptRun, pauseRun, resumeRun } from "../runs/background/status.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { store } from "../shared/store.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { renderSessionList } from "../tui/session-list.js";
import { openSessionPicker } from "../tui/session-overlays.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import type { PiCommandContext } from "./public-types.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { stripYesFlag } from "./workflow-command-utils.js";
import {
	deleteWorkflowResumeEntry,
	handleDurableResume,
	prepareWorkflowResumeCatalog,
	resolveWorkflowResumeTarget,
	type WorkflowRunControlDeps,
} from "./workflow-durable-resume-command.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import {
	collectResumePickerLiveRuns,
	type ResumePickerCatalogRows,
	resumePickerLiveUpdateOptions,
} from "./workflow-resume-picker-rows.js";
import { classifyDurableResumeShadow, reconcileDurableResumeShadow } from "./workflow-resume-shadow.js";
import { overlaySurfaceFromContext, resolveRunId, resolveStageTarget } from "./workflow-targets.js";

export type { WorkflowRunControlDeps } from "./workflow-durable-resume-command.js";

export async function handleRunControlCommand(
	action: "connect" | "interrupt" | "quit" | "attach" | "pause" | "resume",
	rest: string[],
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
): Promise<boolean> {
	const policy = workflowPolicyFromContext(ctx);
	const print = (msg: string): void => reporter.info(msg);
	const fail = (msg: string): void => reporter.error(msg);
	const canOpenPicker = (ui: PiCommandContext["ui"] | undefined): boolean =>
		policy.allowInputPicker && typeof ui?.custom === "function";
	const ensureWorkflowResourcesVisible = async (): Promise<void> => {
		try {
			await deps.ensureWorkflowResourcesLoaded();
		} catch (error) {
			ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
		}
	};
	const confirmationPrompt =
		policy.allowHumanInput && typeof ctx.ui?.confirm === "function" ? ctx.ui.confirm.bind(ctx.ui) : undefined;
	const theme = deriveGraphTheme({});
	const failHeadlessAttachCommand = (targetAction: "connect" | "attach", runId: string, stageId?: string): boolean => {
		if (policy.allowInputPicker) return false;
		const displayTarget = stageId ? `${runId} stage ${stageId}` : runId;
		fail(
			`/workflow ${targetAction} requires an interactive UI surface and cannot attach in non-interactive mode. ` +
				`Target: ${displayTarget}. Use /workflow status ${runId} or the workflow tool's status/stages/transcript actions for non-interactive inspection.`,
		);
		return true;
	};

	if (action === "connect") {
		const target = rest.find((t) => !t.startsWith("--"));
		if (!target) {
			const ui = ctx.ui;
			if (!canOpenPicker(ui)) {
				fail(
					`${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow connect <id>`,
				);
				return true;
			}
			const result = await openSessionPicker(ui, store, theme, "connect");
			if (result.kind === "close") return true;
			if (result.kind === "connect") {
				deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
				return true;
			}
			return true;
		}
		const resolved = resolveRunId(target);
		if (resolved.kind === "malformed") {
			fail(resolved.message);
			return true;
		}
		if (resolved.kind === "not_found") {
			fail(`Run not found: ${target}\n\n${renderSessionList(store.runs(), { theme, includeAll: true })}`);
			return true;
		}
		if (failHeadlessAttachCommand("connect", resolved.runId)) return true;
		if (policy.allowInputPicker) deps.overlay.open(resolved.runId, overlaySurfaceFromContext(ctx));
		print(`Connected to ${resolved.runId}. h hide · ctrl+x leave graph · return to main chat · esc close.`);
		return true;
	}

	if (action === "interrupt" || action === "quit") {
		const { tokens, yes } = action === "interrupt" ? stripYesFlag(rest) : { tokens: rest, yes: false };
		const unsupportedTarget =
			action === "quit" ? tokens.find((token) => token === "-y" || token === "--yes") : undefined;
		let target =
			action === "quit"
				? (unsupportedTarget ?? tokens.find((token) => token !== "--all"))
				: tokens.find((token) => !token.startsWith("--"));
		const wantsAll = unsupportedTarget === undefined && tokens.includes("--all");
		if (!target && !wantsAll) {
			target = store.activeRunId() ?? undefined;
			if (!target) {
				fail(`No in-flight runs to ${action}.`);
				return true;
			}
		}
		if (wantsAll) {
			const inFlight = topLevelWorkflowRuns(store.runs()).filter((run) => run.endedAt === undefined);
			if (inFlight.length === 0) {
				fail(`No in-flight runs to ${action}.`);
				return true;
			}
			if (action === "interrupt" && !yes && confirmationPrompt) {
				const title = `Interrupt all ${inFlight.length} in-flight workflow runs?`;
				const body = `Pauses: ${inFlight.map((run) => `${run.name} (${run.id})`).join(", ")}`;
				if (!(await confirmationPrompt(title, body))) {
					print("Cancelled.");
					return true;
				}
			}
			const results = action === "quit" ? await quitAllRuns({ actor: "user" }) : await interruptAllRuns();
			const successes = results.filter((result) => result.ok);
			const changed = successes.length;
			const failures = results.filter((result) => !result.ok);
			if (action === "quit" && failures.length > 0) {
				const outcomes = results
					.map((result) =>
						result.ok
							? `${result.runId}: quit`
							: `${result.runId}: ${result.reason}${"message" in result ? ` (${result.message})` : ""}`,
					)
					.join(", ");
				const message = `${changed > 0 ? `Quit ${changed} run(s); ` : ""}failed to quit ${failures.length} run(s); outcomes: ${outcomes}.`;
				if (changed > 0) print(message);
				else fail(message);
			} else if (changed > 0) {
				print(
					action === "quit"
						? `Quit ${changed} run(s); resume with /workflow resume.`
						: `Interrupted ${changed} run(s).`,
				);
			} else {
				fail(`No in-flight runs to ${action}.`);
			}
			return true;
		}
		const resolved = resolveRunId(target!);
		if (resolved.kind === "malformed") {
			fail(resolved.message);
			return true;
		}
		if (resolved.kind === "not_found") {
			fail(`Run not found: ${target}`);
			return true;
		}
		const run = store.runs().find((candidate) => candidate.id === resolved.runId);
		if (action === "quit") {
			if (run?.endedAt !== undefined) {
				print(`Run ${resolved.runId} already ended.`);
				return true;
			}
			try {
				const result = await quitRun(resolved.runId, { actor: "user" });
				if (result.ok) print(`Run ${result.runId} quit and can be resumed with /workflow resume.`);
				else if (result.reason === "already_ended") print(`Run ${result.runId} already ended.`);
				else if (result.reason === "no_active_stages") {
					fail(`No controllable stages on run ${result.runId}; the run remains active.`);
				} else fail(`Run not found: ${target}`);
			} catch (error) {
				fail(`Failed to quit run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return true;
		}
		if (!yes && run && run.endedAt === undefined && confirmationPrompt) {
			const confirmed = await confirmationPrompt(
				`Interrupt workflow run ${run.name} (${run.id})?`,
				"Pauses live work so it can be resumed later.",
			);
			if (!confirmed) {
				print(`Cancelled. Run ${resolved.runId} is still active.`);
				return true;
			}
		}
		try {
			const result = await interruptRun(resolved.runId);
			if (result.ok) print(`Run ${result.runId} interrupted and can be resumed.`);
			else
				fail(
					result.reason === "not_found"
						? `Run not found: ${target}`
						: result.reason === "already_ended"
							? `Run already ended: ${target}`
							: result.reason === "stage_not_found"
								? `Stage not found for run ${resolved.runId}.`
								: `No active stages to interrupt on run ${resolved.runId}.`,
				);
		} catch (error) {
			fail(`Failed to interrupt run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}
	if (action === "attach" || action === "pause" || action === "resume") {
		const target = rest[0];
		const stageTarget = rest[1];
		const message = action === "resume" ? rest.slice(2).join(" ").trim() || undefined : undefined;
		let runId: string;
		if (!target) {
			const ui = ctx.ui;
			if (!canOpenPicker(ui)) {
				if (action === "pause") {
					const active = topLevelWorkflowRuns(store.runs()).filter((r) => r.endedAt === undefined);
					fail(
						active.length === 0
							? "No active runs to pause."
							: `Picker requires an interactive UI surface. Active runs:\n${active.map((r) => `  ${r.id}  ${r.name}`).join("\n")}\n\nUsage: /workflow pause <runId> [stageId]`,
					);
				} else if (action === "attach") {
					fail(
						`${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow attach <id> [stageId]`,
					);
				} else {
					// resume: show cross-session durable catalog in headless/print mode.
					return await handleDurableResume(undefined, ctx, reporter, deps);
				}
				return true;
			}
			if (action === "resume") {
				// Mount the picker before any resource/catalog loading. Live rows seed the
				// first frame; durable/completed rows hydrate asynchronously and merge in.
				// The RPC prompt carrying this slash command no longer times out while the
				// picker awaits (long-lived command classification in RpcClient).
				const initial = collectResumePickerLiveRuns(store);
				const runtime = deps.runtimeForContext(ctx);
				const hydrate = async (): Promise<ResumePickerCatalogRows> => {
					await ensureWorkflowResourcesVisible();
					const catalog = await prepareWorkflowResumeCatalog(runtime, initial.suppressedLiveIds);
					return { durable: catalog.resumable, completed: catalog.completed };
				};
				let picked: Awaited<ReturnType<typeof openWorkflowResumeSelector>>;
				try {
					picked = await openWorkflowResumeSelector(ctx.ui, initial.liveRuns, hydrate, {
						deleteWorkflow: deleteWorkflowResumeEntry,
						...resumePickerLiveUpdateOptions(store, runtime),
					});
				} catch (error) {
					// No fallback: a host without the session-picker capability fails
					// the resume command with one actionable message.
					fail(error instanceof Error ? error.message : String(error));
					return true;
				}
				const durableEntries = picked.catalog.durable;
				const completedEntries = picked.catalog.completed;
				if (picked.result.kind === "durable" || picked.result.kind === "completed") {
					return await handleDurableResume(picked.result.workflowId, ctx, reporter, deps, {
						resumable: durableEntries,
						completed: completedEntries,
					});
				}
				if (picked.result.kind === "live") {
					const resolved = resolveRunId(picked.result.runId);
					if (resolved.kind !== "exact") {
						fail(`Run not found: ${picked.result.runId}`);
						return true;
					}
					const run = store.runs().find((r) => r.id === resolved.runId);
					const isPaused = run !== undefined && workflowHasPausedState(store, resolved.runId);
					const isDurableAuthorExit = run?.exited === true && run.status === "failed" && run.resumable === true;
					const isResumableContinuation =
						run !== undefined &&
						!isPaused &&
						run.exitReason !== "quit" &&
						isWorkflowRunResumable(workflowRunResumeCandidate(run));
					if (isDurableAuthorExit) {
						return await handleDurableResume(resolved.runId, ctx, reporter, deps);
					}
					if (isResumableContinuation) {
						await ensureWorkflowResourcesVisible();
						const continuation = await deps
							.runtimeForContext(ctx)
							.resumeFailedRun(resolved.runId, undefined, { policy, actor: "user" });
						continuation.ok ? print(continuation.message) : fail(continuation.message);
					} else {
						try {
							const result = await resumeRun(resolved.runId, { actor: "user" });
							if (result.ok && !isPaused && result.mode === "snapshot" && run?.exitReason === "quit") {
								return await handleDurableResume(resolved.runId, ctx, reporter, deps);
							}
							if (result.ok && result.mode === "partial") {
								fail(result.message ?? `Partially resumed ${result.runId}.`);
							} else {
								if (result.ok && policy.allowInputPicker)
									deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
								result.ok
									? print(result.message ?? `Resumed ${result.runId}`)
									: fail(`Run not found: ${picked.result.runId}`);
							}
						} catch (error) {
							fail(
								`Failed to resume run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}
				return true;
			}
			const picked = await openSessionPicker(ui, store, theme, action === "attach" ? "connect" : action);
			if (picked.kind !== (action === "attach" ? "connect" : action)) return true;
			runId = picked.runId;
		} else if (action === "resume") {
			const backend = getDurableBackend();
			const localResolution = resolveRunId(target);
			const localBeforePreparation =
				localResolution.kind === "exact" ? store.runs().find((run) => run.id === localResolution.runId) : undefined;
			const exactBeforePreparation = localBeforePreparation?.id === target ? localBeforePreparation : undefined;
			const shadow =
				localBeforePreparation === undefined
					? "not_shadow"
					: classifyDurableResumeShadow(localBeforePreparation, store, { backend });
			if (shadow === "ineligible") {
				fail(
					"Workflow " +
						localBeforePreparation!.id +
						" has no durable checkpoint or pending prompt progress and is not resumable.",
				);
				return true;
			}
			const exactHasPausedState =
				exactBeforePreparation !== undefined && workflowHasPausedState(store, exactBeforePreparation.id);
			const exactIsRecoverableBlock =
				exactBeforePreparation !== undefined &&
				exactBeforePreparation.endedAt === undefined &&
				exactBeforePreparation.resumable === true &&
				exactBeforePreparation.failureRecoverability === "recoverable";
			const exactIsActivelyRunning =
				exactBeforePreparation !== undefined &&
				exactBeforePreparation.endedAt === undefined &&
				exactBeforePreparation.status === "running" &&
				!exactHasPausedState &&
				exactBeforePreparation.exitReason !== "quit" &&
				!exactIsRecoverableBlock &&
				!hasPendingDurableResumeTransition(exactBeforePreparation.id);
			if (exactIsActivelyRunning) {
				fail(
					`Workflow ${exactBeforePreparation.id} is already running in this session. Attach with \`/workflow connect ${exactBeforePreparation.id}\` instead of resuming.`,
				);
				return true;
			}
			if (
				exactBeforePreparation !== undefined &&
				exactBeforePreparation.parentRunId === undefined &&
				exactHasPausedState &&
				shadow === "not_shadow" &&
				backend.isWorkflowLoadable(exactBeforePreparation.id)
			) {
				// Exact top-level live state is authoritative. Avoid scanning the
				// potentially large completed catalog while preserving the established
				// top-level target namespace and live-over-durable precedence.
				runId = exactBeforePreparation.id;
			} else {
				const localIsDurableResumeShadow = shadow === "eligible";
				let durable: readonly ResumableWorkflowEntry[] = [];
				let preparationError: string | undefined;
				const needsDurablePreparation =
					localBeforePreparation === undefined ||
					localIsDurableResumeShadow ||
					!backend.isWorkflowLoadable(localBeforePreparation.id);
				if (needsDurablePreparation) {
					await ensureWorkflowResourcesVisible();
					const runtime = deps.runtimeForContext(ctx);
					try {
						durable = await runtime.prepareDurableResumable(target);
					} catch (error) {
						preparationError = error instanceof Error ? error.message : String(error);
					}
				}
				const loadableRuns = topLevelWorkflowRuns(store.runs()).filter(
					(run) => backend.isWorkflowLoadable(run.id) && !reconcileDurableResumeShadow(run, store, { backend }),
				);
				const combined = resolveWorkflowResumeTarget(
					target,
					loadableRuns,
					durable,
					backend.listCompletedWorkflows(),
				);
				if (combined.kind === "malformed") {
					fail(combined.message);
					return true;
				}
				if (combined.kind === "completed" || combined.kind === "durable") {
					return await handleDurableResume(combined.workflowId, ctx, reporter, deps);
				}
				if (combined.kind === "live") runId = combined.workflowId;
				else {
					if (preparationError !== undefined) {
						fail(`Failed to resolve workflow resume target: ${preparationError}`);
						return true;
					}
					return await handleDurableResume(target, ctx, reporter, deps);
				}
			}
		} else {
			const resolved = resolveRunId(target);
			if (resolved.kind === "malformed") {
				fail(resolved.message);
				return true;
			}
			if (resolved.kind === "not_found") {
				fail(`Run not found: ${target}`);
				return true;
			}
			runId = resolved.runId;
		}
		if (action === "attach") {
			const resolvedStage = resolveStageTarget(runId, stageTarget);
			if (!resolvedStage.ok) {
				fail(resolvedStage.message);
				return true;
			}
			const stageId = resolvedStage.stageId;
			const stageRunId = resolvedStage.runId ?? runId;
			if (failHeadlessAttachCommand("attach", runId, stageId)) return true;
			if (policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
			print(
				stageId
					? `Attached to ${runId} stage ${stageId}. ctrl+x return to graph · esc close.`
					: `Attached to ${runId}. ↵ chat · ctrl+x leave graph · return to main chat.`,
			);
			return true;
		}
		const resolvedStage = resolveStageTarget(runId, stageTarget);
		if (!resolvedStage.ok) {
			fail(resolvedStage.message);
			return true;
		}
		const stageId = resolvedStage.stageId;
		const stageRunId = resolvedStage.runId ?? runId;
		if (action === "pause") {
			try {
				const result = await pauseRun(stageRunId, { stageId, actor: "user" });
				if (!result.ok) {
					fail(
						result.reason === "not_found"
							? `Run not found: ${stageRunId}`
							: result.reason === "already_ended"
								? `Run ${stageRunId} already ended.`
								: result.reason === "no_active_stages"
									? `No pausable stages on run ${stageRunId}.`
									: `Stage not found: ${stageTarget ?? "(unknown)"}`,
					);
					return true;
				}
				if (policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
				print(
					result.paused.length === 0
						? `No stages were paused on run ${stageRunId}.`
						: `Paused ${result.paused.length} stage(s) on run ${stageRunId}: ${result.paused.map((stage) => stage.name).join(", ")}`,
				);
			} catch (error) {
				fail(`Failed to pause run ${stageRunId}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return true;
		}
		const run = store.runs().find((r) => r.id === stageRunId);
		const hadPausedRunState = run?.status === "paused";
		const hadPausedStageState = run !== undefined && workflowHasPausedStages(store, stageRunId);
		const isPaused = run !== undefined && workflowHasPausedState(store, stageRunId);
		const isDurableAuthorExit = run?.exited === true && run.status === "failed" && run.resumable === true;
		const isResumableContinuation =
			run !== undefined &&
			!isPaused &&
			run.exitReason !== "quit" &&
			isWorkflowRunResumable(workflowRunResumeCandidate(run));
		const isActivelyRunning =
			run !== undefined &&
			run.endedAt === undefined &&
			run.status === "running" &&
			!isPaused &&
			run.exitReason !== "quit";
		if (
			isActivelyRunning &&
			!isResumableContinuation &&
			action === "resume" &&
			!hasPendingDurableResumeTransition(stageRunId)
		) {
			fail(
				`Workflow ${stageRunId} is already running in this session. Attach with \`/workflow connect ${stageRunId}\` instead of resuming.`,
			);
			return true;
		}
		if (isDurableAuthorExit) {
			return await handleDurableResume(stageRunId, ctx, reporter, deps);
		}
		if (isResumableContinuation) {
			await ensureWorkflowResourcesVisible();
			const continuation = await deps
				.runtimeForContext(ctx)
				.resumeFailedRun(stageRunId, stageId, { policy, actor: "user" });
			continuation.ok ? print(continuation.message) : fail(continuation.message);
			return true;
		}
		// A quit, non-paused durable run is a resume shadow rather than a live
		// stage-control pause. Routing directly to durable resume preserves the
		// previous snapshot-only diversion without reopening a stale local overlay.
		if (!isPaused && run?.exitReason === "quit" && action === "resume") {
			return await handleDurableResume(stageRunId, ctx, reporter, deps);
		}
		let result: Awaited<ReturnType<typeof resumeRun>>;
		try {
			result = await resumeRun(stageRunId, { stageId, message, actor: "user" });
		} catch (error) {
			fail(`Failed to resume run ${stageRunId}: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		if (!result.ok) {
			fail(`Run not found: ${stageRunId}`);
			return true;
		}
		if (result.mode === "partial") {
			fail(result.message ?? `Partially resumed ${result.runId}.`);
			return true;
		}
		if (result.snapshot.endedAt !== undefined && result.message !== undefined) {
			print(result.message);
			return true;
		}
		if (!isPaused) {
			if (policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
			print(
				result.message ??
					`Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`,
			);
			return true;
		}
		if (!message && stageId && policy.allowInputPicker)
			deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
		if (result.resumed.length === 0) {
			const runLevelResumed =
				hadPausedRunState && !hadPausedStageState && stageId === undefined && result.snapshot.status === "running";
			if (result.message !== undefined) print(result.message);
			else if (runLevelResumed) print(`Resumed run ${stageRunId}.`);
			else fail(`No paused stages on run ${stageRunId}.`);
		} else {
			print(
				`Resumed ${result.resumed.length} stage(s) on run ${stageRunId}${message ? ` with message: "${message}"` : ""}.`,
			);
		}
		return true;
	}

	return false;
}
