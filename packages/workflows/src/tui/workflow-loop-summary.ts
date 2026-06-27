import type { RunStatus, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowInputValues, WorkflowOutputValues, WorkflowSerializableValue } from "../shared/types.js";
import { ELLIPSIS } from "./chat-surface.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

const DEFAULT_WIDTH = 120;
const LOOP_INPUT_RE = /^max_(loops?|turns?|iterations?|rounds?|refinements?)$/i;
const COUNTED_SUFFIX_RE = /^(.*?)-(\d+)$/;
const LETTER_SUFFIX_RE = /^(reviewer|review|locator|pattern|analyzer|online|design-system|system|worker)-[a-z]$/i;
const BUILTIN_COUNTED_BASES = new Set([
  "research-prompt-refinement", "prompt-refine", "research", "orchestrator",
  "work-turn", "completion-reviewer", "evidence-reviewer", "risk-reviewer",
  "generate", "user-feedback", "locator", "pattern-finder", "pattern",
  "analyzer", "online-researcher", "online",
]);
const BUILTIN_LOOP_DEFAULTS: Record<string, Record<string, number>> = {
  ralph: { max_loops: 10 },
  goal: { max_turns: 10 },
  "open-claude-design": { max_refinements: 3 },
};

export interface WorkflowLoopSource {
  readonly name: string;
  readonly status: RunStatus;
  readonly inputs: Readonly<WorkflowInputValues>;
  readonly stages: readonly StageSnapshot[];
  readonly result?: WorkflowOutputValues;
  readonly endedAt?: number;
}

export interface WorkflowLoopSummary {
  readonly phases: readonly string[];
  readonly oneLine: string;
  readonly detailLines: readonly string[];
}

interface LoopHint {
  readonly maxKey: string;
  readonly max: number;
  readonly completed: number;
  readonly remaining: number;
  readonly noun: string;
}

interface PhaseGroup {
  readonly label: string;
  readonly count: number;
  readonly parallel: boolean;
}

export function shouldRenderWorkflowLoopSummary(source: WorkflowLoopSource): boolean {
  if (source.endedAt !== undefined) return false;
  if (source.stages.length > 1) return true;
  if (loopHint(source) !== undefined) return true;
  return fallbackPhases(source).length > 0;
}

export function buildWorkflowLoopSummary(
  source: WorkflowLoopSource,
  opts: { width?: number; includePrefix?: boolean } = {},
): WorkflowLoopSummary {
  const width = Math.max(0, opts.width ?? DEFAULT_WIDTH);
  const includePrefix = opts.includePrefix ?? true;
  const groups = phaseGroups(source);
  const specialPhases = builtinPhases(source);
  const phases = specialPhases ?? (groups.length > 0 ? groups.map(formatPhaseGroup) : fallbackPhases(source));
  const hint = loopHint(source);
  const conditional = conditionalHint(source);

  const raw = composeLoopText(source, phases, hint, conditional);
  const oneLine = fitLoopLine(raw, width, {
    includePrefix,
    phaseCount: phases.length,
    first: phases[0],
    last: phases.at(-1),
    hint,
    conditional,
    sourceName: source.name,
    phases,
  });

  return {
    phases,
    oneLine,
    detailLines: detailLines(phases, groups, hint, conditional, source),
  };
}

function fitLoopSummaryText(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), ELLIPSIS);
}

function phaseGroups(source: WorkflowLoopSource): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  const countedBases = repeatedCountedBases(source.stages);
  let i = 0;
  while (i < source.stages.length) {
    const stage = source.stages[i]!;
    const parentKey = parentSignature(stage);
    const siblings: StageSnapshot[] = [stage];
    let j = i + 1;
    while (j < source.stages.length) {
      const next = source.stages[j]!;
      if (parentSignature(next) !== parentKey) break;
      const previous = source.stages[j - 1]!;
      const nextBase = normalizeStageName(next.name, countedBases);
      const previousBase = normalizeStageName(previous.name, countedBases);
      if (nextBase !== previousBase && !looksParallelSibling(stage, next)) break;
      siblings.push(next);
      j++;
    }
    groups.push(groupSiblings(siblings, countedBases));
    i = j;
  }
  return coalesceSequentialRepeats(groups);
}

function repeatedCountedBases(stages: readonly StageSnapshot[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const stage of stages) {
    const match = COUNTED_SUFFIX_RE.exec(stage.name.toLowerCase());
    if (!match) continue;
    const base = displayStageBase(match[1] ?? "");
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([base]) => base));
}

