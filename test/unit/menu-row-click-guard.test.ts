/**
 * Every list a user picks from runs its rows on one click. A component that handles a key that chooses a row (Enter,
 * the list's confirm or open key) takes a click on those rows through the shared clickable-row path, or is listed
 * here with how a click reaches its rows, so a new list cannot ship keyboard-only.
 *
 * Audit every component that renders and handles keyboard input, independent of how it recognizes keys. Also check
 * standalone handlers for the choosing keys. Views without selectable rows need a reason in the inventory.
 */
import assert from "node:assert/strict";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { parse } from "@babel/parser";
import { type Node, type TraversalAncestors, traverse } from "@babel/types";
import { test } from "vitest";
import { repositoryRoot } from "../../vitest.base.js";
import { ColorList } from "../fixtures/clickable-color-list.js";
import { makeClickScreen } from "../helpers/fullscreen-clicks.js";

/** The keys and key actions that choose or open the selected row of a list. */
const CHOOSE_KEYS = new Set(["enter", "return", "tui.select.confirm", "app.list.open"]);
/** Constants naming those keys, as `Key.enter` or `TUI_ACTION.selectConfirm` spell them. */
const CHOOSE_KEY_CONSTANTS = new Set(["enter", "return", "selectConfirm", "listOpen"]);
/** A call matching input against a key or key action: `matchesKey`, `keybindings.matches`, `matchesAction`... */
const MATCHING_CALL = /^_?matches/;
/** The shared clickable-row path a list draws its rows through. */
const SHARED_ROWS = new Set(["ClickableRows", "ClickableRow"]);

type Route =
	/** The component hosts a list and forwards each mouse event to it. */
	| { readonly route: "forwards"; readonly to: string }
	/** Another component, `file#Name`, draws the rows these keys move through and takes clicks on them. */
	| { readonly route: "drawn-by"; readonly component: string }
	/** Nothing here is a row a user picks. */
	| { readonly route: "no-rows"; readonly reason: string };

const TEXT_FIELD = "a text field: Enter submits what was typed, and there is no row to pick";

/**
 * Components, as `file#Name`, or files whose functions handle a choosing key outside any component, that do not draw
 * clickable rows themselves, and how a click reaches their rows. A component that has `handleMouse` and draws its rows
 * through `ClickableRows` or `ClickableRow` needs no entry.
 */
