import type { ExtensionWidgetOptions } from "./types.ts";

export interface ReactiveWidgetComponent {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
}

export type ReactiveWidgetFactory<TTheme> = (tui: unknown, theme: TTheme) => ReactiveWidgetComponent;

export interface ReactiveWidgetUi<TTheme> {
	setWidget(key: string, factory: ReactiveWidgetFactory<TTheme> | undefined, options?: ExtensionWidgetOptions): void;
	requestRender?: () => void;
}

export interface ReactiveWidgetTimerHandle {
	unref?: () => void;
}

export interface ReactiveWidgetTimerApi {
	setTimeout(handler: () => void, delayMs: number): ReactiveWidgetTimerHandle;
	clearTimeout(handle: ReactiveWidgetTimerHandle): void;
}

export interface ReactiveWidgetScheduler {
	queueMicrotask(handler: () => void): void;
}

export type ReactiveWidgetAction = "mount" | "unmount" | "update" | "none";
export type ReactiveWidgetRefreshReason = "initial" | "state" | "clock" | "manual";

export interface ReactiveWidgetRenderState {
	readonly mounted: boolean;
	readonly lines: readonly string[];
}

export interface ReactiveWidgetRenderContext<TTheme> {
	theme: TTheme;
	width: number;
	now: number;
}

export interface ReactiveWidgetController {
	refresh(reason?: ReactiveWidgetRefreshReason): void;
	dispose(): void;
	isMounted(): boolean;
}

export interface InstallReactiveWidgetOptions<TSnapshot, TTheme> {
	ui: ReactiveWidgetUi<TTheme>;
	key: string;
	placement?: ExtensionWidgetOptions["placement"];
	getSnapshot(): TSnapshot;
	subscribe?(listener: () => void): () => void;
	getPreviewLines(snapshot: TSnapshot, now: number): readonly string[];
	render(snapshot: TSnapshot, context: ReactiveWidgetRenderContext<TTheme>): readonly string[];
	getNextRefreshDelayMs?(snapshot: TSnapshot, now: number): number | undefined;
	now?: () => number;
	timers?: ReactiveWidgetTimerApi;
	scheduler?: ReactiveWidgetScheduler;
	coalesceRenderRequests?: boolean;
	requestRenderOnMount?: boolean;
	requestRenderOnUnmount?: boolean;
	requestRenderOnStateNoop?: boolean;
	isStaleError?: (error: unknown) => boolean;
}

const defaultTimerApi: ReactiveWidgetTimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs) as ReactiveWidgetTimerHandle,
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultScheduler: ReactiveWidgetScheduler = {
	queueMicrotask: (handler) => queueMicrotask(handler),
};

