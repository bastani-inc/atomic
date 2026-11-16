import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";
import { DefaultMainDriver } from "./fixtures/default-main-driver.ts";

/**
 * The default isolated CLI end to end: a real host and a real engine child, with an extension in the engine whose
 * `ctx.ui.custom()` component paints `tui.mode`. The host's renderer is fullscreen on a terminal and the
 * main-screen fallback under `TERM=dumb`. Skipped on Windows like the sibling default-main suites; the bridge
 * tests in interactive-engine-host-tui-mode.test.ts cover the same protocol there.
 */
const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;
const REAL_HOST_AND_ENGINE_TEST_TIMEOUT_MS = 120_000;

async function probeTuiMode(env: Record<string, string>): Promise<string | undefined> {
	const temp = mkdtempSync(join(tmpdir(), "atomic-engine-tui-mode-"));
	const fixtures = join(moduleDir(import.meta.url), "fixtures");
	const driver = new DefaultMainDriver(
		[
			"--no-extensions",
			"--extension",
			join(fixtures, "blocking-tool-extension.ts"),
			"--extension",
			join(fixtures, "tui-mode-probe-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
			"--approve",
			"--provider",
			"isolation-fixture",
			"--model",
			"blocking-model",
			"--session-dir",
			join(temp, "sessions"),
		],
		{ ATOMIC_CODING_AGENT_DIR: join(temp, "agent"), ATOMIC_NONBLOCKING_TOOL: "1", NO_COLOR: "1", ...env },
	);
	try {
		await driver.waitFor((report) => report.type === "terminal_ready");
		await driver.waitFor((report) => report.type === "heartbeat" && typeof report.enginePid === "number");
		driver.send({ type: "input", data: "/probe-tui-mode" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "/probe-tui-mode");
		driver.send({ type: "input", data: "\r" });
		const painted = await driver.waitFor(
			(report) => report.type === "render" && report.output?.includes("probe tui.mode=") === true,
		);
		return /probe tui\.mode=(\w+)/.exec(painted.output ?? "")?.[1];
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}

serialTest(
	"an extension component in the isolated engine sees the host's fullscreen renderer as tui.mode",
	async () => {
		assert.equal(await probeTuiMode({}), "fullscreen");
	},
	REAL_HOST_AND_ENGINE_TEST_TIMEOUT_MS,
);

serialTest(
	"an extension component in the isolated engine sees the host's main-screen fallback as tui.mode",
	async () => {
		assert.equal(await probeTuiMode({ TERM: "dumb" }), "regular");
	},
	REAL_HOST_AND_ENGINE_TEST_TIMEOUT_MS,
);
