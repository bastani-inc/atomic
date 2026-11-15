import assert from "node:assert/strict";
import { Agent } from "@bastani/atomic-agent-core";
import { test } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { CancelReceipt } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { BashToolDetails } from "../../packages/coding-agent/src/core/tools/bash.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { sleep } from "../helpers/runtime.js";

for (const stage of [false, true]) {
	test(`actual ${stage ? "workflow-stage" : "main"} session registers and binds shell kill to its own tasks`, async () => {
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const boundary = new WorkflowStageAdmissionBoundary();
		const makeSession = () =>
			new AgentSession({
				agent: new Agent({
					streamFn: () => {
						throw new Error("No model request expected");
					},
				}),
				modelRuntime,
				cwd: process.cwd(),
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				...(stage
					? {
							orchestrationContext: {
								kind: "workflow-stage" as const,
								workflowRunId: "run",
								workflowStageId: "stage",
								workflowStageName: "stage",
								constraints: { disableWorkflowTool: true },
								messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
							},
						}
					: {}),
			});
		const session = makeSession();
		try {
			assert.ok(session.getActiveToolNames().includes("kill"));
			const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
			const kill = session.agent.state.tools.find((tool) => tool.name === "kill");
			assert.ok(bash && kill);
			const launch = await bash.execute("session-launch", { command: "sleep 60", wait: { kind: "background" } });
			const observation = (launch.details as BashToolDetails).observation;
			assert.ok(observation?.kind === "yielded");
			const id = observation.taskId;
			const stopped = await kill.execute("session-kill", { id });
			assert.equal((stopped.details as CancelReceipt).taskId, id);
			const deadline = Date.now() + 5000;
			for (;;) {
				const result = await kill.execute("session-kill-repeat", { id });
				const receipt = result.details as CancelReceipt;
				if (receipt.execution.kind === "settled" && receipt.cleanup.kind === "reaped") {
					assert.equal(receipt.execution.result.kind, "cancelled");
					break;
				}
				assert.ok(Date.now() < deadline, JSON.stringify(receipt));
				await sleep(10);
			}
		} finally {
			if (stage) await boundary.close();
			session.dispose();
		}
	});
}