const interactive = "packages/coding-agent/src/modes/interactive/components/";
const forwards = (to: string): Route => ({ route: "forwards", to });
const noRows = (reason: string): Route => ({ route: "no-rows", reason });
const selector = forwards("the mounted selector");
const transcript = noRows("scrollable output, not a row picker");
const ROUTES: Record<string, Route> = {
	"packages/coding-agent/src/extensions/llama/ui.ts#LlamaView": selector,
	"packages/coding-agent/src/extensions/mcp/ui.ts#McpManagerView": selector,
	"packages/coding-agent/src/modes/interactive-engine/remote-component.ts#RemoteComponent":
		forwards("the engine component"),
	[`${interactive}bordered-loader.ts#BorderedLoader`]: noRows("a progress indicator with a cancel key"),
	[`${interactive}chat-session-host.ts#ChatSessionHost`]: noRows(
		"the chat's scroll and text input; task rows belong to TaskInspector",
	),
	[`${interactive}chat-transcript.ts#ScrollableChatTranscriptComponent`]: transcript,
	[`${interactive}chat-transcript.ts#ScrollableComponentViewport`]: transcript,
	[`${interactive}config-selector.ts#ConfigSelectorComponent`]: selector,
	[`${interactive}extension-selector.ts#ExtensionSelectorComponent`]: selector,
	[`${interactive}model-selector.ts#ModelSelectorComponent`]: selector,
	[`${interactive}oauth-selector.ts#OAuthSelectorComponent`]: selector,
	[`${interactive}prompt-history-selector.ts#PromptHistorySelectorComponent`]: selector,
	[`${interactive}scoped-models-selector.ts#ScopedModelsSelectorComponent`]: selector,
	[`${interactive}selector.ts#FramedSelector`]: selector,
	[`${interactive}show-images-selector.ts#ShowImagesSelectorComponent`]: selector,
	[`${interactive}theme-selector.ts#ThemeSelectorComponent`]: selector,
	[`${interactive}thinking-selector.ts#ThinkingSelectorComponent`]: selector,
	[`${interactive}trust-selector.ts#TrustSelectorComponent`]: selector,
	[`${interactive}user-message-selector.ts#UserMessageSelectorComponent`]: selector,
	"packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts#component": forwards(
		"the session's recorded question rows",
	),
	"packages/workflows/src/tui/workflows-listing.ts#component": forwards("the listing's recorded run rows"),
	"packages/workflows/src/tui/workflows-listing.ts": {
		route: "drawn-by",
		component: "packages/workflows/src/tui/workflows-listing.ts#component",
	},
	[`${interactive}custom-editor.ts#CustomEditor`]: forwards("the editor's completion list"),
	[`${interactive}extension-editor.ts#ExtensionEditorComponent`]: noRows(TEXT_FIELD),
	[`${interactive}main-composer-keys.ts#MainComposerKeyOverlay`]: noRows("key help, with no row selection"),
	[`${interactive}reserved-bottom-overlay.ts#ReservedBottomOverlay`]: forwards("the component in the overlay"),
	[`${interactive}session-selector.ts#SessionSelectorComponent`]: selector,
	[`${interactive}settings-picker.ts#SettingsPicker`]: selector,
	[`${interactive}settings-selector-submenus.ts#SelectSubmenu`]: selector,
	[`${interactive}settings-selector-submenus.ts#ThemeSubmenu`]: selector,
	[`${interactive}settings-selector-submenus.ts#WarningSettingsSubmenu`]: selector,
	[`${interactive}task-transcript-page.ts#TaskAgentTranscriptPage`]: forwards(
		"the held question under the transcript",
	),
	[`${interactive}task-transcript-page.ts#TaskCommandOutputPage`]: transcript,
	[`${interactive}tree-selector-component.ts#TreeSelectorComponent`]: selector,
	[`${interactive}tree-selector-help.ts#SearchLine`]: noRows(TEXT_FIELD),
	"packages/coding-agent/src/modes/interactive/interactive-session-routing.ts#view": selector,
	"packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts#<object in showAgentPanel>": forwards("the agent panel"),
	"packages/coding-agent/src/modes/rpc/task-ui-bridge.ts#<object in showTaskInspector>":
		forwards("the task inspector"),
	"packages/tui/src/alt-screen-search.ts#AltScreenSearchComponent": noRows("a text search and two navigation buttons"),
	"packages/tui/src/components/cancellable-loader.ts#CancellableLoader": noRows(
		"a progress indicator with a cancel key",
	),
	"packages/tui/src/components/input.ts#Input": noRows(TEXT_FIELD),
	"packages/workflows/src/tui/overlay-adapter.ts#<object in makeComponent>": forwards("the workflow view"),
	"packages/coding-agent/src/cli/startup-ui.ts#StartupDialogInputGuard": {
		route: "no-rows",
		reason:
			"startup prompts run on the main-screen renderer before the full-screen view starts, with no mouse reporting",
	},
	"packages/coding-agent/src/core/tools/ask-user-question/state/key-router.ts": {
		route: "drawn-by",
		component: "packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts#component",
	},
	"packages/coding-agent/src/extensions/mcp/ui.ts#<object in redirectUrl>": {
		route: "no-rows",
		reason: "the redirect URL field: Enter submits the pasted URL, and there is no row to pick",
	},
	"packages/coding-agent/src/modes/interactive/components/agent-panel.ts#AgentPanelFocus": {
		route: "drawn-by",
		component: "packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts#<object in refresh>",
	},
	"packages/coding-agent/src/modes/interactive/components/chat-session-host-editor.ts": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/extension-input.ts#ExtensionInputComponent": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/login-dialog.ts#LoginDialogComponent": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/task-navigation.ts#TaskNavigation": {
		route: "drawn-by",
		component: "packages/coding-agent/src/modes/interactive/components/task-inspector.ts#TaskInspector",
	},
	"packages/coding-agent/src/modes/interactive/components/task-transcript-page.ts": {
		route: "no-rows",
		reason: "the chat prompt of a task's page: Enter sends what was typed, and there is no row to pick",
	},
	"packages/coding-agent/src/modes/interactive/components/tree-selector-label-input.ts#LabelInput": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/trust-decision-selector.ts#TrustDecisionSelector": {
		route: "forwards",
		to: "the selector it shows, a child its container passes each click to",
	},
	"packages/intercom/ui/compose.ts#ComposeOverlay": { route: "no-rows", reason: TEXT_FIELD },
	"packages/tui/src/components/editor.ts#Editor": { route: "forwards", to: "its autocomplete SelectList" },
	"packages/tui/src/keys.ts": {
		route: "no-rows",
		reason: "key decoding: it matches terminal input against key names, and draws nothing",
	},
	"packages/workflows/src/extension/workflow-durable-resume-command.ts#<object in confirmEditedWorkflowDefinition>": {
		route: "no-rows",
		reason: "a confirmation whose only actions are its key hints, which the key-hint path runs on a click",
	},
	"packages/workflows/src/tui/prompt-card-input.ts": {
		route: "drawn-by",
		component: "packages/workflows/src/tui/stage-chat-view.ts#StageChatView",
	},
	"packages/workflows/src/tui/prompt-card-select.ts": {
		route: "drawn-by",
		component: "packages/workflows/src/tui/stage-chat-view.ts#StageChatView",
	},
	"packages/workflows/src/tui/stage-chat-view-input.ts": {
		route: "drawn-by",
		component: "packages/workflows/src/tui/stage-chat-view.ts#StageChatView",
	},
	"packages/workflows/src/tui/workflow-attach-pane.ts#WorkflowAttachPane": {
		route: "forwards",
		to: "the attached stage chat and the graph's stage switcher",
	},
};

