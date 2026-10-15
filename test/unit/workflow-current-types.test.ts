import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkflowHeartbeatAnchorRecord } from "../../packages/workflows/src/durable/workflow-heartbeat-anchor.js";
import type { ConfigLoadResult } from "../../packages/workflows/src/extension/config-loader.js";
import type { WorkflowHeartbeatLaunchRecord } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import type { WorkflowRunStatusSummary } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import type { RunDetail } from "../../packages/workflows/src/runs/background/run-inspect.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type {
	StageOptions,
	WorkflowScopedModel,
} from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type {
	RunResult as AuthoredRunResult,
	WorkflowUIAdapter,
} from "../../packages/workflows/src/shared/authoring-contract-ui.js";

test("current execution and inspection collections and UI methods are required", () => {
	const runtimeToolNodesOptional: object extends Pick<RunResult, "toolNodes"> ? true : false = false;
	const authoredToolNodesOptional: object extends Pick<AuthoredRunResult, "toolNodes"> ? true : false = false;
	const inspectionToolsOptional: object extends Pick<RunDetail, "tools"> ? true : false = false;
	const summaryToolsOptional: object extends Pick<WorkflowRunStatusSummary, "tools"> ? true : false = false;
	const customOptional: object extends Pick<WorkflowUIAdapter, "custom"> ? true : false = false;
	assert.deepEqual(
		[
			runtimeToolNodesOptional,
			authoredToolNodesOptional,
			inspectionToolsOptional,
			summaryToolsOptional,
			customOptional,
		],
		[false, false, false, false, false],
	);
});

test("current authored model options exclude separate reasoning fields", () => {
	const stageThinking: "thinkingLevel" extends keyof StageOptions ? true : false = false;
	const fallbackThinking: "fallbackThinkingLevels" extends keyof StageOptions ? true : false = false;
	const scopedThinking: "thinkingLevel" extends keyof WorkflowScopedModel ? true : false = false;
	assert.deepEqual([stageThinking, fallbackThinking, scopedThinking], [false, false, false]);
});

test("current configuration results and heartbeat records require their written fields", () => {
	const globalConfigOptional: object extends Pick<ConfigLoadResult, "globalConfig"> ? true : false = false;
	const projectConfigOptional: object extends Pick<ConfigLoadResult, "projectConfig"> ? true : false = false;
	const anchorCadenceOptional: object extends Pick<WorkflowHeartbeatAnchorRecord, "intervalMinutes"> ? true : false =
		false;
	const launchCadenceOptional: object extends Pick<WorkflowHeartbeatLaunchRecord, "intervalMinutes"> ? true : false =
		false;
	const emptyConfig: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
	assert.deepEqual(
		[globalConfigOptional, projectConfigOptional, anchorCadenceOptional, launchCadenceOptional],
		[false, false, false, false],
	);
	assert.equal(emptyConfig.globalConfig, null);
	assert.equal(emptyConfig.projectConfig, null);
});
