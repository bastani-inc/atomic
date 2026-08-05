// Env-tunable cache and worker policy for filesystem scans.

use crate::env_uint;

// ═══════════════════════════════════════════════════════════════════════════
// Cache policy
// ═══════════════════════════════════════════════════════════════════════════

env_uint! {
	// Configured cache TTL in milliseconds.
	static CACHE_TTL_MS: u64 = "FS_SCAN_CACHE_TTL_MS" or 1_000 => [0, u64::MAX];
	// Configured empty-result recheck threshold in milliseconds.
	static EMPTY_RECHECK_MS: u64 = "FS_SCAN_EMPTY_RECHECK_MS" or 200 => [0, u64::MAX];
	// Configured maximum number of cache entries.
	static MAX_CACHE_ENTRIES: usize = "FS_SCAN_CACHE_MAX_ENTRIES" or 16 => [0, usize::MAX];
}

env_uint! {
	// Worker count for parallel filesystem walks. 0 lets ignore choose.
	static GREP_WORKERS: usize = "PI_GREP_WORKERS" or 4 => [0, usize::MAX];
}

pub fn cache_ttl_ms() -> u64 {
	*CACHE_TTL_MS
}

pub fn empty_recheck_ms() -> u64 {
	*EMPTY_RECHECK_MS
}

pub fn max_cache_entries() -> usize {
	*MAX_CACHE_ENTRIES
}

pub fn grep_workers() -> usize {
	*GREP_WORKERS
}
