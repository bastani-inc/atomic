import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@bastani/pi-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	routerModel: "",
	transport: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		compression_ratio: 0.5,
		preserve_recent: 2,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	sessionSummary: {
		enabled: true,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	bashInterceptor: {
		enabled: false,
	},
	search: {
		contextBefore: 1,
		contextAfter: 3,
	},
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableSkillCommands: true,
	herdr: {
		enabled: true,
	},
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	fullscreenScrollbar: "auto",
	fullscreenExitOutput: "transcript",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
	codemode: {
		mode: "on",
		inlineBudget: 3000,
	},
	markdown: {
		codeBlockIndent: "  ",
		mermaid: "streaming",
		latex: true,
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	httpIdleTimeoutMs: 600_000,
	cacheWarming: "streaming",
} as const;
