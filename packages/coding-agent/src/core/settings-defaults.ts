import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@bastani/atomic-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	decisionModel: "",
	transport: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	sessionSummary: {
		enabled: true,
	},
	snapshots: {
		enabled: true,
		includeUntracked: true,
		maxFileBytes: 5 * 1024 * 1024,
		maxSnapshotBytes: 50 * 1024 * 1024,
		fullEvery: 10,
		autoCollect: true,
		collectIntervalSeconds: 3600,
		graceSeconds: 3600,
		pool: {
			/** Idle pooled worktrees kept per repository (#4748). */
			maxIdlePerRepository: 2,
		},
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		fallbackOnContentFilter: true,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	search: {
		contextBefore: 1,
		contextAfter: 3,
	},
	collapseChangelog: false,
	debug: false,
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
	cacheWarming: "idle",
	tasks: {
		heartbeatMs: 15 * 60_000,
		/** A task heartbeat starts a turn in an idle chat, including after an interrupt. */
		heartbeatWakesIdleSession: true,
	},
} as const;
