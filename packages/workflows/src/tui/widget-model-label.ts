/**
 * Model-segment formatting for the BACKGROUND workflow widget.
 *
 * Mirrors the main-session footer's `<model> <thinking> [fast]` identity for a
 * run's active stage, and collapses concurrently-running parallel stages that
 * use differing models into a deduped, provider-stripped, capped list so a
 * fan-out run stays legible on a single widget row.
 *
 * cross-ref: src/tui/widget.ts `metaLine`, and the main-session footer
 *   (packages/coding-agent/src/modes/interactive/components/footer.ts).
 */

import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { codexFastModeLabel } from "./codex-fast-label.js";

/** Max distinct parallel-stage models listed before collapsing to `+N`. */
const MAX_WIDGET_PARALLEL_MODELS = 2;

/** Bare model name with any `provider/` prefix stripped. */
function shortModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * The stage whose model best answers "which model is running right now".
 * Prefer an actively running stage; otherwise fall back to the most recent
 * stage that recorded an effective model (covers a chain paused between
 * stages, and single-stage direct tasks).
 */
function activeModelStage(run: RunSnapshot): StageSnapshot | undefined {
  const running = run.stages.find((s) => s.status === "running" && s.model);
  if (running) return running;
  for (let i = run.stages.length - 1; i >= 0; i--) {
    if (run.stages[i]!.model) return run.stages[i];
  }
  return undefined;
}

/**
 * Distinct models across the run's concurrently-running stages, deduped,
 * provider-stripped, and capped with `+N`. Returns undefined when fewer than
 * two distinct models are active so the caller renders the single-model form
 * (which keeps the provider prefix, thinking level, and fast marker).
 */
function parallelModelsLabel(run: RunSnapshot): string | undefined {
  const distinct: string[] = [];
  for (const stage of run.stages) {
    if (stage.status !== "running" || !stage.model) continue;
    const short = shortModelName(stage.model);
    if (!distinct.includes(short)) distinct.push(short);
  }
  if (distinct.length <= 1) return undefined;
  if (distinct.length <= MAX_WIDGET_PARALLEL_MODELS) return distinct.join(", ");
  const shown = distinct.slice(0, MAX_WIDGET_PARALLEL_MODELS).join(", ");
  return `${shown} +${distinct.length - MAX_WIDGET_PARALLEL_MODELS}`;
}

/**
 * `<model> <thinking> [fast]` for the active stage, mirroring the main-session
 * footer (thinking omitted when off/absent; `fast` appended via the shared
 * Codex fast-mode label helper). Undefined when no stage has recorded a model.
 */
function singleModelLabel(run: RunSnapshot): string | undefined {
  const stage = activeModelStage(run);
  const model = stage?.model;
  if (!model) return undefined;
  const level = stage.thinkingLevel;
  const base = level && level !== "off" ? `${model} ${level}` : model;
  return codexFastModeLabel(base, stage.fastMode === true);
}

/**
 * The model segment for a run: a deduped list when multiple distinct models
 * run in parallel, otherwise the single active model with thinking + fast.
 */
export function runModelLabel(run: RunSnapshot): string | undefined {
  return parallelModelsLabel(run) ?? singleModelLabel(run);
}
