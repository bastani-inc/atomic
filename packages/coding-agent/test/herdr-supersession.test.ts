/**
 * Supersession of Herdr's installed file integration by the builtin reporter.
 *
 * Herdr installs `herdr-agent-state.ts` into the agent extension directory of
 * hosts without a builtin reporter. Atomic has one, and the two must never
 * share a pane: two writers flap the label between agents, and a file
 * integration that loads but fails at runtime used to silence the builtin
 * through blind deferral — leaving the pane reported by nobody. The contract
 * pinned here is load-time supersession: inside a Herdr pane the resource
 * loader skips the known integration files entirely, and the builtin reports
 * whenever it is active. Outside a pane, the file integration loads untouched.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	filterSupersededHerdrIntegrationPaths,
	herdrPaneEnvironmentPresent,
	isHerdrFileIntegrationPath,
} from "../src/core/extensions/herdr-file-integration.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

const PANE_ENV: NodeJS.ProcessEnv = {
	HERDR_ENV: "1",
	HERDR_PANE_ID: "pane-1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
};

describe("herdr file-integration supersession predicates", () => {
	it("recognizes the installed integration by basename, wherever it lives", () => {
		assert.equal(isHerdrFileIntegrationPath("/home/u/.pi/agent/extensions/herdr-agent-state.ts"), true);
		assert.equal(isHerdrFileIntegrationPath("/home/u/.atomic/agent/extensions/herdr-agent-state.js"), true);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state.ts"), true);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state.mjs"), false);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state-notes.ts"), false);
	});

	it("mirrors the builtin's activation gate exactly", () => {
		assert.equal(herdrPaneEnvironmentPresent(PANE_ENV), true);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_ENV: "0" }), false);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_ENV: "true" }), false);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_PANE_ID: "" }), false);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_SOCKET_PATH: undefined }), false);
	});

	it("skips the integration files only inside a Herdr pane", () => {
		const paths = [
			"/home/u/.pi/agent/extensions/herdr-agent-state.ts",
			"/home/u/.atomic/agent/extensions/other.ts",
			"/project/.atomic/extensions/herdr-agent-state.js",
		];
		assert.deepEqual(filterSupersededHerdrIntegrationPaths([...paths], PANE_ENV), [
			"/home/u/.atomic/agent/extensions/other.ts",
		]);
		// Outside a pane nothing is skipped, and the exact array comes back.
		const outside = [...paths];
		assert.equal(filterSupersededHerdrIntegrationPaths(outside, {}), outside);
	});

	it("returns the caller's own array when there is nothing to skip", () => {
		const paths = ["/home/u/.atomic/agent/extensions/other.ts"];
		assert.equal(filterSupersededHerdrIntegrationPaths(paths, PANE_ENV), paths);
	});
});

describe("herdr file-integration supersession through the real resource loader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let saved: { env?: string; pane?: string; socket?: string };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-herdr-supersession-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(extensionsDir, "herdr-agent-state.ts"), "export default function () {}\n");
		writeFileSync(join(extensionsDir, "unrelated.ts"), "export default function () {}\n");
		saved = {
			env: process.env.HERDR_ENV,
			pane: process.env.HERDR_PANE_ID,
			socket: process.env.HERDR_SOCKET_PATH,
		};
	});

	afterEach(() => {
		if (saved.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved.env;
		if (saved.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved.pane;
		if (saved.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = saved.socket;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function loadedBasenames(loader: DefaultResourceLoader): string[] {
		return loader
			.getExtensions()
			.extensions.filter((extension) => !extension.path.startsWith("<inline:"))
			.map((extension) => extension.resolvedPath.split("/").at(-1) ?? "");
	}

	it("skips the installed integration inside a Herdr pane and loads it outside one", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-supersession";
		process.env.HERDR_SOCKET_PATH = join(tempDir, "herdr.sock");
		const inPane = new DefaultResourceLoader({ cwd, agentDir });
		await inPane.reload();
		assert.deepEqual(loadedBasenames(inPane), ["unrelated.ts"], "the pane's only reporter is the builtin");
		assert.deepEqual(inPane.getExtensions().errors, []);

		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
		delete process.env.HERDR_SOCKET_PATH;
		const outside = new DefaultResourceLoader({ cwd, agentDir });
		await outside.reload();
		assert.deepEqual(
			loadedBasenames(outside).sort(),
			["herdr-agent-state.ts", "unrelated.ts"],
			"outside a pane the installed integration loads exactly as before",
		);
	});
});
