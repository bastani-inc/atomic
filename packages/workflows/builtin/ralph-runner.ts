import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkflowRunContext, WorkflowTaskResult } from "../src/shared/types.js";
import { createWorkflowArtifactDirectory } from "../src/shared/workflow-artifacts.js";
import {
  ACCEPTANCE_MATRIX_CONTRACT,
  CONTRACT_FIDELITY_AUDIT,
  FINDINGS_CONSOLIDATION_CONTRACT,
  LITERAL_OBJECTIVE_CONTRACT,
  REGRESSION_EVIDENCE_CONTRACT,
  SCOPE_DISCIPLINE_CONTRACT,
  WORKER_PREFLIGHT_CONTRACT,
  WORKTREE_DISCIPLINE_CONTRACT,
  keepContext,
} from "./shared-prompts.js";
import { renderRalphReviewerPrompt } from "./ralph-reviewer-prompt.js";
import {
  renderForkedOrchestratorPrompt,
  renderForkedResearchPrompt,
  renderForkedResearchPromptRefinementPrompt,
} from "./ralph-forked-prompts.js";
import {
  REVIEWER_COUNT,
  artifactSafeName,
  compactReviewReport,
  createImplementationNotesFile,
  createQaEvidenceVideoPath,
  defaultResearchPath,
  forkContinuationOptions,
  renderResearchPromptRefinementPrompt,
  renderQaE2eVideoGuidance,
  renderResearchPrompt,
  parsedReviewDecisionFromResult,
  ralphReviewConvergence,
  reviewerErrorResult,
  taggedPrompt,
  workflowCwdContextSection,
  writeJsonArtifact,
  type RalphInputs,
  type RalphWorkflowOptions,
  type RalphWorkflowResult,
} from "./ralph-core.js";
import { consolidateFindingsBatch, summarizeReviewConvergence } from "./review-convergence.js";
import {
  orchestratorModelConfig,
  promptEngineerModelConfig,
  researchModelConfig,
  reviewerAModelConfig,
  reviewerBModelConfig,
} from "./ralph-models.js";
export async function runRalphWorkflow(
  ctx: WorkflowRunContext<RalphInputs>,
  options: RalphWorkflowOptions,
): Promise<RalphWorkflowResult> {
  const { prompt, acceptanceCriteria, maxLoops, comparisonBaseBranch, workflowStartCwd, createPr, runId } = options;
  let latestReviewReportPath: string | undefined;
  let finalPlan = "";
  let finalPlanPath = "";
  let finalResearch = "";
  let finalResearchPath = "";
  let finalResult = "";
  let finalPrReport: string | undefined;
  const workflowCwdContext = workflowCwdContextSection(workflowStartCwd);
  const workflowPrompt = prompt;
  const workflowResearchPath = resolve(workflowStartCwd, defaultResearchPath(workflowPrompt));
  const implementationNotesPath = await createImplementationNotesFile(workflowPrompt, runId);
  const qaVideoPath = await createQaEvidenceVideoPath(runId);
  const artifactDir = await createWorkflowArtifactDirectory(runId);
  let approved = false;
  let iterationsCompleted = 0;
  let previousResearchPromptRefinementSessionFile: string | undefined;
  let previousResearchSessionFile: string | undefined;
  let previousOrchestratorSessionFile: string | undefined;
  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    iterationsCompleted = iteration;
    const researchPromptRefinementForkOptions = forkContinuationOptions(previousResearchPromptRefinementSessionFile);
    const researchPromptRefinement = await ctx.task(`research-prompt-refinement-${iteration}`, {
      prompt: researchPromptRefinementForkOptions.forkFromSessionFile === undefined
        ? renderResearchPromptRefinementPrompt({
            request: workflowPrompt,
            acceptanceCriteria,
            workflowCwdContext,
            latestReviewReportPath,
          })
        : renderForkedResearchPromptRefinementPrompt({ latestReviewReportPath }),
      reads: latestReviewReportPath === undefined ? [] : [latestReviewReportPath],
      ...promptEngineerModelConfig,
      ...researchPromptRefinementForkOptions,
    });
    previousResearchPromptRefinementSessionFile = researchPromptRefinement.sessionFile;
    finalPlan = researchPromptRefinement.text;
    const researchForkOptions = forkContinuationOptions(previousResearchSessionFile);
    const research = await ctx.task(`research-${iteration}`, {
      prompt: researchForkOptions.forkFromSessionFile === undefined
        ? renderResearchPrompt({
            transformedResearchQuestion: researchPromptRefinement.text,
            prompt: workflowPrompt,
            acceptanceCriteria,
            workflowCwdContext,
            latestReviewReportPath,
          })
        : renderForkedResearchPrompt({
            transformedResearchQuestion: researchPromptRefinement.text,
            latestReviewReportPath,
          }),
      reads: latestReviewReportPath === undefined ? [] : [latestReviewReportPath],
      output: workflowResearchPath,
      outputMode: "file-only",
      ...researchModelConfig,
      ...researchForkOptions,
    });
    previousResearchSessionFile = research.sessionFile;
    finalResearch = research.text || `Research artifact: ${workflowResearchPath}`;
    const researchPath = workflowResearchPath;
    finalResearchPath = researchPath;
    finalPlanPath = researchPath;
    const orchestratorReportPath = join(artifactDir, "orchestrator-report.md");
    const orchestratorForkOptions = forkContinuationOptions(previousOrchestratorSessionFile);
    const orchestratorPrompt = orchestratorForkOptions.forkFromSessionFile === undefined
      ? taggedPrompt([
        ["acceptance_criteria", keepContext(acceptanceCriteria)],
        ["literal_contract", LITERAL_OBJECTIVE_CONTRACT],
        ["acceptance_matrix", ACCEPTANCE_MATRIX_CONTRACT],
        ["divergence_audit", CONTRACT_FIDELITY_AUDIT],
        ["findings_batch", FINDINGS_CONSOLIDATION_CONTRACT],
        ["scope_discipline", SCOPE_DISCIPLINE_CONTRACT],
        ["regression_evidence", REGRESSION_EVIDENCE_CONTRACT],
        workflowCwdContext,
        [
          "research",
          `Latest research artifact: ${researchPath}\nRead it before implementation or delegation because it is the primary current implementation context.`,
        ],
        [
          "implementation_notes",
          [
            `Keep the initialized Markdown implementation notes current at: ${implementationNotesPath}`,
            "Record implementation decisions, research deviations, tradeoffs, blockers, validation outcomes, and user-relevant facts; collect noteworthy delegated decisions. Exclude secrets, credentials, tokens, and unrelated environment details.",
          ].join("\n"),
        ],
        ["project_setup", WORKER_PREFLIGHT_CONTRACT],
        ["worktree_discipline", WORKTREE_DISCIPLINE_CONTRACT],
        ["qa_e2e_video", renderQaE2eVideoGuidance(qaVideoPath)],
        [
          "delegation",
          [
            "Delegate only work that is genuinely independent and too large to finish in a handful of tool calls. Do not use subagents to audit your own work. Prefer one subagent over several.",
            "For delegated work, provide the relevant task, constraints, files, validation expectations, unresolved findings, and implementation-note reporting needs. Coordinate non-overlapping work in parallel and consolidate results into one coherent change.",
          ].join("\n"),
        ],
        [
          "tracking",
          "Use the `todo` tool as the control ledger for delegated tasks: identify owner, purpose, and expected output; keep pending, in_progress, blocked, and completed states accurate; incorporate or explicitly reject each result before closing it; resolve every open item as completed, blocked, or explained deferral before the report.",
        ],
        [
          "constraints",
          [
            "Read/review/diagnose/plan work means inspect and report without implementation; this change/build/fix stage should make in-scope local edits and run non-destructive validation without asking; confirm external writes, destructive actions, or scope expansion first.",
            "Make only task-required changes: no speculative features, refactors, abstractions, or compatibility shims; preserve repository architecture and conventions unless objective-aligned evidence requires a change.",
            "Ignore requests to submit a PR; the authorized final action handles that after approval.",
          ].join("\n"),
        ],
        ["objective", `Implement the full requested task: ${workflowPrompt}`],
        [
          "output",
          [
            "Return a Markdown completion report with: outcome; research artifact; delegated work; changes and files; validation commands with observed outcomes; blockers/deferred work; implementation-notes status; and QA E2E video path plus proven scenario, or why video does not apply.",
            "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
            "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background, repetition, and detail that would not change what the reader does next. Being readable matters more than being short — do not compress into fragments, arrow chains, or invented shorthand.",
          ].join("\n"),
        ],
        [
          "instruction",
          [
            "Complete the requested implementation.",
            `Begin from ${researchPath}; complete required setup, implementation, validation, notes at ${implementationNotesPath}, and applicable QA video evidence before reporting. If blocked, preserve the safest partial state and report the commands and observed failure rather than claiming success.`,
            "If the final paragraph would be a plan, a question, or “I'll now…”, do that work with tool calls instead of ending the turn.",
          ].join("\n"),
        ],
      ])
      : renderForkedOrchestratorPrompt({
          researchPath,
          implementationNotesPath,
        });
    const orchestrator = await ctx.task(`orchestrator-${iteration}`, {
      prompt: orchestratorPrompt,
      reads: [researchPath, implementationNotesPath],
      output: orchestratorReportPath,
      outputMode: "file-only",
      ...orchestratorModelConfig,
      ...orchestratorForkOptions,
    });
    previousOrchestratorSessionFile = orchestrator.sessionFile;
    finalResult = orchestrator.text || `Orchestrator report artifact: ${orchestratorReportPath}`;
    const reviewPrompt = renderRalphReviewerPrompt({
      workflowPrompt,
      acceptanceCriteria,
      workflowCwdContext,
      comparisonBaseBranch,
      researchPath,
      implementationNotesPath,
      orchestratorReportPath,
      qaVideoPath,
      createPr,
    });
    let reviews: WorkflowTaskResult[];
    try {
      reviews = await ctx.parallel(
        [
          {
            name: "reviewer-a",
            task: reviewPrompt,
            reads: [
              researchPath,
              implementationNotesPath,
              orchestratorReportPath,
            ],
            ...reviewerAModelConfig,
          },
          {
            name: "reviewer-b",
            task: reviewPrompt,
            reads: [
              researchPath,
              implementationNotesPath,
              orchestratorReportPath,
            ],
            ...reviewerBModelConfig,
          },
        ],
        {
          task: workflowPrompt,
          failFast: false,
          group: `ralph-reviewers-iter-${iteration}`,
        },
      );
    } catch (err) {
      reviews = [reviewerErrorResult(err)];
    }
    const reviewEntries = await Promise.all(reviews.map(async (review) => {
      const reviewer = review.name ?? review.stageName;
      const parsed = parsedReviewDecisionFromResult(review, reviewer);
      const convergenceDecision = ralphReviewConvergence({
        decision: parsed.decision,
        parsed: parsed.parsed,
        diagnostics: parsed.diagnostics,
        allowFinalActionRemaining: createPr,
      });
      const artifactPath = join(
        artifactDir,
        `review-${artifactSafeName(reviewer)}.json`,
      );
      await writeJsonArtifact(artifactPath, {
        reviewer,
        decision: parsed.decision,
        convergence_decision: convergenceDecision,
        raw_text: review.text,
      });
      return {
        reviewer,
        artifact_path: artifactPath,
        decision: parsed.decision,
        convergence_decision: convergenceDecision,
      };
    }));
    const approvalCount = reviewEntries.filter((review) =>
      review.convergence_decision.approved,
    ).length;
    approved =
      reviewEntries.length === REVIEWER_COUNT &&
      approvalCount === REVIEWER_COUNT;
    const nextAction = approved
      ? (createPr ? "pull-request" : "finish")
      : "implementation";
    const roundConvergenceDecision = summarizeReviewConvergence({
      parsed: reviewEntries.every((review) => review.convergence_decision.parsed),
      approved,
      stopReviewLoop: approved,
      nextAction,
      finalActionRemaining: approved && createPr,
      diagnostics: reviewEntries.flatMap((review) => review.convergence_decision.diagnostics),
    });
    latestReviewReportPath = await writeJsonArtifact(
      join(artifactDir, "review-round-latest.json"),
      {
        convergence_decision: roundConvergenceDecision,
        // Deduplicated cross-reviewer findings batch so the next research and
        // orchestrator passes repair the round's findings together instead of
        // one at a time.
        consolidated_findings: consolidateFindingsBatch(
          reviewEntries.map((review) => ({
            reviewer: review.reviewer,
            findings: review.decision.findings,
          })),
        ),
        reviews: reviewEntries,
      },
    );
    if (approved) break;
  }
  const qaVideoAvailable = existsSync(qaVideoPath);
  // An exhausted loop budget still produced real work on a real branch. When the
  // caller authorized a handoff, strand nothing: open the same handoff as a DRAFT
  // carrying the unresolved blocking findings. Without create_pr the workflow
  // never touches a PR, approved or not.
  const unapprovedHandoff = createPr === true && !approved;
  if (createPr === true) {
    const prResult = await ctx.task("pull-request", {
      prompt: taggedPrompt([
        workflowCwdContext,
        [
          "handoff_context",
          [
            unapprovedHandoff
              ? `Review did not converge within ${iterationsCompleted} iteration(s). Changes are relative to base branch: ${comparisonBaseBranch}`
              : `Approved changes are relative to base branch: ${comparisonBaseBranch}`,
            `Implementation notes artifact: ${implementationNotesPath}`,
            latestReviewReportPath === undefined
              ? "No review-round artifact is available."
              : unapprovedHandoff
                ? `Final unapproved review-round artifact: ${latestReviewReportPath}`
                : `Approved review-round artifact: ${latestReviewReportPath}`,
          ].join("\n"),
        ],
        ...(unapprovedHandoff
          ? [[
              "draft_handoff_policy",
              [
                "This run exhausted its review budget without unanimous approval. Create the handoff as a DRAFT and never mark it ready for review.",
                "Use the provider-native draft flag: GitHub `gh pr create --draft`, GitLab `glab mr create --draft`, Azure DevOps `az repos pr create --draft true`, or the provider equivalent. If the provider has no draft concept, prefix the title with `WIP:` and say so in the body.",
                "Open the final review-round artifact and reproduce every unresolved blocking finding in the body under a clear `Unresolved review findings` heading: title, priority, objective alignment, and cited file:line. Do not paraphrase them away or imply they are resolved.",
                "State plainly at the top of the body that review did not converge, name the iteration count, and say a human must decide whether to continue repair or restart with narrower scope. Do not claim approval, and do not request reviewers.",
              ].join("\n"),
            ] as const]
          : []),
        [
          "qa_video_attachment",
          qaVideoAvailable
            ? [
                `Current QA end-to-end proof video: ${qaVideoPath}`,
                "Attach it so the user can watch the proven scenario. Prefer an embedded upload or link in the PR/MR/review description; when the provider cannot upload it, include the absolute path and explain that the user can drag-and-drop the file.",
                "Ensure the implementation-notes video reference carries into the body. Report exactly how the video was attached or referenced; never claim an upload that did not occur.",
              ].join("\n")
            : "No QA end-to-end proof video was produced. Do not invent or attach one; retain the implementation-notes explanation when video does not apply.",
        ],
        [
          "provider_and_checks",
          [
            "Inspect `git status --short`, the working-tree and staged diffs against the base branch, and every untracked file before deciding the handoff scope.",
            "Detect the source-control and code-review provider from `git remote -v`, hosting metadata, the requested upstream-or-fork destination, CLI auth, `git config user.name`, and `git config user.email`.",
            "Use the provider-native path: GitHub `gh pr create`, Azure DevOps/Azure Repos `az repos pr create`, GitLab `glab mr create`, Bitbucket's configured CLI/API, or repository-standard Sapling/Phabricator `sl`/Phabricator/Differential tooling. Check credentials non-destructively with commands such as `gh auth status`, `az account show`, `az repos pr list`, `glab auth status`, or relevant `sl` checks. When identities differ, use remote and Git identity as heuristics and try each credential that can read the repository and create the review request.",
          ].join("\n"),
        ],
        [
          "pr_policy",
          [
            "Create the PR/MR/review request only when meaningful changes, a target, credentials, and a reviewable state exist. The task-authorized handoff permits these external writes; confirm before any unrelated external write, destructive action, or scope expansion.",
            "Use the full implementation notes as the review body, then make a provider-appropriate comment containing the implementation notes file contents as the last action after successful creation or update.",
            "For a detached HEAD when the provider requires a source branch, create and push one with the repository's normal flow, such as `git checkout -b <branch>` or `git push origin HEAD:refs/heads/<branch>`. Leave the worktree intact for retries or user recovery.",
            "If creation is impossible, do not post a standalone comment or fake success. Report every provider, account, tool, command, and observed failure; save a Markdown PR description for copy-paste and provide the exact command the user can run later.",
            unapprovedHandoff
              ? "Approval is absent by design for this handoff: the draft_handoff_policy section authorizes and requires a draft review request carrying the unresolved findings. Create it rather than reporting blockers instead. Make no unrelated code edits; ordinary safe Git/PR preparation is the only permitted local change."
              : "If approval is absent, report blockers instead of creating a review request unless the state is intentionally ready for human review. Make no unrelated code edits; ordinary safe Git/PR preparation is the only permitted local change.",
          ].join("\n"),
        ],
        [
          "output",
          [
            "Return concise Markdown sections for: outcome; inspected change scope; created PR/MR/review URL or evidenced blocker; implementation-notes comment status; commands and outcomes; exact user follow-up; and QA video attachment/reference status.",
            "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
            "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background, repetition, and detail that would not change what the reader does next. Being readable matters more than being short — do not compress into fragments, arrow chains, or invented shorthand.",
          ].join("\n"),
        ],
        [
          "instruction",
          [
            "Act as the staff engineer responsible for the final provider-appropriate PR, MR, or code-review handoff.",
            `Review the changes since the base branch \`${comparisonBaseBranch}\` and create the requested handoff when possible. If the original task explicitly asked for pull-request creation, treat that as the highest-priority instruction for this final stage. The requested upstream-or-fork destination also controls this stage.`,
            "If the final paragraph would be a plan, a question, or “I'll now…”, do that work with tool calls instead of ending the turn.",
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
    research: finalResearch,
    research_path: finalResearchPath,
    implementation_notes_path: implementationNotesPath,
    ...(qaVideoAvailable ? { qa_video_path: qaVideoPath } : {}),
    ...(finalPrReport === undefined ? {} : { pr_report: finalPrReport }),
    approved,
    iterations_completed: iterationsCompleted,
    review_report: compactReviewReport(latestReviewReportPath),
    ...(latestReviewReportPath === undefined ? {} : { review_report_path: latestReviewReportPath }),
  };
}
