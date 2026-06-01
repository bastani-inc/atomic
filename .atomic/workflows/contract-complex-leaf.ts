import { defineWorkflow } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";

const VARIANTS = ["alpha", "beta", "gamma"] as const;
type Variant = (typeof VARIANTS)[number];

interface ComplexMetricSet extends WorkflowSerializableObject {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly buckets: readonly number[];
  readonly notes: readonly (string | null)[];
}

interface ComplexNode extends WorkflowSerializableObject {
  readonly id: string;
  readonly label: string;
  readonly path: readonly string[];
  readonly variant: Variant;
  readonly weight: number;
  readonly active: boolean;
  readonly flags: readonly boolean[];
  readonly annotations: readonly (string | null)[];
  readonly metrics: ComplexMetricSet;
  readonly children: readonly ComplexNode[];
}

interface ComplexRecord extends WorkflowSerializableObject {
  readonly id: string;
  readonly index: number;
  readonly tuple: readonly [string, number, boolean, null];
  readonly attributes: ComplexMetricSet;
}

interface ComplexPacket extends WorkflowSerializableObject {
  readonly schemaVersion: number;
  readonly topic: string;
  readonly variant: Variant;
  readonly generatedBy: string;
  readonly tree: ComplexNode;
  readonly records: readonly ComplexRecord[];
  readonly matrix: readonly (readonly number[])[];
  readonly nullable: null;
  readonly tags: readonly string[];
}

function clampDepth(value: number): number {
  return Math.max(0, Math.min(3, Math.floor(value)));
}

function metricSet(seed: number): ComplexMetricSet {
  return {
    min: seed,
    max: seed + 10,
    mean: seed + 5,
    buckets: [seed, seed + 1, seed + 3, seed + 6],
    notes: ["serializable", null, `seed:${seed}`],
  };
}

function nodeId(path: readonly string[]): string {
  return path.length === 0 ? "root" : path.join(".");
}

function buildNode(topic: string, variant: Variant, depth: number, path: readonly string[]): ComplexNode {
  const id = nodeId(path);
  const seed = topic.length + path.length + id.length;
  const children = depth <= 0
    ? []
    : [
        buildNode(topic, variant, depth - 1, [...path, "left"]),
        buildNode(topic, variant, depth - 1, [...path, "right"]),
      ];

  return {
    id,
    label: `${topic}:${id}`,
    path,
    variant,
    weight: seed * (variant === "gamma" ? 3 : variant === "beta" ? 2 : 1),
    active: path.length % 2 === 0,
    flags: [path.length % 2 === 0, variant !== "alpha", depth > 0],
    annotations: [`depth:${depth}`, null, `children:${children.length}`],
    metrics: metricSet(seed),
    children,
  };
}

function buildRecords(topic: string, variant: Variant, count: number): readonly ComplexRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${variant}-${index + 1}`;
    return {
      id,
      index,
      tuple: [id, topic.length + index, index % 2 === 0, null],
      attributes: metricSet(topic.length + index),
    };
  });
}

function buildMatrix(size: number): readonly (readonly number[])[] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row + 1) * (column + 1)),
  );
}

export default defineWorkflow("contract-complex-leaf")
  .description("Leaf workflow for complex nested-import validation. Returns a deeply nested JSON-serializable object graph.")
  .input("topic", {
    type: "text",
    required: true,
    description: "Topic used to generate the complex packet.",
  })
  .input("depth", {
    type: "number",
    default: 2,
    description: "Tree depth for the complex packet. Clamped to 0..3.",
  })
  .input("variant", {
    type: "select",
    choices: VARIANTS,
    default: "alpha",
    description: "Variant used in nested records and tree nodes.",
  })
  .output("result", {
    type: "text",
    required: true,
    description: "Leaf summary string.",
  })
  .output("packet", {
    type: "object",
    required: true,
    description: "Deeply nested JSON-serializable packet.",
  })
  .output("records", {
    type: "array",
    required: true,
    description: "Array of complex serializable records.",
  })
  .output("score", {
    type: "number",
    required: true,
    description: "Finite numeric score derived from the complex packet.",
  })
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const depth = clampDepth(ctx.inputs.depth);
    const variant = ctx.inputs.variant;
    const records = buildRecords(topic, variant, depth + 2);
    const packet: ComplexPacket = {
      schemaVersion: 1,
      topic,
      variant,
      generatedBy: "contract-complex-leaf",
      tree: buildNode(topic, variant, depth, []),
      records,
      matrix: buildMatrix(depth + 2),
      nullable: null,
      tags: ["complex", "json", "nested-import", variant],
    };

    await ctx.stage("complex-leaf-marker", { noTools: "all" }).prompt(
      [
        `Complex leaf marker for topic: ${topic}`,
        "Reply exactly: CONTRACT_COMPLEX_LEAF_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    return {
      result: `complex leaf generated ${records.length} records for ${topic}`,
      packet,
      records,
      score: topic.length * (depth + 1) * (variant === "gamma" ? 3 : variant === "beta" ? 2 : 1),
    };
  })
  .compile();
