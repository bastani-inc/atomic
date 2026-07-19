import { test } from "bun:test";
import assert from "node:assert/strict";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

type Group = string | true;
interface AuthoredSet { group?: Group; itemGroups?: readonly [Group, Group] }

function assertSharedUuid(groups: readonly string[]): void {
  assert.equal(groups.length, 2);
  assert.equal(groups[0], groups[1]);
  assert.match(groups[0]!, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
}

async function runAuthoredSets(sets: readonly AuthoredSet[]): Promise<string[]> {
  const groups: string[] = [];
  const definition = workflow({
    name: "authored-auto-group",
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      for (const set of sets) {
        await ctx.parallel([
          { name: "reviewer-a", task: "review A", ...(set.itemGroups ? { group: set.itemGroups[0] } : {}) },
          { name: "reviewer-b", task: "review B", ...(set.itemGroups ? { group: set.itemGroups[1] } : {}) },
        ], set.group === undefined ? {} : { group: set.group });
      }
      return {};
    },
  });
  const result = await run(definition, {}, {
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
  assert.equal(result.status, "completed");
  return groups;
}

test("authored ctx.parallel normalizes a string auto group into one shared UUID", async () => {
  assertSharedUuid(await runAuthoredSets([{ group: " AuTo " }]));
});

test("separate authored string-auto parallel sets receive different UUIDs", async () => {
  const groups = await runAuthoredSets([{ group: "true" }, { group: " AUTO " }]);
  assertSharedUuid(groups.slice(0, 2));
  assertSharedUuid(groups.slice(2, 4));
  assert.notEqual(groups[0], groups[2]);
});

test("authored boolean true remains auto while a named group remains literal", async () => {
  const booleanGroups = await runAuthoredSets([{ group: true }]);
  assertSharedUuid(booleanGroups);
  const namedGroups = await runAuthoredSets([{ group: "reviewers" }]);
  assert.deepEqual(namedGroups, ["reviewers", "reviewers"]);
});

test("authored per-step string sentinels normalize before shared UUID minting", async () => {
  assertSharedUuid(await runAuthoredSets([{ itemGroups: [" TrUe ", " aUtO "] }]));
});
