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

export async function writeReviewArtifact(
  artifactDir: string,
  turn: number,
  reviewer: string,
  decision: ReviewDecision,
  rawText: string,
): Promise<string> {
  const artifactPath = join(
    artifactDir,
    `review-turn-${turn}-${artifactSafeName(reviewer)}.json`,
  );
  await writeFile(
    artifactPath,
    `${JSON.stringify({ turn, reviewer, decision, raw_text: rawText }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return artifactPath;
}

export async function writeReviewRoundArtifact(
  artifactDir: string,
  turn: number,
  reviews: readonly ReviewRecord[],
): Promise<string> {
  const artifactPath = join(artifactDir, `review-round-${turn}.json`);
  await writeFile(artifactPath, `${JSON.stringify({ turn, reviews }, null, 2)}\n`, {
    encoding: "utf8",
  });
  return artifactPath;
}

