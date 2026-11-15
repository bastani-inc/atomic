/** One scope's limit, as `workers.rateLimits` sets it (#4768). */
export interface FleetRateLimit {
	/** The scope's rate across every host of the fleet. */
	readonly requestsPerMinute: number;
	/** Requests that may start at once after an idle spell. Default: ten seconds' worth, and at least one. */
	readonly burst?: number;
	/** Tokens a host takes from the shared journal per acquire. Default: half its workers for the root, rounded up. */
	readonly prefetch?: number;
}

/** `workers.rateLimits`: limits by provider id (`"anthropic"`) or `provider/model` (`"anthropic/claude-sonnet-4-5"`). */
export type FleetRateLimits = Readonly<Record<string, FleetRateLimit>>;
