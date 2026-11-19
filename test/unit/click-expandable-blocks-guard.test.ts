import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { parse } from "@babel/parser";
import { type Node, type TraversalAncestors, traverse } from "@babel/types";
import { test } from "vitest";
import { repositoryRoot } from "../../vitest.base.js";

/**
 * Packages whose components the transcript draws, and the TUI package their components extend. Every component Ctrl+O
 * expands (Ctrl+O calls `setExpanded` on any block that has one) is a block a click expands too: it has
 * `expandsOnClick`, `isExpanded` and `clickArea`, as `ClickExpandableBlock` in transcript-block-clicks.ts describes.
 */
const SCANNED = [
	"packages/coding-agent/src",
	"packages/subagents/src",
	"packages/intercom",
	"packages/web-access",
	"packages/mcp",
	"packages/tui/src",
];

/** Components, as `file#name`, that define `setExpanded` but are not transcript blocks of their own, and why. */
const NOT_BLOCKS: Readonly<Record<string, string>> = {
	"packages/coding-agent/src/modes/interactive/components/notice-line.ts#NoticeLine":
		"a notice line is drawn inside a message card or a stage notice row, and that block takes the click",
	"packages/coding-agent/src/modes/interactive/components/startup-identity.ts#StartupIdentityComponent":
		"the startup header shows nothing more when expanded; its setExpanded does nothing",
};

/** What a click needs of a block besides the `setExpanded` Ctrl+O calls. */
const CLICK_MEMBERS = ["expandsOnClick", "isExpanded", "clickArea"] as const;

interface SourceFile {
	/** The file's path from the repository root, with `/` separators. */
	readonly path: string;
	readonly text: string;
}

/** A class, or an object literal, and the members its instances have. */
interface Shape {
	readonly kind: "class" | "object";
	readonly file: string;
	readonly name: string;
	/** The instance members it defines itself: methods, accessors, fields and constructor parameter properties. */
	readonly members: ReadonlySet<string>;
	/** An abstract class is never drawn itself, only as the classes that extend it. */
	readonly abstract: boolean;
	/** The class it extends, by the name its file uses. */
	readonly base?: string;
}

interface ParsedFile {
	readonly shapes: Shape[];
	/** Each imported name, by the local name the file gives it. */
	readonly imports: ReadonlyMap<string, { readonly source: string; readonly imported: string }>;
}

function keyName(key: Node): string | undefined {
	if (key.type === "Identifier") return key.name;
	if (key.type === "StringLiteral") return key.value;
	return undefined;
}

/** The instance members a class body defines. */
function classMembers(body: readonly Node[]): Set<string> {
	const members = new Set<string>();
	for (const member of body) {
		if (member.type === "ClassMethod" && member.kind === "constructor") {
			for (const param of member.params) {
				if (param.type !== "TSParameterProperty") continue;
				const binding = param.parameter.type === "AssignmentPattern" ? param.parameter.left : param.parameter;
				if (binding.type === "Identifier") members.add(binding.name);
			}
			continue;
		}
		if (
			member.type !== "ClassMethod" &&
			member.type !== "ClassProperty" &&
			member.type !== "ClassAccessorProperty" &&
			member.type !== "TSDeclareMethod"
		)
			continue;
		if (member.static || member.computed) continue;
		const name = keyName(member.key);
		if (name !== undefined) members.add(name);
	}
	return members;
}

/** The members an object literal defines; a spread adds members this cannot see, and none of them count. */
function objectMembers(properties: readonly Node[]): Set<string> {
	const members = new Set<string>();
	for (const property of properties) {
		if ((property.type !== "ObjectProperty" && property.type !== "ObjectMethod") || property.computed) continue;
		const name = keyName(property.key);
		if (name !== undefined) members.add(name);
	}
	return members;
}

