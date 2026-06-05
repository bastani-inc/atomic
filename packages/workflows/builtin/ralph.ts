/**
 * Builtin workflow: ralph
 *
 * Re-implements the Atomic SDK Ralph design with the local workflow task
 * primitives: bounded plan → orchestrate → simplify → review iterations.
 * Reviewer passes fan out with ctx.parallel(); each iteration feeds review
 * findings into the next planner with ctx.task().
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import type {
  WorkflowRunContext,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import { WORKER_PREFLIGHT_CONTRACT } from "./shared-prompts.js";

const DEFAULT_MAX_LOOPS = 10;
const DEFAULT_SPEC_DIR = "specs";
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";
const MAX_SPEC_SLUG_LENGTH = 80;

type ReviewFinding = {
  readonly title: string;
  readonly body: string;
  readonly confidence_score: number;
  readonly priority?: number | null;
  readonly code_location: {
    readonly absolute_file_path: string;
    readonly line_range: {
      readonly start: number;
      readonly end: number;
    };
  };
};

type ReviewerError = {
  readonly kind:
    | "validation_unavailable"
    | "dependency_unavailable"
    | "tool_failure"
    | "reviewer_failure";
  readonly message: string;
  readonly attempted_recovery: string;
};

type ReviewDecision = {
  readonly findings: readonly ReviewFinding[];
  readonly overall_correctness: "patch is correct" | "patch is incorrect";
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
  readonly stop_review_loop: boolean;
  readonly reviewer_error?: ReviewerError | null;
};

const reviewDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence_score",
    "stop_review_loop",
  ],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "confidence_score", "code_location"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence_score: { type: "number", minimum: 0, maximum: 1 },
          priority: { type: ["integer", "null"], minimum: 0, maximum: 3 },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["absolute_file_path", "line_range"],
            properties: {
              absolute_file_path: { type: "string" },
              line_range: {
                type: "object",
                additionalProperties: false,
                required: ["start", "end"],
                properties: {
                  start: { type: "integer", minimum: 1 },
                  end: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: { type: "string" },
    overall_confidence_score: { type: "number", minimum: 0, maximum: 1 },
    stop_review_loop: { type: "boolean" },
    reviewer_error: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "message", "attempted_recovery"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "validation_unavailable",
                "dependency_unavailable",
                "tool_failure",
                "reviewer_failure",
              ],
            },
            message: { type: "string" },
            attempted_recovery: { type: "string" },
          },
        },
      ],
    },
  },
} as const;

const reviewDecisionTool = {
  name: "review_decision",
  label: "Review Decision",
  description:
    "Emit the final structured review verdict after inspecting the patch.",
  promptSnippet: "Emit the final review verdict as structured data",
  promptGuidelines: [
    "Call review_decision after completing review investigation and validation.",
    "This is a terminating structured-output tool; do not emit another assistant response after calling it.",
  ],
  parameters: reviewDecisionSchema,
  async execute(_toolCallId: string, params: ReviewDecision) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(params, null, 2) },
      ],
      details: params,
      terminate: true,
    };
  },
};

const PLANNER_RFC_TEMPLATE = `
# [Project Name] Technical Design Document / RFC

| Document Metadata      | Details                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Author(s)              | Run \`git config user.name\` and insert the result.                              |
| Status                 | Draft (WIP) / In Review (RFC) / Approved / Implemented / Deprecated / Rejected |
| Team / Owner           |                                                                                |
| Created / Last Updated |                                                                                |

## 1. Executive Summary

_Instruction: A "TL;DR" of the document. Assume the reader is a VP or an engineer from another team who has 2 minutes. Summarize the Context (Problem), the Solution (Proposal), and the Impact (Value). Name the one or two **doors** at the heart of the change. Keep it under 200 words._

> **Example:** This RFC proposes replacing our current nightly batch billing system with an event-driven architecture. Currently, billing delays cause a 5% increase in customer support tickets. The proposed solution introduces two money doors — \`authorize_charge\` (reversible hold) and \`settle_payment\` (irreversible capture) — as the single chokepoint for outbound money, reducing billing latency from 24 hours to <5 minutes while making double-charges structurally impossible.

## 2. Context and Motivation

_Instruction: Why are we doing this? Why now? Link to the Product Requirement Document (PRD) and cite the relevant \`research/\` documents._

### 2.1 Current State

_Instruction: Describe the existing architecture. Use a "Context Diagram" if possible. Be honest about the flaws — including which existing doors **leak** (named for tools, dishonest compression, scattered danger)._

- **Architecture:** Currently, Service A communicates with Service B via a shared SQL database.
- **Limitations:** This creates a tight coupling; when Service A locks the table, Service B times out.
- **Leaking doors (today):** e.g. \`chargeCard(token, cents)\` is reachable from checkout, the retry job, *and* the admin panel — no one owns "charge exactly once." \`processPayment(...) -> bool\` collapses a declined card, a network failure, and a duplicate submission into the same \`false\`.

### 2.2 The Problem

_Instruction: What is the specific pain point?_

- **User Impact:** Customers cannot download receipts during the nightly batch window.
- **Business Impact:** We are losing $X/month in churn due to billing errors.
- **Technical Debt:** Danger is scattered; the boundary is misplaced, with defensive code deep inside the core instead of at the door.

## 3. Goals and Non-Goals

_Instruction: This is the contract / Definition of Success. Be precise._

### 3.1 Functional Goals

- [ ] Users must be able to export data in CSV format.
- [ ] System must support multi-tenant data isolation.

### 3.2 Non-Goals (Out of Scope)

_Instruction: Explicitly state what you are NOT doing. Remember: **intent lives in what the door refuses** — the doors you deliberately do not build are as much a statement of purpose as the ones you do. This prevents scope creep._

- [ ] We will NOT support PDF export in this version (CSV only).
- [ ] We will NOT migrate data older than 3 years.
- [ ] We will NOT expose a second path to move money; \`settle_payment\` remains the only chokepoint.

## 4. Proposed Solution (High-Level Design)

_Instruction: The "Big Picture." Diagrams are mandatory here._

### 4.1 System Architecture Diagram

_Instruction: Insert a C4 System Context or Container diagram. Show the "Black Boxes" and mark where the **airlock** sits (the single edge where untrusted network becomes a trusted request)._

\`\`\`mermaid
%%{init: {'theme':'base', 'themeVariables': { 'primaryColor':'#f8f9fa','primaryTextColor':'#2c3e50','primaryBorderColor':'#4a5568','lineColor':'#4a90e2','secondaryColor':'#ffffff','tertiaryColor':'#e9ecef','clusterBkg':'#ffffff','clusterBorder':'#cbd5e0'}}}%%
flowchart TB
    classDef person fill:#5a67d8,stroke:#4c51bf,stroke-width:3px,color:#fff,font-weight:600
    classDef core fill:#4a90e2,stroke:#357abd,stroke-width:2.5px,color:#fff,font-weight:600
    classDef support fill:#667eea,stroke:#5a67d8,stroke-width:2.5px,color:#fff,font-weight:600
    classDef db fill:#48bb78,stroke:#38a169,stroke-width:2.5px,color:#fff,font-weight:600
    classDef external fill:#718096,stroke:#4a5568,stroke-width:2.5px,color:#fff,font-weight:600,stroke-dasharray:6 3

    User(("◉<br><b>User</b>")):::person
    subgraph Boundary["◆ System Boundary — Airlock at the edge"]
        direction TB
        Gateway{{"<b>API Gateway</b><br><i>auth · validate · authorize</i><br>the one trust transition"}}:::core
        API["<b>Core Service</b><br><i>trusts its own invariants</i>"]:::core
        Worker(["<b>Worker</b><br><i>async</i>"]):::support
        DB[("●<br><b>Primary DB</b>")]:::db
    end
    Ext{{"<b>Payment Provider</b>"}}:::external

    User -->|"1. HTTPS (untrusted)"| Gateway
    Gateway -->|"2. trusted request"| API
    API -->|"3. persist (txn)"| DB
    API -.->|"4. enqueue"| Worker
    Worker -.->|"5. settle (irreversible)"| Ext
    style Boundary fill:#fff,stroke:#cbd5e0,stroke-width:2px,stroke-dasharray:8 4
\`\`\`

### 4.2 Architectural Pattern

_Instruction: Name the pattern (e.g., "Event Sourcing", "BFF — Backend for Frontend", "Publisher-Subscriber")._

- We are adopting a Publisher-Subscriber pattern where the Order Service publishes \`OrderCreated\` events, and the Billing Service consumes them asynchronously.

### 4.3 Key Components

| Component         | Responsibility              | Technology Stack  | Justification                                |
| ----------------- | --------------------------- | ----------------- | -------------------------------------------- |
| Ingestion Service | Validates incoming webhooks | Go, Gin Framework | High concurrency performance needed.         |
| Event Bus         | Decouples services          | Kafka             | Durable log, replay capability.              |
| Projections DB    | Read-optimized views        | MongoDB           | Flexible schema for diverse receipt formats. |

### 4.4 The Door Set at a Glance (Stranger-Across-Time View)

_Instruction: List the entrypoint **names alone** — no signatures, no bodies. A competent stranger should reconstruct the system's purpose from this list. If they cannot, intent has leaked into the mechanism; return to §5 and rename until they can. Mark every door that guards an irreversible effect with ⚠._

> **Example:** \`register_account\`, \`authenticate\`, \`authorize_charge\`, \`settle_payment\` ⚠, \`grant_access\` ⚠, \`revoke_access\`, \`publish_draft\`. Reading these alone tells you who the system lets in, that money moves in exactly two steps and only those two, who may hand out access, and what it means for work to go live.

## 5. Detailed Design

_Instruction: The "Meat" of the document. Sufficient detail for an engineer to start coding. Lead with the **doors** — they are the load-bearing part of the spec — then describe the mechanism behind them._

### 5.1 The Doors (Entrypoint Contracts)

_Instruction: For each non-trivial entrypoint, give a typed signature (typed pseudocode is fine — read the types, not the syntax), the one-sentence guarantee (no "and"), the named failure set, and the refusals it enforces in the type system. Then record the rubric result. Make illegal states **unrepresentable**, not merely checked. Cite the \`research/\` doc that establishes each joint._

\`\`\`
// — Money. Two doors, and there is no third way to move a cent. —

authorize_charge(
  account: AccountId,            // newtype: cannot be confused with any other id
  amount: Money,                 // currency-typed: USD and JPY will not add
  idempotency_key: IdempotencyKey,
): Result<AuthorizedCharge, ChargeError>
// Guarantee: places a reversible hold and returns proof an authorization exists.
// ChargeError = InsufficientFunds | CardDeclined | NetworkError | DuplicateKey

settle_payment(
  authorized: AuthorizedCharge,  // ← can ONLY be produced by authorize_charge
  idempotency_key: IdempotencyKey,
): Result<Settlement, SettlementError>
// Guarantee: captures the held funds. IRREVERSIBLE. The single chokepoint for outbound money.
// You cannot settle a charge you did not authorize — not because a check forbids it,
// but because there is no way to CONSTRUCT an AuthorizedCharge except by calling
// authorize_charge. The illegal state is unrepresentable. The idempotency key makes
// the retry, the double-click, and the at-least-once queue converge on ONE settlement.
\`\`\`

**Per-door audit (run the rubric):**

| Door               | (1) Joint       | (2) One sentence, no "and"   | (3) Honest name                 | (5) Every exit                                   | (6) Refusals real                         | (7) Trust transition | (8) One chokepoint             |
| ------------------ | --------------- | ---------------------------- | ------------------------------- | ------------------------------------------------ | ----------------------------------------- | -------------------- | ------------------------------ |
| \`authorize_charge\` | ✅ business verb | ✅ "places a reversible hold" | ✅                               | retry → \`DuplicateKey\`; timeout → \`NetworkError\` | currency mismatch unrepresentable         | n/a                  | reversible, not the chokepoint |
| \`settle_payment\` ⚠ | ✅ business verb | ✅ "captures held funds"      | ✅ irreversibility in doc + type | replay converges via key                         | cannot settle un-authorized charge (type) | n/a                  | ✅ the sole outbound-money door |

### 5.2 API Interfaces — The Same Doors on the Wire

_Instruction: A web service's real boundary is its transport surface. The URL names the joint, the HTTP verb declares its safety class, the status code is the door's honest exit. Never \`200 OK\` wrapping an error. The wire door MUST carry the same name as its in-process twin (§5.1)._

\`\`\`
# Identity — the one trust transition, at the edge
POST   /v1/sessions                       201 Created      # = authenticate; 401 on bad credentials
DELETE /v1/sessions/current               204 No Content   # = log out

# Money — two doors, one chokepoint, idempotent under retry
POST   /v1/payment_intents                201   Idempotency-Key: <key>   # = authorize_charge (reversible)
POST   /v1/payment_intents/{id}/capture   200   Idempotency-Key: <key>   # = settle_payment (IRREVERSIBLE)
#   409 Conflict if the key is replayed with a different body
#   422 Unprocessable if the intent was never authorized

# Access — authority demanded by the route, destructive door made idempotent
POST   /v1/accounts/{id}/grants           201   (admin scope required)            # = grant_access
DELETE /v1/grants/{id}                     204   (204 even if already revoked)     # = revoke_access

# Publishing — the domain's own verb, refusing to clobber a concurrent edit
POST   /v1/drafts/{id}/publish            200   If-Match: <etag>                   # = publish_draft
#   412 Precondition Failed if the draft moved under you — the wire's --force-with-lease
\`\`\`

_If using gRPC, define the same joints in the \`.proto\`; the typed request message is the airlock by construction. Use honest status codes (\`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\`, \`NOT_FOUND\`, \`ALREADY_EXISTS\`, \`FAILED_PRECONDITION\`, retryable \`ABORTED\`/\`UNAVAILABLE\`) — never a lone \`OK\` carrying an error field._

### 5.3 Data Model / Schema

_Instruction: Provide ERDs or JSON schemas. Discuss normalization vs. denormalization. Prefer schemas that make illegal states unrepresentable (sum-type status columns over independent boolean flags)._

**Table:** \`invoices\` (PostgreSQL)

| Column    | Type | Constraints                          | Description                    |
| --------- | ---- | ------------------------------------ | ------------------------------ |
| \`id\`      | UUID | PK                                   |                                |
| \`user_id\` | UUID | FK -> Users                          | Partition Key                  |
| \`status\`  | ENUM | 'DRAFT','LOCKED','PROCESSING','PAID' | A sum type, not three booleans |

### 5.4 Algorithms and State Management

_Instruction: Describe complex logic, state machines, or consistency models. Tie each state transition to the door that performs it._

- **State Machine:** An invoice moves \`DRAFT\` → \`LOCKED\` → \`PROCESSING\` → \`PAID\`; the \`PROCESSING → PAID\` transition happens only through \`settle_payment\`.
- **Concurrency:** Optimistic locking on the \`version\` column; on the wire this surfaces as \`If-Match\`/\`412\`.

## 6. Alternatives Considered

_Instruction: Prove you thought about trade-offs — including alternative **door sets** (e.g., one god endpoint vs. distinct joints). Why is your boundary better than the others?_

| Option                                      | Pros                                        | Cons                                                   | Reason for Rejection                                                           |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Option A: Single \`POST /execute {action}\`   | One route, flexible                         | God door; intent hidden in payload; danger un-funneled | Fails "joint, not tool" and "few dangerous doors."                             |
| Option B: One-step \`chargeCard()\`           | Fewest calls                                | No reversible hold; retries double-charge              | Cannot make double-charge unrepresentable.                                     |
| Option C: \`authorize\` + \`settle\` (Selected) | Reversible hold; one chokepoint; idempotent | Two calls instead of one                               | **Selected:** the two real joints, with the irreversible effect funneled once. |

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

_Instruction: This is where "keep the dangerous doors few and honest" and "the airlock at the boundary" become concrete._

- **The trust transition is singular:** untrusted callers become trusted only at \`POST /v1/sessions\` / the gateway. No other door promotes an anonymous caller. (Rubric #7.)
- **Authority carried by type:** destructive/privileged doors demand a capability (\`AdminSession\`) that only \`authenticate\` can mint — the permission check cannot be forgotten at a call site because there is no call site where it is absent. (Rubric #6.)
- **Irreversible effects pass one chokepoint:** money via \`settle_payment\`, deletion via the single guarded door; the catastrophic version must be asked for explicitly. (Rubric #8.)
- **Data Protection:** PII (names, emails) encrypted at rest (AES-256); \`Password\` is a newtype that cannot be logged, printed, or compared by accident.
- **Threat Model:** Primary threat is a compromised API key; remediation is rapid rotation and rate limiting.

## 8. Test Plan

_Instruction: Test the doors at their promises and their refusals — not just the happy path. Every exit in rubric #5 deserves a test. The interactive verification is what lets a human or another agent confirm the feature is correct without reading the bodies — the stranger-across-time test, made executable._

- **Unit Tests:** each door's named failure variants; the *refusals* (e.g., a type/construction test proving \`settle_payment\` cannot accept anything but an \`AuthorizedCharge\`).
- **End-to-End Tests:** full domain flows named by joint (register → authenticate → authorize → settle), driven through the real wire doors of §5.2.
- **Integration Tests:** idempotency under replay (same key → one settlement); concurrent-edit \`412\`; trust transition (no door promotes an anonymous caller except \`authenticate\`).
- **Fuzz / Property Tests:** throw malformed and adversarial input at the doors (the airlock); the boundary must reject everything the types forbid and never crash the core. Assert invariants over random inputs (e.g., \`settle_payment\` converges on one settlement under any interleaving of retries; no input sequence reaches a money move except through the chokepoint).
- **Interactive Verification:** a runnable checklist or script a human OR another agent can execute to confirm the feature was implemented correctly — each step names a door, supplies an input, and states the expected honest exit (status code / named error / resulting state), so correctness is observable from the boundary alone. Include the exact commands or requests to run and the pass/fail condition for each.

## 9. Open Questions / Unresolved Issues

_Instruction: List known unknowns. These must be resolved before the doc is marked "Approved." Include any door whose rubric could not be answered cleanly — especially undefined guarantees (rubric #2, the most dangerous case) and any irreversible effect not yet funneled to a single chokepoint (rubric #8). Resolve these with the user via contrastive clarification._

- [ ] Is \`publish_draft\` the only door that moves a draft to live, or can the admin panel also publish? (If the latter, the effect is not yet funneled — rubric #8.)
- [ ] What exactly does \`authorize_charge\` promise on a partial provider outage — is the guarantee defined? (rubric #2.)
- [ ] Will the Legal team approve the 3rd-party library for PDF generation?
- [ ] Does the current VPC peering allow connection to the legacy mainframe?`.trim();

type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
}

function workflowCwdContextSection(workflowCwd: string): PromptSection {
  return [
    "workflow_cwd_context",
    [
      `Current working directory: ${workflowCwd}`,
      "Use this as the starting directory for repository work in this stage.",
      "Shell commands and relative file paths should be relative to this directory unless you intentionally pass an explicit cwd override.",
      "When delegating, pass along that this is the current working directory for the workflow.",
    ].join("\n"),
  ];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeBranchInput(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;

  const looksLikeSafeGitRef =
    /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(
      trimmed,
    );
  return looksLikeSafeGitRef ? trimmed : fallback;
}

function slugifySpecTopic(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SPEC_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "plan";
}

function defaultSpecPath(prompt: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(DEFAULT_SPEC_DIR, `${date}-${slugifySpecTopic(prompt)}.md`);
}

async function writeSpecFile(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
  });
  return path;
}

async function createImplementationNotesFile(prompt: string): Promise<string> {
  const notesDir = await mkdtemp(join(tmpdir(), "atomic-ralph-notes-"));
  const notesPath = join(notesDir, IMPLEMENTATION_NOTES_FILENAME);
  const initialNotes = [
    "# Implementation Notes",
    "",
    `Task: ${prompt || "(empty prompt)"}`,
    "",
    "## Running Notes",
    "",
    "- Record implementation decisions, deviations from the spec, tradeoffs, blockers, validation notes, and anything else the user should know.",
  ].join("\n");
  await writeFile(notesPath, `${initialNotes}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return notesPath;
}

function parseReviewDecision(text: string): ReviewDecision | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewDecision>;
    if (
      parsed.overall_correctness !== "patch is correct" &&
      parsed.overall_correctness !== "patch is incorrect"
    ) {
      return undefined;
    }
    if (!Array.isArray(parsed.findings)) return undefined;
    if (typeof parsed.stop_review_loop !== "boolean") return undefined;
    if (typeof parsed.overall_explanation !== "string") return undefined;
    if (typeof parsed.overall_confidence_score !== "number") return undefined;
    return parsed as ReviewDecision;
  } catch {
    return undefined;
  }
}

function reviewDecisionApproved(decision: ReviewDecision): boolean {
  return (
    decision.stop_review_loop === true &&
    decision.overall_correctness === "patch is correct" &&
    decision.findings.length === 0 &&
    decision.reviewer_error == null
  );
}

function reviewerErrorDecision(error: string): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is incorrect",
    overall_explanation:
      "Reviewer execution failed, so the review loop cannot safely approve this iteration.",
    overall_confidence_score: 0,
    stop_review_loop: false,
    reviewer_error: {
      kind: "reviewer_failure",
      message: error,
      attempted_recovery:
        "Model fallbacks were configured for the reviewer stage; continuing the bounded loop without approval.",
    },
  };
}

function reviewerErrorResult(
  error: string,
): WorkflowTaskResult {
  return {
    name: "reviewer-error",
    stageName: "reviewer-error",
    text: JSON.stringify(reviewerErrorDecision(error), null, 2),
  };
}

function artifactSafeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "artifact";
}

type ReviewArtifact = {
  readonly iteration: number;
  readonly reviewer: string;
  readonly decision: ReviewDecision;
  readonly raw_text: string;
};

type ReviewRoundArtifact = {
  readonly iteration: number;
  readonly reviews: readonly {
    readonly reviewer: string;
    readonly artifact_path: string;
    readonly decision: ReviewDecision;
  }[];
};

async function writeJsonArtifact(path: string, content: ReviewArtifact | ReviewRoundArtifact): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
  });
  return path;
}

function compactReviewReport(path: string | undefined): string {
  return path === undefined
    ? "No reviewer artifact was produced."
    : `Latest review round artifact: ${path}`;
}

type RalphInputs = {
  readonly prompt?: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};

type RalphWorkflowOptions = {
  readonly prompt: string;
  readonly maxLoops: number;
  readonly comparisonBaseBranch: string;
  readonly workflowStartCwd: string;
  readonly createPr: boolean;
};

type RalphWorkflowResult = {
  readonly result: string;
  readonly plan: string;
  readonly plan_path: string;
  readonly implementation_notes_path: string;
  readonly pr_report?: string;
  readonly approved: boolean;
  readonly iterations_completed: number;
  readonly review_report: string;
  readonly review_report_path?: string;
};

async function runRalphWorkflow(
  ctx: WorkflowRunContext<RalphInputs>,
  options: RalphWorkflowOptions,
): Promise<RalphWorkflowResult> {
  const {
    prompt,
    maxLoops,
    comparisonBaseBranch,
    workflowStartCwd,
    createPr,
  } = options;

  let latestReviewReportPath: string | undefined;
  let finalPlan = "";
  let finalPlanPath = "";
  let finalResult = "";
  let finalPrReport: string | undefined;
  // Keep generated specs under the workflow runtime cwd. When Ralph is invoked
  // with git_worktree_dir, the executor defaults ctx.cwd to the matching
  // worktree cwd so specs and stage writes land in the same checkout.
  const workflowSpecPath = resolve(workflowStartCwd, defaultSpecPath(prompt));
  const implementationNotesPath = await createImplementationNotesFile(prompt);
  const artifactDir = await mkdtemp(join(tmpdir(), "atomic-ralph-run-"));
  const workflowCwdContext = workflowCwdContextSection(workflowStartCwd);
  let approved = false;
  let iterationsCompleted = 0;

  const plannerModelConfig = {
    model: "openai/gpt-5.5:xhigh",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "github-copilot/claude-opus-4.8:xhigh",
    ],
    excludedTools: ["ask_user_question"],
  };

  const orchestratorModelConfig = {
    model: "openai/gpt-5.5:medium",
    fallbackModels: [
      "openai-codex/gpt-5.5:medium",
      "github-copilot/gpt-5.5:medium",
      "anthropic/claude-opus-4-8:medium",
      "github-copilot/claude-opus-4.8:medium",
    ],
    excludedTools: ["ask_user_question"],
  };

  const simplifierModelConfig = {
    model: "openai/gpt-5.5:medium",
    fallbackModels: [
      "openai-codex/gpt-5.5:medium",
      "github-copilot/gpt-5.5:medium",
      "anthropic/claude-opus-4-8:medium",
      "github-copilot/claude-opus-4.8:medium",
    ],
    excludedTools: ["ask_user_question"],
  };

  const reviewerModelConfig = {
    model: "openai/gpt-5.5:xhigh",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "github-copilot/claude-opus-4.8:xhigh",
    ],
    excludedTools: ["ask_user_question"],
    customTools: [reviewDecisionTool],
  };

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    iterationsCompleted = iteration;

    const planner = await ctx.task(`planner-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          "You are a technical architect. Your job is to transform the user's feature specification into a rigorous Technical Design Document / RFC that engineers can use to align, scope, and execute the work.",
        ],
        [
          "critical_deliverable",
          [
            "Your final output is a filled-in RFC rendered as markdown text.",
            "Render the RFC Template in this prompt with every section populated by feature-specific content drawn from the user's specification and your codebase investigation.",
            "Do not implement code changes in this stage; this stage only investigates and authors the RFC.",
          ].join("\n"),
        ],
        [
          "task",
          `Plan iteration ${iteration}/${maxLoops} for this user specification:\n${prompt}`,
        ],
        workflowCwdContext,
        [
          "latest_review_artifact",
          latestReviewReportPath === undefined
            ? "No prior review artifact; this is the first iteration."
            : [
                `Latest review round artifact: ${latestReviewReportPath}`,
                "Read this JSON artifact incrementally and address only unresolved findings from the latest review round.",
                "Do not rely on an injected review transcript or older review history unless the latest artifact explicitly points you there.",
              ].join("\n"),
        ],
        [
          "spec_revision_target",
          iteration === 1
            ? [
                `Ralph will write your final RFC markdown for this workflow run to: ${workflowSpecPath}`,
                "Treat this as the original spec file for the run.",
              ].join("\n")
            : [
                `The existing RFC/spec file for this workflow run is: ${workflowSpecPath}`,
                "Read that original spec before drafting; revise it in response to review findings and current repository evidence.",
                "Your final output must be the full updated RFC markdown that should replace the original spec, not a diff, patch, or commentary.",
              ].join("\n"),
        ],
        [
          "input_spec_files",
          [
            "If the user specification is a file path instead of raw prose, read that file and use it as source material for the RFC.",
            "Still author the RFC normally; do not output only a forwarded path.",
          ].join("\n"),
        ],
        [
          "investigation_phase",
          [
            "Before drafting, read the specification carefully and identify the concrete problem, success criteria, hard constraints, and non-goals.",
            "Survey the codebase using file/search tools such as read plus grep/rg/find/glob-style shell commands to ground the RFC in current architecture.",
            "Name concrete services, modules, files, tests, data models, APIs, CLIs, config files, and external integrations this work will touch.",
            "Capture metadata with bash: `git config user.name` for Author(s), and `date '+%Y-%m-%d'` for Created / Last Updated.",
            "Look for prior art: existing RFCs, ADRs, README files, specs, docs, tests, or code comments that explain why the current state exists.",
          ].join("\n"),
        ],
        [
          "authoring_principles",
          [
            "Be specific: `src/server/auth.ts:42` beats `the auth layer`.",
            "Trade-offs over conclusions: Alternatives Considered must include at least two real alternatives with honest pros, cons, and rejection reasons.",
            "Non-goals matter: explicitly exclude work that is out of scope to prevent scope creep.",
            "Diagrams are load-bearing: Section 4.1 must include a Mermaid system architecture diagram grounded in real components.",
            "Surface open questions in Section 9 with owner placeholders such as `[OWNER: infra team]`; do not paper over uncertainty.",
            "Match depth to stakes: a small refactor can be concise, but every template section header must remain present.",
            "If prior review findings are present, explicitly address each finding or explain why it is obsolete.",
            "Determine the compatibility posture:",
            "- Before decomposing the spec creation request, identify whether this project must preserve backward compatibility for real downstream users.",
            "- If the user explicitly allows breaking changes, public API changes, cleanup, or says there are no real users/downstream dependencies, allow breaking changes.",
            "- If the user mentions production users, published APIs, downstream consumers, migration safety, or compatibility requirements, disallow breaking changes.",
            "- Carry this posture into the spec creation plan, the final spec frontmatter, and a `## Backwards Compatibility` section in the final spec.",
            "- When allowing breaking changes, document existing legacy behavior, compatibility shims, optional flags, and public APIs as current state, not as constraints future specs must preserve unless the user explicitly asks for preservation.",
            "- When not allowing breaking changes, document public APIs, compatibility-sensitive surfaces, downstream callers, migration constraints, and behavior that future work must preserve."
          ].join("\n"),
        ],
        [
          "stage_contract",
          [
            "This stage is investigation-first RFC authoring. The RFC is only valid if it is grounded in repository inspection performed during this stage.",
            "Do not fill the template from generic architecture guesses. Before writing the final RFC, inspect relevant code, docs, tests, configs, and prior design material.",
            "Treat the output format as the report after investigation, not a substitute for investigation.",
          ].join("\n"),
        ],
        [
          "evidence_expectations",
          [
            "Every major design claim should be traceable to concrete evidence: file paths, symbols, commands, docs, tests, configs, or prior RFCs.",
            "Include those concrete references inside the RFC sections where they support the design.",
            "If expected evidence cannot be found, say so in the relevant RFC section or Open Questions rather than papering over the gap.",
          ].join("\n"),
        ],
        [
          "output_discipline",
          [
            "Render the RFC Template exactly as the final document structure: preserve every header and the metadata table.",
            "Replace instructional placeholders with real, feature-specific content; do not leave template guidance in the final RFC.",
            "Output nothing after the RFC: no meta-commentary, no summary of what you wrote, no implementation log.",
          ].join("\n"),
        ],
        ["rfc_template", PLANNER_RFC_TEMPLATE],
      ]),
      reads: [
        ...(iteration > 1 ? [workflowSpecPath] : []),
        ...(latestReviewReportPath === undefined ? [] : [latestReviewReportPath]),
      ],
      ...plannerModelConfig,
    });
    finalPlan = planner.text;
    const specPath = await writeSpecFile(workflowSpecPath, planner.text);
    finalPlanPath = specPath;

    const orchestratorReportPath = join(artifactDir, `orchestrator-${iteration}.md`);
    const simplifierReportPath = join(artifactDir, `code-simplifier-${iteration}.md`);

    const orchestrator = await ctx.task(`orchestrator-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          "You are a sub-agent orchestrator with many tools available. Your primary implementation tool is the `subagent` tool.",
        ],
        [
          "objective",
          `Implement iteration ${iteration}/${maxLoops} for the task: ${prompt}`,
        ],
        workflowCwdContext,
        [
          "spec_file",
          [
            `The current technical specification for this workflow run is written to: ${specPath}`,
            "This is an absolute host-repository path and may be outside the worktree cwd; read it exactly as provided, not as a path relative to the worktree.",
            "Read this file before delegating or implementing anything.",
            "Do not rely on an inline planner transcript; the spec file is the authoritative plan for this iteration.",
          ].join("\n"),
        ],
        [
          "implementation_notes",
          [
            `Keep a running Markdown implementation notes file at this OS temp directory path: ${implementationNotesPath}`,
            "The file has already been initialized for this workflow run; update it while you implement the spec.",
            "Record decisions you had to make that were not in the spec, things you had to change from the spec, tradeoffs you had to make, blockers, validation outcomes, and anything else the user should know.",
            "Ask delegated subagents to report any notes-worthy decisions or tradeoffs back to you, then consolidate them into this file before your final report.",
            "Do not include secrets, credentials, tokens, or unrelated environment details in the notes file.",
          ].join("\n"),
        ],
        ["project_initialization_preflight", WORKER_PREFLIGHT_CONTRACT],
        [
          "delegation_policy",
          [
            "You are not the implementer. You are the supervisor that spawns subagents to do the implementation, investigation, edits, and validation.",
            "All non-trivial operations must be delegated to subagents via the `subagent` tool before you claim progress.",
            "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
            "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
            "Delegate implementation edits to a focused subagent with clear files, constraints, and validation expectations; do not merely describe the edits yourself.",
            "Keep delegated work focused on implementation, tests, docs, validation evidence, and implementation notes.",
            "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
            "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
            "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
          ].join("\n"),
        ],
        [
          "execution_contract",
          [
            "The required output format is a completion report, not the task itself.",
            "Do not jump straight to the report. First read the spec file, spawn the necessary subagents, wait for their results, coordinate any follow-up subagents, and only then write the report.",
            "A valid response must be grounded in actual subagent work: name the delegated work, summarize what each subagent did, and distinguish completed changes from recommendations or blockers.",
            "If you cannot read the spec file, spawn subagents, or use subagents, treat that as a blocker and report it honestly instead of pretending the requested work was done.",
          ].join("\n"),
        ],
        [
          "subagent_tracking",
          [
            "Use the `todo` tool as your active control ledger for subagent work.",
            "Before launching subagents, create todo items for each delegated task with enough detail to identify owner, purpose, and expected output.",
            "Mark todo items in_progress when the corresponding subagent starts, append progress/results as subagents report back, and close them only after you have incorporated or explicitly rejected their result.",
            "Keep pending, in_progress, blocked, and completed work accurate so you do not lose track of parallel subagents or unresolved follow-ups.",
            "Before writing the final report, review the todo list and resolve every pending/in_progress item as completed, blocked, or deferred with an explanation.",
          ].join("\n"),
        ],
        [
          "instructions",
          [
            `Start by reading the spec file at ${specPath}.`,
            "Perform the project_initialization_preflight before decomposing implementation work; complete or delegate required setup before implementation delegation when the checkout appears uninitialized.",
            "Decompose the work into delegated subagent tasks based on that spec file.",
            "Pass each subagent the relevant task, constraints, files, validation expectations, any prior review findings from the spec, and instructions to report implementation-note-worthy decisions or tradeoffs.",
            "Coordinate subagent results into the smallest coherent set of changes that satisfies the spec.",
            "Preserve existing architecture and repository conventions unless the spec explicitly justifies a change.",
            "Run or delegate the most relevant validation commands available in the repository.",
            `Before your final report, update the running implementation notes file at ${implementationNotesPath} with decisions, spec deviations, tradeoffs, blockers, and validation outcomes from this iteration.`,
            "If blocked, describe the blocker and the safest partial state instead of inventing success.",
            "Do not hide failures; reviewers need accurate status.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "After subagents have done the work, return Markdown with headings:",
            "1. Spec file — the path you read",
            "2. Delegations performed — subagents spawned and what each completed",
            "3. Changes made — concrete changes from subagent work, not intentions",
            "4. Files touched",
            "5. Validation run / recommended",
            "6. Deferred work or blockers",
            "7. Implementation notes — confirm the OS temp notes path was updated",
          ].join("\n"),
        ],
      ]),
      reads: [specPath, implementationNotesPath],
      output: orchestratorReportPath,
      outputMode: "file-only",
      ...orchestratorModelConfig,
    });
    finalResult = orchestrator.text || `Orchestrator report artifact: ${orchestratorReportPath}`;

    await ctx.task(`code-simplifier-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          [
            "You are an expert code simplification specialist focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.",
            "Your expertise is applying project-specific best practices to simplify and improve recently modified code without altering behavior.",
            "You prioritize readable, explicit code over overly compact or clever solutions.",
          ].join("\n"),
        ],
        [
          "objective",
          `Refine recently modified code for this task while preserving exact behavior: ${prompt}`,
        ],
        workflowCwdContext,
        [
          "artifact_handoff",
          [
            `Spec artifact: ${specPath}`,
            `Implementation notes artifact: ${implementationNotesPath}`,
            `Orchestrator report artifact: ${orchestratorReportPath}`,
            "Read these artifacts incrementally only when needed to identify recently modified files and intent; do not depend on an injected planner/orchestrator transcript tail.",
          ].join("\n"),
        ],
        [
          "functionality_preservation",
          [
            "Never change what the code does — only how it does it.",
            "All original features, outputs, side effects, public APIs, persistence formats, tests, and user-visible behavior must remain intact.",
            "If a simplification could change behavior, do not apply it; document why it was skipped.",
          ].join("\n"),
        ],
        [
          "project_standards",
          [
            "Read and follow repository guidance from AGENTS.md and/or CLAUDE.md when present.",
            "Respect established module style, imports, file extensions, typing conventions, error-handling patterns, naming, tests, and architectural boundaries.",
            "For this TypeScript workflow repo, preserve ESM .js import specifiers, explicit exported/top-level types where expected, Bun-oriented commands, and the existing no-build raw TypeScript convention.",
            "Do not impose standards that conflict with local project guidance.",
          ].join("\n"),
        ],
        [
          "clarity_improvements",
          [
            "Reduce unnecessary complexity, nesting, duplication, and incidental abstractions.",
            "Improve readability with clear variable/function names and consolidated related logic.",
            "Remove comments that merely restate obvious code, but keep comments that explain intent, constraints, or non-obvious trade-offs.",
            "Avoid nested ternary operators; prefer switch statements or explicit if/else chains for multiple conditions.",
            "Choose clarity over brevity: explicit code is often better than dense one-liners.",
          ].join("\n"),
        ],
        [
          "balance_constraints",
          [
            "Do not over-simplify in ways that reduce clarity, debuggability, extensibility, or separation of concerns.",
            "Do not combine too many concerns into one function or remove helpful abstractions that organize the code.",
            "Do not prioritize fewer lines over maintainability.",
            "Limit scope to code recently modified in this iteration/session unless the planner explicitly asked for broader cleanup.",
          ].join("\n"),
        ],
        [
          "stage_contract",
          [
            "This is an active code-refinement stage, not just a commentary stage.",
            "Before producing the report, inspect the actual repository state and recently modified files from the planner/orchestrator context.",
            "Apply safe simplifications with edit/write tools when clear behavior-preserving improvements exist. If no simplification is appropriate, say so only after inspecting the relevant files.",
          ].join("\n"),
        ],
        [
          "required_actions_before_output",
          [
            "1. Identify the concrete files/sections changed in this iteration.",
            "2. Read those files before deciding whether to simplify.",
            "3. Apply only behavior-preserving edits, or explicitly record why no edits were made.",
            "4. Run or recommend focused validation tied to the touched files.",
          ].join("\n"),
        ],
        [
          "handoff_expectations",
          "In the final report, distinguish edits actually applied from observations only. Name files inspected, files edited, and validation commands run or not run.",
        ],
        [
          "process",
          [
            "Identify recently modified code sections from the iteration context and repository state.",
            "Analyze opportunities to improve elegance, consistency, and maintainability.",
            "Apply project-specific best practices while preserving behavior.",
            "Run or recommend focused validation when appropriate.",
            "Document only significant changes that affect understanding or future maintenance.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Markdown with headings:",
            "1. Simplifications applied",
            "2. Behavior-preservation notes",
            "3. Validation run / recommended",
            "4. Skipped risky simplifications",
          ].join("\n"),
        ],
      ]),
      reads: [specPath, implementationNotesPath, orchestratorReportPath],
      output: simplifierReportPath,
      outputMode: "file-only",
      ...simplifierModelConfig,
    });

    const reviewPrompt = taggedPrompt([
      [
        "role",
        [
          "You are acting as a reviewer for a proposed code change made by another engineer.",
          "Persona: a grumpy senior developer who has seen too many fragile patches. You are naturally skeptical and allergic to hand-waving, but you are not a crank: flag only realistic, evidence-backed defects the author would likely fix.",
          "Be terse, concrete, and technically fair. Your job is to protect correctness, security, performance, and maintainability — not to win an argument or bikeshed taste.",
        ].join("\n"),
      ],
      ["objective", `Review the current code delta for the task: ${prompt}`],
      workflowCwdContext,
      [
        "comparison_baseline",
        [
          `The baseline branch for comparison is \`${comparisonBaseBranch}\`.`,
          "Compare the current working tree against this baseline branch, not against previous workflow reasoning or expected loop progress.",
          `Start with \`git status --short\`, then use working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\` to identify changed tracked files; inspect untracked files from status directly.`,
        ].join("\n"),
      ],
      [
        "review_context_files",
        [
          `Spec artifact: ${specPath}`,
          `Implementation notes artifact: ${implementationNotesPath}`,
          `Orchestrator report artifact: ${orchestratorReportPath}`,
          `Simplifier report artifact: ${simplifierReportPath}`,
          "Read the files above incrementally when they help explain intent or recent changes, but verify the actual repository state directly before approving.",
        ].join("\n"),
      ],
      [
        "project_guidance",
        [
          "Use the repository's AGENTS.md and/or CLAUDE.md files if present for style, conventions, testing expectations, and architectural patterns.",
          "Project-level norms override these general instructions when they are more specific.",
          "Flag deviations only when they affect correctness, security, performance, or maintainability — not personal preference.",
          "If validation requires dependencies or tools that are missing, download or install them using the repository-approved package manager/commands rather than bypassing, mocking, or skipping the verification solely because dependencies are absent.",
        ].join("\n"),
      ],
      [
        "validation_expectations",
        [
          "Inspect the actual diff/repository state rather than trusting stage summaries.",
          "Run or delegate focused validation when it is necessary to distinguish a real bug from a hunch.",
          "If tests or typechecks fail because dependencies are missing, install/download the missing dependencies with the repo's documented package manager instead of bypassing the check.",
          "If validation cannot be completed after reasonable recovery, record the limitation in overall_explanation and reviewer_error; do not use missing dependencies as a reason to approve.",
        ].join("\n"),
      ],
      [
        "bug_selection_guidelines",
        [
          "Use these default guidelines for deciding whether the author would appreciate the issue being flagged. More specific user, project, or file-level guidance overrides them.",
          "Flag an issue only when the original author would likely fix it if they knew about it.",
          "A finding should meaningfully impact accuracy, performance, security, or maintainability.",
          "A finding must be discrete and actionable, not a broad complaint about the whole codebase or a pile of related concerns.",
          "Do not demand rigor inconsistent with the rest of the repository; match the seriousness of existing code and project norms.",
          "Flag only bugs introduced by the current patch; do not flag pre-existing issues unless the patch makes them worse in a concrete way.",
          "Do not rely on unstated assumptions about author intent or codebase behavior.",
          "Speculation is insufficient: identify the code path, scenario, environment, or input that is provably affected.",
          "Do not flag intentional behavior changes as bugs unless they clearly violate the task or documented contract.",
          "Ignore trivial style unless it obscures meaning or violates documented standards in a way that affects correctness/security/maintainability.",
          "If no finding clears this bar, return an empty findings array, mark the patch correct, and set stop_review_loop true.",
        ].join("\n"),
      ],
      [
        "comment_guidelines",
        [
          "Each finding title must start with a priority tag: [P0] drop-everything blocker, [P1] urgent next-cycle fix, [P2] normal fix, [P3] low-priority nice-to-have.",
          "Also include numeric priority: 0 for P0, 1 for P1, 2 for P2, 3 for P3; use null only if priority genuinely cannot be determined.",
          "The body must be one concise paragraph explaining why this is a bug and the exact scenario, environment, or inputs required for it to arise.",
          "Use a matter-of-fact, non-accusatory tone. Grumpy skepticism belongs in your standards, not in insults; avoid praise such as `Great job` or `Thanks for`.",
          "Keep code_location ranges as short as possible, ideally one line and never longer than 5-10 lines unless unavoidable.",
          "The code_location must overlap the diff/change under review.",
          "Use one finding per distinct issue. Do not generate or apply a fix patch.",
          "Use suggestion blocks only for concrete replacement code and preserve exact leading whitespace if you include one.",
        ].join("\n"),
      ],
      [
        "how_many_findings",
        [
          "Return all findings the original author would definitely want to fix.",
          "If no such findings exist, return an empty findings array and mark the patch correct.",
          "Do not stop after the first qualifying finding; continue until every qualifying finding is listed.",
        ].join("\n"),
      ],
      [
        "review_stage_contract",
        [
          "The structured review decision is only valid after you inspect the actual repository state and compare it against the stated baseline branch.",
          "Do not approve based solely on workflow stage summaries or prior agent reasoning.",
          "The tool call is the final verdict after review work, not a shortcut around review work.",
        ].join("\n"),
      ],
      [
        "required_actions_before_tool_call",
        [
          "1. Identify the changed files or diff under review.",
          "2. Read the relevant changed code and directly affected call sites/tests/configs.",
          "3. Run or delegate focused validation when needed to resolve uncertainty.",
          "4. If you cannot inspect or validate enough to approve safely, populate reviewer_error and set stop_review_loop=false.",
        ].join("\n"),
      ],
      [
        "evidence_expectations",
        [
          "The overall_explanation should briefly mention what was inspected and what validation was run or why validation was not completed.",
          "Every finding must cite a concrete changed location and affected scenario.",
        ].join("\n"),
      ],
      [
        "structured_output_contract",
        [
          "You have a structured-output tool named review_decision. Use it after your investigation and validation attempts.",
          "The tool terminates the turn and provides the structured data; do not emit a separate final assistant response after calling it.",
          "The review loop decides whether to stop only by parsing the JSON object returned by this tool; invalid JSON, missing fields, reviewer_error, or stop_review_loop=false are treated as not approved for safety.",
          "Set stop_review_loop=true only when findings is empty, overall_correctness is patch is correct, and reviewer_error is null/omitted.",
          "If you hit a reviewer/tool/validation error, still return the object with stop_review_loop=false and reviewer_error populated instead of pretending the patch is approved.",
          "The review_decision tool schema is authoritative; do not copy a hand-written JSON blob into the final response. Here is an example output:",
          "{",
          '  "findings": [',
          "    {",
          '      "title": "<≤ 80 chars, imperative, starts with [P0]/[P1]/[P2]/[P3]>",',
          '      "body": "<one paragraph of valid Markdown explaining why this is a problem; cite files/lines/functions>",',
          '      "confidence_score": <float 0.0-1.0>,',
          '      "priority": <int 0-3 or null>,',
          '      "code_location": {',
          '        "absolute_file_path": "<absolute file path>",',
          '        "line_range": {"start": <int>, "end": <int>}',
          "      }",
          "    }",
          "  ],",
          '  "overall_correctness": "patch is correct" | "patch is incorrect",',
          '  "overall_explanation": "<1-3 sentence explanation justifying the verdict>",',
          '  "overall_confidence_score": <float 0.0-1.0>,',
          '  "goal_oracle_satisfied": <boolean>,',
          '  "receipt_assessment": "<how receipts/current evidence map to the verification oracle>",',
          '  "verification_remaining": "<oracle-relevant verification still missing, or none>",',
          '  "stop_review_loop": <boolean>,',
          '  "reviewer_error": null | {"kind": "validation_unavailable" | "dependency_unavailable" | "tool_failure" | "reviewer_failure", "message": "<what failed>", "attempted_recovery": "<what you tried>"}',
          "}",
        ].join("\n"),
      ],
    ]);

    let reviews: WorkflowTaskResult[];
    try {
      reviews = await ctx.parallel(
        [
          {
            name: "reviewer-a",
            task: reviewPrompt,
            reads: [
              specPath,
              implementationNotesPath,
              orchestratorReportPath,
              simplifierReportPath,
            ],
            ...reviewerModelConfig,
          },
          {
            name: "reviewer-b",
            task: reviewPrompt,
            reads: [
              specPath,
              implementationNotesPath,
              orchestratorReportPath,
              simplifierReportPath,
            ],
            ...reviewerModelConfig,
          },
        ],
        {
          task: prompt,
          failFast: false,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reviews = [reviewerErrorResult(message)];
    }

    const reviewEntries = await Promise.all(reviews.map(async (review) => {
      const reviewer = review.name ?? review.stageName;
      const decision = parseReviewDecision(review.text) ??
        reviewerErrorDecision(`Reviewer ${reviewer} returned invalid structured JSON.`);
      const artifactPath = join(
        artifactDir,
        `review-${iteration}-${artifactSafeName(reviewer)}.json`,
      );
      await writeJsonArtifact(artifactPath, {
        iteration,
        reviewer,
        decision,
        raw_text: review.text,
      });
      return { reviewer, artifact_path: artifactPath, decision };
    }));
    approved =
      reviewEntries.length > 0 &&
      reviewEntries.every((review) => reviewDecisionApproved(review.decision));
    latestReviewReportPath = await writeJsonArtifact(
      join(artifactDir, `review-round-${iteration}.json`),
      { iteration, reviews: reviewEntries },
    );
    if (approved) break;
  }

  if (createPr === true) {
    const prResult = await ctx.task("pull-request", {
      prompt: taggedPrompt([
        [
          "role",
          "You are a careful release engineer preparing a provider-appropriate pull request, merge request, or code-review handoff from the current workspace state.",
        ],
        [
          "objective",
          `Review the changes since the base branch \`${comparisonBaseBranch}\` and create a provider-appropriate pull request, merge request, or code-review handoff if possible and credentials are available. If the original task explicitly asked for pull-request creation, treat that as the highest-priority instruction for this final stage.`,
        ],
        workflowCwdContext,
        [
          "workflow_context",
          [
            `Original task: ${prompt}`,
            `Review loop approved: ${approved ? "yes" : "no"}`,
            finalPlanPath
              ? `Planner spec path: ${finalPlanPath}`
              : "Planner spec path: unavailable",
            `Implementation notes path: ${implementationNotesPath}`,
            latestReviewReportPath === undefined
              ? "Latest review artifact: unavailable"
              : `Latest review artifact: ${latestReviewReportPath}`,
          ].join("\n"),
        ],
        [
          "required_checks",
          [
            "Start by inspecting `git status --short` so unstaged, staged, and untracked changes are all visible.",
            `Review the patch against \`${comparisonBaseBranch}\` with working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\`.`,
            "If untracked files are present, inspect them directly before deciding whether they belong in the PR.",
            "Read the implementation notes file and use its full contents as the body of a provider-appropriate PR/review comment after the pull request, merge request, or review exists.",
            "Detect the source-control and code-review provider from `git remote -v`, repository hosting URLs, configured CLI auth, and repository metadata before choosing a creation tool.",
            "Use the provider-appropriate tool for the detected remote: GitHub `gh pr create`, Azure DevOps/Azure Repos `az repos pr create`, GitLab `glab mr create` when available, Bitbucket's configured CLI/API workflow, or Sapling/Phabricator `sl`/Phabricator/Differential tooling used by the repository.",
            "Check the local Git identity with `git config user.name` and `git config user.email` so you can prefer the matching account when multiple provider accounts are logged in.",
            "Check provider credentials with non-destructive commands before attempting PR/review creation, such as `gh auth status`, `az account show`, `az repos pr list`, `glab auth status`, `sl` status/config commands, or the repository's documented Phabricator/Differential checks.",
            "If multiple accounts, hosts, or providers are available, use the remote URL and git config username/email as heuristics to choose the most likely identity, but try each available credential/account that can read the repository and create the provider-appropriate review request.",
          ].join("\n"),
        ],
        [
          "pr_policy",
          [
            "Create a provider-appropriate PR/MR/review request only if there are meaningful changes, a remote/branch target is available, credentials are available, and the current state is suitable for review.",
            "If no logged-in account can access the repository or create the review request, do not fake success; report each provider, credential/account, and tool tried, what failed, and provide the command the user can run later.",
            "When you successfully create or update the review request, create a provider-appropriate comment containing the implementation notes file contents as the last action of this workflow stage.",
            "Ralph-created worktrees are detached HEAD checkouts. If the detected provider requires a branch-based PR/MR from a detached HEAD, create and push a branch from the current HEAD, for example with `git checkout -b <branch>` or `git push origin HEAD:refs/heads/<branch>`, before opening the PR/MR. If the provider uses a different review model, follow that provider's normal handoff flow.",
            "Ralph does not remove git_worktree_dir automatically. Leave the worktree intact for retries or user recovery.",
            "If PR/MR/review creation is not possible, do not create a standalone comment elsewhere; include the implementation notes path and summary in your report instead.",
            "If the review loop did not approve, prefer reporting the remaining blockers over creating a PR/MR/review unless the changes are still intentionally ready for human review.",
            "Do not make unrelated code edits in this phase. Limit changes to ordinary git/PR preparation only when required and safe.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Return Markdown with headings:",
            "1. Change review — summary of files and diff scope inspected",
            "2. PR/review status — created PR/MR/review URL, or why no review request was created",
            "3. Implementation notes comment — whether the provider-appropriate comment was created as the last action, or why it could not be created",
            "4. Commands run — include exit status or clear outcome",
            "5. Follow-up for the user — exact next steps if credentials or repository state blocked PR creation",
          ].join("\n"),
        ],
      ]),
      reads: [
        ...(finalPlanPath ? [finalPlanPath] : []),
        implementationNotesPath,
        ...(latestReviewReportPath === undefined ? [] : [latestReviewReportPath]),
      ],
      ...orchestratorModelConfig,
    });
    finalPrReport = prResult.text;
  }

  return {
    result: finalResult,
    plan: finalPlan,
    plan_path: finalPlanPath,
    implementation_notes_path: implementationNotesPath,
    ...(finalPrReport === undefined ? {} : { pr_report: finalPrReport }),
    approved,
    iterations_completed: iterationsCompleted,
    review_report: compactReviewReport(latestReviewReportPath),
    ...(latestReviewReportPath === undefined ? {} : { review_report_path: latestReviewReportPath }),
  };
}

export default defineWorkflow("ralph")
  .description(
    "Plan → orchestrate → simplify → parallel review loop with bounded iteration.",
  )
  .input("prompt", Type.String({ description: "The task or goal to plan, execute, and refine." }))
  .input("max_loops", Type.Number({
    default: DEFAULT_MAX_LOOPS,
    description: `Maximum plan/orchestrate/review iterations (default ${DEFAULT_MAX_LOOPS}).`,
  }))
  .input("base_branch", Type.String({
    default: "origin/main",
    description: "Branch reviewers compare the current code delta against (default origin/main).",
  }))
  .input("git_worktree_dir", Type.String({
    default: "",
    description:
      "Optional Git worktree path. Ralph must start inside a Git repo; absolute paths are used as-is, relative paths resolve from the repo root, existing Git worktrees from the invoking repository are reused/shared as-is, and missing paths are created from base_branch.",
  }))
  .input("create_pr", Type.Boolean({
    default: false,
    description:
      "Whether to run the final pull-request creation stage. Defaults to false; prompt text alone does not opt in. Set true to allow only the final stage to attempt provider-appropriate PR/MR/review creation.",
  }))
  .worktreeFromInputs({
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  })
  .output("result", Type.Optional(Type.String({ description: "Final implementation report from the orchestrator stage." })))
  .output("plan", Type.Optional(Type.String({ description: "Latest RFC-style plan text." })))
  .output("plan_path", Type.Optional(Type.String({ description: "Path to the latest generated spec under specs/." })))
  .output("implementation_notes_path", Type.Optional(Type.String({ description: "OS-temp notes file containing decisions, deviations, blockers, and validation notes." })))
  .output("pr_report", Type.Optional(Type.String({ description: "Pull-request report emitted only when create_pr=true and the final pull-request stage runs." })))
  .output("approved", Type.Optional(Type.Boolean({ description: "Whether the reviewer loop approved before completion or optional final handoff." })))
  .output("iterations_completed", Type.Optional(Type.Number({ description: "Number of plan/orchestrate/review loops completed." })))
  .output("review_report", Type.Optional(Type.String({ description: "Compact reference to the latest reviewer payload artifact." })))
  .output("review_report_path", Type.Optional(Type.String({ description: "JSON artifact path for the latest Ralph review round." })))
  .run(async (ctx) => {
    const workflowCtx = ctx;
    const workflowStartCwd = workflowCtx.cwd ?? process.cwd();
    const inputs = workflowCtx.inputs;
    const prompt = inputs.prompt;
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);
    const comparisonBaseBranch = normalizeBranchInput(
      inputs.base_branch,
      "origin/main",
    );
    const createPr = inputs.create_pr === true;
    return await runRalphWorkflow(workflowCtx, {
      prompt,
      maxLoops,
      comparisonBaseBranch,
      workflowStartCwd,
      createPr,
    });
  })
  .compile();