function groupSiblings(stages: readonly StageSnapshot[], countedBases: ReadonlySet<string>): PhaseGroup {
  const labels = stages.map((stage) => normalizeStageName(stage.name, countedBases));
  const unique = [...new Set(labels)];
  const parallel = stages.length > 1 && sameParents(stages);
  if (unique.length === 1) {
    return { label: unique[0]!, count: stages.length, parallel };
  }
  const families = compactFamilies(unique);
  return { label: families.join("/"), count: partitionLikeCount(stages) ?? stages.length, parallel };
}

function partitionLikeCount(stages: readonly StageSnapshot[]): number | undefined {
  const suffixes = new Set<number>();
  for (const stage of stages) {
    const match = COUNTED_SUFFIX_RE.exec(stage.name.toLowerCase());
    if (!match) return undefined;
    const parsed = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(parsed)) return undefined;
    suffixes.add(parsed);
  }
  return suffixes.size > 0 ? suffixes.size : undefined;
}

function coalesceSequentialRepeats(groups: readonly PhaseGroup[]): PhaseGroup[] {
  const out: PhaseGroup[] = [];
  for (const group of groups) {
    const previous = out.at(-1);
    if (previous && previous.label === group.label && !previous.parallel && !group.parallel) {
      out[out.length - 1] = { label: group.label, count: previous.count + group.count, parallel: false };
    } else {
      out.push(group);
    }
  }
  return out;
}

function compactFamilies(labels: readonly string[]): string[] {
  const roots = labels.map((label) => label.replace(/-(locator|pattern|analyzer|online)$/i, ""));
  return [...new Set(roots)];
}

function looksParallelSibling(first: StageSnapshot, next: StageSnapshot): boolean {
  return sameParents([first, next]);
}

function sameParents(stages: readonly StageSnapshot[]): boolean {
  if (stages.length < 2) return false;
  const first = parentSignature(stages[0]!);
  return stages.every((stage) => parentSignature(stage) === first);
}

function parentSignature(stage: StageSnapshot): string {
  return [...stage.parentIds].sort().join("|");
}

function normalizeStageName(name: string, countedBases: ReadonlySet<string> = new Set()): string {
  const lower = name.trim().toLowerCase();
  const counted = COUNTED_SUFFIX_RE.exec(lower);
  if (counted) {
    const base = displayStageBase(counted[1] ?? lower);
    if (countedBases.has(base) || BUILTIN_COUNTED_BASES.has(base)) return base;
  }
  const lettered = LETTER_SUFFIX_RE.exec(lower);
  if (lettered) return displayStageBase(lettered[1] ?? lower);
  return displayStageBase(lower);
}

function displayStageBase(base: string): string {
  if (base === "prompt-refinement" || base === "research-prompt-refinement") return "prompt-refine";
  if (base === "reviewer" || base.endsWith("-reviewer")) return "review";
  if (base === "history-locator") return "history";
  if (base === "codebase-scout") return "scout";
  if (base === "pattern-finder") return "pattern";
  if (base === "online-researcher") return "online";
  return base;
}

function formatPhaseGroup(group: PhaseGroup): string {
  if (group.count <= 1) return group.label;
  if (group.parallel) return `${group.label} ×${group.count}`;
  return `${group.label} ×${group.count} repeats`;
}

function builtinPhases(source: WorkflowLoopSource): string[] | undefined {
  if (source.name === "ralph" || source.name === "goal") return fallbackPhases(source);
  if (source.name === "deep-research-codebase") return deepResearchPhases(source);
  if (source.name === "open-claude-design") return fallbackPhases(source);
  return undefined;
}

function deepResearchPhases(source: WorkflowLoopSource): string[] {
  const partitionCount = maxSuffixForBases(source.stages, new Set(["locator", "pattern", "analyzer", "online"]));
  if (partitionCount === 0) return fallbackPhases(source);
  const phases = ["scout + history", "partition", `locator/pattern ×${partitionCount}`, `analyzer/online ×${partitionCount}`];
  phases.push("aggregator");
  return phases;
}

function fallbackPhases(source: WorkflowLoopSource): string[] {
  switch (source.name) {
    case "ralph":
      return ["prompt-refine", "research", "orchestrator", "review ×3"];
    case "goal":
      return ["work-turn", "review ×3"];
    case "deep-research-codebase":
      return ["scout + history-locator", "history-analyzer", "partition", "specialist waves", "aggregator"];
    case "open-claude-design":
      return referencesDisabled(source.inputs)
        ? ["discovery", "design-system ×3", "generate/feedback", "export"]
        : ["discovery", "design-system ×3", "references", "generate/feedback", "export"];
    default:
      return [];
  }
}

function referencesDisabled(inputs: Readonly<WorkflowInputValues>): boolean {
  return inputs.discover_references === false || inputs.references === false || inputs.reference === false || inputs.include_references === false;
}

