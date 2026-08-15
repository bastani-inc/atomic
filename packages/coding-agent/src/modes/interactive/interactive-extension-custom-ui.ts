import {
	ReservedBottomOverlay,
	type TranscriptOverlayIntersection,
	TranscriptOverlayReserve,
	transcriptOverlayIntersection,
	type WrappedOverlayComponent,
} from "./components/reserved-bottom-overlay.ts";
import { InteractiveModeBase, isFullscreenTranscriptScrollAction } from "./interactive-mode-base.ts";
import {
	type Component,
	type KeybindingsManager,
	type OverlayHandle,
	type OverlayOptions,
	Text,
	type Theme,
	type TUI,
	theme,
} from "./interactive-mode-deps.ts";
import { isMouseWheelInput, isOverlayMounted } from "./interactive-tui.ts";

function validateReservedBottomOverlayOptions(options: OverlayOptions | undefined): void {
	const anchor = options?.anchor;
	if (anchor !== "bottom-left" && anchor !== "bottom-center" && anchor !== "bottom-right") {
		throw new Error(
			"reserveTranscriptRows requires an explicit bottom anchor: bottom-left, bottom-center, or bottom-right",
		);
	}
	if (options?.row !== undefined) {
		throw new Error("reserveTranscriptRows does not support overlayOptions.row");
	}
	if (options?.offsetY !== undefined && options.offsetY !== 0) {
		throw new Error("reserveTranscriptRows does not support a nonzero overlayOptions.offsetY");
	}
}

InteractiveModeBase.prototype.showExtensionNotify = function (
	this: InteractiveModeBase,
	message: string,
	type?: "info" | "warning" | "error",
): void {
	if (type === "error") {
		this.showError(message);
	} else if (type === "warning") {
		this.showWarning(message);
	} else {
		this.showStatus(message);
	}
};

