import type { EngineTerminalControl } from "./protocol.ts";

/**
 * Host-side terminal-mode arbiter for remote custom components.
 *
 * Remote components (running in the engine child) cannot touch the host TTY —
 * their stdout is the JSONL transport, not a terminal. Instead they send a
 * typed autowrap intent; this controller owns the concrete escape sequences
 * and applies them to the real host terminal associated with the mounted
 * component. Never a raw byte channel: only the allowlisted mode below can
 * reach the terminal.
 *
 * Guarantees:
 *  - Controls that arrive before the component mounts are buffered and flushed
 *    on mount.
 *  - In fullscreen, `TuiAltScreen` owns autowrap itself. Remote intents remain
 *    tracked but never write over that baseline; switching back to regular mode
 *    reapplies the active intent.
 *  - A component's autowrap state is restored when it unmounts, or when the
 *    whole controller resets (engine crash / restart / generation replacement /
 *    host shutdown).
 *  - State is component-scoped: a stale child cannot reset or alter a mode
 *    owned by the currently mounted component.
 */

export const HOST_TERMINAL_AUTOWRAP_ON = "\x1b[?7h";
export const HOST_TERMINAL_AUTOWRAP_OFF = "\x1b[?7l";

export interface HostTerminalWriter {
	write(data: string): void;
}

interface ComponentTerminalState {
	terminal?: HostTerminalWriter;
	/** Component currently has autowrap disabled (its non-default state). */
	autowrapDisabled: boolean;
	/** Controls received before the component mounted. */
	buffered: EngineTerminalControl[];
}

export class TerminalModeController {
	private readonly isFullscreen: () => boolean;
	private readonly components = new Map<string, ComponentTerminalState>();

	constructor(isFullscreen: () => boolean) {
		this.isFullscreen = isFullscreen;
	}

	/** Apply (or buffer) a typed control for a component. */
	applyControl(componentId: string, control: EngineTerminalControl): void {
		let state = this.components.get(componentId);
		if (!state) {
			// A control from an unmounted (late/stale) component that only restores
			// the default mode has nothing to reset — ignore it rather than leak a
			// dead entry or let a stale child perturb terminal-mode bookkeeping.
			if (isDefaultControl(control)) return;
			state = this.ensure(componentId);
		}
		if (!state.terminal) {
			state.buffered.push(control);
			return;
		}
		this.write(state, control);
	}

	/** Register the host terminal for a component and flush buffered controls. */
	onMount(componentId: string, terminal: HostTerminalWriter): void {
		const state = this.ensure(componentId);
		state.terminal = terminal;
		for (const control of state.buffered.splice(0)) this.write(state, control);
	}

	/** Reset and forget a single component's terminal modes. */
	onUnmount(componentId: string): void {
		const state = this.components.get(componentId);
		if (!state) return;
		this.reset(state);
		this.components.delete(componentId);
	}

	/** Reset every component (engine crash/restart/generation swap/shutdown). */
	resetAll(): void {
		for (const state of this.components.values()) this.reset(state);
		this.components.clear();
	}

	/** Reapply active controls after the host renderer changes mode. */
	rebindTui(): void {
		if (this.isFullscreen()) return;
		const terminal = this.firstTerminal();
		if (!terminal) return;
		if (this.hasAutowrapDisabledControl()) this.writeAutowrap(terminal);
	}

	private ensure(componentId: string): ComponentTerminalState {
		let state = this.components.get(componentId);
		if (!state) {
			state = { autowrapDisabled: false, buffered: [] };
			this.components.set(componentId, state);
		}
		return state;
	}

	private write(state: ComponentTerminalState, control: EngineTerminalControl): void {
		const disabled = !control.enabled;
		if (disabled === state.autowrapDisabled) return;
		const hadAutowrapDisabledControl = this.hasAutowrapDisabledControl();
		state.autowrapDisabled = disabled;
		if (hadAutowrapDisabledControl !== this.hasAutowrapDisabledControl()) this.writeAutowrap(state.terminal);
	}

	private writeAutowrap(terminal: HostTerminalWriter | undefined): void {
		if (!terminal || this.isFullscreen()) return;
		terminal.write(this.hasAutowrapDisabledControl() ? HOST_TERMINAL_AUTOWRAP_OFF : HOST_TERMINAL_AUTOWRAP_ON);
	}

	private hasAutowrapDisabledControl(): boolean {
		for (const state of this.components.values()) {
			if (state.terminal && state.autowrapDisabled) return true;
		}
		return false;
	}

	private firstTerminal(): HostTerminalWriter | undefined {
		for (const state of this.components.values()) {
			if (state.terminal) return state.terminal;
		}
		return undefined;
	}

	private reset(state: ComponentTerminalState): void {
		if (state.autowrapDisabled) {
			const hadAutowrapDisabledControl = this.hasAutowrapDisabledControl();
			state.autowrapDisabled = false;
			if (hadAutowrapDisabledControl !== this.hasAutowrapDisabledControl()) this.writeAutowrap(state.terminal);
		}
		state.buffered = [];
	}
}

/** Whether a control merely restores autowrap's safe default. */
function isDefaultControl(control: EngineTerminalControl): boolean {
	return control.enabled;
}
