import type { DurableWorkflowBackend } from "../durable/backend.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import { staleResumeSelectionMessage } from "../durable/resume-runtime.js";
import { DurableBackendNotInitializedError, requireStoreDurableBackend } from "../durable/store-backend.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { hasPendingDurableResumeTransition } from "../runs/background/durable-resume-transition.js";
import { quitAllRuns, quitRun } from "../runs/background/quit.js";
import { pauseAllRuns, pauseRun, resumeRun } from "../runs/background/status.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import { isRunIdPrefix } from "../shared/run-id.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { refreshWorkflowArtifactPresence, workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import type { PiCommandContext } from "./public-types.js";
import { bulkAlreadyPausedCount, bulkFailedRuns, bulkFailureMessage } from "./workflow-bulk-control.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { stripYesFlag } from "./workflow-command-utils.js";
import {
	ACCEPT_ENTRY_CHANGES_FLAG,
	type DurableResumeCommandOptions,
	deleteWorkflowResumeEntry,
	handleDurableResume,
	prepareWorkflowResumeCatalog,
	resolveWorkflowResumeTarget,
	resumeFailedRunWithConfirmation,
	stageScopedDurableResumeMessage,
	type WorkflowResumeCatalog,
	type WorkflowRunControlDeps,
} from "./workflow-durable-resume-command.js";
import { captureWorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import {
	collectResumePickerLiveRuns,
	type ResumePickerCatalogRows,
	resumePickerLiveUpdateOptions,
} from "./workflow-resume-picker-rows.js";
import { classifyDurableResumeShadow } from "./workflow-resume-shadow.js";
import { injectWorkflowResumeSummary } from "./workflow-resume-summary.js";
import { isResolvedRunId, overlaySurfaceFromContext, resolveRunId, resolveStageTarget } from "./workflow-targets.js";

export type { WorkflowRunControlDeps } from "./workflow-durable-resume-command.js";

export async function handleRunControlCommand(
	action: "quit" | "pause" | "resume",
	rest: string[],
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
	expectedUpdatedAt?: number,
): Promise<boolean> {
	const owner = deps.owner ?? captureWorkflowOwnerResources();
	deps = { ...deps, owner };
	const { store, toolControlRegistry } = owner;
	const shadowDeps = {
		jobs: owner.jobs,
		stageControls: owner.stageControlRegistry,
		toolControls: toolControlRegistry,
	};
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
	if (action === "pause" || action === "quit") {
		const { tokens, yes } = action === "pause" ? stripYesFlag(rest) : { tokens: rest, yes: false };
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
			if (action === "pause" && !yes && confirmationPrompt) {
				const title = `Pause all ${inFlight.length} in-flight workflow runs?`;
				const body = `Pauses: ${inFlight.map((run) => `${run.name} (${run.id})`).join(", ")}`;
				if (!(await confirmationPrompt(title, body))) {
					print("Cancelled.");
					return true;
				}
			}
			const results = action === "quit" ? await quitAllRuns({ ...owner, actor: "user" }) : await pauseAllRuns(owner);
			const successes = results.flatMap((result) => (result.ok ? [result] : []));
			const changed = successes.length;
			const alreadyPaused = bulkAlreadyPausedCount(results);
			if (bulkFailedRuns(results).length > 0) {
				const message = bulkFailureMessage(
					action === "quit" ? "Quit" : "Paused",
					action,
					results,
					(result) => result.message ?? `${result.runId}: ${action === "quit" ? "quit" : "paused"}`,
				);
				if (changed > 0) print(message);
				else fail(message);
			} else if (changed > 0) {
				print(
					successes.some((result) => result.message !== undefined)
						? successes.map((result) => result.message ?? `Run ${result.runId} stopped.`).join("\n")
						: action === "quit"
							? `Quit ${changed} run(s); resume with /resume.`
							: `Paused ${changed} run(s).`,
				);
			} else if (alreadyPaused > 0) {
				print(`${alreadyPaused} in-flight run(s) already paused.`);
			} else {
				fail(`No in-flight runs to ${action}.`);
			}
			return true;
		}
		const resolved = resolveRunId(target!, store);
		if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
			fail(resolved.message);
			return true;
		}
		if (resolved.kind === "not_found") {
			fail(`Run not found: ${target}`);
			return true;
		}
		const run = store.run(resolved.runId);

		const positional = tokens.filter((token) => !token.startsWith("--"));
		const stageTarget = action === "pause" && target === positional[0] ? positional[1] : undefined;
		if (stageTarget !== undefined) {
			const stage = resolveStageTarget(resolved.runId, stageTarget, store);
			if (!stage.ok || stage.stageId === undefined) {
				fail(stage.ok ? `Stage not found for run ${resolved.runId}: ${stageTarget}` : stage.message);
				return true;
			}
			const stageRunId = stage.runId ?? resolved.runId;
			if (!yes && run && run.endedAt === undefined && confirmationPrompt) {
				const confirmed = await confirmationPrompt(
					`Pause stage ${stageTarget} of workflow run ${run.name} (${run.id})?`,
					"Pauses only this stage so it can be resumed later; other stages keep running.",
				);
				if (!confirmed) {
					print(`Cancelled. Stage ${stageTarget} is still active.`);
					return true;
				}
			}
			try {
				const result = await pauseRun(stageRunId, { ...owner, stageId: stage.stageId });
				if (result.ok)
					print(
						result.message ??
							`Stage ${stageTarget} of run ${resolved.runId} paused; resume it from /workflows ${resolved.runId}.`,
					);
				else
					fail(
						result.reason === "stage_not_found"
							? `Stage not found for run ${resolved.runId}: ${stageTarget}`
							: result.reason === "already_ended"
								? `Run already ended: ${target}`
								: `Stage ${stageTarget} of run ${resolved.runId} is not running.`,
					);
			} catch (error) {
				fail(
					`Failed to pause stage ${stageTarget} of run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return true;
		}
		if (action === "quit") {
			if (run?.endedAt !== undefined) {
				print(`Run ${resolved.runId} already ended.`);
				return true;
			}
			try {
				const result = await quitRun(resolved.runId, { ...owner, actor: "user" });
				if (result.ok) print(result.message ?? `Run ${result.runId} quit and can be resumed with /resume.`);
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
				`Pause workflow run ${run.name} (${run.id})?`,
				"Pauses live work so it can be resumed later.",
			);
			if (!confirmed) {
				print(`Cancelled. Run ${resolved.runId} is still active.`);
				return true;
			}
		}
		try {
			const result = await pauseRun(resolved.runId, owner);
			if (result.ok) print(result.message ?? `Run ${result.runId} paused and can be resumed.`);
			else if (result.reason === "already_paused") print(`Run ${result.runId} is already paused.`);
			else
				fail(
					result.reason === "not_found"
						? `Run not found: ${target}`
						: result.reason === "already_ended"
							? `Run already ended: ${target}`
							: result.reason === "stage_not_found"
								? `Stage not found for run ${resolved.runId}.`
								: `No active stages to pause on run ${resolved.runId}.`,
				);
		} catch (error) {
			fail(`Failed to pause run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}
	if (action === "resume") {
		// The flag may stand anywhere among the arguments: the rest are the run, its stage and the message.
		const acceptEntryChanges = rest.includes(ACCEPT_ENTRY_CHANGES_FLAG);
		const args = acceptEntryChanges ? rest.filter((token) => token !== ACCEPT_ENTRY_CHANGES_FLAG) : rest;
		const resumeOptions: DurableResumeCommandOptions = {
			...(acceptEntryChanges ? { acceptEntryChanges: true } : {}),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
		};
		const durableResume = (workflowId: string | undefined, catalog?: WorkflowResumeCatalog) =>
			handleDurableResume(workflowId, ctx, reporter, deps, catalog, resumeOptions);
		const target = args[0];
		const stageTarget = args[1];
		const message = args.slice(2).join(" ").trim() || undefined;
		let runId: string;
		if (!target) {
			const ui = ctx.ui;
			if (!canOpenPicker(ui)) {
				return await durableResume(undefined);
			}
			// Mount the picker before any resource/catalog loading. Live rows seed the
			// first frame; durable/completed rows hydrate asynchronously and merge in.
			// The RPC prompt carrying this slash command no longer times out while the
			// picker awaits (long-lived command classification in RpcClient).
			await refreshWorkflowArtifactPresence(store.runs());
			const initial = collectResumePickerLiveRuns(store, shadowDeps);
			const runtime = deps.runtimeForContext(ctx);
			const hydrate = async (): Promise<ResumePickerCatalogRows> => {
				await ensureWorkflowResourcesVisible();
				const catalog = await prepareWorkflowResumeCatalog(runtime, initial.suppressedLiveIds);
				return { durable: catalog.resumable, completed: catalog.completed };
			};
			let picked: Awaited<ReturnType<typeof openWorkflowResumeSelector>>;
			try {
				picked = await openWorkflowResumeSelector(ctx.ui, initial.liveRuns, hydrate, {
					deleteWorkflow: (workflowId) => deleteWorkflowResumeEntry(workflowId, store),
					...resumePickerLiveUpdateOptions(store, runtime, shadowDeps),
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
				return await durableResume(picked.result.workflowId, {
					resumable: durableEntries,
					completed: completedEntries,
				});
			}
			if (picked.result.kind === "live") {
				const resolved = resolveRunId(picked.result.runId, store);
				if (!isResolvedRunId(resolved)) {
					fail(`Run not found: ${picked.result.runId}`);
					return true;
				}
				const run = store.run(resolved.runId);
				await injectWorkflowResumeSummary(
					deps.pi,
					ctx,
					resolved.runId,
					run,
					undefined,
					requireStoreDurableBackend(store, resolved.runId),
				);
				if (run !== undefined) await refreshWorkflowArtifactPresence([run], store.runs());
				const isPaused = run !== undefined && workflowHasPausedState(store, resolved.runId);
				const isDurableAuthorExit = run?.exited === true && run.status === "failed" && run.resumable === true;
				const isResumableContinuation =
					run !== undefined &&
					!isPaused &&
					run.exitReason !== "quit" &&
					isWorkflowRunResumable(
						workflowRunResumeCandidate(run, store.runs(), requireStoreDurableBackend(store, resolved.runId)),
					);
				if (isDurableAuthorExit) {
					return await durableResume(resolved.runId);
				}
				if (isResumableContinuation) {
					await ensureWorkflowResourcesVisible();
					await resumeFailedRunWithConfirmation(
						resolved.runId,
						undefined,
						ctx,
						reporter,
						deps,
						deps.runtimeForContext(ctx),
						resumeOptions,
					);
				} else {
					try {
						const result = await resumeRun(resolved.runId, { ...owner, actor: "user" });
						if (result.ok && !isPaused && result.mode === "snapshot" && run?.exitReason === "quit") {
							return await durableResume(resolved.runId);
						}
						if (result.ok && result.mode === "partial") {
							fail(result.message ?? `Partially resumed ${result.runId}.`);
						} else if (result.ok && result.mode === "not_resumable") {
							fail(result.message ?? `Workflow ${result.runId} is not resumable.`);
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
		} else {
			let backend: DurableWorkflowBackend;
			try {
				try {
					backend = requireStoreDurableBackend(store, target);
				} catch (error) {
					if (!(error instanceof DurableBackendNotInitializedError)) throw error;
					// Fresh CLI sessions have no backend until a durable operation prepares it.
					await ensureWorkflowResourcesVisible();
					await deps.runtimeForContext(ctx).prepareDurableResumable(target);
					backend = requireStoreDurableBackend(store, target);
				}
			} catch (error) {
				fail(`Failed to resolve workflow resume target: ${error instanceof Error ? error.message : String(error)}`);
				return true;
			}
			if (expectedUpdatedAt !== undefined) {
				await backend.hydrateWorkflow(target, { checkHeader: true });
				if (backend.getWorkflow(target)?.updatedAt !== expectedUpdatedAt) {
					fail(staleResumeSelectionMessage(target));
					return true;
				}
			}
			const localResolution = resolveRunId(target, store);
			const localBeforePreparation = isResolvedRunId(localResolution) ? store.run(localResolution.runId) : undefined;
			const exactBeforePreparation = localBeforePreparation?.id === target ? localBeforePreparation : undefined;
			// Only an exact target can be refused before checking the other stored roots for prefix collisions.
			const shadow =
				exactBeforePreparation === undefined
					? "not_shadow"
					: classifyDurableResumeShadow(exactBeforePreparation, store, { ...shadowDeps, backend });
			if (shadow === "ineligible") {
				fail(
					"Workflow " +
						exactBeforePreparation!.id +
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
				!hasPendingDurableResumeTransition(exactBeforePreparation.id, backend);
			if (exactIsActivelyRunning) {
				fail(
					`Workflow ${exactBeforePreparation.id} is already running in this session. Open it with \`/workflows ${exactBeforePreparation.id}\` instead of resuming.`,
				);
				return true;
			}
			if (
				exactBeforePreparation !== undefined &&
				exactBeforePreparation.parentRunId === undefined &&
				exactHasPausedState &&
				shadow === "not_shadow" &&
				(toolControlRegistry.runControl(exactBeforePreparation.id) !== undefined ||
					backend.isWorkflowLoadable(exactBeforePreparation.id))
			) {
				// Exact top-level live state is authoritative. Avoid scanning the
				// potentially large completed catalog while preserving the established
				// top-level target namespace and live-over-durable precedence.
				runId = exactBeforePreparation.id;
			} else {
				const localIsDurableResumeShadow = shadow === "eligible";
				let storedIds: readonly string[] | undefined;
				let durable: readonly ResumableWorkflowEntry[] = [];
				let completed: readonly ResumableWorkflowEntry[] = backend.listCompletedWorkflows();
				let preparationError: string | undefined;
				const needsDurablePreparation =
					localBeforePreparation === undefined ||
					isRunIdPrefix(target) ||
					localIsDurableResumeShadow ||
					!backend.isWorkflowLoadable(localBeforePreparation.id);
				if (needsDurablePreparation) {
					await ensureWorkflowResourcesVisible();
					const runtime = deps.runtimeForContext(ctx);
					try {
						const catalog = isRunIdPrefix(target) ? await runtime.prepareDurableCatalog?.() : undefined;
						storedIds = catalog?.inspectableIds;
						durable = catalog?.resumable ?? (await runtime.prepareDurableResumable(target));
						completed =
							catalog?.completed ??
							(await runtime.prepareCompletedDurable?.()) ??
							backend.listCompletedWorkflows();
					} catch (error) {
						preparationError = error instanceof Error ? error.message : String(error);
					}
				}
				if (preparationError !== undefined && isRunIdPrefix(target)) {
					fail(`Failed to resolve workflow resume target: ${preparationError}`);
					return true;
				}
				const loadableRuns = topLevelWorkflowRuns(store.runs()).filter(
					(run) =>
						backend.isWorkflowLoadable(run.id) &&
						classifyDurableResumeShadow(run, store, { ...shadowDeps, backend }) === "not_shadow",
				);
				await refreshWorkflowArtifactPresence(loadableRuns, store.runs());
				const combined = resolveWorkflowResumeTarget(
					target,
					loadableRuns,
					durable,
					completed,
					store.runs(),
					backend,
					storedIds,
				);
				if (combined.kind === "malformed" || combined.kind === "ambiguous") {
					fail(combined.message);
					return true;
				}
				if (combined.kind === "completed" || combined.kind === "durable") {
					if (combined.kind === "durable" && stageTarget !== undefined && stageTarget.trim().length > 0) {
						fail(stageScopedDurableResumeMessage(combined.workflowId));
						return true;
					}
					return await durableResume(combined.workflowId);
				}
				if (combined.kind === "live") runId = combined.workflowId;
				else {
					if (preparationError !== undefined) {
						fail(`Failed to resolve workflow resume target: ${preparationError}`);
						return true;
					}
					return await durableResume(combined.kind === "stored" ? combined.workflowId : target);
				}
			}
		}
		const resolvedStage = resolveStageTarget(runId, stageTarget, store);
		if (!resolvedStage.ok) {
			fail(resolvedStage.message);
			return true;
		}
		const stageId = resolvedStage.stageId;
		const stageRunId = resolvedStage.runId ?? runId;
		const run = store.run(stageRunId);
		if (run !== undefined) await refreshWorkflowArtifactPresence([run], store.runs());
		const hadPausedRunState = run?.status === "paused";
		const hadPausedStageState = run !== undefined && workflowHasPausedStages(store, stageRunId);
		const isPaused = run !== undefined && workflowHasPausedState(store, stageRunId);
		const isDurableAuthorExit = run?.exited === true && run.status === "failed" && run.resumable === true;
		const isResumableContinuation =
			run !== undefined &&
			!isPaused &&
			run.exitReason !== "quit" &&
			isWorkflowRunResumable(
				workflowRunResumeCandidate(run, store.runs(), requireStoreDurableBackend(store, stageRunId)),
			);
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
			!hasPendingDurableResumeTransition(stageRunId, requireStoreDurableBackend(store, stageRunId))
		) {
			fail(
				`Workflow ${stageRunId} is already running in this session. Open it with \`/workflows ${stageRunId}\` instead of resuming.`,
			);
			return true;
		}
		await injectWorkflowResumeSummary(
			deps.pi,
			ctx,
			stageRunId,
			run,
			undefined,
			requireStoreDurableBackend(store, stageRunId),
		);
		if (isDurableAuthorExit) {
			return await durableResume(stageRunId);
		}
		if (isResumableContinuation) {
			await ensureWorkflowResourcesVisible();
			return await resumeFailedRunWithConfirmation(
				stageRunId,
				stageId,
				ctx,
				reporter,
				deps,
				deps.runtimeForContext(ctx),
				resumeOptions,
			);
		}
		// A quit, non-paused durable run is a resume shadow rather than a live
		// stage-control pause. Routing directly to durable resume preserves the
		// previous snapshot-only diversion without reopening a stale local overlay.
		if (!isPaused && run?.exitReason === "quit" && action === "resume") {
			return await durableResume(stageRunId);
		}
		let result: Awaited<ReturnType<typeof resumeRun>>;
		try {
			if (
				expectedUpdatedAt !== undefined &&
				requireStoreDurableBackend(store, stageRunId).getWorkflow(stageRunId)?.updatedAt !== expectedUpdatedAt
			) {
				fail(staleResumeSelectionMessage(stageRunId));
				return true;
			}
			result = await resumeRun(stageRunId, { ...owner, stageId, message, actor: "user" });
		} catch (error) {
			fail(`Failed to resume run ${stageRunId}: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		if (!result.ok) {
			fail(`Run not found: ${stageRunId}`);
			return true;
		}
		if (result.mode === "not_resumable") {
			fail(result.message ?? `Workflow ${result.runId} is not resumable.`);
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