InteractiveModeBase.prototype.showExtensionCustom = async function <T>(
	this: InteractiveModeBase,
	factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	options?: {
		overlay?: boolean;
		deferInlineCustomUiFocus?: boolean;
		handlesInternalUiAction?: boolean;
		reserveTranscriptRows?: boolean;
		signal?: AbortSignal;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
		onHandle?: (handle: OverlayHandle) => void;
	},
): Promise<T> {
	const savedText = this.editor.getText();
	const isOverlay = options?.overlay ?? false;

	const restoreEditor = (focusEditor: boolean) => {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.editor.setText(savedText);
		// Focus fence: a surviving overlay owns input, and taking it away to
		// "restore" the editor would dismiss a newer native dialog.
		if (focusEditor && !this.ui.hasOverlay()) this.ui.setFocus(this.editor);
		this.ui.requestRender();
	};

	return new Promise((resolve, reject) => {
		let component: (Component & { dispose?(): void }) | undefined;
		let closed = false;
		let mounted = false;
		let overlayHandle: OverlayHandle | undefined;
		let releaseHostInlineCustomUi: (() => void) | undefined;
		let releaseOverlayInlineCustomUiFocusDeferral: (() => void) | undefined;
		let transcriptReserveCoordinator: TranscriptOverlayReserve | undefined;
		let releaseTranscriptReserveRegistration: (() => void) | undefined;

		const disposeComponent = () => {
			try {
				component?.dispose?.();
			} catch {
				/* ignore dispose errors */
			}
		};

		const releaseHostCustomUi = () => {
			if (component !== undefined && this.pendingInlineCustomUiFocus === component) {
				this.pendingInlineCustomUiFocus = undefined;
				this.notifyHostCustomUiStateListeners();
			}
			releaseHostInlineCustomUi?.();
		};

		const cleanupAbortListener = () => {
			options?.signal?.removeEventListener("abort", abortCustomUi);
		};

		const releaseTranscriptReserve = () => {
			const coordinator = transcriptReserveCoordinator;
			releaseTranscriptReserveRegistration?.();
			releaseTranscriptReserveRegistration = undefined;
			transcriptReserveCoordinator = undefined;
			if (!coordinator) return;
			if (coordinator.empty) {
				this.documentContainer.removeChild(coordinator);
				if (this.transcriptOverlayReserve === coordinator) this.transcriptOverlayReserve = undefined;
			}
			this.ui.requestRender();
		};

		const closeMountedUi = () => {
			if (!mounted) return;
			if (isOverlay) {
				releaseOverlayInlineCustomUiFocusDeferral?.();
				releaseOverlayInlineCustomUiFocusDeferral = undefined;
				releaseTranscriptReserve();
				// Hide THIS overlay, not whatever is on top: during engine-death
				// teardown an unrelated native overlay can be above this one, and the
				// generic top-overlay call would close that instead.
				if (overlayHandle) overlayHandle.hide();
				else this.ui.hideOverlay();
			} else {
				restoreEditor(!this.shouldDeferInlineCustomUiFocus() && this.pendingInlineCustomUiFocus !== component);
			}
		};

		const close = (result: T) => {
			if (closed) return;
			closed = true;
			cleanupAbortListener();
			closeMountedUi();
			disposeComponent();
			releaseHostCustomUi();
			resolve(result);
		};

		const rejectAndClose = (reason: unknown) => {
			if (closed) return;
			closed = true;
			cleanupAbortListener();
			closeMountedUi();
			disposeComponent();
			releaseHostCustomUi();
			reject(reason);
		};

		function abortCustomUi(): void {
			rejectAndClose(options?.signal?.reason ?? new Error("Extension custom UI aborted"));
		}

		if (options?.signal?.aborted) {
			abortCustomUi();
			return;
		}
		releaseHostInlineCustomUi = isOverlay ? undefined : this.beginHostInlineCustomUi();
		if (options?.signal?.aborted) {
			abortCustomUi();
			return;
		}
		options?.signal?.addEventListener("abort", abortCustomUi, { once: true });

		let factoryResult: (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
		try {
			factoryResult = factory(this.ui, theme, this.keybindings, close);
		} catch (err) {
			rejectAndClose(err);
			return;
		}

		Promise.resolve(factoryResult)
			.then((c) => {
				if (closed) {
					try {
						c.dispose?.();
					} catch {
						/* ignore dispose errors */
					}
					return;
				}
				component = c;
				if (options?.handlesInternalUiAction === true) {
					(component as Component & { handlesInternalUiAction?: boolean }).handlesInternalUiAction = true;
				}
				if (isOverlay) {
					// Resolve overlay options - can be static or dynamic function
					const resolveOptions = (): OverlayOptions | undefined => {
						if (options?.overlayOptions) {
							const opts =
								typeof options.overlayOptions === "function"
									? options.overlayOptions()
									: options.overlayOptions;
							return opts;
						}
						// Fallback: use component's width property if available
						const w = (component as { width?: number } | undefined)?.width;
						return w ? { width: w } : undefined;
					};
					// A reserving overlay is bounded so a transcript strip always
					// survives, and the rows it still covers are added to the end of
					// the document so the scroll clamp can raise them into that strip.
					const resolvedOverlayOptions = resolveOptions();
					let mountedOverlayOptions = resolvedOverlayOptions;
					let mountedComponent = component;
					let pendingReserve: (() => TranscriptOverlayIntersection | undefined) | undefined;
					if (options?.reserveTranscriptRows === true) {
						validateReservedBottomOverlayOptions(resolvedOverlayOptions);
						// `custom()` documents the richer `ExtensionCustomComponent`
						// contract; this signature still names pi-tui's narrower one.
						const bounded = new ReservedBottomOverlay(
							component as WrappedOverlayComponent,
							() => this.ui.terminal.rows,
							resolvedOverlayOptions?.margin,
							resolvedOverlayOptions?.maxHeight,
							(data) => isFullscreenTranscriptScrollAction(data, this.keybindings) || isMouseWheelInput(data),
							() => this.ui.requestRender(),
						);
						mountedComponent = bounded;
						if (resolvedOverlayOptions?.maxHeight !== undefined) {
							mountedOverlayOptions = { ...resolvedOverlayOptions };
							delete mountedOverlayOptions.maxHeight;
						}
						// A raw host reset can remove the exact overlay without touching its
						// handle. Stop reserving in that frame, then remove the registration
						// after the document render traversal finishes.
						let removalObserved = false;
						const overlayShowing = (): boolean => {
							if (!isOverlayMounted(this.ui, mountedComponent)) {
								if (!removalObserved) {
									removalObserved = true;
									queueMicrotask(releaseTranscriptReserve);
								}
								return false;
							}
							if (overlayHandle === undefined || overlayHandle.isHidden()) return false;
							const visible = resolvedOverlayOptions?.visible;
							return visible === undefined ? true : visible(this.ui.terminal.columns, this.ui.terminal.rows);
						};
						pendingReserve = () =>
							overlayShowing()
								? transcriptOverlayIntersection(
										bounded.renderedHeight,
										this.ui.terminal.rows,
										this.transcriptScrollView?.viewportHeight ?? 0,
										resolvedOverlayOptions?.margin,
									)
								: undefined;
					}
					const handle = this.ui.showOverlay(mountedComponent, mountedOverlayOptions);
					overlayHandle = handle;
					mounted = true;
					// Register only once the overlay is really up and `mounted` is
					// set: a throw before this point must not leave a registry entry
					// or blank-row component in the transcript document.
					if (pendingReserve) {
						let coordinator = this.transcriptOverlayReserve;
						if (!coordinator) {
							coordinator = new TranscriptOverlayReserve(() => this.transcriptScrollView?.viewportHeight ?? 0);
							this.transcriptOverlayReserve = coordinator;
							transcriptReserveCoordinator = coordinator;
							this.documentContainer.addChild(coordinator);
						} else {
							transcriptReserveCoordinator = coordinator;
						}
						releaseTranscriptReserveRegistration = coordinator.register(pendingReserve);
					}
					let releaseDeferral: (() => void) | undefined;
					if (options?.deferInlineCustomUiFocus) {
						releaseDeferral = this.beginInlineCustomUiFocusDeferral();
						releaseOverlayInlineCustomUiFocusDeferral = () => {
							releaseDeferral?.();
							releaseDeferral = undefined;
						};
					}
					if (options?.deferInlineCustomUiFocus || pendingReserve) {
						const release = () => {
							releaseOverlayInlineCustomUiFocusDeferral?.();
							releaseOverlayInlineCustomUiFocusDeferral = undefined;
						};
						const wrappedHandle: OverlayHandle = {
							hide: () => {
								release();
								releaseTranscriptReserve();
								handle.hide();
							},
							setHidden: (hidden) => {
								if (hidden) release();
								handle.setHidden(hidden);
								if (!hidden && options?.deferInlineCustomUiFocus && releaseDeferral === undefined) {
									releaseDeferral = this.beginInlineCustomUiFocusDeferral();
									releaseOverlayInlineCustomUiFocusDeferral = () => {
										releaseDeferral?.();
										releaseDeferral = undefined;
									};
								}
							},
							isHidden: () => handle.isHidden(),
							focus: () => handle.focus(),
							unfocus: (unfocusOptions) => handle.unfocus(unfocusOptions),
							isFocused: () => handle.isFocused(),
						};
						overlayHandle = wrappedHandle;
						options?.onHandle?.(wrappedHandle);
					} else {
						options?.onHandle?.(handle);
					}
				} else {
					this.disposeActiveSelector();
					this.editorContainer.clear();
					this.editorContainer.addChild(component);
					if (this.shouldDeferInlineCustomUiFocus()) {
						this.pendingInlineCustomUiFocus = component;
						this.notifyHostCustomUiStateListeners();
					} else {
						this.ui.setFocus(component);
					}
					mounted = true;
					this.ui.requestRender();
				}
			})
			.catch((err) => {
				rejectAndClose(err);
			});
	});
};

InteractiveModeBase.prototype.showExtensionError = function (
	this: InteractiveModeBase,
	extensionPath: string,
	error: string,
	stack?: string,
): void {
	const errorMsg = `Extension "${extensionPath}" error: ${error}`;
	const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
	this.chatContainer.addChild(errorText);
	if (stack) {
		// Show stack trace in dim color, indented
		const stackLines = stack
			.split("\n")
			.slice(1) // Skip first line (duplicates error message)
			.map((line) => theme.fg("dim", `  ${line.trim()}`))
			.join("\n");
		if (stackLines) {
			this.chatContainer.addChild(new Text(stackLines, 1, 0));
		}
	}
	this.ui.requestRender();
};
