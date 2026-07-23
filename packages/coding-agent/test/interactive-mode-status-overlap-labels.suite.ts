import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { normalizeRenderedOutput } from "./interactive-mode-status-helpers.ts";
import { createShowLoadedResourcesThis, createSourceInfo } from "./interactive-mode-status-resources-helpers.ts";

describe("InteractiveMode overlap labels", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves distinct local package sources in the overlap notice", () => {
		const bundled = {
			...createSourceInfo("/tmp/bundled/extensions/index.ts", {
				source: "npm:@example/bundled",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const inherited = (name: string) => ({
			...createSourceInfo(`/tmp/${name}/extensions/index.ts`, {
				source: `/tmp/${name}`,
				scope: "user",
				origin: "package",
				baseDir: `/tmp/${name}`,
			}),
			configurationOrigin: "inherited-pi" as const,
		});
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [
				{ resourceType: "tool", name: "alpha", inherited: inherited("package-a"), bundled },
				{ resourceType: "command", name: "beta", inherited: inherited("package-b"), bundled },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toContain("`package-a` and `package-b` provide resources already bundled with Atomic.");
	});

	test("disambiguates local package sources with the same basename", () => {
		const bundled = {
			...createSourceInfo("/tmp/bundled/extensions/index.ts", {
				source: "npm:@example/bundled",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const inherited = (source: string) => ({
			...createSourceInfo(`${source}/extensions/index.ts`, {
				source,
				scope: "user",
				origin: "package",
				baseDir: source,
			}),
			configurationOrigin: "inherited-pi" as const,
		});
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [
				{ resourceType: "tool", name: "alpha", inherited: inherited("/tmp/a/plugin"), bundled },
				{ resourceType: "command", name: "beta", inherited: inherited("/tmp/b/plugin"), bundled },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toContain("`a/plugin` and `b/plugin` provide resources already bundled with Atomic.");
	});

	test("disambiguates local package labels from npm package labels", () => {
		const bundled = {
			...createSourceInfo("/tmp/bundled/extensions/index.ts", {
				source: "npm:@example/bundled",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const npmInherited = {
			...createSourceInfo("/tmp/npm/plugin/extensions/index.ts", {
				source: "npm:plugin",
				scope: "user",
				origin: "package",
			}),
			configurationOrigin: "inherited-pi" as const,
		};
		const localInherited = {
			...createSourceInfo("/tmp/plugin/extensions/index.ts", {
				source: "/tmp/plugin",
				scope: "user",
				origin: "package",
				baseDir: "/tmp/plugin",
			}),
			configurationOrigin: "inherited-pi" as const,
		};
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [
				{ resourceType: "tool", name: "alpha", inherited: npmInherited, bundled },
				{ resourceType: "command", name: "beta", inherited: localInherited, bundled },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toContain("`plugin` and `tmp/plugin` provide resources already bundled with Atomic.");
	});

	test("preserves distinct auto-discovered extension labels", () => {
		const bundled = {
			...createSourceInfo("/tmp/bundled/extensions/index.ts", {
				source: "npm:@example/bundled",
				scope: "temporary",
				origin: "package",
			}),
			configurationOrigin: "bundled" as const,
		};
		const inherited = (resourcePath: string) => ({
			...createSourceInfo(resourcePath, {
				source: "auto",
				scope: "user",
				origin: "top-level",
				baseDir: resourcePath.slice(0, resourcePath.lastIndexOf("/")),
			}),
			configurationOrigin: "inherited-pi" as const,
		});
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			overlaps: [
				{ resourceType: "tool", name: "alpha", inherited: inherited("/tmp/pi-home/extensions/plugin-a/index.ts"), bundled },
				{ resourceType: "command", name: "beta", inherited: inherited("/tmp/pi-project/extensions/plugin-b/index.ts"), bundled },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toContain("`plugin-a` and `plugin-b` provide resources already bundled with Atomic.");
	});
});
