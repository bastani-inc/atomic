import type { EngineTerminalControl } from "./protocol.ts";

/**
 * Host-side terminal-mode arbiter for remote custom components.
 *
 * Remote components (running in the engine child) cannot touch the host TTY —
 * their stdout is the JSONL transport, not a terminal. Instead they send typed
 * {@link EngineTerminalControl} intents; this controller owns the concrete
 * escape sequences and applies them to the real host terminal associated with
 * the mounted component. Never a raw byte channel: only the two allowlisted
 * modes below can ever reach the terminal.
 *
 * Guarantees:
 *  - Controls that arrive before the component mounts are buffered and flushed
 *    on mount (the child enables mouse reporting inside the overlay factory,
 *    which runs before the mount `engine_custom_open` on the wire).
 *  - In fullscreen, `TuiAltScreen` owns mouse and autowrap itself. Remote
 *    intents remain tracked but never write over that baseline; switching back
 *    to regular mode reapplies active intents.
 *  - In regular mode, every mode a component turns on is restored when that
 *    component unmounts, or when the whole controller resets (engine crash /
 *    restart / generation replacement / host shutdown).
 *  - State is component-scoped: a stale child cannot reset or alter a mode
 *    owned by the currently mounted component.
 */

export const HOST_MOUSE_SCROLL_TRACKING_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const HOST_MOUSE_SCROLL_TRACKING_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
export const HOST_TERMINAL_AUTOWRAP_ON = "\x1b[?7h";
export const HOST_TERMINAL_AUTOWRAP_OFF = "\x1b[?7l";

export interface HostTerminalWriter {
	write(data: string): void;
}

interface ComponentTerminalState {
	terminal?: HostTerminalWriter;
	/** Component currently has mouse-scroll reporting enabled. */
	mouse: boolean;
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
		if (this.hasMouseControl()) this.writeMouse(terminal);
		if (this.hasAutowrapDisabledControl()) this.writeAutowrap(terminal);
	}

	private ensure(componentId: string): ComponentTerminalState {
		let state = this.components.get(componentId);
		if (!state) {
			state = { mouse: false, autowrapDisabled: false, buffered: [] };
			this.components.set(componentId, state);
		}
		return state;
	}

	private write(state: ComponentTerminalState, control: EngineTerminalControl): void {
		if (control.kind === "mouse-scroll-tracking") {
			if (control.enabled === state.mouse) return;
			const hadMouseControl = this.hasMouseControl();
			state.mouse = control.enabled;
			if (hadMouseControl !== this.hasMouseControl()) this.writeMouse(state.terminal);
			return;
		}
		const disabled = !control.enabled;
		if (disabled === state.autowrapDisabled) return;
		const hadAutowrapDisabledControl = this.hasAutowrapDisabledControl();
		state.autowrapDisabled = disabled;
		if (hadAutowrapDisabledControl !== this.hasAutowrapDisabledControl()) this.writeAutowrap(state.terminal);
	}

	private writeMouse(terminal: HostTerminalWriter | undefined): void {
		if (!terminal || this.isFullscreen()) return;
		terminal.write(this.hasMouseControl() ? HOST_MOUSE_SCROLL_TRACKING_ON : HOST_MOUSE_SCROLL_TRACKING_OFF);
	}

	private writeAutowrap(terminal: HostTerminalWriter | undefined): void {
		if (!terminal || this.isFullscreen()) return;
		terminal.write(this.hasAutowrapDisabledControl() ? HOST_TERMINAL_AUTOWRAP_OFF : HOST_TERMINAL_AUTOWRAP_ON);
	}

	private hasMouseControl(): boolean {
		for (const state of this.components.values()) {
			if (state.terminal && state.mouse) return true;
		}
		return false;
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
		if (state.mouse) {
			const hadMouseControl = this.hasMouseControl();
			state.mouse = false;
			if (hadMouseControl !== this.hasMouseControl()) this.writeMouse(state.terminal);
		}
		if (state.autowrapDisabled) {
			const hadAutowrapDisabledControl = this.hasAutowrapDisabledControl();
			state.autowrapDisabled = false;
			if (hadAutowrapDisabledControl !== this.hasAutowrapDisabledControl()) this.writeAutowrap(state.terminal);
		}
		state.buffered = [];
	}
}

/** Whether a control merely restores a mode's safe default (mouse off / autowrap on). */
function isDefaultControl(control: EngineTerminalControl): boolean {
	return control.kind === "mouse-scroll-tracking" ? !control.enabled : control.enabled;
}
