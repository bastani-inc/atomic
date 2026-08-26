import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";
import { DefaultMainDriver } from "./fixtures/default-main-driver.js";

const REAL_ENGINE_WORKFLOW_TIMEOUT_TIMEOUT_MS = 60_000;
const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

serialTest(
	"a real interactive engine settles workflow timeouts once and remains usable for interrupt",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-workflow-public-timeout-"));
		const extension = join(moduleDir(import.meta.url), "fixtures", "workflow-public-timeout-extension.ts");
		const driver = new DefaultMainDriver(
			[
				"--no-extensions",
				"--extension",
				extension,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
				"--approve",
				"--provider",
				"workflow-timeout-fixture",
				"--model",
				"workflow-timeout-model",
				"--session-dir",
				join(temp, "sessions"),
			],
			{ ATOMIC_CODING_AGENT_DIR: join(temp, "agent") },
		);
		try {
			await driver.waitFor((report) => report.type === "input_loop_ready");
			const initial = await driver.waitFor(
				(report) => report.type === "heartbeat" && typeof report.enginePid === "number",
			);

			let from = driver.reports.length;
			driver.send({ type: "input", data: "time out the workflow list action" });
			driver.send({ type: "input", data: "\r" });
			await driver.waitForNext(
				from,
				(report) => report.type === "session_event" && report.eventType === "agent_end",
			);

			from = driver.reports.length;
			driver.send({ type: "input", data: "now time out workflow interrupt" });
			driver.send({ type: "input", data: "\r" });
			await driver.waitForNext(
				from,
				(report) => report.type === "session_event" && report.eventType === "agent_end",
			);
			driver.send({ type: "state" });
			const final = await driver.waitForNext(
				from,
				(report) => report.type === "state" && typeof report.sessionFile === "string",
			);
			assert.equal(final.enginePid, initial.enginePid);
			assert.equal(final.generation, initial.generation);

			const sessionLines = readFileSync(final.sessionFile!, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							message?: { role?: string; toolName?: string; details?: { code?: string } };
						},
				);
			const workflowResults = sessionLines.filter(
				(entry) => entry.message?.role === "toolResult" && entry.message.toolName === "workflow",
			);
			assert.equal(workflowResults.length, 2);
			for (const result of workflowResults) assert.equal(result.message?.details?.code, "WORKFLOW_TIMEOUT");
			for (const report of driver.reports) {
				assert.doesNotMatch(`${report.message ?? ""}\n${report.output ?? ""}`, /Agent process stopped/);
			}
		} finally {
			await driver.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	REAL_ENGINE_WORKFLOW_TIMEOUT_TIMEOUT_MS,
);
