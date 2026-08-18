/**
 * Shared verification rubric primitive.
 *
 * Doors: `parse_rubric`, `normalize_criteria`, `select_criteria`,
 * `decide_verification`. A CriterionScore can only exist as a schema-valid
 * structured report — an unparseable verifier output is unrepresentable as a
 * vote, so it cannot shift the mean.
 */
import { Type, type TSchema } from "typebox";

export interface Criterion {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface Criteria {
  readonly groundTruthNote: string;
  readonly criteria: readonly Criterion[];
}

export interface CriterionInput {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}

export interface Finding {
  readonly finding: string;
  readonly severity: "veto" | "blocking" | "note";
}

export interface CriterionScore {
  readonly criterionId: string;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly findings: readonly Finding[];
}

export type RubricErrorCode = "NoCriteria" | "EmptyCriterion";

export class RubricError extends Error {
  readonly code: RubricErrorCode;

  constructor(message: string, code: RubricErrorCode) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class NoCriteria extends RubricError {
  constructor(message = "no criteria found — check the `## Criteria` section and its `### Name {#id}` headings") {
    super(message, "NoCriteria");
    this.name = "NoCriteria";
  }
}

export class EmptyCriterion extends RubricError {
  readonly ids: readonly string[];

  constructor(ids: readonly string[]) {
    super(`criteria have empty instructions: ${ids.join(", ")}`, "EmptyCriterion");
    this.name = "EmptyCriterion";
    this.ids = ids;
  }
}

const CRITERION_ID_ANCHOR = /^(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*$/;
const HTML_COMMENT = /<!--.*?-->/gs;
const SLUG_MAX_LENGTH = 40;

function slug_id(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/_+$/g, "") || "criterion";
}

function dedup_id(cid: string, seen: Set<string>): string {
  let out = cid;
  let n = 1;
  while (seen.has(out)) {
    n += 1;
    out = `${cid}_${n}`;
  }
  seen.add(out);
  return out;
}

function criterion(id: string, name: string, description: string): Criterion {
  return { id, name, description };
}

/**
 * Parse a `criteria.md` document into normalized criteria.
 *
 * `# title` is ignored. `## Ground Truth Note` is optional; the first section
 * wins. `## Criteria` owns `### Name {#id}` headings. HTML comments are stripped
 * before parse. Ids slug to lowercase alnum/underscore, ≤40 chars, fallback
 * `"criterion"`, with encounter-order `_2` / `_3` dedup.
 *
 * @throws {NoCriteria} when the Criteria section yields no headings
 * @throws {EmptyCriterion} when any criterion has an empty body
 */
export function parse_rubric(markdown: string): Criteria {
  const lines = markdown.replace(HTML_COMMENT, "").split(/\r?\n/);

  let groundTruthNote = "";
  let seenGroundTruth = false;
  const criteria: Criterion[] = [];
  const seen = new Set<string>();

  let section: "ground_truth" | "criteria" | null = null;
  let currentName: string | null = null;
  let currentId: string | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    const text = buf.join("\n").trim();
    buf = [];
    if (section === "ground_truth") {
      if (!seenGroundTruth) {
        groundTruthNote = text;
        seenGroundTruth = true;
      }
      return;
    }
    if (currentName === null || currentId === null) return;
    criteria.push(criterion(currentId, currentName, text));
    currentName = null;
    currentId = null;
  };

  for (const line of lines) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      flush();
      const heading = line.slice(3).trim().toLowerCase();
      if (heading.includes("ground truth")) {
        section = "ground_truth";
      } else if (heading.includes("criteri")) {
        section = "criteria";
      } else {
        section = null;
      }
      continue;
    }
    if (line.startsWith("### ") && section === "criteria") {
      flush();
      const heading = line.slice(4).trim();
      const anchored = CRITERION_ID_ANCHOR.exec(heading);
      const name = anchored ? anchored[1]!.trim() : heading;
      const rawId = anchored ? anchored[2]!.trim() : slug_id(heading);
      currentName = name;
      currentId = dedup_id(rawId, seen);
      continue;
    }
    if (line.startsWith("# ")) {
      continue;
    }
    buf.push(line);
  }
  flush();

  if (criteria.length === 0) {
    throw new NoCriteria();
  }
  const empty = criteria.filter((item) => item.description.length === 0).map((item) => item.id);
  if (empty.length > 0) {
    throw new EmptyCriterion(empty);
  }
  return { groundTruthNote, criteria };
}

export const VERIFICATION_SCALE: {
  readonly min: 1;
  readonly max: 20;
  readonly anchors: string;
  readonly schema: TSchema;
} = {
  min: 1,
  max: 20,
  anchors: "1 = certainly fails … 10 = borderline … 20 = verified correct",
  schema: Type.Integer({ minimum: 1, maximum: 20 }),
};
