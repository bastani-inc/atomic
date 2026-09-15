import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateRuntimeDependencies } from "./postgres-runtime-dependencies.mjs";

function digest(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function runtimePath(root, path) {
	if (
		typeof path !== "string" ||
		!path ||
		isAbsolute(path) ||
		/[\\:\0]/u.test(path) ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error(`invalid runtime path: ${path}`);
	return join(root, path);
}

// Runs inside the staged standalone launcher, without host runtimes or tools.
export function validateInstalledPostgres(root) {
	try {
		const provenance = JSON.parse(readFileSync(join(root, "runtime-provenance.json"), "utf8"));
		const inventoryPath = join(root, "payload-files.json");
		if (digest(inventoryPath) !== provenance.payloadInventorySha256)
			throw new Error("runtime inventory checksum mismatch");
		const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
		if (!Array.isArray(inventory) || !inventory.length) throw new Error("empty or invalid runtime inventory");
		const expected = new Map();
		for (const row of inventory) {
			if (!row || typeof row !== "object" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256))
				throw new Error("invalid runtime inventory row");
			runtimePath(root, row.path);
			if (expected.has(row.path)) throw new Error(`duplicate runtime inventory path: ${row.path}`);
			expected.set(row.path, row.sha256);
		}
		function visit(directory, prefix = "") {
			for (const entry of readdirSync(directory)) {
				const name = prefix + entry;
				const path = join(directory, entry);
				const stat = lstatSync(path);
				if (stat.isDirectory()) {
					visit(path, `${name}/`);
					continue;
				}
				if (!stat.isFile()) throw new Error(`runtime contains a non-file: ${name}`);
				if (!prefix && ["runtime-provenance.json", "payload-files.json"].includes(name)) continue;
				if (!expected.has(name) || digest(path) !== expected.get(name))
					throw new Error(`runtime inventory mismatch: ${name}`);
				expected.delete(name);
			}
		}
		visit(root);
		if (expected.size) throw new Error(`runtime inventory missing file: ${expected.keys().next().value}`);
		const links = JSON.parse(readFileSync(join(root, "pg-symlinks.json"), "utf8"));
		if (!Array.isArray(links)) throw new Error("invalid runtime aliases");
		const targets = new Map();
		for (const row of links) {
			if (!row || typeof row !== "object") throw new Error("invalid runtime alias");
			const source = runtimePath(root, row.source),
				target = runtimePath(root, row.target);
			if (targets.has(row.target) && targets.get(row.target) !== row.source)
				throw new Error(`conflicting runtime alias: ${row.target}`);
			targets.set(row.target, row.source);
			if (!lstatSync(source).isFile() || !lstatSync(target).isFile() || digest(source) !== digest(target))
				throw new Error(`invalid materialized runtime alias: ${row.target}`);
		}
		// Do not allow the manifest to substitute for a physically present dependency.
		validateRuntimeDependencies(root);
	} catch (cause) {
		throw new Error(
			`incomplete PostgreSQL runtime: ${cause.message}; installation was not promoted. Download a repaired release.`,
			{ cause },
		);
	}
}
