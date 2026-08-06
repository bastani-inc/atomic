import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Make `@bastani/atomic-natives` present before the suites run, and say so out
 * loud when it is not.
 *
 * `npm ci --ignore-scripts` is the mandated install (AGENTS.md) and the natives
 * workspace has no install hook, so a fresh checkout or a new git worktree has
 * no `.node` at all. Since the in-process subagent runner landed,
 * `packages/subagents` reaches the Rust control plane through a *static*
 * import, so a missing binding is not a graceful degradation: the bundled
 * extension throws while the module graph is still loading and takes roughly
 * twenty root unit and integration files down with it.
 *
 * The errors name whatever imported the extension — `workflow-stage-bundled-
 * resources`, the in-process runner suites — rather than the missing binding,
 * so the failure reads like a regression in an unrelated subsystem.
 *
 * The generated napi-rs loader makes that worse. Its own miss message is:
 *
 *   Cannot find native binding. npm has a bug related to optional dependencies
 *   ... Please try `npm i` again after removing both package-lock.json and
 *   node_modules directory.
 *
 * That advice is wrong here. Reinstalling under `--ignore-scripts` never
 * produces the binding, so a developer who follows it loops. `native/index.js`
 * is generated (`@ts-nocheck`) and would lose any hand edit at the next
 * `napi artifacts`, so the correct instruction has to live here.
 *
 * Shape borrowed from `can1357/oh-my-pi`'s `packages/natives/native/
 * loader-state.js`, which solves the same problem for its runtime loader:
 * report every candidate that was tried, give the exact command for the context
 * you are actually in, and let a dev tree keep running on a stale binding
 * rather than hard-failing while a rebuild is pending. Two deliberate
 * differences: this runs at test setup rather than load time, so it can repair
 * the missing case instead of only describing it; and staleness here is a
 * timestamp comparison rather than their embedded version sentinel, because our
 * `.node` carries no sentinel to compare against.
 *
 * Cost model: one `existsSync` plus a 27-file stat walk (~4 ms) on the happy
 * path. CI builds the binding in an explicit step before invoking vitest, and a
 * warm worktree already has it, so neither pays for the build.
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const NATIVE_DIR = join(REPO_ROOT, "packages", "natives", "native");
const BUILD_COMMAND = "npm run build --workspace=@bastani/atomic-natives";
/** Sources whose edit invalidates a compiled binding. */
const SOURCE_ROOTS = [join(REPO_ROOT, "crates"), join(REPO_ROOT, "packages", "natives", "src")];

function note(lines: readonly string[]): void {
	process.stderr.write(`\n${lines.join("\n")}\n\n`);
}

/** Every compiled binding present, newest first. */
function compiledBindings(): string[] {
	if (!existsSync(NATIVE_DIR)) return [];
	try {
		return readdirSync(NATIVE_DIR)
			.filter((entry) => entry.endsWith(".node"))
			.map((entry) => join(NATIVE_DIR, entry));
	} catch {
		return [];
	}
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

function buildNatives(): { ok: true } | { ok: false; reason: string } {
	const result = spawnSync("npm", ["run", "build", "--workspace=@bastani/atomic-natives"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error !== undefined) return { ok: false, reason: result.error.message };
	if (result.status !== 0) return { ok: false, reason: `the build exited with status ${result.status}` };
	return { ok: true };
}

export default function setup(): void {
	const existing = compiledBindings();

	if (existing.length > 0) {
		// Stale is a warning, never a rebuild and never a failure. A timestamp is
		// weaker evidence than a version sentinel -- `git checkout` rewrites
		// mtimes, so this can cry wolf after a branch switch -- and blocking a
		// suite on weak evidence is worse than running one build too few.
		const newestSource = newestSourceMtime();
		const stale = existing.filter((binding) => {
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

	note([
		"@bastani/atomic-natives has no compiled binding, so it is being built now.",
		`  looked in: ${NATIVE_DIR}`,
		"",
		"Without it packages/subagents fails at import and takes roughly twenty",
		"unrelated unit and integration files down with it, naming the importer",
		"rather than the binding.",
		"",
		"This happens once per checkout or git worktree, and takes about 35 seconds.",
		`  ${BUILD_COMMAND}`,
	]);

	const built = buildNatives();
	if (!built.ok) {
		throw new Error(
			[
				`Could not build @bastani/atomic-natives: ${built.reason}.`,
				"",
				`Looked for a compiled binding in: ${NATIVE_DIR}`,
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

	if (compiledBindings().length === 0) {
		throw new Error(
			`${BUILD_COMMAND} reported success but left no .node file in ${NATIVE_DIR}. Run it directly to see why.`,
		);
	}
}
