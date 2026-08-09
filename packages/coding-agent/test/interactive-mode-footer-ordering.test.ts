import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * Regression for the fullscreen dock: footer swaps must update the stable
 * footer container used by both the flat renderer and the layout root.
 */

type Comp = { render: (width: number) => string[]; dispose?: () => void };

interface FakeUi {
	requestRender(): void;
}

interface FooterContainer {
	children: Comp[];
	clear(): void;
	addChild(component: Comp): void;
}

interface FooterCtx {
	customFooter: Comp | undefined;
	footer: Comp;
	footerContainer: FooterContainer;
	footerDataProvider: Record<string, never>;
	ui: FakeUi;
}

type FooterFactory = ((tui: unknown, thm: unknown, footerData: unknown) => Comp) | undefined;

interface ProtoWithFooter {
	setExtensionFooter(this: FooterCtx, factory: FooterFactory): void;
}

function makeComp(): Comp {
	return { render: () => [] };
}

function makeFooterContainer(footer: Comp): FooterContainer {
	return {
		children: [footer],
		clear() {
			this.children = [];
		},
		addChild(component) {
			this.children.push(component);
		},
	};
}

function callSetFooter(ctx: FooterCtx, factory: FooterFactory): void {
	(InteractiveMode.prototype as unknown as ProtoWithFooter).setExtensionFooter.call(ctx, factory);
}

function makeCtx(): FooterCtx {
	const footer = makeComp();
	return {
		customFooter: undefined,
		footer,
		footerContainer: makeFooterContainer(footer),
		footerDataProvider: {},
		ui: { requestRender() {} },
	};
}

describe("InteractiveMode.setExtensionFooter dock slot", () => {
	test("installing a custom footer replaces the stable footer container child", () => {
		const ctx = makeCtx();
		const customFooter = makeComp();

		callSetFooter(ctx, () => customFooter);

		expect(ctx.footerContainer.children).toEqual([customFooter]);
		expect(ctx.customFooter).toBe(customFooter);
	});

	test("restoring the built-in footer restores the stable footer container child", () => {
		const ctx = makeCtx();
		callSetFooter(ctx, () => makeComp());
		callSetFooter(ctx, undefined);

		expect(ctx.footerContainer.children).toEqual([ctx.footer]);
		expect(ctx.customFooter).toBeUndefined();
	});

	test("clearing the slot removes stale footer components before mounting the next one", () => {
		const ctx = makeCtx();
		ctx.footerContainer.children.push(makeComp());
		const customFooter = makeComp();

		callSetFooter(ctx, () => customFooter);

		expect(ctx.footerContainer.children).toEqual([customFooter]);
	});
});
