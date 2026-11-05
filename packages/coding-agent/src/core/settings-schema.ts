import { ModelThinkingLevelSchema } from "@bastani/pi-ai/providers/model-schema";
import { type Static, type TSchemaOptions, Type } from "typebox";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

function nonNegativeSafeInteger(options: { default?: number; description?: string } = {}) {
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function caseInsensitive(word: string): string {
	return [...word].map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join("");
}

/** Mirrors `parseHttpIdleTimeoutMs`: milliseconds, `disabled`, or a duration such as `30s`, `5m`, `1h`. */
const TIMEOUT_STRING_PATTERN = `^(?:${caseInsensitive("disabled")}|[0-9]+(?:${caseInsensitive("ms")}|[smhSMH])?)$`;

function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.String({ pattern: TIMEOUT_STRING_PATTERN })], options);
}

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	preserve_recent: Type.Optional(nonNegativeSafeInteger()),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	reserveTokens: Type.Optional(
		nonNegativeSafeInteger({
			description: "Free context tokens below which automatic compaction starts.",
			default: SETTINGS_DEFAULTS.compaction.reserveTokens,
		}),
	),
	compression_ratio: Type.Optional(
		Type.Number({
			exclusiveMinimum: 0,
			exclusiveMaximum: 1,
			description: "Fraction of compactable transcript lines to keep.",
			default: SETTINGS_DEFAULTS.compaction.compression_ratio,
		}),
	),
	preserve_recent: Type.Optional(
		nonNegativeSafeInteger({
			description: "Exact number of newest context-visible messages kept outside the compactable region.",
			default: SETTINGS_DEFAULTS.compaction.preserve_recent,
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"Relevance focus for selecting older lines to retain. Defaults to the last user message when omitted.",
		}),
	),
	planningTimeoutMs: Type.Optional(
		timeoutSetting({
			description:
				'Wall-clock limit on model planning in automatic compaction (every planner request, retry, trim, fallback model and credential lookup) as milliseconds, a duration such as "5m", or "disabled"; 0 or "disabled" disables it. When it runs out, post-tool and overflow compaction start a fresh context window and threshold compaction fails.',
			default: SETTINGS_DEFAULTS.compaction.planningTimeoutMs,
		}),
	),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Compact older context in the background while the agent keeps working; blocking compaction only on overflow. False restores foreground compaction at the reserveTokens threshold.",
			default: SETTINGS_DEFAULTS.compaction.background,
		}),
	),
	backgroundThresholdPercent: Type.Optional(
		Type.Number({
			exclusiveMinimum: 0,
			exclusiveMaximum: 100,
			description:
				"Percentage of the context window at which background compaction starts. The reserveTokens threshold still compacts in the foreground when no background result is ready.",
			default: SETTINGS_DEFAULTS.compaction.backgroundThresholdPercent,
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved when selecting branch history; the provider sizes summary output.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const SessionSummarySettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description: "Generate a one-line resume-picker summary once the agent goes idle.",
			default: SETTINGS_DEFAULTS.sessionSummary.enabled,
		}),
	),
});