/** What the code around a class or object literal calls it: the variable, field or property it is assigned to. */
function nameFromAncestors(ancestors: TraversalAncestors, node: Node): string {
	const parent = ancestors.at(-1)?.node;
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
	if ((parent?.type === "ObjectProperty" || parent?.type === "ClassProperty") && !parent.computed) {
		const name = keyName(parent.key);
		if (name !== undefined) return name;
	}
	if (parent?.type === "AssignmentExpression" && parent.left.type === "MemberExpression") {
		const name = keyName(parent.left.property);
		if (name !== undefined) return name;
	}
	return `<anonymous at line ${node.loc?.start.line ?? "?"}>`;
}

function parseFile({ path, text }: SourceFile): ParsedFile {
	let program: Node;
	try {
		program = parse(text, { sourceType: "module", plugins: ["typescript"] });
	} catch (error) {
		throw new Error(`${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	const shapes: Shape[] = [];
	const imports = new Map<string, { source: string; imported: string }>();
	traverse(program, (node, ancestors) => {
		if (node.type === "ImportDeclaration") {
			for (const specifier of node.specifiers) {
				if (specifier.type !== "ImportSpecifier") continue;
				const imported = keyName(specifier.imported) ?? specifier.local.name;
				imports.set(specifier.local.name, { source: node.source.value, imported });
			}
		} else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
			const superClass = node.superClass;
			const base =
				superClass?.type === "Identifier"
					? superClass.name
					: superClass?.type === "MemberExpression"
						? keyName(superClass.property)
						: undefined;
			shapes.push({
				kind: "class",
				file: path,
				name: node.id?.name ?? nameFromAncestors(ancestors, node),
				members: classMembers(node.body.body),
				abstract: node.type === "ClassDeclaration" && node.abstract === true,
				...(base === undefined ? {} : { base }),
			});
		} else if (node.type === "ObjectExpression") {
			// An object literal extends nothing and nothing extends it: only one with the setter matters.
			const members = objectMembers(node.properties);
			if (members.has("setExpanded")) {
				shapes.push({
					kind: "object",
					file: path,
					name: nameFromAncestors(ancestors, node),
					members,
					abstract: false,
				});
			}
		}
	});
	return { shapes, imports };
}

/** The file a relative import of `source` from `file` names, among `known` files. */
function importedFile(file: string, source: string, known: ReadonlyMap<string, ParsedFile>): string | undefined {
	const target = posix.normalize(posix.join(posix.dirname(file), source));
	const stem = target.replace(/\.[cm]?js$/, "");
	return [target, `${stem}.ts`, `${stem}/index.ts`].find((candidate) => known.has(candidate));
}

/**
 * The components among `files` that Ctrl+O expands, as `file#name`, and those of them a click does not expand, each
 * with what it lacks. Members a class inherits count as its own, through bases its file imports or declares.
 */
function clickInventory(files: readonly SourceFile[]): { readonly expandable: string[]; readonly missing: string[] } {
	const parsed = new Map<string, ParsedFile>();
	for (const file of files) {
		// Only a class or an object with `setExpanded` can take Ctrl+O's expansion, or pass one on.
		if (file.text.includes("class") || file.text.includes("setExpanded")) parsed.set(file.path, parseFile(file));
	}
	const classesByName = new Map<string, Shape[]>();
	for (const { shapes } of parsed.values()) {
		for (const shape of shapes) {
			if (shape.kind === "class") classesByName.set(shape.name, [...(classesByName.get(shape.name) ?? []), shape]);
		}
	}
	const bases = (shape: Shape): readonly Shape[] => {
		const base = shape.base;
		const file = parsed.get(shape.file);
		if (base === undefined || file === undefined) return [];
		const local = file.shapes.filter(
			(candidate) => candidate.kind === "class" && candidate.name === base && candidate !== shape,
		);
		if (local.length > 0) return local;
		const imported = file.imports.get(base);
		const name = imported?.imported ?? base;
		if (imported?.source.startsWith(".")) {
			const target = importedFile(shape.file, imported.source, parsed);
			const there = target === undefined ? [] : (parsed.get(target)?.shapes ?? []);
			const found = there.filter((candidate) => candidate.kind === "class" && candidate.name === name);
			if (found.length > 0) return found;
		}
		// A package import or a re-export: the class of that name, wherever it is declared.
		return classesByName.get(name) ?? [];
	};
	const membersOf = (shape: Shape, seen: ReadonlySet<Shape> = new Set()): Set<string> => {
		const members = new Set(shape.members);
		for (const base of bases(shape)) {
			if (seen.has(base)) continue;
			for (const member of membersOf(base, new Set([...seen, shape]))) members.add(member);
		}
		return members;
	};
	const expandable: string[] = [];
	const missing: string[] = [];
	for (const { shapes } of parsed.values()) {
		for (const shape of shapes) {
			if (shape.abstract) continue;
			const members = membersOf(shape);
			if (!members.has("setExpanded")) continue;
			const name = `${shape.file}#${shape.name}`;
			expandable.push(name);
			if (NOT_BLOCKS[name] !== undefined) continue;
			const lacks = CLICK_MEMBERS.filter((member) => !members.has(member));
			if (lacks.length > 0) missing.push(`${name}: no ${lacks.join(", ")}`);
		}
	}
	return { expandable, missing };
}

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts"))
			files.push(path);
	}
	return files;
}

test("every component Ctrl+O expands is a block a click expands, or is listed with the reason it is not", () => {
	const files = SCANNED.flatMap((root) =>
		sourceFiles(join(repositoryRoot, root)).map((path) => ({
			path: relative(repositoryRoot, path).replaceAll("\\", "/"),
			text: readFileSync(path, "utf8"),
		})),
	);
	const { expandable, missing } = clickInventory(files);
	assert.deepEqual(missing, [], "each of these components expands with Ctrl+O but takes no click");
	for (const name of Object.keys(NOT_BLOCKS)) {
		assert.ok(expandable.includes(name), `${name} no longer defines setExpanded; drop it from the list`);
	}
});

/** What a component needs to be a block a click expands, as `ClickExpandableBlock` names it: class members... */
const CLICK_MEMBERS_SOURCE = `
	readonly expandsOnClick = true;
	isExpanded(): boolean {
		return this.expanded;
	}
	clickArea(width: number) {
		return { start: 0, end: this.render(width).length };
	}`;
/** ...and the same as an object literal's members. */
const OBJECT_CLICK_MEMBERS_SOURCE = `
	expandsOnClick: true,
	isExpanded: () => expanded,
	clickArea: (width: number) => ({ start: 0, end: width > 0 ? 1 : 0 }),`;

/** Each way a component can take Ctrl+O's expansion: the source of a component without click support. */
const SETTER_FORMS: readonly { readonly form: string; readonly files: readonly SourceFile[]; readonly name: string }[] =
	[
		{
			form: "a method",
			name: "pkg/method.ts#MethodCard",
			files: [
				{
					path: "pkg/method.ts",
					text: `export class MethodCard {
	private expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	render(_width: number): string[] {
		return this.expanded ? ["summary", "detail"] : ["summary"];
	}
	invalidate(): void {}
}`,
				},
			],
		},
		{
			form: "a class field holding an arrow function",
			name: "pkg/field.ts#FieldCard",
			files: [
				{
					path: "pkg/field.ts",
					text: `export class FieldCard {
	private expanded = false;
	setExpanded = (expanded: boolean): void => { this.expanded = expanded; };
	render(_width: number): string[] {
		return this.expanded ? ["summary", "detail"] : ["summary"];
	}
	invalidate(): void {}
}`,
				},
			],
		},
		{
			form: "a class field holding a bound function",
			name: "pkg/bound.ts#BoundCard",
			files: [
				{
					path: "pkg/bound.ts",
					text: `export class BoundCard {
	private expanded = false;
	readonly setExpanded = this.apply.bind(this);
	private apply(expanded: boolean): void {
		this.expanded = expanded;
	}
	render(_width: number): string[] {
		return this.expanded ? ["summary", "detail"] : ["summary"];
	}
	invalidate(): void {}
}`,
				},
			],
		},
		{
			form: "a setter inherited from a base class in another file",
			name: "pkg/inherited.ts#InheritedCard",
			files: [
				{
					path: "pkg/base.ts",
					text: `export abstract class ExpandingCard {
	protected expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {}
}`,
				},
				{
					path: "pkg/inherited.ts",
					text: `import { ExpandingCard } from "./base.js";

export class InheritedCard extends ExpandingCard {
	render(_width: number): string[] {
		return this.expanded ? ["summary", "detail"] : ["summary"];
	}
}`,
				},
			],
		},
		{
			form: "an object literal's method",
			name: "pkg/literal.ts#card",
			files: [
				{
					path: "pkg/literal.ts",
					text: `let expanded = false;
export const card = {
	setExpanded(next: boolean) {
		expanded = next;
	},
	render: (_width: number) => (expanded ? ["summary", "detail"] : ["summary"]),
	invalidate() {},
};`,
				},
			],
		},
		{
			form: "an object literal's property",
			name: "pkg/property.ts#card",
			files: [
				{
					path: "pkg/property.ts",
					text: `let expanded = false;
const apply = (next: boolean) => {
	expanded = next;
};
export const card = {
	setExpanded: apply,
	render: (_width: number) => (expanded ? ["summary", "detail"] : ["summary"]),
	invalidate() {},
};`,
				},
			],
		},
	];

for (const { form, files, name } of SETTER_FORMS) {
	test(`a component that takes Ctrl+O's expansion through ${form} is reported until a click expands it too`, () => {
		const without = clickInventory(files);
		assert.ok(without.expandable.includes(name), `${name} is not seen to expand: ${without.expandable.join(", ")}`);
		assert.deepEqual(without.missing, [`${name}: no expandsOnClick, isExpanded, clickArea`]);

		// The same component with what a click needs: in its class body or its object literal.
		const clickable = files.map((file) =>
			file.path !== name.split("#")[0]
				? file
				: {
						...file,
						text: file.text.includes("class ")
							? file.text.replace(/\{\n/, `{${CLICK_MEMBERS_SOURCE}\n`)
							: file.text.replace("= {\n", `= {${OBJECT_CLICK_MEMBERS_SOURCE}\n`),
					},
		);
		const withClicks = clickInventory(clickable);
		assert.ok(withClicks.expandable.includes(name));
		assert.deepEqual(withClicks.missing, []);
	});
}

test("a component that inherits both Ctrl+O's expansion and what a click needs is not reported", () => {
	const { expandable, missing } = clickInventory([
		{
			path: "pkg/base.ts",
			text: `export abstract class ClickableCard {
	protected expanded = false;${CLICK_MEMBERS_SOURCE}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	abstract render(width: number): string[];
	invalidate(): void {}
}`,
		},
		{
			path: "pkg/inherited.ts",
			text: `import { ClickableCard as Card } from "./base.js";

export class InheritedCard extends Card {
	render(_width: number): string[] {
		return this.expanded ? ["summary", "detail"] : ["summary"];
	}
}`,
		},
	]);
	assert.deepEqual(expandable, ["pkg/inherited.ts#InheritedCard"]);
	assert.deepEqual(missing, []);
});

test("declarations that only describe a setter, such as an interface or a parameter's type, are not components", () => {
	const { expandable } = clickInventory([
		{
			path: "pkg/types.ts",
			text: `export interface Expandable {
	setExpanded(expanded: boolean): void;
}
export type Toggle = { setExpanded: (expanded: boolean) => void };
export function expandAll(blocks: readonly { setExpanded(expanded: boolean): void }[]): void {
	for (const block of blocks) block.setExpanded(true);
}
export class Caller {
	run(setExpanded: (expanded: boolean) => void): void {
		setExpanded(true);
	}
}`,
		},
	]);
	assert.deepEqual(expandable, []);
});
