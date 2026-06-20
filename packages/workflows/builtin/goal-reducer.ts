import type { BlockerObservation, GoalLedger, ReducerOutcome, ReviewRecord } from "./goal-types.js";

export function normalizeBlocker(blocker: string): string {
  return blocker.toLowerCase().replace(/\s+/g, " ").trim();
}

export function blockerCandidate(
  turn: number,
  decisions: readonly ReviewRecord[],
): BlockerObservation | undefined {
  const counts = new Map<string, { blocker: string; reviewers: string[] }>();
  for (const decision of decisions) {
    if (decision.decision !== "blocked" || !decision.blocker?.trim()) {
      continue;
    }
    const key = normalizeBlocker(decision.blocker);
    const existing = counts.get(key) ?? { blocker: decision.blocker.trim(), reviewers: [] };
    existing.reviewers.push(decision.reviewer);
    counts.set(key, existing);
  }

  let selected: { blocker: string; reviewers: string[] } | undefined;
  for (const entry of counts.values()) {
    if (selected === undefined || entry.reviewers.length > selected.reviewers.length) {
      selected = entry;
    }
  }

  return selected === undefined
    ? undefined
    : { turn, blocker: selected.blocker, reviewers: selected.reviewers };
}

export function consecutiveBlockerTurns(
  blockers: readonly BlockerObservation[],
  blocker: string,
  currentTurn: number,
): number {
  const normalized = normalizeBlocker(blocker);
  let expectedTurn = currentTurn;
  let count = 0;

  for (const observation of [...blockers].reverse()) {
    if (observation.turn > expectedTurn) continue;
    if (observation.turn < expectedTurn) break;
    if (normalizeBlocker(observation.blocker) !== normalized) break;
    count += 1;
    expectedTurn -= 1;
  }

  return count;
}

export function collectRemainingWork(reviews: readonly ReviewRecord[]): string {
  const gaps = reviews.flatMap((review) => review.gaps);
  const blockers = reviews
    .map((review) => review.blocker)
    .filter((blocker): blocker is string => typeof blocker === "string" && blocker.trim().length > 0);
  const items = [...gaps, ...blockers];
  return items.length > 0 ? items.join("; ") : "Reviewer quorum did not prove completion.";
}

export function reduceGoalDecision(
  ledger: GoalLedger,
  turnReviews: readonly ReviewRecord[],
  options: {
    readonly turn: number;
    readonly maxTurns: number;
    readonly reviewQuorum: number;
    readonly blockerThreshold: number;
  },
): ReducerOutcome {
  const completeVotes = turnReviews.filter(
    (review) => review.decision === "complete",
  ).length;

  if (completeVotes >= options.reviewQuorum) {
    return {
      status: "complete",
      decision: {
        turn: options.turn,
        decision: "complete",
        reason: `Reviewer quorum met: ${completeVotes}/${options.reviewQuorum} reviewers marked complete.`,
        complete_votes: completeVotes,
        review_quorum: options.reviewQuorum,
      },
    };
  }

  const observation = blockerCandidate(options.turn, turnReviews);
  const blockerCount = observation === undefined
    ? 0
    : consecutiveBlockerTurns(
        [...ledger.blockers, observation],
        observation.blocker,
        options.turn,
      );

  if (observation !== undefined && blockerCount >= options.blockerThreshold) {
    return {
      status: "blocked",
      blockerObservation: observation,
      decision: {
        turn: options.turn,
        decision: "blocked",
        reason: `Same blocker repeated for ${blockerCount}/${options.blockerThreshold} consecutive turns.`,
        complete_votes: completeVotes,
        review_quorum: options.reviewQuorum,
        blocker: observation.blocker,
      },
    };
  }

  if (options.turn >= options.maxTurns) {
    return {
      status: "needs_human",
      blockerObservation: observation,
      decision: {
        turn: options.turn,
        decision: "needs_human",
        reason: `Maximum worker turns reached without reviewer quorum. Remaining work: ${collectRemainingWork(turnReviews)}`,
        complete_votes: completeVotes,
        review_quorum: options.reviewQuorum,
        ...(observation ? { blocker: observation.blocker } : {}),
      },
    };
  }

  return {
    status: "active",
    blockerObservation: observation,
    decision: {
      turn: options.turn,
      decision: "continue",
      reason: `Reviewer quorum not met. Remaining work: ${collectRemainingWork(turnReviews)}`,
      complete_votes: completeVotes,
      review_quorum: options.reviewQuorum,
      ...(observation ? { blocker: observation.blocker } : {}),
    },
  };
}
