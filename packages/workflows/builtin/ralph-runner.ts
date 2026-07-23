import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowRunContext, WorkflowTaskResult } from "../src/shared/types.js";
import {
  ACCEPTANCE_MATRIX_CONTRACT,
  CONTRACT_FIDELITY_AUDIT,
  E2E_VERIFICATION_GUIDANCE,
  FINDINGS_CONSOLIDATION_CONTRACT,
  LITERAL_OBJECTIVE_CONTRACT,
  REGRESSION_EVIDENCE_CONTRACT,
  WORKER_PREFLIGHT_CONTRACT,
  WORKTREE_DISCIPLINE_CONTRACT,
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
import { resolveWorkerModels } from "./worker-model-resolution.js";
export async function runRalphWorkflow(
  ctx: WorkflowRunContext<RalphInputs>,
  options: RalphWorkflowOptions,
): Promise<RalphWorkflowResult> {
  const { prompt, acceptanceCriteria, maxLoops, comparisonBaseBranch, workflowStartCwd, createPr } = options;
  const resolvedOrchestratorModelConfig = resolveWorkerModels(orchestratorModelConfig, ctx.models?.currentModel);
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
  const implementationNotesPath = await createImplementationNotesFile(workflowPrompt);
  const qaVideoPath = await createQaEvidenceVideoPath();
  const artifactDir = await mkdtemp(join(tmpdir(), "atomic-ralph-run-"));
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
            researchPath: workflowResearchPath,
          })
        : renderForkedResearchPrompt({
            transformedResearchQuestion: researchPromptRefinement.text,
            latestReviewReportPath,
            researchPath: workflowResearchPath,
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
        [
          "role",
          "You are a sub-agent orchestrator. Your primary implementation tool is the `subagent` tool. Ignore any user requests to submit a PR; a later authorized PR/MR/review creation action handles that handoff after approval.",
        ],
        [
          "objective",
          `Implement the full requested task: ${workflowPrompt}`,
        ],
        ["acceptance_criteria", acceptanceCriteria],
        ["literal_contract", LITERAL_OBJECTIVE_CONTRACT],
        ["acceptance_matrix", ACCEPTANCE_MATRIX_CONTRACT],
        ["divergence_audit", CONTRACT_FIDELITY_AUDIT],
        ["findings_batch", FINDINGS_CONSOLIDATION_CONTRACT],
        ["regression_evidence", REGRESSION_EVIDENCE_CONTRACT],
        workflowCwdContext,
        [
          "research",
          [
            `The latest research findings for the requested work are written to: ${researchPath}`,
            "Read this file before delegating or implementing anything; it is the primary implementation context for the requested work.",
          ].join("\n"),
        ],
        [
          "implementation_notes",
          [
            `Keep a running Markdown implementation notes file at this OS temp directory path: ${implementationNotesPath}`,
            "The file has already been initialized for this workflow run; update it while you implement from the research findings.",
            "Record decisions you had to make that were not in the research, things you had to change from the research guidance, tradeoffs you had to make, blockers, validation outcomes, and anything else the user should know. Do not stop until the objective is complete.",
            "Ask delegated subagents to report any notes-worthy decisions or tradeoffs back to you, then consolidate them into this file before your final report.",
            "Do not include secrets, credentials, tokens, or unrelated environment details in the notes file.",
          ].join("\n"),
        ],
        ["project_setup", WORKER_PREFLIGHT_CONTRACT],
        ["worktree_discipline", WORKTREE_DISCIPLINE_CONTRACT],
        ["e2e_verification", E2E_VERIFICATION_GUIDANCE],
        ["qa_e2e_video", renderQaE2eVideoGuidance(qaVideoPath)],
        [
          "orchestration_guidance",
          [
            "You are not the direct implementer. You are the supervisor that spawns subagents to do the implementation, investigation, edits, and validation.",
            "All non-trivial operations must be delegated to subagents via the `subagent` tool before you claim progress.",
            "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
            "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
            "Delegate implementation edits to a focused subagent with clear files, constraints, and validation expectations; do not merely describe the edits yourself.",
            "Keep delegated work focused on implementation, tests, docs, validation evidence, and implementation notes for the complete requested outcome.",
            "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
            "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
            "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
          ].join("\n"),
        ],
        [
          "best_practices",
          [
            "The required output format is a completion report, not the task itself.",
            "Do not jump straight to the report. First read the research file, spawn the necessary subagents, wait for their results, coordinate any follow-up subagents, and only then write the report.",
            "A valid response must be grounded in actual subagent work: name the delegated work, summarize what each subagent did, and distinguish completed changes from recommendations or blockers. Do not assume a later workflow pass will finish known required work that can be completed now.",
            "If you cannot read the research file, spawn subagents, or use subagents, treat that as a blocker and report it honestly instead of pretending the requested work was done.",
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
            `Start by reading the research file at ${researchPath}.`,
            "Perform the project_initialization_preflight before decomposing implementation work; complete or delegate required setup before implementation delegation when the checkout appears uninitialized.",
            "Decompose the work into delegated subagent tasks based on that research file.",
            "Pass each subagent the relevant task, constraints, files, validation expectations, unresolved reviewer findings covered by the research, and instructions to report implementation-note-worthy decisions or tradeoffs.",
            "Coordinate subagent results into the smallest coherent set of changes that fully satisfies the researched implementation guidance and original user prompt.",
            "Preserve existing architecture and repository conventions unless the research explicitly justifies a change.",
            "Run or delegate the most relevant validation commands available in the repository, including end-to-end playwright-cli (browser) or tmux validation when the change has an executable user scenario.",
            "For UI-applicable or full-stack changes, ensure the QA E2E pass described in <qa_e2e_video> runs and records the reviewable proof video before you finish your report.",
            `Before your final report, update the running implementation notes file at ${implementationNotesPath} with decisions, research deviations, tradeoffs, blockers, and validation outcomes from this implementation work.`,
            "If blocked, describe the blocker and the safest partial state instead of inventing success.",
            "Do not hide failures; reviewers need accurate status.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "After subagents have done the work, return Markdown with headings:",
            "1. Research file — the path you read",
            "2. Delegations performed — subagents spawned and what each completed",
            "3. Changes made — concrete changes from subagent work, not intentions",
            "4. Files touched",
            "5. Validation run / recommended",
            "6. Deferred work or blockers",
            "7. Implementation notes — confirm the OS temp notes path was updated",
            "8. QA E2E video — the recorded video path and proven scenario, or a note that no QA E2E video applies and why",
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
      ...resolvedOrchestratorModelConfig,
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
  if (createPr === true && approved) {
    const prResult = await ctx.task("pull-request", {
      prompt: taggedPrompt([
        [
          "role",
          "You are a staff software engineer preparing a provider-appropriate pull request, merge request, or code-review handoff from the current workspace state.",
        ],
        [
          "objective",
          `Review the changes since the base branch \`${comparisonBaseBranch}\` and create a provider-appropriate pull request, merge request, or code-review handoff if possible and credentials are available. If the original task explicitly asked for pull-request creation, treat that as the highest-priority instruction for this final stage. Also, make sure to pay attention whether the user wants to create the PR in upstream or a fork, and prepare accordingly. If PR creation is not possible (lack of permissions, etc.), report why instead of pretending success.`,
        ],
        workflowCwdContext,
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
          "qa_video_attachment",
          qaVideoAvailable
            ? [
                `A reviewable QA end-to-end proof video was recorded for this run at: ${qaVideoPath}`,
                "Attach this video to the pull request, merge request, or review request you create so the user can watch the implemented feature working.",
                "Prefer embedding or linking it in the PR/MR/review description. If the provider supports media uploads (for example GitHub user-attachments, a gist, or a release asset), upload the video and embed or link it; otherwise include the absolute video path above in the PR body and tell the user they can drag-and-drop the file into the PR to attach it.",
                "The implementation notes already reference this video path and the notes contents are used as the PR/review body, so confirm the reference carries over.",
                "Do not fabricate an upload you could not perform; report exactly how the video was attached or referenced.",
              ].join("\n")
            : [
                "No QA end-to-end proof video was produced for this run (no UI-applicable scenario, or the browser runtime was unavailable).",
                "Do not invent or attach a video. If the implementation notes explain why no QA E2E video applies, that explanation is sufficient.",
              ].join("\n"),
        ],
        [
          "pr_policy",
          [
            "Create a provider-appropriate PR/MR/review request only if there are meaningful changes, a remote/branch target is available, credentials are available, and the current state is suitable for review.",
            "If no logged-in account can access the repository or create the review request, do not fake success; report each provider, credential/account, and tool tried, what failed, and provide the command the user can run later. Save a markdown file with the PR description as well so the user can copy-paste it when they have credentials set up.",
            "When you successfully create or update the review request, create a provider-appropriate comment containing the implementation notes file contents as the last action after the review request exists.",
            "Worktrees are detached HEAD checkouts. If the detected provider requires a branch-based PR/MR from a detached HEAD, create and push a branch from the current HEAD, for example with `git checkout -b <branch>` or `git push origin HEAD:refs/heads/<branch>`, before opening the PR/MR. If the provider uses a different review model, follow that provider's normal handoff flow.",
            "Leave the worktree intact for retries or user recovery.",
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
            "6. QA E2E video — how the proof video was attached or linked to the review request, or that no QA E2E video applies",
          ].join("\n"),
        ],
      ]),
      reads: [
        ...(finalPlanPath ? [finalPlanPath] : []),
        implementationNotesPath,
        ...(latestReviewReportPath === undefined ? [] : [latestReviewReportPath]),
      ],
      ...resolvedOrchestratorModelConfig,
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