/** Source directories of the packages that draw views. */
const SOURCE_ROOTS = [
	"packages/coding-agent/src",
	"packages/tui/src",
	"packages/workflows/src",
	"packages/subagents/src",
	"packages/intercom",
	"packages/mcp",
	"packages/web-access",
];

interface SourceFile {
	/** The file's path from the repository root, with `/` separators. */
	readonly path: string;
	readonly text: string;
}

/** A class, or an object literal that handles input, and the members it defines itself. */
interface Shape {
	readonly file: string;
	readonly name: string;
	readonly members: ReadonlySet<string>;
	/** The class it extends, by the name its file uses. */
	readonly base?: string;
}

interface ParsedFile {
	readonly shapes: Shape[];
	/** Each imported name, by the local name the file gives it. */
	readonly imports: ReadonlyMap<string, { readonly source: string; readonly imported: string }>;
	/** Components that construct their own shared rows. */
	readonly sharedRows: ReadonlyMap<Shape, ReadonlySet<string | Node>>;
	readonly registrations: ReadonlyMap<Shape, ReadonlySet<string | Node>>;
	readonly dispatchesMouse: ReadonlySet<Shape>;
	readonly forwardsMouse: ReadonlySet<Shape>;
	/** What handles a choosing key: a component, or `undefined` for the file's own functions. */
	readonly choosers: ReadonlySet<Shape | undefined>;
}

function keyName(key: Node): string | undefined {
	if (key.type === "Identifier") return key.name;
	if (key.type === "StringLiteral") return key.value;
	return undefined;
}

/** The instance members a class body defines: methods, accessors, fields and constructor parameter properties. */
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
		if (name === "handleInput" && member.type === "ClassMethod" && !member.body.body.length) continue;
		if (name !== undefined) members.add(name);
	}
	return members;
}

/** The members an object literal defines. */
function objectMembers(properties: readonly Node[]): Set<string> {
	const members = new Set<string>();
	for (const property of properties) {
		if ((property.type !== "ObjectProperty" && property.type !== "ObjectMethod") || property.computed) continue;
		const name = keyName(property.key);
		const handler = property.type === "ObjectProperty" ? property.value : property;
		if (
			name === "handleInput" &&
			(handler.type === "ObjectMethod" ||
				handler.type === "ArrowFunctionExpression" ||
				handler.type === "FunctionExpression") &&
			handler.body.type === "BlockStatement" &&
			!handler.body.body.length
		)
			continue;
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
	// Returned or passed on: named by the function it is built in.
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const scope = ancestors[index]!.node;
		if (scope.type === "FunctionDeclaration" && scope.id) return `<object in ${scope.id.name}>`;
		if ((scope.type === "ClassMethod" || scope.type === "ObjectMethod") && !scope.computed) {
			const name = keyName(scope.key);
			if (name !== undefined) return `<object in ${name}>`;
		}
		if (
			scope.type === "VariableDeclarator" &&
			scope.id.type === "Identifier" &&
			(scope.init?.type === "ArrowFunctionExpression" || scope.init?.type === "FunctionExpression")
		)
			return `<object in ${scope.id.name}>`;
	}
	return `<object at line ${node.loc?.start.line ?? "?"}>`;
}

/** The name a call's callee goes by: `matchesKey`, or `matches` for `keybindings.matches`. */
function calleeName(callee: Node): string | undefined {
	if (callee.type === "Identifier") return callee.name;
	if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed)
		return keyName(callee.property);
	return undefined;
}

