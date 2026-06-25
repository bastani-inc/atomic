import { Container } from "@earendil-works/pi-tui";
import type { SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { ExtensionFixture } from "./interactive-mode-status-helpers.ts";
export function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
			getResourceDiagnosticsTotal: (values: Array<{ length: number }[]>) =>
				values.reduce((total, diagnostics) => total + diagnostics.length, 0),
			formatResourceCount: (count: number, singular: string, plural?: string) =>
				(InteractiveMode as any).prototype.formatResourceCount.call(fakeThis, count, singular, plural),
			addResourceDisclosure: (disclosure: unknown) =>
				(InteractiveMode as any).prototype.addResourceDisclosure.call(fakeThis, disclosure),
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

export function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

export function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}
