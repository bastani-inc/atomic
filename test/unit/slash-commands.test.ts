import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { APP_NAME } from "../../packages/coding-agent/src/config.js";
import { BUILTIN_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";

describe("built-in slash commands", () => {
  test("lists /exit as a graceful shutdown command", () => {
    const command = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "exit");

    assert.ok(command, "expected /exit to be listed as a built-in command");
    assert.equal(command.description, `Exit ${APP_NAME}`);
  });
});
