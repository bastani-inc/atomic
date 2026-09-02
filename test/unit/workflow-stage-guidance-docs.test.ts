import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { PENDING_STAGE_DELIVERY_GUIDANCE } from "../../packages/workflows/builtin/shared-prompts.js";
import { formatWorkflowHeartbeatNoticeText } from "../../packages/workflows/src/extension/workflow-heartbeat-notice.js";
import { WORKFLOW_TOOL_DESCRIPTION } from "../../packages/workflows/src/extension/workflow-prompts.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const documentationPaths = [
	"packages/intercom/skills/intercom/SKILL.md",
	"packages/intercom/docs/workflow-stage-discovery.md",
	"packages/workflows/README.md",
	"packages/intercom/README.md",
	"packages/coding-agent/docs/intercom.md",
	"packages/coding-agent/docs/workflows.md",
] as const;
const promptSourcePaths = [
	"packages/intercom/intercom-tool.ts",
	"packages/intercom/index.ts",
	"packages/workflows/src/extension/workflow-heartbeat-notice.ts",
	"packages/workflows/src/extension/workflow-prompts.ts",
	"packages/workflows/builtin/shared-prompts.ts",
] as const;

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

describe("workflow-stage path guidance", () => {
	test("removes the legacy run-and-stage target forms from D11 surfaces", async () => {
		for (const path of [...documentationPaths, ...promptSourcePaths]) {
			const content = await readRepositoryFile(path);
			assert.doesNotMatch(content, /<runId>:<stage(?:Key|Id)>/, path);
		}
	});

	test("teaches canonical paths and recursive broadcast in every user-facing document", async () => {
		for (const path of documentationPaths) {
			const content = await readRepositoryFile(path);
			assert.match(content, /workflow:<rootRunId>\//, `${path} must teach the canonical path namespace`);
			assert.match(content, /workflow:<rootRunId>\/\*\*/, `${path} must teach the recursive broadcast`);
			assert.match(content, /intercom list/, `${path} must teach future-target discovery`);
			assert.match(content, /sticky/, `${path} must teach repeated future delivery`);
			assert.match(content, /notInKnownSet/, `${path} must teach speculative acceptance`);
			assert.match(content, /undeliverable/, `${path} must teach terminal settlement`);
			assert.match(content, /ask.*live/is, `${path} must reserve ask for live targets`);
		}
	});

	test("keeps recursive broadcast in every model-facing workflow guidance surface", () => {
		const heartbeat = formatWorkflowHeartbeatNoticeText({
			runId: "4ac72924-c452-4e5f-9e63-2435722109f7",
			workflowName: "goal",
			startedAt: 1_000,
			scheduledAt: 61_000,
			intervalMinutes: 15,
		});
		for (const guidance of [heartbeat, WORKFLOW_TOOL_DESCRIPTION, PENDING_STAGE_DELIVERY_GUIDANCE]) {
			assert.match(guidance, /workflow:<rootRunId>\/<segment>/);
			assert.match(guidance, /`\*` matches one segment and `\*\*` any depth/);
			assert.match(guidance, /workflow:<rootRunId>\/\*\*/);
			assert.match(guidance, /rather than enumerating stages/);
			assert.match(guidance, /intercom list/);
			assert.match(guidance, /sticky/);
			assert.match(guidance, /notInKnownSet/);
			assert.match(guidance, /undeliverable/);
			assert.match(guidance, /ask.*live/is);
		}
	});
});
