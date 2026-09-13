import type { KeyId } from "@earendil-works/pi-tui";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { keybindingIdentity } from "../keybinding-identity.js";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { Extension, ExtensionShortcut } from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

// These actions are dispatched by the workflow extension, not by the editor.
const WORKFLOW_SCROLL_ACTIONS = ["app.workflows.scrollUp", "app.workflows.scrollDown"];

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined || WORKFLOW_SCROLL_ACTIONS.includes(keybinding)) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = { keybinding, restrictOverride };
		}
	}
	return builtinKeybindings;
};

export interface ExtensionShortcutResolution {
	shortcuts: Map<KeyId, ExtensionShortcut>;
	diagnostics: ResourceDiagnostic[];
}

function configuredShortcutKeys(shortcut: ExtensionShortcut, bindings: KeybindingsConfig): KeyId[] {
	const configured = bindings[shortcut.keybinding!] ?? [];
	return (Array.isArray(configured) ? configured : [configured]).filter(
		(key) =>
			!Object.entries(bindings).some(
				([action, keys]) =>
					action !== shortcut.keybinding &&
					!WORKFLOW_SCROLL_ACTIONS.includes(action) &&
					(shortcut.preferEditor ||
						(RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(action)) &&
					(Array.isArray(keys) ? keys : [keys]).some(
						(value) => value !== undefined && keybindingIdentity(value) === keybindingIdentity(key),
					),
			),
	);
}

export function resolveExtensionShortcuts(
	extensions: Extension[],
	resolvedKeybindings: KeybindingsConfig,
	hasUI: boolean,
): ExtensionShortcutResolution {
	const diagnostics: ResourceDiagnostic[] = [];
	const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
	const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

	const addDiagnostic = (message: string, extensionPath: string) => {
		diagnostics.push({ type: "warning", message, path: extensionPath });
		if (!hasUI) {
			console.warn(message);
		}
	};

	for (const ext of extensions) {
		for (const [key, shortcut] of ext.shortcuts) {
			if (shortcut.keybinding) {
				for (const binding of configuredShortcutKeys(shortcut, resolvedKeybindings)) {
					extensionShortcuts.set(binding.toLowerCase() as KeyId, { ...shortcut, shortcut: binding });
				}
				continue;
			}
			const normalizedKey = key.toLowerCase() as KeyId;
			const builtInKeybinding = builtinKeybindings[normalizedKey];
			const editorConflict =
				shortcut.preferEditor &&
				Object.keys(builtinKeybindings).some(
					(binding) => keybindingIdentity(binding as KeyId) === keybindingIdentity(key),
				);
			if (builtInKeybinding?.restrictOverride === true || editorConflict) {
				addDiagnostic(
					`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
					shortcut.extensionPath,
				);
				continue;
			}

			if (builtInKeybinding?.restrictOverride === false) {
				addDiagnostic(
					`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
					shortcut.extensionPath,
				);
			}

			const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
			if (existingExtensionShortcut) {
				addDiagnostic(
					`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
					shortcut.extensionPath,
				);
			}
			extensionShortcuts.set(normalizedKey, shortcut);
		}
	}
	return { shortcuts: extensionShortcuts, diagnostics };
}
