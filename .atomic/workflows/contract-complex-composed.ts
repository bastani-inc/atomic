import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";
import complexLeaf from "./contract-complex-leaf.js";

const VARIANTS = ["alpha", "beta", "gamma"] as const;

type Variant = (typeof VARIANTS)[number];

interface ChildDigest extends WorkflowSerializableObject {
  readonly pass: number;
  readonly workflow: string;
  readonly runId: string;
  readonly result: string;
  readonly score: number;
  readonly packet: WorkflowSerializableObject;
}

interface CompositionBundle extends WorkflowSerializableObject {
  readonly topic: string;
  readonly depth: number;
  readonly variant: Variant;
  readonly childCount: number;
  readonly totalScore: number;
  readonly digests: readonly ChildDigest[];
  readonly auditTrail: readonly WorkflowSerializableObject[];
}

function clampDepth(value: number): number {
  return Math.max(0, Math.min(3, Math.floor(value)));
}

function clampPasses(value: number): number {
  return Math.max(1, Math.min(3, Math.floor(value)));
}

export default defineWorkflow("contract-complex-composed")
  .description("Composed workflow for nested-import validation. Imports contract-complex-leaf and calls it multiple times.")
  .input("topic", Type.String({ description: "Topic forwarded into imported leaf workflows." }))
  .input("depth", Type.Number({ default: 2, description: "Tree depth forwarded into the leaf workflows. Clamped to 0..3." }))
  .input(
    "variant",
    Type.Union([Type.Literal("alpha"), Type.Literal("beta"), Type.Literal("gamma")], {
      default: "alpha",
      description: "Variant forwarded into the leaf workflows.",
    }),
  )
  .input("passes", Type.Number({ default: 2, description: "Number of imported leaf workflow calls. Clamped to 1..3." }))
  .output("result", Type.String({ description: "Composition summary string." }))
  .output("bundle", Type.Unsafe<CompositionBundle>(Type.Object({}, { additionalProperties: true, description: "Deeply nested composition object built from child workflow outputs." })))
  .output("childDigests", Type.Unsafe<readonly ChildDigest[]>(Type.Array(Type.Unknown(), { description: "Per-child digest array." })))
  .output("totalScore", Type.Number({ description: "Finite sum of child scores." }))
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const depth = clampDepth(ctx.inputs.depth);
    const variant = ctx.inputs.variant;
    const passes = clampPasses(ctx.inputs.passes);
    const childDigests: ChildDigest[] = [];

    for (let pass = 1; pass <= passes; pass += 1) {
      const child = await ctx.workflow(complexLeaf, {
        stageName: `complex-leaf:pass-${pass}`,
        inputs: {
          topic: `${topic} / pass ${pass}`,
          depth,
          variant,
        },
      });

      // child.outputs is typed from contract-complex-leaf's declared output
      // contract, so these are read directly without defensive narrowing.
      childDigests.push({
        pass,
        workflow: child.workflow,
        runId: child.runId,
        result: child.outputs.result,
        score: child.outputs.score,
        packet: child.outputs.packet,
      });
    }

    const totalScore = childDigests.reduce((sum, digest) => sum + digest.score, 0);
    const bundle: CompositionBundle = {
      topic,
      depth,
      variant,
      childCount: childDigests.length,
      totalScore,
      digests: childDigests,
      auditTrail: childDigests.map((digest) => ({
        pass: digest.pass,
        childRunId: digest.runId,
        declaredPacketKeys: Object.keys(digest.packet).sort(),
      })),
    };

    return {
      result: `complex composition imported ${childDigests.length} leaf workflow run${childDigests.length === 1 ? "" : "s"}; total score ${totalScore}`,
      bundle,
      childDigests,
      totalScore,
    };
  })
  .compile();