/** Which field or local construction a call uses, including a named alias or a destructured instance field. */
function receiverMember(receiver: Node, ancestors: TraversalAncestors, ownField: boolean): string | Node | undefined {
	let source: Node | null | undefined = receiver;
	if (receiver.type === "Identifier") {
		findBinding: for (let i = ancestors.length - 1; i >= 0; i--) {
			const scope = ancestors[i]!.node;
			if (scope.type !== "BlockStatement") continue;
			for (const statement of scope.body) {
				if (statement.type !== "VariableDeclaration") continue;
				for (const { id, init } of statement.declarations) {
					if (id.type === "Identifier" && id.name === receiver.name) {
						source = init;
						break findBinding;
					}
					if (id.type !== "ObjectPattern") continue;
					for (const prop of id.properties) {
						if (
							prop.type === "ObjectProperty" &&
							prop.value.type === "Identifier" &&
							prop.value.name === receiver.name
						)
							return (!ownField || init?.type === "ThisExpression") && !prop.computed
								? keyName(prop.key)
								: undefined;
					}
				}
			}
		}
	}
	if (source?.type === "NewExpression") return source;
	if (source?.type !== "MemberExpression" && source?.type !== "OptionalMemberExpression") return undefined;
	if (ownField && source.object.type !== "ThisExpression") return undefined;
	return source.computed && source.property.type !== "StringLiteral" ? undefined : keyName(source.property);
}

/** A local collection is identified by its construction; an instance member can also be filled by a subclass. */
function recordRowMember(members: Map<Shape, Set<string | Node>>, owner: Shape, member: string | Node): void {
	const known = members.get(owner);
	if (known) known.add(member);
	else members.set(owner, new Set([member]));
}

/** Whether `node` names a choosing key: its literal, a constant such as `Key.enter`, or a local alias of one. */
function namesChoosingKey(node: Node, aliases: ReadonlySet<string>): boolean {
	if (node.type === "StringLiteral") return CHOOSE_KEYS.has(node.value);
	if (node.type === "Identifier") return aliases.has(node.name);
	if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed) {
		const property = keyName(node.property);
		return property !== undefined && CHOOSE_KEY_CONSTANTS.has(property);
	}
	return false;
}

