import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";

/**
 * Refuse to run when the installed packages belong to another checkout.
 *
 * A Git worktree whose `node_modules` is one link to the main checkout's `node_modules` resolves
 * `@bastani/atomic` and the other workspace packages to the main checkout's `packages/`. Tests
 * that start child processes through those packages then run the main checkout's build, so they
 * pass or fail for code that is not the branch under test. Vitest's own files also sit outside
 * the project root then, and Vitest 4 mistakes some bare imports (`string_decoder`, `stream`)
 * for its own files.
 *
 * `node scripts/worktree-setup.mjs` sets up a worktree that shares the main checkout's
 * third-party packages without either problem.
 */
const REPO_ROOT = join(import.meta.dirname, "..");
const SETUP_COMMAND = "node scripts/worktree-setup.mjs";

function inside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

export default function setup(): void {
	const root = realpathSync(REPO_ROOT);
	const require = createRequire(join(root, "package.json"));
	const problems: string[] = [];
	const workspace = realpathSync(join(root, "node_modules", "@bastani", "atomic"));
	if (relative(join(root, "packages", "coding-agent"), workspace) !== "") {
		problems.push(`@bastani/atomic resolves to ${workspace}, not this checkout's packages/coding-agent.`);
	}
	const vitest = realpathSync(require.resolve("vitest/package.json"));
	if (!inside(root, vitest)) problems.push(`vitest resolves to ${vitest}, outside this checkout.`);
	if (problems.length === 0) return;
	throw new Error(
		[
			"This checkout's node_modules belongs to another checkout, so tests would not exercise this checkout's code:",
			...problems.map((problem) => `  - ${problem}`),
			`Run \`${SETUP_COMMAND}\` from this worktree, or install with \`npm ci --ignore-scripts\`.`,
		].join("\n"),
	);
}
