/**
 * Supersession of Herdr's installed file integration by the builtin reporter.
 *
 * Herdr installs `herdr-agent-state.ts` into the agent extension directory of
 * hosts without a builtin reporter — including the legacy Pi root Atomic still
 * auto-loads from. Atomic has one, and the two must never share a pane: two
 * writers flap the label between agents, and a file integration that loads but
 * fails at runtime used to silence the builtin through blind deferral, leaving
 * the pane reported by nobody. The contract pinned here is load-time
 * supersession: inside a Herdr pane the resource loader skips the known
 * integration files entirely, and the builtin reports whenever it is active.
 * Outside a pane, the file integration loads untouched.
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

/** A complete pane environment, matching the builtin's four-variable gate. */
const PANE_ENV: NodeJS.ProcessEnv = {
	HERDR_ENV: "1",
	HERDR_BIN_PATH: "/usr/local/bin/herdr",
	HERDR_PANE_ID: "pane-1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
};

describe("herdr file-integration supersession predicates", () => {
	it("recognizes the installed integration by basename, wherever it lives", () => {
		assert.equal(isHerdrFileIntegrationPath("/home/u/.pi/agent/extensions/herdr-agent-state.ts"), true);
		assert.equal(isHerdrFileIntegrationPath("/home/u/.atomic/agent/extensions/herdr-agent-state.js"), true);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state.ts"), true);
		// Windows separators are recognized on either platform: `node:path`'s
		// POSIX `basename` would leave the backslashes inside one segment.
		assert.equal(isHerdrFileIntegrationPath("C:\\loaded\\herdr-agent-state.ts"), true);
		assert.equal(isHerdrFileIntegrationPath("C:\\Users\\u\\.pi\\agent\\extensions\\herdr-agent-state.js"), true);
		assert.equal(isHerdrFileIntegrationPath("herdr-agent-state.ts"), true);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state.mjs"), false);
		assert.equal(isHerdrFileIntegrationPath("/anywhere/herdr-agent-state-notes.ts"), false);
		assert.equal(isHerdrFileIntegrationPath("C:\\loaded\\herdr-agent-state-notes.ts"), false);
		// The builtin no longer defers to a directory-based community reporter,
		// and the loader does not skip one either.
		assert.equal(isHerdrFileIntegrationPath("/loaded/herdr-atomic-reporter/index.ts"), false);
	});

	it("mirrors the builtin's four-variable activation gate exactly", () => {
		assert.equal(herdrPaneEnvironmentPresent(PANE_ENV), true);
		assert.equal(herdrPaneEnvironmentPresent({}), false);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_ENV: "0" }), false);
		assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, HERDR_ENV: "true" }), false);
		for (const key of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const) {
			assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, [key]: undefined }), false, `${key} missing`);
			assert.equal(herdrPaneEnvironmentPresent({ ...PANE_ENV, [key]: "" }), false, `${key} empty`);
		}
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

	it("does not skip the integration when the builtin itself would not activate", () => {
		// A pane environment missing `HERDR_BIN_PATH` never starts the builtin, so
		// skipping the installed asset there would leave the pane with no reporter
		// at all — strictly worse than deferring to it.
		const paths = ["/home/u/.pi/agent/extensions/herdr-agent-state.ts"];
		const incomplete: NodeJS.ProcessEnv = { ...PANE_ENV, HERDR_BIN_PATH: undefined };
		assert.equal(filterSupersededHerdrIntegrationPaths(paths, incomplete), paths);
	});

	it("returns the caller's own array when there is nothing to skip", () => {
		const paths = ["/home/u/.atomic/agent/extensions/other.ts"];
		assert.equal(filterSupersededHerdrIntegrationPaths(paths, PANE_ENV), paths);
	});
});

describe("herdr file-integration supersession through the real resource loader", () => {
	const ENV_KEYS = [
		"HOME",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"ATOMIC_CODING_AGENT_DIR",
		"PI_CODING_AGENT_DIR",
		"HERDR_ENV",
		"HERDR_BIN_PATH",
		"HERDR_PANE_ID",
		"HERDR_SOCKET_PATH",
	] as const;
	const savedEnv = new Map<string, string | undefined>();
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
		tempDir = mkdtempSync(join(tmpdir(), "atomic-herdr-supersession-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(extensionsDir, "herdr-agent-state.ts"), "export default function () {}\n");
		writeFileSync(join(extensionsDir, "unrelated.ts"), "export default function () {}\n");
		// Keep discovery inside the fixture: the legacy Pi root is resolved from
		// the home directory, and a real one would contribute its own extensions.
		process.env.HOME = tempDir;
		process.env.USERPROFILE = tempDir;
		process.env.HOMEDRIVE = "";
		process.env.HOMEPATH = "";
		delete process.env.ATOMIC_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		savedEnv.clear();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function loadedBasenames(loader: DefaultResourceLoader): string[] {
		return loader
			.getExtensions()
			.extensions.filter((extension) => !extension.path.startsWith("<"))
			.map((extension) => extension.resolvedPath.split(/[\\/]/).at(-1) ?? "")
			.sort();
	}

	function createLoader(): DefaultResourceLoader {
		return new DefaultResourceLoader({ cwd, agentDir, builtinPackagePaths: [] });
	}

	it("skips the installed integration inside a Herdr pane and loads it outside one", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_BIN_PATH = join(tempDir, "herdr");
		process.env.HERDR_PANE_ID = "pane-supersession";
		process.env.HERDR_SOCKET_PATH = join(tempDir, "herdr.sock");
		const inPane = createLoader();
		await inPane.reload();
		assert.deepEqual(loadedBasenames(inPane), ["unrelated.ts"], "the pane's only reporter is the builtin");
		assert.deepEqual(inPane.getExtensions().errors, []);

		for (const key of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const)
			delete process.env[key];
		const outside = createLoader();
		await outside.reload();
		assert.deepEqual(
			loadedBasenames(outside),
			["herdr-agent-state.ts", "unrelated.ts"],
			"outside a pane the installed integration loads exactly as before",
		);
	});

	it("loads the installed integration in an incomplete pane environment", async () => {
		// Same reasoning as the predicate test, proved through the real loader.
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-supersession";
		process.env.HERDR_SOCKET_PATH = join(tempDir, "herdr.sock");
		delete process.env.HERDR_BIN_PATH;
		const loader = createLoader();
		await loader.reload();
		assert.deepEqual(loadedBasenames(loader), ["herdr-agent-state.ts", "unrelated.ts"]);
	});
});
