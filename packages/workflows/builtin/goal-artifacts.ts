import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewDecision, ReviewRecord } from "./goal-types.js";

export function artifactSafeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "artifact";
}

function withoutTurn<T extends { readonly turn: number }>(value: T): Omit<T, "turn"> {
  const copy = { ...value } as Omit<T, "turn"> & { turn?: number };
  delete copy.turn;
  return copy;
}

export async function writeReviewArtifact(
  artifactDir: string,
  reviewer: string,
  decision: ReviewDecision,
  rawText: string,
): Promise<string> {
  const artifactPath = join(
    artifactDir,
    `review-${artifactSafeName(reviewer)}.json`,
  );
  await writeFile(
    artifactPath,
    `${JSON.stringify({ reviewer, decision, raw_text: rawText }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return artifactPath;
}

export async function writeReviewRoundArtifact(
  artifactDir: string,
  reviews: readonly ReviewRecord[],
): Promise<string> {
  const artifactPath = join(artifactDir, "review-round-latest.json");
  const visibleReviews = reviews.map(withoutTurn);
  await writeFile(artifactPath, `${JSON.stringify({ reviews: visibleReviews }, null, 2)}\n`, {
    encoding: "utf8",
  });
  return artifactPath;
}