function positiveSafeInteger(options: { default: number; description: string }) {
	return Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

const SnapshotSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description: "Record worktree snapshots so sessions and workflow runs can resume with their repository state.",
			default: SETTINGS_DEFAULTS.snapshots.enabled,
		}),
	),
	includeUntracked: Type.Optional(
		Type.Boolean({
			description: "Capture untracked files that no ignore rule or deny pattern excludes.",
			default: SETTINGS_DEFAULTS.snapshots.includeUntracked,
		}),
	),
	maxFileBytes: Type.Optional(
		positiveSafeInteger({
			description: "Largest file a snapshot captures, in bytes; larger files are listed as omitted.",
			default: SETTINGS_DEFAULTS.snapshots.maxFileBytes,
		}),
	),
	maxSnapshotBytes: Type.Optional(
		positiveSafeInteger({
			description: "Largest total of captured file content, and largest unpushed-commit bundle, in bytes.",
			default: SETTINGS_DEFAULTS.snapshots.maxSnapshotBytes,
		}),
	),
	fullEvery: Type.Optional(
		positiveSafeInteger({
			description: "Record a full delta against HEAD after this many incremental snapshots.",
			default: SETTINGS_DEFAULTS.snapshots.fullEvery,
		}),
	),
	autoCollect: Type.Optional(
		Type.Boolean({
			description:
				"Delete snapshot blobs that no retained snapshot references when a session closes or a workflow run finishes.",
			default: SETTINGS_DEFAULTS.snapshots.autoCollect,
		}),
	),
	collectIntervalSeconds: Type.Optional(
		positiveSafeInteger({
			description: "Shortest time between two automatic snapshot blob collections of one database, in seconds.",
			default: SETTINGS_DEFAULTS.snapshots.collectIntervalSeconds,
		}),
	),
	graceSeconds: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description:
				"Snapshot blobs stored less than this many seconds ago are never collected, which protects captures still being recorded.",
			default: SETTINGS_DEFAULTS.snapshots.graceSeconds,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum agent-level backoff delay in milliseconds. 0 retries immediately.",
			default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
		}),
	),
	fallbackOnContentFilter: Type.Optional(
		Type.Boolean({
			description:
				"When a provider's content filter refuses a request, such as OpenAI's HTTP 422 cyber_policy, move to the next fallback model instead of retrying the same one.",
			default: SETTINGS_DEFAULTS.retry.fallbackOnContentFilter,
		}),
	),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			deprecated: true,
		}),
	),
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	hyperlinks: Type.Optional(
		Type.Union([Type.Boolean(), Type.Literal("auto")], {
			description: 'Hyperlink capability override. "auto" and invalid values keep terminal detection.',
		}),
	),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)], {
			description: 'Inline-image protocol override. false disables images; "auto" keeps terminal detection.',
		}),
	),
	trueColor: Type.Optional(
		Type.Union([Type.Boolean(), Type.Literal("auto")], {
			description: 'Truecolor capability override. "auto" and invalid values keep terminal detection.',
		}),
	),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

const SearchSettingsSchema = Type.Object({
	contextBefore: Type.Optional(
		Type.Number({
			description: "Number of context lines before each search match.",
			default: SETTINGS_DEFAULTS.search.contextBefore,
		}),
	),
	contextAfter: Type.Optional(
		Type.Number({
			description: "Number of context lines after each search match.",
			default: SETTINGS_DEFAULTS.search.contextAfter,
		}),
	),
});

const HerdrSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description: "Enable the built-in reporter in an eligible Herdr pane.",
			default: SETTINGS_DEFAULTS.herdr.enabled,
		}),
	),
});

const ModelRoutingSettingsSchema = Type.Object(
	{
		allowedProviders: Type.Optional(
			Type.Array(Type.String(), {
				description: "When nonempty, only models from these provider IDs are routing candidates.",
			}),
		),
		excludedProviders: Type.Optional(
			Type.Array(Type.String(), {
				description: "Provider IDs that are never routing candidates. Applied after allowedProviders.",
			}),
		),
		allowedModels: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"When nonempty, only models matching these full-ID or glob patterns, as in enabledModels, are routing candidates.",
			}),
		),
		excludedModels: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Models matching these full-ID or glob patterns are never routing candidates. Applied after allowedModels.",
			}),
		),
	},
	{
		description:
			'Provider and model filters for the candidates model "auto" may route to. Does not affect decisionModel.',
	},
);