function parseFile({ path, text }: SourceFile): ParsedFile {
	let program: Node;
	try {
		program = parse(text, { sourceType: "module", plugins: ["typescript"] });
	} catch (error) {
		throw new Error(`${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	// Local names given to a choosing key, such as `const KEYBIND_CONFIRM = "tui.select.confirm"`.
	const aliases = new Set<string>();
	const sharedRows = new Map<Shape, Set<string | Node>>();
	const registrations = new Map<Shape, Set<string | Node>>();
	const dispatchesMouse = new Set<Shape>();
	const forwardsMouse = new Set<Shape>();
	traverse(program, (node) => {
		if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init?.type === "StringLiteral") {
			if (CHOOSE_KEYS.has(node.init.value)) aliases.add(node.id.name);
		}
	});
	const shapes: Shape[] = [];
	const shapeOf = new Map<Node, Shape>();
	const imports = new Map<string, { source: string; imported: string }>();
	const choosers = new Set<Shape | undefined>();
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
			const shape: Shape = {
				file: path,
				name: node.id?.name ?? nameFromAncestors(ancestors, node),
				members: classMembers(node.body.body),
				...(base === undefined ? {} : { base }),
			};
			shapes.push(shape);
			shapeOf.set(node, shape);
		} else if (node.type === "ObjectExpression") {
			// An object literal is a component of its own when it handles input or the mouse.
			const members = objectMembers(node.properties);
			if (members.has("handleInput") || members.has("handleMouse")) {
				const shape: Shape = { file: path, name: nameFromAncestors(ancestors, node), members };
				shapes.push(shape);
				shapeOf.set(node, shape);
			}
		} else if (
			node.type === "NewExpression" ||
			node.type === "CallExpression" ||
			node.type === "OptionalCallExpression"
		) {
			const name = calleeName(node.callee);
			const draws = node.type === "NewExpression" && name !== undefined && SHARED_ROWS.has(name);
			const member =
				node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression"
					? node.callee
					: undefined;
			const receiver = member?.object;
			const method = member?.computed && member.property.type === "StringLiteral" ? member.property.value : name;
			const registers = receiver && (method === "add" || method === "addFrom" || method === "collect");
			const directDispatch = name === "handleMouse" || name === "dispatchMouseEvent";
			const forwardsClick =
				directDispatch ||
				(name === "click" && receiver?.type === "Identifier" && receiver.name === "focus") ||
				(name === "sendEngineCommand" &&
					node.arguments.some(
						(arg) =>
							arg.type === "ObjectExpression" &&
							arg.properties.some(
								(prop) =>
									prop.type === "ObjectProperty" &&
									keyName(prop.key) === "type" &&
									prop.value.type === "StringLiteral" &&
									prop.value.value === "engine_custom_click",
							),
					)) ||
				(name === "call" && receiver && receiverMember(receiver, ancestors, false) === "handleMouse");
			const dispatches =
				forwardsClick &&
				ancestors.some(
					({ node: parent }) =>
						(parent.type === "ClassMethod" ||
							parent.type === "ObjectMethod" ||
							parent.type === "ObjectProperty" ||
							parent.type === "ClassProperty") &&
						keyName(parent.key) === "handleMouse",
				);
			if (
				!dispatches &&
				!draws &&
				!registers &&
				!(
					name &&
					MATCHING_CALL.test(name) &&
					node.arguments.some((argument) => namesChoosingKey(argument, aliases))
				)
			)
				return;
			// The innermost class or component object literal around the call owns it.
			let owner: Shape | undefined;
			for (let index = ancestors.length - 1; index >= 0 && owner === undefined; index--)
				owner = shapeOf.get(ancestors[index]!.node);
			if (dispatches && owner) {
				forwardsMouse.add(owner);
				if (directDispatch) dispatchesMouse.add(owner);
			} else if (draws && owner) {
				const member =
					ancestors.at(-1)?.node.type === "VariableDeclarator" ? node : nameFromAncestors(ancestors, node);
				recordRowMember(sharedRows, owner, name === "ClickableRow" ? "<row>" : member);
			} else if (registers && owner) {
				const target = receiverMember(receiver, ancestors, true);
				if (target) recordRowMember(registrations, owner, target);
			} else if (!draws && !dispatches && !registers) choosers.add(owner);
		}
	});
	return { shapes, imports, sharedRows, registrations, dispatchesMouse, forwardsMouse, choosers };
}

/** The file a relative import of `source` from `file` names, among `known` files. */
function importedFile(file: string, source: string, known: ReadonlyMap<string, ParsedFile>): string | undefined {
	const target = posix.normalize(posix.join(posix.dirname(file), source));
	const stem = target.replace(/\.[cm]?js$/, "").replace(/\.ts$/, "");
	return [target, `${stem}.ts`, `${stem}/index.ts`].find((candidate) => known.has(candidate));
}

interface Inventory {
	/** Each component, as `file#Name`, or file, that handles a choosing key. */
	readonly choosers: string[];
	/** Those that take no click on their rows and have no route here, each with what it lacks. */
	readonly missing: string[];
	/** Each listed route, by its key, and why it does not hold. */
	readonly broken: string[];
}

/**
 * The components among `files` that choose a row with a key, and those of them a click does not reach. Members and
 * the shared rows a class inherits count as its own, through bases its file imports or declares.
 */
function clickInventory(files: readonly SourceFile[], routes: Readonly<Record<string, Route>>): Inventory {
	const parsed = new Map<string, ParsedFile>();
	for (const file of files) {
		if (/class|matches|handleInput/.test(file.text)) parsed.set(file.path, parseFile(file));
	}
	const classesByName = new Map<string, Shape[]>();
	for (const { shapes } of parsed.values()) {
		for (const shape of shapes) classesByName.set(shape.name, [...(classesByName.get(shape.name) ?? []), shape]);
	}
	const bases = (shape: Shape): readonly Shape[] => {
		const base = shape.base;
		const file = parsed.get(shape.file);
		if (base === undefined || file === undefined) return [];
		const local = file.shapes.filter((candidate) => candidate.name === base && candidate !== shape);
		if (local.length > 0) return local;
		const imported = file.imports.get(base);
		const name = imported?.imported ?? base;
		if (imported?.source.startsWith(".")) {
			const target = importedFile(shape.file, imported.source, parsed);
			const found = (target === undefined ? [] : (parsed.get(target)?.shapes ?? [])).filter(
				(candidate) => candidate.name === name,
			);
			if (found.length > 0) return found;
		}
		// A package import or a re-export: the class of that name, wherever it is declared.
		return classesByName.get(name) ?? [];
	};
	/** The class itself and every class it extends. */
	const lineage = (shape: Shape, seen: ReadonlySet<Shape> = new Set()): Shape[] => [
		shape,
		...bases(shape)
			.filter((base) => !seen.has(base))
			.flatMap((base) => lineage(base, new Set([...seen, shape]))),
	];
	const handlesMouse = (shape: Shape) => lineage(shape).some((ancestor) => ancestor.members.has("handleMouse"));
	const forwardsMouse = (shape: Shape) => {
		const handler = lineage(shape).find((ancestor) => ancestor.members.has("handleMouse"));
		return handler !== undefined && parsed.get(handler.file)?.forwardsMouse.has(handler);
	};
	const rowTargets = (shape: Shape) => {
		const ancestors = lineage(shape);
		const handler = ancestors.find((ancestor) => ancestor.members.has("handleMouse"));
		if (!handler || !parsed.get(handler.file)?.dispatchesMouse.has(handler)) return "none";
		let ownsRows = false;
		for (const ancestor of ancestors) {
			for (const member of parsed.get(ancestor.file)?.sharedRows.get(ancestor) ?? []) {
				ownsRows = true;
				if (
					member === "<row>" ||
					ancestors.some((base) => parsed.get(base.file)?.registrations.get(base)?.has(member))
				)
					return "registered";
			}
		}
		return ownsRows ? "unregistered" : "none";
	};
	const drawsSharedRows = (shape: Shape) => rowTargets(shape) === "registered";
	const shapeNamed = (name: string): Shape | undefined => {
		const [file, component] = name.split("#");
		return parsed.get(file ?? "")?.shapes.find((shape) => shape.name === component);
	};

	const choosers: string[] = [];
	const audited = new Set<string>();
	const missing: string[] = [];
	for (const [path, { choosers: owners, shapes }] of parsed) {
		// Audit every keyboard-driven view, even when it delegates its key handling to an opaque helper. Looking
		// only for a spelling of Enter (or a recognized decoder) would miss ordinary keyboard-only lists.
		const views = shapes.filter((shape) => {
			const members = lineage(shape);
			return (
				members.some((base) => base.members.has("render")) &&
				members.some((base) => base.members.has("handleInput"))
			);
		});
		for (const owner of new Set([...owners, ...views])) {
			const name = owner === undefined ? path : `${owner.file}#${owner.name}`;
			audited.add(name);
			if (owners.has(owner)) choosers.push(name);
			if (owner !== undefined && drawsSharedRows(owner)) continue;
			// A function outside any component, such as a key handler a list in the same file calls.
			if (owner === undefined && shapes.some(drawsSharedRows)) continue;
			if (routes[name] === undefined)
				missing.push(
					`${name}: ${owner === undefined ? "handles a choosing key outside a component" : handlesMouse(owner) ? "takes clicks, but draws no ClickableRows" : "has no handleMouse"}`,
				);
		}
	}
	const broken: string[] = [];
	for (const [name, route] of Object.entries(routes)) {
		if (!audited.has(name)) {
			broken.push(`${name}: handles no choosing key; remove it`);
			continue;
		}
		const shape = name.includes("#") ? shapeNamed(name) : undefined;
		const shapes = name.includes("#") ? [] : (parsed.get(name)?.shapes ?? []);
		const targets = (shape === undefined ? shapes : [shape]).map(rowTargets);
		if (targets.includes("registered")) broken.push(`${name}: draws clickable rows; remove it`);
		else if (targets.includes("unregistered"))
			broken.push(`${name}: constructs ClickableRows but registers no targets`);
		if (route.route === "forwards" && !(shape === undefined ? shapes : [shape]).some(forwardsMouse))
			broken.push(`${name}: forwards no click to ${route.to}`);
		if (route.route === "drawn-by") {
			const drawing = shapeNamed(route.component);
			if (drawing === undefined || !handlesMouse(drawing))
				broken.push(`${name}: ${route.component}, which draws its rows, takes no click on them`);
		}
	}
	return { choosers: choosers.sort(), missing: missing.sort(), broken: broken.sort() };
}

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (["node_modules", "dist", "test", "tests"].includes(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts"))
			files.push(path);
	}
	return files;
}

test("every component that chooses a row with a key takes a click on that row, or says how a click reaches it", () => {
	const files = SOURCE_ROOTS.flatMap((root) =>
		sourceFiles(join(repositoryRoot, root)).map((path) => ({
			path: relative(repositoryRoot, path).replaceAll("\\", "/"),
			text: readFileSync(path, "utf8"),
		})),
	);
	const { missing, broken } = clickInventory(files, ROUTES);
	assert.deepEqual(
		missing,
		[],
		"These components handle a key that chooses a list row. Draw the rows through ClickableRows or ClickableRow, " +
			"or add the component to ROUTES with how a click reaches its rows.",
	);
	assert.deepEqual(broken, [], "These ROUTES entries do not hold.");
});

/** A list that picks a color with the keyboard only; `INPUT` and `CHECK` are filled in by each case below. */
const KEYBOARD_ONLY_LIST = `import { getKeybindings, Key, matchesKey, type Component } from "@bastani/atomic-tui";
const OPEN_KEY = "tui.select.confirm";
export class ColorList implements Component {
	private selected = 0;
	constructor(private readonly choose: (value: string) => void) {}
	render(): string[] {
		return ["Pick a color", ...["red", "blue"].map((value, i) => \`\${i === this.selected ? ">" : " "} \${value}\`)];
	}
	invalidate(): void {}
	handleInput(INPUT: string): void {
		if (matchesKey(INPUT, "down")) this.selected = 1;
		if (CHECK) this.choose(["red", "blue"][this.selected]!);
	}
}`;

/** What the same list needs to take a click on its rows through the shared path. */
const CLICKABLE_MEMBERS = `
	private readonly rows = new ClickableRows<number>();
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.rows.handleMouse(event, { activate: (index) => this.choose(["red", "blue"][index]!) });
	}`;

const CHOOSING_CHECKS: readonly { readonly form: string; readonly input: string; readonly check: string }[] = [
	{ form: "Enter, read from input named `input`", input: "input", check: 'matchesKey(input, "enter")' },
	{ form: "Enter, read from input named `data`", input: "data", check: 'matchesKey(data, "enter")' },
	{ form: "Enter through the Key constants", input: "keys", check: "matchesKey(keys, Key.enter)" },
	{
		form: "the confirm action through the keybindings",
		input: "event",
		check: 'getKeybindings().matches(event, "tui.select.confirm")',
	},
	{
		form: "the confirm action through a local constant",
		input: "raw",
		check: "getKeybindings().matches(raw, OPEN_KEY)",
	},
];

for (const [form, body] of [
	["a switch on a decoded key", "switch (parseKey(input)) { case 'enter': this.choose('red'); }"],
	["a raw carriage return", String.raw`if (input === '\r') this.choose('red');`],
	["a delegated key check", "if (shouldSelect(input)) this.choose('red');"],
]) {
	test(`a keyboard-only list using ${form} is reported`, () => {
		const text = KEYBOARD_ONLY_LIST.replaceAll("INPUT", "input").replace(/if \(CHECK\).*?;/, body!);
		const { missing } = clickInventory([{ path: "pkg/color-list.ts", text }], {});
		assert.deepEqual(missing, ["pkg/color-list.ts#ColorList: has no handleMouse"]);
	});
}

for (const { form, input, check } of CHOOSING_CHECKS) {
	test(`a keyboard-only list that chooses its row with ${form} is reported until it takes clicks`, () => {
		const source = KEYBOARD_ONLY_LIST.replaceAll("INPUT", input).replace("CHECK", check);
		const keyboardOnly = clickInventory([{ path: "pkg/color-list.ts", text: source }], {});
		assert.deepEqual(keyboardOnly.missing, ["pkg/color-list.ts#ColorList: has no handleMouse"]);

		const clickable = source
			.replace("import {", "import { ClickableRows, type TuiMouseEvent, type TuiMouseEventResult,")
			.replace("\tprivate selected = 0;", `\tprivate selected = 0;${CLICKABLE_MEMBERS}`)
			.replace(
				'return ["Pick a color",',
				'this.rows.clear(); ["red", "blue"].forEach((value, i) => this.rows.add(i + 1, i, value)); return ["Pick a color",',
			);
		const withClicks = clickInventory([{ path: "pkg/color-list.ts", text: clickable }], {});
		assert.deepEqual(withClicks.choosers, ["pkg/color-list.ts#ColorList"]);
		assert.deepEqual(withClicks.missing, []);
	});
}

test("a keyboard-only list in a file that draws another list's clickable rows is still reported", () => {
	const source = `import { ClickableRows, matchesKey, type TuiMouseEvent } from "@bastani/atomic-tui";
export class ClickableList {
	private readonly rows = new ClickableRows<number>();
	render(): string[] { this.rows.add(0, 0, "red"); return ["red"]; }
	handleInput(data: string): void { if (matchesKey(data, "enter")) this.rows.clear(); }
	handleMouse(event: TuiMouseEvent) { return this.rows.handleMouse(event, { activate: () => {} }); }
}
export const keyboardOnly = {
	render: () => ["red", "blue"],
	handleInput(input: string) { if (matchesKey(input, "enter")) return; },
};`;
	const { choosers, missing } = clickInventory([{ path: "pkg/lists.ts", text: source }], {});
	assert.deepEqual(choosers, ["pkg/lists.ts#ClickableList", "pkg/lists.ts#keyboardOnly"]);
	assert.deepEqual(missing, ["pkg/lists.ts#keyboardOnly: has no handleMouse"]);
});

test("another component's shared rows do not cover a keyboard-only list with an unrelated mouse handler", () => {
	const text = `${KEYBOARD_ONLY_LIST.replaceAll("INPUT", "input").replace("CHECK", "matchesKey(input, 'enter')").replace("invalidate():", "handleMouse(event: TuiMouseEvent) { if (event.type === 'wheel') this.selected = 0; } invalidate():")}\nclass Other { rows = new ClickableRows(); }`;
	assert.deepEqual(clickInventory([{ path: "pkg/list.ts", text }], {}).missing, [
		"pkg/list.ts#ColorList: takes clicks, but draws no ClickableRows",
	]);
});

test("a list needs to register the rows it paints for a click (#5642)", async () => {
	const path = "test/fixtures/clickable-color-list.ts";
	const text = readFileSync(join(repositoryRoot, path), "utf8");
	const ui = makeClickScreen();
	try {
		const list = new ColorList();
		ui.dock(list);
		await ui.click("blue");
		assert.deepEqual(list.chosen, ["blue"]);
		for (const registration of [
			"this.rows.add",
			"this.rows?.add",
			'this.rows["add"]',
			"const { rows: targets } = this; targets.add",
		]) {
			const registered = text.replace("this.rows.add", registration);
			assert.deepEqual(clickInventory([{ path, text: registered }], {}).missing, [], registration);
		}
		for (const registration of ["", "const other = { rows: new Set<string>() }; other.rows.add(color);"]) {
			const unregistered = text.replace("this.rows.add(index, color, color);", registration);
			assert.deepEqual(clickInventory([{ path, text: unregistered }], {}).missing, [
				`${path}#ColorList: takes clicks, but draws no ClickableRows`,
			]);
		}
	} finally {
		ui.tui.stop();
	}
});

test("a route entry cannot excuse a list that registers none of its rows (#5642)", () => {
	const path = "test/fixtures/clickable-color-list.ts";
	const text = readFileSync(join(repositoryRoot, path), "utf8").replace("this.rows.add(index, color, color);", "");
	const routes = { [`${path}#ColorList`]: noRows("no selectable rows") };
	assert.deepEqual(clickInventory([{ path, text }], routes).broken, [
		`${path}#ColorList: constructs ClickableRows but registers no targets`,
	]);
});

test("a list with registered rows still needs to send mouse events to them (#5642)", () => {
	const path = "test/fixtures/clickable-color-list.ts";
	const text = readFileSync(join(repositoryRoot, path), "utf8").replace(
		"return this.rows.handleMouse(event,",
		"const focus = { click() {} }; return focus.click(event,",
	);
	assert.deepEqual(clickInventory([{ path, text }], {}).missing, [
		`${path}#ColorList: takes clicks, but draws no ClickableRows`,
	]);
});

test("a listed wrapper must actually forward clicks, not merely declare a mouse handler (#5642)", () => {
	const path = "pkg/wrapper.ts";
	const routes = { [`${path}#Pane`]: forwards("its list") };
	const text = `class Pane {
		render() { return this.list.render(); }
		handleInput(data) { return this.list.handleInput(data); }
		handleMouse(event) { return this.list.handleMouse(event); }
	}`;
	assert.deepEqual(clickInventory([{ path, text }], routes).broken, []);
	assert.deepEqual(
		clickInventory([{ path, text: text.replace("return this.list.handleMouse(event)", "return undefined") }], routes)
			.broken,
		[`${path}#Pane: forwards no click to its list`],
	);
});

test("constructing shared rows without routing mouse input to them still reports a keyboard-only list", () => {
	const text = KEYBOARD_ONLY_LIST.replaceAll("INPUT", "input")
		.replace("CHECK", "matchesKey(input, 'enter')")
		.replace(
			"private selected",
			"private rows = new ClickableRows(); handleMouse() { return undefined; } private selected",
		);
	assert.deepEqual(clickInventory([{ path: "pkg/list.ts", text }], {}).missing, [
		"pkg/list.ts#ColorList: takes clicks, but draws no ClickableRows",
	]);
});

test("a list that inherits its click handling and its clickable rows from a base class is not reported", () => {
	const { missing } = clickInventory(
		[
			{
				path: "pkg/base.ts",
				text: `import { ClickableRows, type TuiMouseEvent } from "@bastani/atomic-tui";
export abstract class ClickableBase {
	protected readonly rows = new ClickableRows<number>();
	handleMouse(event: TuiMouseEvent) { return this.rows.handleMouse(event, { activate: () => {} }); }
}`,
			},
			{
				path: "pkg/list.ts",
				text: `import { matchesKey } from "@bastani/atomic-tui";
import { ClickableBase } from "./base.js";
export class List extends ClickableBase {
	render(): string[] { this.rows.add(0, 0, "red"); return ["red"]; }
	handleInput(key: string): void { if (matchesKey(key, "enter")) this.rows.clear(); }
}`,
			},
		],
		{},
	);
	assert.deepEqual(missing, []);
});

test("a key hint naming the confirm key, or a key matched against something else, chooses nothing", () => {
	const { choosers } = clickInventory(
		[
			{
				path: "pkg/hints.ts",
				text: `import { keyHint, matchesKey } from "@bastani/atomic-tui";
export class Hints {
	render(): string[] { return [keyHint("tui.select.confirm", "continue")]; }
	handleInput(data: string): void { if (matchesKey(data, "down")) return; }
}`,
			},
		],
		{},
	);
	assert.deepEqual(choosers, []);
});
