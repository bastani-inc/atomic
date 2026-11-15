import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");

/** A pi.dev host (pi.dev, radius.pi.dev, …) as a URL or host name. */
const PI_DOMAIN = /(?:https?:\/\/|\b)(?:[a-z0-9-]+\.)*pi\.dev(?:[/:]|\b(?!,|\s))/giu;
/** A URL into pi's GitHub organization. */
const PI_GITHUB =
	/https?:\/\/(?:github\.com|raw\.githubusercontent\.com|api\.github\.com\/repos)\/earendil-works\b[^\s"'`)]*/giu;
/** Provenance a comment may keep: a link to an upstream issue, pull request or commit. */
const PROVENANCE_LINK = /^https:\/\/github\.com\/earendil-works\/[\w.-]+\/(?:issues|pull|commit)\/[\w]+\.?$/u;

// `binaries` holds local release archives, rebuilt from the scanned sources.
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"test",
	"tests",
	"docs",
	"examples",
	"fixtures",
	"skills",
	"binaries",
]);
const SCANNED_EXTENSIONS = /\.(?:[cm]?[jt]s|json)$/u;

function* shippedFiles(directory: string): Generator<string> {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) yield* shippedFiles(path);
		} else if (SCANNED_EXTENSIONS.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]s$/u.test(entry.name)) {
			yield path;
		}
	}
}

function isComment(line: string): boolean {
	return /^\s*(?:\/\/|\/?\*)/u.test(line);
}

test("no shipped source, build script or built output contacts pi's services (#5174)", () => {
	const roots = [
		...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name)),
		join(root, "scripts"),
	];
	const violations: string[] = [];
	let scanned = 0;
	for (const directory of roots) {
		for (const file of shippedFiles(directory)) {
			scanned += 1;
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				const where = `${relative(root, file)}:${index + 1}`;
				for (const match of line.matchAll(PI_DOMAIN)) violations.push(`${where}: ${match[0]}`);
				for (const match of line.matchAll(PI_GITHUB)) {
					// Comments may cite the upstream issue or commit a workaround came from; code may not use pi's URLs.
					if (isComment(line) && PROVENANCE_LINK.test(match[0])) continue;
					violations.push(`${where}: ${match[0]}`);
				}
			}
		}
	}
	assert.ok(scanned > 1000, `expected to scan the shipped sources, scanned ${scanned}`);
	assert.deepEqual(violations, []);
});
