import { test } from "bun:test";
import { validateToolCall } from "@earendil-works/pi-ai/compat";
import assert from "node:assert/strict";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { createStore, mockSession } from "./executor-shared.js";

const workflowTool = [{
  name: "workflow",
  description: "Run a workflow",
  parameters: WorkflowParametersSchema,
}];

async function runGroupedSet(
  group?: string | true,
  itemGroups?: readonly [string | true, string | true],
): Promise<string[]> {
  const groups: string[] = [];
  const args = validateToolCall(workflowTool, {
    type: "toolCall",
    id: "workflow-direct-auto-group",
    name: "workflow",
    arguments: {
      tasks: [
        { name: "reviewer-a", task: "review A", ...(itemGroups ? { group: itemGroups[0] } : {}) },
        { name: "reviewer-b", task: "review B", ...(itemGroups ? { group: itemGroups[1] } : {}) },
      ],
      ...(group === undefined ? {} : { group }),
    },
  }) as WorkflowToolArgs;
  const runtime = createExtensionRuntime({
    store: createStore(),
    adapters: {
      agentSession: {
        async create(options) {
          groups.push(options.orchestrationContext?.intercomGroup ?? "missing");
          return mockSession();
        },
      },
    },
  });

  const details = await runtime.runDirect(args);
  assert.equal(details.status, "completed");
  return groups;
}

function assertSharedUuid(groups: readonly string[]): void {
  assert.equal(groups.length, 2);
  assert.equal(groups[0], groups[1]);
  assert.match(groups[0]!, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
}

test("direct workflow group:true shares one UUID per parallel set and isolates separate sets", async () => {
  const first = await runGroupedSet(true);
  const second = await runGroupedSet(true);

  assertSharedUuid(first);
  assertSharedUuid(second);
  assert.notEqual(first[0], "true");
  assert.notEqual(first[0], second[0]);
});

test("agent-style string true auto-groups each direct set while named groups remain literal", async () => {
  const first = await runGroupedSet("true");
  const second = await runGroupedSet("true");
  const named = await runGroupedSet("revlevel-1");

  assertSharedUuid(first);
  assertSharedUuid(second);
  assert.notEqual(first[0], "true");
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(named, ["revlevel-1", "revlevel-1"]);
});

test("item-level string auto sentinels are case-insensitive and trimmed", async () => {
  const groups = await runGroupedSet(undefined, [" TrUe ", " AuTo "]);

  assertSharedUuid(groups);
});