function loopHint(source: WorkflowLoopSource): LoopHint | undefined {
  const candidate = loopInputCandidates(source.inputs)[0];
  if (!candidate) return undefined;
  const max = loopInputMax(source, candidate);
  const completed = completedLoopCount(source, candidate.key);
  return {
    maxKey: candidate.key,
    max,
    completed,
    remaining: Math.max(0, max - completed),
    noun: loopNoun(candidate.key),
  };
}

interface LoopInputCandidate {
  readonly key: string;
  readonly value: number;
}

function loopInputCandidates(inputs: Readonly<WorkflowInputValues>): LoopInputCandidate[] {
  return Object.entries(inputs)
    .flatMap(([key, value]) => {
      if (!LOOP_INPUT_RE.test(key) || typeof value !== "number" || !Number.isFinite(value)) return [];
      return [{ key, value }];
    })
    .sort((left, right) => {
      const priorityDelta = loopInputPriority(left.key) - loopInputPriority(right.key);
      return priorityDelta !== 0 ? priorityDelta : left.key.localeCompare(right.key);
    });
}

function loopInputPriority(key: string): number {
  const normalized = key.toLowerCase();
  if (/^max_turns?$/.test(normalized)) return 0;
  if (/^max_refinements?$/.test(normalized)) return 1;
  if (/^max_loops?$/.test(normalized)) return 2;
  if (/^max_iterations?$/.test(normalized)) return 3;
  if (/^max_rounds?$/.test(normalized)) return 4;
  return 5;
}

function completedLoopCount(source: WorkflowLoopSource, maxKey: string): number {
  const resultKey = resultCountKey(maxKey);
  const fromResult = readNumber(source.result?.[resultKey]);
  if (fromResult !== undefined) return fromResult;
  const preferredBases = preferredLoopStageBases(source, maxKey);
  if (preferredBases === undefined) return genericSequentialLoopCount(source.stages);
  return maxSuffixForBases(source.stages, preferredBases);
}

function loopInputMax(source: WorkflowLoopSource, candidate: LoopInputCandidate): number {
  if (candidate.value > 0) return Math.floor(candidate.value);
  return BUILTIN_LOOP_DEFAULTS[source.name]?.[candidate.key] ?? Math.max(0, Math.floor(candidate.value));
}

function genericSequentialLoopCount(stages: readonly StageSnapshot[]): number {
  const parsed = stages.flatMap((stage) => {
    const match = COUNTED_SUFFIX_RE.exec(stage.name.toLowerCase());
    if (!match) return [];
    const suffix = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(suffix)) return [];
    return [{ stage, base: displayStageBase(match[1] ?? ""), suffix }];
  });
  const fanoutParentKeys = new Set<string>();
  const countsByParent = new Map<string, number>();
  for (const item of parsed) {
    const key = parentSignature(item.stage);
    countsByParent.set(key, (countsByParent.get(key) ?? 0) + 1);
  }
  for (const [key, count] of countsByParent) {
    if (count > 1) fanoutParentKeys.add(key);
  }
  const suffixesByBase = new Map<string, Set<number>>();
  for (const item of parsed) {
    if (fanoutParentKeys.has(parentSignature(item.stage))) continue;
    const suffixes = suffixesByBase.get(item.base) ?? new Set<number>();
    suffixes.add(item.suffix);
    suffixesByBase.set(item.base, suffixes);
  }
  let max = 0;
  for (const suffixes of suffixesByBase.values()) {
    if (!suffixes.has(1) && suffixes.size < 2) continue;
    max = Math.max(max, ...suffixes);
  }
  return max;
}

function maxSuffixForBases(stages: readonly StageSnapshot[], preferredBases: ReadonlySet<string> | undefined): number {
  let maxSuffix = 0;
  for (const stage of stages) {
    const match = COUNTED_SUFFIX_RE.exec(stage.name.toLowerCase());
    if (!match) continue;
    const base = displayStageBase(match[1] ?? "");
    if (preferredBases !== undefined && !preferredBases.has(base)) continue;
    const parsed = Number.parseInt(match[2] ?? "0", 10);
    if (Number.isFinite(parsed)) maxSuffix = Math.max(maxSuffix, parsed);
  }
  return maxSuffix;
}

