import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSyncCollect } from "./helpers/runtime.js";

/**
 * Make `@bastani/atomic-natives` loadable before the suites run, and say so out
 * loud when it is not.
 *
 * `npm ci --ignore-scripts` is the mandated install (AGENTS.md) and the natives
 * workspace has no install hook, so a fresh checkout or a new git worktree has
 * no compiled binding. Since the in-process subagent runner landed,
 * `packages/subagents` reaches the Rust control plane through a *static*
 * import, so that is not a graceful degradation: the bundled extension throws
 * while the module graph is still loading and takes roughly twenty root unit
 * and integration files down with it.
 *
 * The errors name whatever imported the extension — `workflow-stage-bundled-
 * resources`, the in-process runner suites — rather than the missing binding,
 * so the failure reads like a regression in an unrelated subsystem.
 *
 * The generated napi-rs loader makes that worse. Its own miss message says to
 * remove `package-lock.json` and `node_modules` and re-run `npm i`. That advice
 * is wrong here: under `--ignore-scripts`, reinstalling never produces the
 * binding, so a developer who follows it loops. `native/index.js` is generated
 * (`@ts-nocheck`) and would lose a hand edit at the next `napi artifacts`, so
 * the correct instruction has to live here.
 *
 * Shape borrowed from `can1357/oh-my-pi`'s `packages/natives/native/
 * loader-state.js`: report what was tried, give the exact command for the
 * context you are in, and let a dev tree keep running on a stale binding rather
 * than hard-failing while a rebuild is pending. Two deliberate differences —
 * this runs at test setup rather than load time, so it can repair the missing
 * case instead of only describing it, and staleness is a timestamp comparison
 * because our `.node` carries no embedded version sentinel.
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const NATIVE_DIR = join(REPO_ROOT, "packages", "natives", "native");
const NATIVE_ENTRY = join(NATIVE_DIR, "index.js");
const BUILD_COMMAND = "npm run build --workspace=@bastani/atomic-natives";
/** Sources whose edit invalidates a compiled binding. */
const SOURCE_ROOTS = [join(REPO_ROOT, "crates"), join(REPO_ROOT, "packages", "natives", "src")];

function note(lines: readonly string[]): void {
	process.stderr.write(`\n${lines.join("\n")}\n\n`);
}

/**
 * Whether a binding usable *by this host* is present.
 *
 * Deliberately a load attempt rather than a filename scan. napi-rs resolves a
 * platform-arch-libc triple through roughly seven hundred lines that also cover
 * musl detection, Android, and WASI; a scan that accepted any `.node` would skip
 * the build when the directory holds only a binding for another platform — a
 * real state after copying a native directory between checkouts or unpacking
 * release artifacts. Requiring the generated entrypoint asks the exact question
 * the suites will ask, so it cannot drift from the loader.
 *
 * The load happens in a CHILD process, and that is the whole point.
 *
 * `globalSetup` runs in vitest's orchestrator, the process that owns the worker
 * pool. Requiring the addon there dlopens it into the orchestrator, which
 * nothing else does: workers load it on demand, in their own processes. On
 * glibc Linux the addon's destructors then run at exit alongside the pool
 * teardown and the process dies with SIGSEGV — every test passing first, then
 * `exit code 139`. It reproduced on every Linux `suites` run and on no macOS or
 * Windows one, which is why local runs never showed it.
 *
 * A child pays one short spawn on a path that already spawns a Rust build when
 * the binding is missing, and the orchestrator never touches the addon.
 */
function bindingLoads(): boolean {
	if (!existsSync(NATIVE_ENTRY)) return false;
	const probe = spawnSyncCollect([process.execPath, "-e", `require(${JSON.stringify(NATIVE_ENTRY)})`], {
		cwd: REPO_ROOT,
	});
	return probe.success;
}

/** Newest mtime across Rust sources, or 0 when none can be read. */
function newestSourceMtime(): number {
	let newest = 0;
	const visit = (directory: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(path);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				if (entry !== "target" && entry !== "node_modules") visit(path);
				continue;
			}
			if (entry.endsWith(".rs") || entry === "Cargo.toml") newest = Math.max(newest, stats.mtimeMs);
		}
	};
	for (const root of SOURCE_ROOTS) visit(root);
	return newest;
}

/** Compiled bindings on disk, for staleness reporting only. */
function bindingFiles(): string[] {
	try {
		return readdirSync(NATIVE_DIR)
			.filter((entry) => entry.endsWith(".node"))
			.map((entry) => join(NATIVE_DIR, entry));
	} catch {
		return [];
	}
}

export default function setup(): void {
	if (bindingLoads()) {
		// Stale is a warning, never a rebuild and never a failure. A timestamp is
		// weaker evidence than a version sentinel -- `git checkout` rewrites
		// mtimes, so this can cry wolf after a branch switch -- and blocking a
		// suite on weak evidence is worse than running one build too few.
		const newestSource = newestSourceMtime();
		const stale = bindingFiles().filter((binding) => {
			try {
				return statSync(binding).mtimeMs < newestSource;
			} catch {
				return false;
			}
		});
		if (stale.length > 0) {
			note([
				"WARNING: the compiled native binding is older than the Rust sources.",
				...stale.map((binding) => `  stale: ${binding}`),
				"",
				"Tests will run against the binding already on disk. If results look",
				"impossible, rebuild first:",
				`  ${BUILD_COMMAND}`,
			]);
		}
		return;
	}

	const present = bindingFiles();
	note([
		"@bastani/atomic-natives has no binding this host can load, so it is being built now.",
		`  looked in: ${NATIVE_DIR}`,
		...(present.length > 0
			? ["  present but not loadable here:", ...present.map((binding) => `    ${binding}`)]
			: ["  no .node files found"]),
		"",
		"Without it packages/subagents fails at import and takes roughly twenty",
		"unrelated unit and integration files down with it, naming the importer",
		"rather than the binding.",
		"",
		"This happens once per checkout or git worktree, and takes about 35 seconds.",
		`  ${BUILD_COMMAND}`,
	]);

	const result = spawnSyncCollect(["npm", "run", "build", "--workspace=@bastani/atomic-natives"], { cwd: REPO_ROOT });

	if (!result.success) {
		throw new Error(
			[
				`Could not build @bastani/atomic-natives (exit ${result.exitCode}).`,
				"",
				`Looked for a loadable binding in: ${NATIVE_DIR}`,
				...(present.length > 0 ? ["Present but not loadable on this host:", ...present.map((b) => `  ${b}`)] : []),
				"",
				result.stderr.toString().trim().split("\n").slice(-12).join("\n"),
				"",
				"The suites cannot run without it: packages/subagents imports the Rust",
				"control plane statically, so the bundled extension fails at import.",
				"",
				"This build needs a stable Rust toolchain with cargo (https://rustup.rs).",
				"The generated napi-rs loader will instead suggest reinstalling with npm;",
				"that cannot work here, because the mandated `npm ci --ignore-scripts`",
				"never runs the build.",
				"",
				`Once cargo is available, run: ${BUILD_COMMAND}`,
			].join("\n"),
		);
	}

	if (!bindingLoads()) {
		throw new Error(
			`${BUILD_COMMAND} reported success but produced no binding this host can load in ${NATIVE_DIR}. Run it directly to see why.`,
		);
	}
}
