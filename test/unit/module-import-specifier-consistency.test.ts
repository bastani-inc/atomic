import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

type ImportSite = {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly line: number;
	readonly specifier: string;
};

type PackageSource = {
	readonly name: string;
	readonly root: string;
};

type ModuleSpelling = {
	readonly modulePath: string;
	readonly spelling: string;
};

type Token = {
	readonly kind: "identifier" | "literal" | "punctuation";
	readonly position: number;
	readonly text: string;
	readonly interpolated: boolean;
};

type RelativeSpecifier = {
	readonly position: number;
	readonly specifier: string;
};

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const packageSources: readonly PackageSource[] = [
	{ name: "@bastani/atomic", root: join(repositoryRoot, "packages/coding-agent/src") },
	{ name: "@bastani/workflows", root: join(repositoryRoot, "packages/workflows") },
	{ name: "@bastani/subagents", root: join(repositoryRoot, "packages/subagents") },
	{ name: "@bastani/mcp", root: join(repositoryRoot, "packages/mcp") },
	{ name: "@bastani/web-access", root: join(repositoryRoot, "packages/web-access") },
	{ name: "@bastani/intercom", root: join(repositoryRoot, "packages/intercom") },
];
const sourceFilePattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const specifierExtensionPattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const path = join(directory, entry);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				if (entry !== "node_modules") walk(path);
			} else if (sourceFilePattern.test(entry)) {
				files.push(path);
			}
		}
	};
	walk(root);
	return files;
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			index += 2;
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const quote = character;
			const position = index + 1;
			index += 1;
			let interpolated = false;
			let escaped = false;
			while (index < source.length) {
				const current = source[index];
				if (escaped) {
					escaped = false;
					index += 1;
					continue;
				}
				if (current === "\\") {
					escaped = true;
					index += 1;
					continue;
				}
				if (quote === "`" && current === "$" && source[index + 1] === "{") interpolated = true;
				if (current === quote) break;
				index += 1;
			}
			const end = index;
			if (index < source.length) index += 1;
			tokens.push({ kind: "literal", position, text: source.slice(position, end), interpolated });
			continue;
		}
		if (/[A-Za-z_$]/.test(character)) {
			const position = index;
			index += 1;
			while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
			tokens.push({ kind: "identifier", position, text: source.slice(position, index), interpolated: false });
			continue;
		}
		tokens.push({ kind: "punctuation", position: index, text: character, interpolated: false });
		index += 1;
	}
	return tokens;
}

function relativeSpecifiers(source: string): RelativeSpecifier[] {
	const tokens = tokenize(source);
	const references: RelativeSpecifier[] = [];
	const addLiteral = (token: Token | undefined): void => {
		if (token?.kind === "literal" && !token.interpolated && token.text.startsWith(".")) {
			references.push({ position: token.position, specifier: token.text });
		}
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind !== "identifier") continue;
		if (token.text === "require" && tokens[index + 1]?.text === "(") {
			addLiteral(tokens[index + 2]);
			continue;
		}
		if (token.text !== "import" && token.text !== "export") continue;
		if (token.text === "import" && tokens[index + 1]?.text === "(") {
			addLiteral(tokens[index + 2]);
			continue;
		}
		if (token.text === "import") addLiteral(tokens[index + 1]);
		for (let next = index + 1; next < tokens.length && tokens[next].text !== ";"; next += 1) {
			if (tokens[next].text === "from") {
				addLiteral(tokens[next + 1]);
				break;
			}
		}
	}
	return references;
}

function moduleSpelling(sourcePath: string, specifier: string): ModuleSpelling {
	const extension = specifier.match(specifierExtensionPattern)?.[0].slice(1);
	if (!extension) {
		return { modulePath: resolve(dirname(sourcePath), specifier), spelling: "<extensionless>" };
	}
	return {
		modulePath: resolve(dirname(sourcePath), specifier.slice(0, -(extension.length + 1))),
		spelling: extension,
	};
}

function moduleImportGroups(): Map<string, Map<string, ImportSite[]>> {
	const groups = new Map<string, Map<string, ImportSite[]>>();
	for (const packageSource of packageSources) {
		for (const sourcePath of sourceFiles(packageSource.root)) {
			const source = readFileSync(sourcePath, "utf8");
			for (const { position, specifier } of relativeSpecifiers(source)) {
				const { modulePath, spelling } = moduleSpelling(sourcePath, specifier);
				const line = source.slice(0, position).split("\n").length;
				let spellings = groups.get(modulePath);
				if (!spellings) {
					spellings = new Map<string, ImportSite[]>();
					groups.set(modulePath, spellings);
				}
				let sites = spellings.get(spelling);
				if (!sites) {
					sites = [];
					spellings.set(spelling, sites);
				}
				sites.push({ packageName: packageSource.name, sourcePath, line, specifier });
			}
		}
	}
	return groups;
}

function conflictDescription(): string[] {
	const conflicts: string[] = [];
	for (const [modulePath, spellings] of moduleImportGroups()) {
		if (spellings.size < 2) continue;
		const sites = [...spellings.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([spelling, imports]) =>
				imports
					.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line)
					.map(
						(site) =>
							`  ${spelling}: ${site.packageName}: ${relative(repositoryRoot, site.sourcePath)}:${site.line} (${site.specifier})`,
					),
			);
		conflicts.push(`${relative(repositoryRoot, modulePath)}\n${sites.join("\n")}`);
	}
	return conflicts.sort();
}

test("shipped package sources use one extension spelling per relative module", () => {
	const conflicts = conflictDescription();
	assert.deepEqual(
		conflicts,
		[],
		"A module must not be imported with multiple specifier spellings (including extensionless imports). Offending module and sites:\n" +
			conflicts.join("\n"),
	);
});
