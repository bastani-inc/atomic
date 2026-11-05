import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@bastani/pi-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	decisionModel: "",
	transport: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		compression_ratio: 0.5,
		preserve_recent: 2,
		/** Wall-clock limit on automatic compaction's model planning, so it cannot block a turn (#4198). */
		planningTimeoutMs: 300_000,
		/** Compact a frozen prefix in the background past the soft threshold; commit at a turn boundary (#4330). */
		background: true,
		backgroundThresholdPercent: 75,
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
	workflows: {
		autoAdvanceAfterSteer: true,
	},
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
	intercom: {
		showUnknownTargetWarnings: false,
	},
	httpIdleTimeoutMs: 600_000,
	cacheWarming: "streaming",
	tasks: {
		/** Same 15-minute default as workflow heartbeats. */
		heartbeatMs: 15 * 60_000,
	},
} as const;
