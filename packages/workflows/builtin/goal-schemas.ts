import { Type } from "typebox";

const reviewFindingSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    objective_alignment: Type.Union([
      Type.Literal("required_by_objective"),
      Type.Literal("consistent_with_objective"),
      Type.Literal("beyond_objective"),
      Type.Literal("contradicts_objective"),
    ]),
    priority: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()]),
    ),
    code_location: Type.Object(
      {
        absolute_file_path: Type.String(),
        line_range: Type.Object(
          {
            start: Type.Integer({ minimum: 1 }),
            end: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);


const requirementsTraceabilitySchema = Type.Object(
  {
    requirement: Type.String(),
    status: Type.Union([
      Type.Literal("proven"),
      Type.Literal("contradicted"),
      Type.Literal("missing"),
      Type.Literal("unverified"),
    ]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

const reviewerErrorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("validation_unavailable"),
      Type.Literal("dependency_unavailable"),
      Type.Literal("tool_failure"),
      Type.Literal("reviewer_failure"),
    ]),
    message: Type.String(),
    attempted_recovery: Type.String(),
  },
  { additionalProperties: false },
);

export const reviewDecisionSchema = Type.Object(
  {
    findings: Type.Array(reviewFindingSchema),
    overall_correctness: Type.Union([
      Type.Literal("patch is correct"),
      Type.Literal("patch is incorrect"),
    ]),
    overall_explanation: Type.String(),
    overall_confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    goal_oracle_satisfied: Type.Boolean(),
    requirements_traceability: Type.Array(requirementsTraceabilitySchema),
    receipt_assessment: Type.String(),
    verification_remaining: Type.String(),
    stop_review_loop: Type.Boolean(),
    reviewer_error: Type.Optional(
      Type.Union([Type.Null(), reviewerErrorSchema]),
    ),
  },
  { additionalProperties: false },
);
