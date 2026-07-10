import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
describe("InteractiveMode.showExtensionCustom host custom UI state", () => {
	function createCustomUiHostFixture() {
		const fakeThis: any = {
			editor: {
				getText: vi.fn(() => "draft"),
				setText: vi.fn(),
			},
			editorContainer: {
				clear: vi.fn(),
				addChild: vi.fn(),
			},
      statusContainer: {
        clear: vi.fn(),
        addChild: vi.fn(),
      },
      loadingAnimation: undefined,
      workingVisible: true,
      runtimeHost: {
        session: { isStreaming: false },
      },
			keybindings: {},
      ui: {
        setFocus: vi.fn(),
        requestRender: vi.fn(),
        showOverlay: vi.fn(() => ({
          hide: vi.fn(),
          setHidden: vi.fn(),
          isHidden: vi.fn(() => false),
          focus: vi.fn(),
          unfocus: vi.fn(),
          isFocused: vi.fn(() => true),
        })),
        hideOverlay: vi.fn(),
      },
			blockingInlineCustomUiDepth: 0,
			deferredInlineCustomUiFocusDepth: 0,
			pendingInlineCustomUiFocus: undefined,
			hostCustomUiStateListeners: new Set(),
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);
		return fakeThis;
	}

	test("runs the custom UI factory synchronously before returning", async () => {
		const fakeThis = createCustomUiHostFixture();
		let returned = false;
		let factoryCalled = false;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			(_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: string) => void) => {
				expect(returned).toBe(false);
				factoryCalled = true;
				done("done");
				return component;
			},
		);
		returned = true;

		expect(factoryCalled).toBe(true);
		await expect(promise).resolves.toBe("done");
	});

	test("does not invoke the custom UI factory or notify host state listeners when the signal is already aborted", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const controller = new AbortController();
		const failure = new Error("already aborted");
		let factoryCalled = false;
		controller.abort(failure);

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(
				fakeThis,
				() => {
					factoryCalled = true;
					return { render: () => [], invalidate: vi.fn() };
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(failure);

		expect(factoryCalled).toBe(false);
		expect(states).toEqual([]);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("immediate abort after custom() returns cannot run a deferred factory", async () => {
		const fakeThis = createCustomUiHostFixture();
		const controller = new AbortController();
		const failure = new Error("aborted after return");
		let factoryCalls = 0;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			() => {
				factoryCalls++;
				return component;
			},
			{ signal: controller.signal },
		);
		expect(factoryCalls).toBe(1);

		controller.abort(failure);
		await expect(promise).rejects.toBe(failure);
		await Promise.resolve();

		expect(factoryCalls).toBe(1);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("releases host state when a non-overlay custom UI factory throws synchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory failed synchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});

	test("releases host state when a non-overlay custom UI factory rejects asynchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory rejected asynchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				return Promise.reject(failure);
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});

  test("suppresses the Working loader while a non-overlay custom UI is active", async () => {
    const fakeThis = createCustomUiHostFixture();
    const firstLoader = { stop: vi.fn() };
    const secondLoader = { stop: vi.fn() };
    fakeThis.createWorkingLoader = vi
      .fn()
      .mockReturnValueOnce(firstLoader)
      .mockReturnValueOnce(secondLoader);
    const component = {
      render: () => [],
      invalidate: vi.fn(),
      dispose: vi.fn(),
    };
    let doneCustomUi: ((result: string) => void) | undefined;

    fakeThis.showWorkingLoaderNow();
    expect(fakeThis.createWorkingLoader).toHaveBeenCalledTimes(1);
    expect(fakeThis.loadingAnimation).toBe(firstLoader);

    const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
      fakeThis,
      (_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: string) => void) => {
        doneCustomUi = done;
        return component;
      },
    );

    expect(firstLoader.stop).toHaveBeenCalledTimes(1);
    expect(fakeThis.loadingAnimation).toBe(undefined);
    fakeThis.runtimeHost.session.isStreaming = true;
    fakeThis.showWorkingLoaderNow();
    expect(fakeThis.createWorkingLoader).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    doneCustomUi?.("done");
    await expect(promise).resolves.toBe("done");
    expect(fakeThis.createWorkingLoader).toHaveBeenCalledTimes(2);
    expect(fakeThis.loadingAnimation).toBe(secondLoader);
  });

  test("does not suppress the Working loader for overlay custom UI", async () => {
    const fakeThis = createCustomUiHostFixture();
    const loader = { stop: vi.fn() };
    fakeThis.createWorkingLoader = vi.fn(() => loader);
    const component = {
      render: () => [],
      invalidate: vi.fn(),
      dispose: vi.fn(),
    };
    let doneCustomUi: ((result: string) => void) | undefined;

    fakeThis.showWorkingLoaderNow();
    const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
      fakeThis,
      (_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: string) => void) => {
        doneCustomUi = done;
        return component;
      },
      { overlay: true },
    );

    expect(loader.stop).not.toHaveBeenCalled();
    expect(fakeThis.getHostCustomUiState()).toEqual({
      blockingInlineCustomUiActive: false,
      blockingInlineCustomUiDepth: 0,
    });

    await Promise.resolve();
    doneCustomUi?.("done");
    await expect(promise).resolves.toBe("done");
  });
});

