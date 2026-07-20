import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  WorkflowRunContext,
  WorkflowSerializableObject,
  WorkflowSerializableValue,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import {
  renderBracketReducerPrompt,
  renderPairwiseJudgePrompt,
  renderTournamentAttemptPrompt,
} from "./tournament-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";

const judgeDecisionSchema = Type.Object({
  winner: Type.Union([Type.Literal("first"), Type.Literal("second")]),
  rationale: Type.String(),
  evidence: Type.Array(Type.String(), { minItems: 1 }),
}, { additionalProperties: false });

type TournamentInputs = {
  readonly prompt: string;
  readonly num_attempts: number;
  readonly max_concurrency: number;
} & Record<string, WorkflowSerializableValue>;

type Entrant = { readonly label: string; readonly path: string };
type MatchRecord = {
  readonly round: number;
  readonly match: number;
  readonly first: string;
  readonly second: string;
  readonly winner: string;
  readonly rationale: string;
  readonly evidence: readonly string[];
  readonly judge_artifact_path: string;
};
type ByeRecord = { readonly round: number; readonly entrant: string };

function serializableObject(
  value: WorkflowSerializableValue | undefined,
): WorkflowSerializableObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return value as WorkflowSerializableObject;
}

function decisionFrom(result: WorkflowTaskResult): {
  readonly winner: "first" | "second";
  readonly rationale: string;
  readonly evidence: readonly string[];
} {
  const value = serializableObject(result.structured);
  if (value === undefined) {
    throw new Error(`tournament: judge ${result.stageName} did not return a structured decision`);
  }
  const winner = value.winner;
  const rationale = value.rationale;
  const evidence = value.evidence;
  if ((winner !== "first" && winner !== "second") || typeof rationale !== "string" ||
      !Array.isArray(evidence) || !evidence.every((item) => typeof item === "string")) {
    throw new Error(`tournament: judge ${result.stageName} returned an invalid decision`);
  }
  return { winner, rationale, evidence };
}

function resultByName(results: readonly WorkflowTaskResult[], name: string): WorkflowTaskResult {
  const result = results.find((candidate) => candidate.stageName === name || candidate.name === name);
  if (result === undefined) throw new Error(`tournament: missing result for ${name}`);
  return result;
}

export async function runTournament(ctx: WorkflowRunContext<TournamentInputs>) {
  const artifactDir = await stableArtifactRoot(ctx, "tournament");
  const attemptsDir = join(artifactDir, "attempts");
  const judgesDir = join(artifactDir, "judges");
  await mkdir(attemptsDir, { recursive: true });
  await mkdir(judgesDir, { recursive: true });

  const attemptArtifactPaths = Array.from({ length: ctx.inputs.num_attempts }, (_, index) =>
    join(attemptsDir, `attempt-${index + 1}.md`));
  await ctx.parallel(
    attemptArtifactPaths.map((path, index) => ({
      name: `attempt-${index + 1}`,
      prompt: renderTournamentAttemptPrompt(ctx.inputs.prompt, index + 1),
      context: "fresh" as const,
      output: path,
      outputMode: "file-only" as const,
    })),
    { concurrency: ctx.inputs.max_concurrency, failFast: true },
  );

  let entrants: Entrant[] = attemptArtifactPaths.map((path, index) => ({
    label: `attempt-${index + 1}`,
    path,
  }));
  const matches: MatchRecord[] = [];
  const byes: ByeRecord[] = [];
  const judgeArtifactPaths: string[] = [];
  let round = 1;

  while (entrants.length > 1) {
    const pairs: Array<readonly [Entrant, Entrant]> = [];
    const bye = entrants.length % 2 === 1 ? entrants.at(-1) : undefined;
    if (bye !== undefined) byes.push({ round, entrant: bye.label });
    for (let index = 0; index + 1 < entrants.length; index += 2) {
      pairs.push([entrants[index]!, entrants[index + 1]!]);
    }
    const judgeSteps = pairs.map(([left, right], index) => {
      const reverse = (round + index) % 2 === 0;
      const first = reverse ? right : left;
      const second = reverse ? left : right;
      const path = join(judgesDir, `round-${round}-match-${index + 1}.json`);
      judgeArtifactPaths.push(path);
      return {
        name: `judge-round-${round}-match-${index + 1}`,
        prompt: renderPairwiseJudgePrompt({
          task: ctx.inputs.prompt,
          firstLabel: first.label,
          secondLabel: second.label,
          firstPath: first.path,
          secondPath: second.path,
        }),
        context: "fresh" as const,
        reads: [first.path, second.path],
        schema: judgeDecisionSchema,
        output: path,
        outputMode: "file-only" as const,
      };
    });
    const judgeResults = await ctx.parallel(judgeSteps, {
      concurrency: Math.min(ctx.inputs.max_concurrency, Math.max(1, judgeSteps.length)),
      failFast: true,
    });
    const next: Entrant[] = [];
    for (let index = 0; index < pairs.length; index += 1) {
      const [left, right] = pairs[index]!;
      const reverse = (round + index) % 2 === 0;
      const first = reverse ? right : left;
      const second = reverse ? left : right;
      const name = `judge-round-${round}-match-${index + 1}`;
      const decision = decisionFrom(resultByName(judgeResults, name));
      const winner = decision.winner === "first" ? first : second;
      next.push(winner);
      matches.push({
        round,
        match: index + 1,
        first: first.label,
        second: second.label,
        winner: winner.label,
        rationale: decision.rationale,
        evidence: decision.evidence,
        judge_artifact_path: judgeArtifactPaths.at(-pairs.length + index)!,
      });
    }
    if (bye !== undefined) next.push(bye);
    entrants = next;
    round += 1;
  }

  const winner = entrants[0]!;
  const bracketPath = join(artifactDir, "bracket.json");
  await writeFile(bracketPath, `${JSON.stringify({ task: ctx.inputs.prompt, matches, byes, winner }, null, 2)}\n`);
  const resultPath = join(artifactDir, "winner.md");
  const reducer = await ctx.task("bracket-reducer", {
    prompt: renderBracketReducerPrompt({
      task: ctx.inputs.prompt,
      bracketPath,
      winnerLabel: winner.label,
      winnerPath: winner.path,
    }),
    context: "fresh",
    reads: [bracketPath, winner.path, ...judgeArtifactPaths],
    output: resultPath,
  });

  return {
    result: reducer.text,
    winner: winner.label,
    winner_artifact_path: winner.path,
    result_path: resultPath,
    attempt_artifact_paths: attemptArtifactPaths,
    judge_artifact_paths: judgeArtifactPaths,
    bracket_path: bracketPath,
    artifact_dir: artifactDir,
  };
}
