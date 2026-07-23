import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { bindWorkflowReplyTracker, preserveWorkflowReplyTracker } from "../../packages/intercom/workflow-reply-tracker.js";

const sender: SessionInfo = {
  id: "sender-1",
  name: "reviewer",
  cwd: "/repo",
  model: "test",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};
const message: Message = {
  id: "message-1",
  timestamp: 1,
  expectsReply: true,
  content: { text: "please reply" },
};

function stageContext(boundary: WorkflowStageAdmissionBoundary): ExtensionContext {
  return {
    orchestrationContext: {
      kind: "workflow-stage",
      workflowRunId: "run-1",
      workflowStageId: "stage-1",
      workflowStageName: "review",
      constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
      messageAdmission: {
        boundary,
        extensionState: new Map(),
        isOpen: () => boundary.isOpen(),
      },
    },
  } as ExtensionContext;
}

test("model-fallback sessions share Intercom reply correlation for the stage generation", () => {
  const boundary = new WorkflowStageAdmissionBoundary();
  const context = stageContext(boundary);
  const primary = bindWorkflowReplyTracker(context, new ReplyTracker());
  const incoming = primary.recordIncomingMessage(sender, message);
  primary.queueTurnContext(incoming);

  const fallback = bindWorkflowReplyTracker(context, new ReplyTracker());
  assert.equal(fallback, primary);
  fallback.beginTurn();
  assert.equal(fallback.resolveReplyTarget({}).message.id, message.id);
  assert.equal(preserveWorkflowReplyTracker(context), true);

  boundary.seal();
  assert.equal(preserveWorkflowReplyTracker(context), false);
});