function readNumber(value: WorkflowSerializableValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function resultCountKey(maxKey: string): string {
  const stem = maxKey.replace(/^max_/, "");
  if (stem === "loops") return "iterations_completed";
  if (stem === "turns") return "turns_completed";
  if (stem === "refinements") return "refinements_completed";
  return `${stem}_completed`;
}

function preferredLoopStageBases(source: WorkflowLoopSource, maxKey: string): ReadonlySet<string> | undefined {
  if (maxKey === "max_turns") return new Set(["work-turn"]);
  if (maxKey === "max_refinements") return new Set(["generate", "user-feedback"]);
  if (maxKey === "max_loops" && source.name === "ralph") return new Set(["orchestrator"]);
  return undefined;
}

function loopNoun(maxKey: string): string {
  if (maxKey.includes("turn")) return "turns";
  if (maxKey.includes("refinement")) return "refinements";
  if (maxKey.includes("iteration")) return "iterations";
  return "rounds";
}

function conditionalHint(source: WorkflowLoopSource): string | undefined {
  if (source.inputs.create_pr !== true) return undefined;
  if (source.name === "ralph") return "PR if approved";
  if (source.name === "goal") return "PR if complete";
  return undefined;
}

function loopHintLine(hint: LoopHint, suffix: "remain" | "may remain"): string {
  return `↻ ${hint.remaining} ${hint.noun} ${suffix}`;
}

function composeLoopText(
  source: WorkflowLoopSource,
  phases: readonly string[],
  hint: LoopHint | undefined,
  conditional: string | undefined,
): string {
  if (phases.length === 0) return "waiting for stages";
  const hintText = hint ? loopHintLine(hint, source.endedAt !== undefined ? "may remain" : "remain") : undefined;
  if (source.name === "open-claude-design" && hintText) {
    const generateIndex = phases.indexOf("generate/feedback");
    if (generateIndex >= 0) {
      const before = phases.slice(0, generateIndex + 1).join(" → ");
      const after = phases.slice(generateIndex + 1).join(" → ");
      const base = after.length > 0 ? `${before} · ${hintText} → ${after}` : `${before} · ${hintText}`;
      return conditional ? `${base} · ${conditional}` : base;
    }
  }
  const tailParts = [hintText, conditional].filter((part): part is string => part !== undefined);
  const base = phases.join(" → ");
  return tailParts.length > 0 ? `${base} · ${tailParts.join(" · ")}` : base;
}

function detailLines(
  phases: readonly string[],
  groups: readonly PhaseGroup[],
  hint: LoopHint | undefined,
  conditional: string | undefined,
  source: WorkflowLoopSource,
): string[] {
  const lines: string[] = [];
  const parallelPhases = new Set(
    groups.filter((group) => group.parallel).map(formatPhaseGroup),
  );
  const detailPhases = phases.map((phase) =>
    parallelPhases.has(phase) ? `${phase} parallel` : phase,
  );
  lines.push(detailPhases.length > 0 ? detailPhases.join(" → ") : "waiting for stages");
  if (groups.some((group) => group.parallel)) lines.push("parallel phases are grouped by shared parents/name patterns");
  if (hint) {
    lines.push(source.endedAt === undefined ? `repeats until workflow exits or ${hint.maxKey} is reached` : `bounded by ${hint.maxKey}`);
    lines.push(loopHintLine(hint, "may remain"));
  }
  if (conditional) lines.push(`pull-request conditional: ${conditional}`);
  return lines;
}

function fitLoopLine(
  raw: string,
  width: number,
  context: {
    includePrefix: boolean;
    phaseCount: number;
    first?: string;
    last?: string;
    hint?: LoopHint;
    conditional?: string;
    sourceName: string;
    phases: readonly string[];
  },
): string {
  const prefix = context.includePrefix ? "Loop: " : "";
  const full = `${prefix}${raw}`;
  if (visibleWidth(full) <= width) return full;

  const shortHint = context.hint ? `↻ ${context.hint.remaining} left` : undefined;
  const tails = [shortHint, context.conditional].filter((part): part is string => part !== undefined);
  if (context.sourceName === "open-claude-design" && shortHint && context.phases.includes("generate/feedback") && context.phases.at(-1) === "export") {
    const special = `${prefix}${context.first ?? "discovery"} → … → generate/feedback · ${shortHint} → export${context.conditional ? ` · ${context.conditional}` : ""}`;
    if (visibleWidth(special) <= width) return special;
    const shorter = `${prefix}generate/feedback · ${shortHint} → export${context.conditional ? ` · ${context.conditional}` : ""}`;
    if (visibleWidth(shorter) <= width) return shorter;
  }
  if (context.first && context.last && context.phaseCount > 2) {
    const compressed = `${prefix}${context.first} → … → ${context.last}${tails.length > 0 ? ` · ${tails.join(" · ")}` : ""}`;
    if (visibleWidth(compressed) <= width) return compressed;
  }

  if (context.phaseCount === 0) {
    const empty = `${prefix}waiting for stages`;
    return fitLoopSummaryText(empty, width);
  }

  const counted = `${prefix}${phaseCountLabel(context.phaseCount)}${tails.length > 0 ? ` · ${tails.join(" · ")}` : ""}`;
  if (visibleWidth(counted) <= width) return counted;
  return fitLoopSummaryText(counted, width);
}

function phaseCountLabel(count: number): string {
  return `${count} ${count === 1 ? "phase" : "phases"}`;
}