function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
	latex: Type.Optional(
		Type.Boolean({
			description: "Render LaTeX expressions as terminal-friendly Unicode math.",
			default: SETTINGS_DEFAULTS.markdown.latex,
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

const IntercomSettingsSchema = Type.Object({
	showUnknownTargetWarnings: Type.Optional(
		Type.Boolean({
			description:
				"Add a note to a queued workflow Intercom send whose target is outside the run's known and predicted stages. Delivery is the same either way.",
			default: SETTINGS_DEFAULTS.intercom.showUnknownTargetWarnings,
		}),
	),
});

const TaskSettingsSchema = Type.Object({
	heartbeatMs: Type.Optional(
		Type.Union([Type.Literal(0), Type.Number({ minimum: 60_000 })], {
			description:
				"Default cadence, in milliseconds, of the periodic heartbeat sent to a chat for each of its running background shells and subagents. 0 disables; otherwise at least 60000. A tool call's heartbeatMs overrides it.",
			default: SETTINGS_DEFAULTS.tasks.heartbeatMs,
		}),
	),
});

function codemodeMode(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

const CodemodeModeSchema = codemodeMode();

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(
		codemodeMode({
			description:
				'How codemode presents tools. "on" keeps direct tool declarations visible with script-call information; "only" hides ordinary direct callable declarations so the model uses scripts. Model-only tools remain directly available.',
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	inlineBudget: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Estimated tokens available for inline codemode tool declarations.",
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
			workflows: Type.Optional(Type.Array(Type.String())),
			mcpServers: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

const StringArraySchema = Type.Array(Type.String());

const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

export const StorageSelectionSchema = Type.Union([
	Type.Object(
		{
			path: Type.Optional(Type.String({ description: "Database path relative to the Atomic home directory." })),
			memory: Type.Optional(Type.Boolean({ description: "Explicitly select ephemeral storage." })),
			prefix: Type.Optional(Type.String()),
		},
		{
			additionalProperties: false,
			not: { required: ["path", "memory"], properties: { path: { minLength: 1 }, memory: { const: true } } },
		},
	),
	Type.Object(
		{
			adapter: Type.String({ minLength: 1, description: "User-installed storage adapter module specifier." }),
			options: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
			),
			secrets: Type.Optional(
				Type.Record(
					Type.String(),
					Type.Union([
						Type.Object({ env: Type.String() }, { additionalProperties: false }),
						Type.Object({ file: Type.String() }, { additionalProperties: false }),
					]),
				),
			),
			prefix: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);

export const SessionStorageSelectionSchema = Type.Union([
	StorageSelectionSchema,
	Type.Object({ dir: Type.String() }, { additionalProperties: false }),
]);

const ResourceLimitsSchema = Type.Object(
	{
		session: Type.Optional(Type.Integer({ minimum: 1 })),
		process: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const WorkflowsSettingsSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Workflow resource paths." })),
			autoAdvanceAfterSteer: Type.Optional(
				Type.Boolean({
					description:
						'After you steer a stage that asked you a question, let the decision model advance the stage or keep it open without asking "Are you ready to move on to the next stage?". It asks when the decision is uncertain or fails. Default: true.',
					default: SETTINGS_DEFAULTS.workflows.autoAdvanceAfterSteer,
				}),
			),
			journal: Type.Optional(StorageSelectionSchema),
			localWorkers: Type.Optional(
				Type.Object(
					{
						count: Type.Integer({ minimum: 1, description: "Number of local worker processes." }),
						definitions: Type.Array(
							Type.Object({ path: Type.String(), exportName: Type.String() }, { additionalProperties: false }),
							{ description: "Importable child workflow definitions workers may run." },
						),
						startupTimeoutMs: Type.Optional(
							Type.Integer({
								minimum: 1,
								maximum: 2_147_483_647,
								description:
									"Milliseconds each worker process may take to become ready. Default: 30000, scaled up when workers plus load exceed CPU cores (at most 600000).",
							}),
						),
						leaseMs: Type.Optional(
							Type.Integer({
								minimum: 2000,
								maximum: 2_147_483_647,
								description:
									"Milliseconds a live worker that has stopped responding keeps its child before the child is replayed elsewhere. Default: 30000.",
							}),
						),
						heartbeatMs: Type.Optional(
							Type.Integer({
								minimum: 100,
								maximum: 1_073_741_823,
								description:
									"Milliseconds between a worker's heartbeats, each renewing its child's lease, reporting usage and reading pause or quit, in one request. At most half of leaseMs. Default: leaseMs / 4.",
							}),
						),
						maxLoadPerCpu: Type.Optional(
							Type.Number({
								minimum: 0,
								description:
									"Load per CPU (1-minute load average / CPU cores) above which pooled stages start one at a time, at most one every 5 seconds. Default: 3. 0 turns it off.",
							}),
						),
						maxWorkerRssBytes: Type.Optional(
							Type.Integer({
								minimum: 1,
								maximum: Number.MAX_SAFE_INTEGER,
								description:
									"Resident memory in bytes past which a local worker is replaced by a fresh one once its current child ends. A running child is never interrupted. Default: unset (never).",
							}),
						),
					},
					{ additionalProperties: false },
				),
			),
			admission: Type.Optional(
				Type.Object(
					{
						limits: Type.Optional(ResourceLimitsSchema),
						userLimits: Type.Optional(ResourceLimitsSchema),
						userDatabase: Type.Optional(Type.String()),
						host: Type.Optional(
							Type.Object(
								{
									maxLoadPerCpu: Type.Optional(Type.Number({ minimum: 0 })),
									minFreeMemoryBytes: Type.Optional(Type.Number({ minimum: 0 })),
								},
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
			),
		}),
	],
	{
		description:
			'Local workflow paths, or an object with "paths", "autoAdvanceAfterSteer", "journal" storage, "localWorkers" and "admission" settings.',
	},
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		storage: Type.Optional(StorageSelectionSchema),
		sessions: Type.Optional(Type.Object({ storage: Type.Optional(SessionStorageSelectionSchema) })),
		teamJoin: Type.Optional(
			Type.Object(
				{
					storage: Type.String({
						pattern: "^sha256:[0-9a-f]{64}$",
						description: "Fingerprint of the `storage` selection that `atomic team join` wrote.",
					}),
				},
				{ description: "Managed team join record; leave unchanged." },
			),
		),
		lastChangelogVersion: Type.Optional(Type.String()),
		firstRunOnboardingStartedVersion: Type.Optional(
			Type.String({ description: "Managed onboarding state; leave unchanged." }),
		),
		onboardedVersion: Type.Optional(
			Type.String({ description: "Managed onboarding completion state; leave unchanged." }),
		),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		decisionModel: Type.Optional(
			Type.String({
				description:
					'The model every decision uses: workflow-stage and subagent model: "auto" selection, structured_output calls without their own model, readiness after a steer, and decide(). An exact provider/model selects a registered chat or classifier model; "auto" and an empty string use the current chat model.',
				default: SETTINGS_DEFAULTS.decisionModel,
			}),
		),
		compactionModel: Type.Optional(
			Type.String({
				description:
					'Compaction model: "auto" or an empty string uses the session model, and an exact provider/model selects a registered chat model, classifier, or compactor.',
			}),
		),
		modelRouting: Type.Optional(ModelRoutingSettingsSchema),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		fallbackModels: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Ordered main-chat fallback models, written as "provider/model" with an optional thinking-level suffix such as ":high".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		enableAnalytics: Type.Optional(
			Type.Boolean({
				description: "Opt in to analytics data sharing. Storage only; Atomic does not transmit analytics.",
			}),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		sessionSummary: Type.Optional(SessionSummarySettingsSchema),
		snapshots: Type.Optional(SnapshotSettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		search: Type.Optional(SearchSettingsSchema),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		selfUpdateCommand: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description:
					'Command `atomic update` runs to update Atomic itself, in argv form such as ["mise", "use", "-g", "npm:{packageName}@{version}"]. Placeholders: {packageName}, {version}, {installSpec}. ATOMIC_SELF_UPDATE_COMMAND takes precedence. Global setting only.',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		debug: Type.Optional(
			Type.Boolean({
				description:
					"Debug mode: turn on every debug output and write it to the debug log that /debug shows. Global setting only.",
				default: SETTINGS_DEFAULTS.debug,
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description: "Send an anonymous version-adoption ping on eligible interactive launches.",
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		workflows: Type.Optional(WorkflowsSettingsSchema),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		herdr: Type.Optional(HerdrSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor (0-3).",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown (3-20).",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "Fullscreen transcript scrollbar visibility.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description:
					"What the terminal keeps when a fullscreen session exits: the final transcript with a resume hint, or only the resume hint.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "Copy fullscreen text selections automatically on mouse release.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		codemode: Type.Optional(CodemodeSettingsSchema),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		intercom: Type.Optional(IntercomSettingsSchema),
		tasks: Type.Optional(TaskSettingsSchema),
		httpProxy: Type.Optional(
			Type.String({
				description:
					"Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Atomic-managed HTTP clients. Global only.",
			}),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description:
					'HTTP idle timeout as milliseconds, a duration such as "30s", "5m", or "1h", or "disabled"; 0 or "disabled" disables it.',
				default: SETTINGS_DEFAULTS.httpIdleTimeoutMs,
			}),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description:
					'WebSocket connect or open handshake timeout as milliseconds, a duration such as "30s", or "disabled"; 0 or "disabled" disables it.',
			}),
		),
		streamDeadlineMs: Type.Optional(
			timeoutSetting({
				description:
					'Maximum idle gap between two provider stream events as milliseconds, a duration such as "30s", or "disabled"; 0 or "disabled" disables it.',
			}),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface SessionSummarySettings extends Static<typeof SessionSummarySettingsSchema> {}
export interface SnapshotSettings extends Static<typeof SnapshotSettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface SearchSettings extends Static<typeof SearchSettingsSchema> {}
export interface ModelRoutingSettings extends Static<typeof ModelRoutingSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export interface TaskSettings extends Static<typeof TaskSettingsSchema> {}
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
