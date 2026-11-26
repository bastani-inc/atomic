// Checks how scripts/worktree-setup.mjs links a worktree to another checkout's installed packages.
import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { linkInstalledPackages } from "./worktree-setup.mjs";

// The script gives Windows worktrees their own install instead of links.
const options = { skip: process.platform === "win32" && "worktree links are not used on Windows" };

function write(path, text = "") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A source checkout with an install, and a fresh worktree of the same repository. */
function checkouts(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "main");
	const target = join(root, "worktrees", "feature");
	for (const checkout of [source, target]) {
		write(join(checkout, "packages", "coding-agent", "dist", "cli.js"), checkout);
		write(join(checkout, "packages", "ai", "package.json"), "{}");
	}
	write(join(source, "node_modules", "chalk", "index.js"));
	write(join(source, "node_modules", "@types", "node", "index.d.ts"));
	write(join(source, "node_modules", "vitest", "dist", "index.js"));
	write(join(source, "node_modules", ".cache", "atomic-build", "ai.stamp.json"));
	write(join(source, "node_modules", ".vite", "vitest", "results.json"));
	mkdirSync(join(source, "node_modules", "@bastani"));
	symlinkSync("../../packages/coding-agent", join(source, "node_modules", "@bastani", "atomic"));
	mkdirSync(join(source, "node_modules", ".bin"));
	symlinkSync("../@bastani/atomic/dist/cli.js", join(source, "node_modules", ".bin", "atomic"));
	write(join(source, "packages", "ai", "node_modules", "agent-base", "index.js"));
	write(join(source, "packages", "ai", "node_modules", ".cache", "tsbuildinfo"));
	return { source, target };
}

test("workspace packages and their bins resolve to the worktree, not the source checkout", options, (t) => {
	const { source, target } = checkouts(t);
	linkInstalledPackages({ source, target });
	assert.equal(
		realpathSync(join(target, "node_modules", "@bastani", "atomic")),
		join(target, "packages", "coding-agent"),
	);
	assert.equal(readFileSync(join(target, "node_modules", ".bin", "atomic"), "utf8"), target);
});

test("third-party packages are shared with the source checkout, at any depth", options, (t) => {
	const { source, target } = checkouts(t);
	linkInstalledPackages({ source, target });
	assert.equal(lstatSync(join(target, "node_modules")).isDirectory(), true);
	assert.equal(realpathSync(join(target, "node_modules", "chalk")), join(source, "node_modules", "chalk"));
	assert.equal(realpathSync(join(target, "node_modules", "@types")), join(source, "node_modules", "@types"));
	assert.equal(
		realpathSync(join(target, "packages", "ai", "node_modules", "agent-base")),
		join(source, "packages", "ai", "node_modules", "agent-base"),
	);
});

test("vitest's real path stays inside the worktree", options, (t) => {
	const { source, target } = checkouts(t);
	linkInstalledPackages({ source, target });
	assert.equal(
		realpathSync(join(target, "node_modules", "vitest", "dist", "index.js")).startsWith(`${target}/`),
		true,
	);
});

test("caches stay per checkout", options, (t) => {
	const { source, target } = checkouts(t);
	linkInstalledPackages({ source, target });
	assert.equal(existsSync(join(target, "node_modules", ".cache")), false);
	assert.equal(existsSync(join(target, "node_modules", ".vite")), false);
	assert.equal(existsSync(join(target, "packages", "ai", "node_modules", ".cache")), false);
});

test("a rerun replaces a whole-directory link and keeps the worktree's own caches", options, (t) => {
	const { source, target } = checkouts(t);
	symlinkSync(join(source, "node_modules"), join(target, "node_modules"));
	linkInstalledPackages({ source, target });
	write(join(target, "node_modules", ".cache", "atomic-build", "own.stamp.json"));
	linkInstalledPackages({ source, target });
	assert.equal(lstatSync(join(target, "node_modules")).isSymbolicLink(), false);
	assert.equal(existsSync(join(target, "node_modules", ".cache", "atomic-build", "own.stamp.json")), true);
	assert.equal(
		realpathSync(join(target, "node_modules", "@bastani", "atomic")),
		join(target, "packages", "coding-agent"),
	);
});

test("a worktree with its own install is left alone", options, (t) => {
	const { source, target } = checkouts(t);
	write(join(target, "node_modules", "chalk", "index.js"), "own");
	const skipped = linkInstalledPackages({ source, target });
	assert.deepEqual(skipped, [join(target, "node_modules")]);
	assert.equal(readFileSync(join(target, "node_modules", "chalk", "index.js"), "utf8"), "own");
});