function getRequestRenderFromHost(host: unknown): (() => void) | undefined {
	if (typeof host !== "object" || host === null) return undefined;
	const candidate = (host as { requestRender?: unknown }).requestRender;
	if (typeof candidate !== "function") return undefined;
	return () => candidate.call(host);
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function decideReactiveWidgetAction(
	prev: ReactiveWidgetRenderState,
	nextLines: readonly string[],
): ReactiveWidgetAction {
	const nextVisible = nextLines.length > 0;
	if (!prev.mounted) return nextVisible ? "mount" : "none";
	if (!nextVisible) return "unmount";
	return linesEqual(prev.lines, nextLines) ? "none" : "update";
}

export function installReactiveWidget<TSnapshot, TTheme = object>(
	options: InstallReactiveWidgetOptions<TSnapshot, TTheme>,
): ReactiveWidgetController {
	const timers = options.timers ?? defaultTimerApi;
	const scheduler = options.scheduler ?? defaultScheduler;
	const now = options.now ?? Date.now;
	const coalesceRenderRequests = options.coalesceRenderRequests ?? true;
	const requestRenderOnMount = options.requestRenderOnMount ?? true;
	const requestRenderOnUnmount = options.requestRenderOnUnmount ?? true;
	const requestRenderOnStateNoop = options.requestRenderOnStateNoop ?? true;

	let disposed = false;
	let mounted = false;
	let renderQueued = false;
	let mountedRequestRender: (() => void) | undefined;
	let refreshTimer: ReactiveWidgetTimerHandle | undefined;
	let currentSnap = options.getSnapshot();
	let currentNow = now();
	let lastLines: readonly string[] = [];

	const clearRefreshTimer = (): void => {
		if (refreshTimer === undefined) return;
		timers.clearTimeout(refreshTimer);
		refreshTimer = undefined;
	};

	const handleError = (error: unknown): void => {
		if (options.isStaleError?.(error)) return;
		throw error;
	};

	const invokeRequestRender = (): void => {
		if (options.ui.requestRender) {
			options.ui.requestRender();
			return;
		}
		mountedRequestRender?.();
	};

	const requestRender = (): void => {
		if (!coalesceRenderRequests) {
			try {
				invokeRequestRender();
			} catch (error) {
				handleError(error);
			}
			return;
		}
		if (renderQueued) return;
		renderQueued = true;
		scheduler.queueMicrotask(() => {
			renderQueued = false;
			if (disposed) return;
			try {
				invokeRequestRender();
			} catch (error) {
				handleError(error);
			}
		});
	};

	const requestRenderForDispose = (): void => {
		renderQueued = false;
		invokeRequestRender();
	};

	const scheduleRefresh = (): void => {
		const delayMs = options.getNextRefreshDelayMs?.(currentSnap, currentNow);
		if (delayMs === undefined) return;
		refreshTimer = timers.setTimeout(() => {
			refreshTimer = undefined;
			controller.refresh("clock");
		}, delayMs);
		refreshTimer.unref?.();
	};

	const widgetFactory: ReactiveWidgetFactory<TTheme> = (tui, theme) => {
		const fallbackRequestRender = getRequestRenderFromHost(tui);
		if (fallbackRequestRender) mountedRequestRender = fallbackRequestRender;
		return {
			render(width: number): string[] {
				return [...options.render(currentSnap, { theme, width, now: currentNow })];
			},
			invalidate(): void {
				// The component is intentionally stateless; callers should rebuild from the
				// latest snapshot/time on every render. This hook exists so pi-tui can still
				// invalidate the long-lived component on theme changes.
			},
		};
	};

	const controller: ReactiveWidgetController = {
		refresh(reason: ReactiveWidgetRefreshReason = "manual"): void {
			if (disposed) return;
			clearRefreshTimer();
			try {
				currentSnap = options.getSnapshot();
				currentNow = now();
				const nextLines = options.getPreviewLines(currentSnap, currentNow);
				const action = decideReactiveWidgetAction({ mounted, lines: lastLines }, nextLines);

				switch (action) {
					case "mount":
						options.ui.setWidget(
							options.key,
							widgetFactory,
							options.placement ? { placement: options.placement } : undefined,
						);
						mounted = true;
						if (requestRenderOnMount) requestRender();
						break;
					case "unmount":
						options.ui.setWidget(options.key, undefined);
						mounted = false;
						if (requestRenderOnUnmount) requestRender();
						break;
					case "update":
						requestRender();
						break;
					case "none":
						if (mounted && reason === "state" && requestRenderOnStateNoop) requestRender();
						break;
				}

				lastLines = nextLines;
				scheduleRefresh();
			} catch (error) {
				handleError(error);
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearRefreshTimer();
			unsubscribe?.();
			try {
				options.ui.setWidget(options.key, undefined);
				mounted = false;
				requestRenderForDispose();
			} catch (error) {
				handleError(error);
			}
		},
		isMounted(): boolean {
			return mounted;
		},
	};

	const unsubscribe = options.subscribe?.(() => controller.refresh("state"));
	controller.refresh("initial");

	return controller;
}
