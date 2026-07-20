import type { AgentSessionReloadOptions } from "../../core/agent-session-types.ts";
import type { KeybindingsConfig, KeybindingsManager } from "../../core/keybindings.ts";
import type { EngineExtensionShortcut, EngineKeybindingState, SerializableKeybindingsConfig } from "../interactive-engine/protocol.ts";

export interface ReloadableSession {
	reload(options?: AgentSessionReloadOptions): Promise<void>;
}

function serializeBindings(config: KeybindingsConfig): SerializableKeybindingsConfig {
	const serialized: SerializableKeybindingsConfig = {};
	for (const [key, binding] of Object.entries(config)) {
		if (binding !== undefined) serialized[key] = Array.isArray(binding) ? [...binding] : binding;
	}
	return serialized;
}

type ShortcutCatalogResolver<TSession extends ReloadableSession> = (
	session: TSession,
	effectiveBindings: KeybindingsConfig,
) => EngineExtensionShortcut[];

/**
 * Serializes the full keybinding/session reload transaction for one shared
 * manager. The queue survives rejection, mutates the manager in place, and
 * publishes only state from a committed successful reload.
 */
export class KeybindingsReloadCoordinator<TSession extends ReloadableSession = ReloadableSession> {
	private tail: Promise<void> = Promise.resolve();
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onCommitted: ((state: EngineKeybindingState) => void) | undefined;
	private readonly resolveShortcuts: ShortcutCatalogResolver<TSession> | undefined;

	constructor(
		keybindings: KeybindingsManager | undefined,
		onCommitted?: (state: EngineKeybindingState) => void,
		resolveShortcuts?: ShortcutCatalogResolver<TSession>,
	) {
		this.keybindings = keybindings;
		this.onCommitted = onCommitted;
		this.resolveShortcuts = resolveShortcuts;
	}

	reload(session: TSession): Promise<EngineKeybindingState | undefined> {
		const transaction = this.tail.then(
			() => this.runTransaction(session),
			() => this.runTransaction(session),
		);
		this.tail = transaction.then(() => {}, () => {});
		return transaction;
	}

	publishCurrentState(session: TSession): EngineKeybindingState | undefined {
		if (!this.keybindings) return undefined;
		const state = this.createState(session);
		this.onCommitted?.(state);
		return state;
	}

	private createState(session: TSession): EngineKeybindingState {
		const effectiveBindings = this.keybindings!.getEffectiveConfig();
		return {
			userBindings: serializeBindings(this.keybindings!.getUserBindings()),
			effectiveBindings: serializeBindings(effectiveBindings),
			shortcuts: this.resolveShortcuts?.(session, effectiveBindings) ?? [],
		};
	}

	private async runTransaction(session: TSession): Promise<EngineKeybindingState | undefined> {
		if (!this.keybindings) {
			await session.reload();
			return undefined;
		}

		const previousUserBindings = this.keybindings.getUserBindings();
		let keybindingsApplied = false;
		try {
			await session.reload({
				beforeSessionStart: () => {
					this.keybindings!.reload();
					keybindingsApplied = true;
				},
			});
			return this.publishCurrentState(session);
		} catch (error) {
			if (keybindingsApplied) this.keybindings.setUserBindings(previousUserBindings);
			throw error;
		}
	}
}

/** Compatibility helper for callers that do not share a longer-lived queue. */
export async function reloadSessionWithKeybindings(
	session: ReloadableSession,
	keybindings: KeybindingsManager | undefined,
	onKeybindingsReloaded?: () => void,
): Promise<void> {
	const coordinator = new KeybindingsReloadCoordinator(
		keybindings,
		onKeybindingsReloaded ? () => onKeybindingsReloaded() : undefined,
	);
	await coordinator.reload(session);
}
