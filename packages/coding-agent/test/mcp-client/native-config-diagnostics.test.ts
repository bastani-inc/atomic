import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadMcpConfig } from "../../src/extensions/mcp/config.js";

test("malformed MCP configuration diagnostics never quote credential contents", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "native-mcp-diagnostic-"));
	try {
		writeFileSync(join(agentDir, "mcp.json"), "private-supervisor-credential");
		const config = loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false });
		assert.deepEqual(config.servers, []);
		assert.deepEqual(config.errors, [`${join(agentDir, "mcp.json")}: failed to read or parse MCP configuration`]);
		assert.doesNotMatch(JSON.stringify(config.errors), /private-supervisor-credential/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
