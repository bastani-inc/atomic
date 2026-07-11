import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  diagnoseIntercomBridge,
  resolveIntercomSessionTarget,
} from "../../packages/subagents/src/intercom/intercom-bridge.js";

const SESSION_ID_ENV = "ATOMIC_INTERCOM_SESSION_ID";

test("prefers the connected Intercom session id over a duplicate-prone display name", () => {
  const previous = process.env[SESSION_ID_ENV];
  process.env[SESSION_ID_ENV] = "broker-session-id";
  try {
    assert.equal(resolveIntercomSessionTarget("shared-name", "atomic-session-id"), "broker-session-id");
  } finally {
    if (previous === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = previous;
  }
});

test("detects Atomic's bundled Intercom extension in a source checkout", () => {
  const diagnostic = diagnoseIntercomBridge({
    config: undefined,
    context: "fresh",
    orchestratorTarget: "parent",
    cwd: process.cwd(),
  });
  assert.equal(diagnostic.active, true);
  assert.equal(diagnostic.piIntercomAvailable, true);
  assert.match(diagnostic.extensionDir, /packages[/\\]intercom$/);
});
