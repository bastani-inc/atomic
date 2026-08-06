// TTL cache, epochs, and invalidation for filesystem scans.

use std::{
	path::{Path, PathBuf},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use dashmap::DashMap;
use napi::bindgen_prelude::Result;

use super::{
	GlobMatch, ScanDetail, ScanOptions, cache_ttl_ms, max_cache_entries, walker::collect_entries,
};
use crate::task;

// ═══════════════════════════════════════════════════════════════════════════
// Cache internals
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
	root: PathBuf,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	detail: ScanDetail,
}

#[derive(Clone)]
struct CacheEntry {
	created_at: Instant,
	epoch: u64,
	entries: Vec<GlobMatch>,
}

static FS_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>> = LazyLock::new(DashMap::new);
static FS_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);

fn cache_epoch() -> u64 {
	FS_CACHE_EPOCH.load(Ordering::Acquire)
}

fn bump_cache_epoch() {
	FS_CACHE_EPOCH.fetch_add(1, Ordering::AcqRel);
}

/// Result of a cache-aware scan, including the age of the cached data.
pub struct ScanResult {
	/// Scanned filesystem entries.
	pub entries: Vec<GlobMatch>,
	/// How old the cached data is in milliseconds (0 = freshly scanned).
	pub cache_age_ms: u64,
}

fn evict_oldest() {
	while FS_CACHE.len() > max_cache_entries() {
		let Some(oldest_key) = FS_CACHE
			.iter()
			.min_by_key(|entry| entry.value().created_at)
			.map(|entry| entry.key().clone())
		else {
			break;
		};
		FS_CACHE.remove(&oldest_key);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache API
// ═══════════════════════════════════════════════════════════════════════════

/// Returns scanned entries using the global TTL cache policy.
///
/// The returned [`ScanResult::cache_age_ms`] lets callers implement
/// empty-result fast recheck: if a query produces zero matches and the cache is
/// older than [`empty_recheck_ms()`](super::empty_recheck_ms), call
/// [`force_rescan`] before returning empty.
pub fn get_or_scan(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<ScanResult> {
	let ttl = cache_ttl_ms();
	if ttl == 0 {
		// Caching disabled – always scan fresh.
		let entries = collect_entries(root, options, ct)?;
		return Ok(ScanResult { entries, cache_age_ms: 0 });
	}

	let key = CacheKey {
		root: root.to_path_buf(),
		include_hidden: options.include_hidden,
		use_gitignore: options.use_gitignore,
		skip_node_modules: options.skip_node_modules,
		detail: options.detail,
	};

	let now = Instant::now();
	if let Some(entry) = FS_CACHE.get(&key) {
		let current_epoch = cache_epoch();
		let age = now.duration_since(entry.created_at);
		if entry.epoch == current_epoch && age < Duration::from_millis(ttl) {
			return Ok(ScanResult {
				entries: entry.entries.clone(),
				cache_age_ms: age.as_millis() as u64,
			});
		}
		drop(entry);
		FS_CACHE.remove(&key);
	}

	let scan_epoch = cache_epoch();
	let entries = collect_entries(root, options, ct)?;
	FS_CACHE.insert(
		key,
		CacheEntry { created_at: Instant::now(), epoch: scan_epoch, entries: entries.clone() },
	);
	evict_oldest();
	Ok(ScanResult { entries, cache_age_ms: 0 })
}

/// Force a fresh scan, replacing any existing cache entry.
///
/// Use when a cached query produced zero matches and the cache was old enough
/// to warrant a recheck. When `store` is false, the fresh scan result is
/// returned without repopulating the cache.
pub fn force_rescan(
	root: &Path,
	options: ScanOptions,
	store: bool,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let key = CacheKey {
		root: root.to_path_buf(),
		include_hidden: options.include_hidden,
		use_gitignore: options.use_gitignore,
		skip_node_modules: options.skip_node_modules,
		detail: options.detail,
	};
	bump_cache_epoch();
	FS_CACHE.remove(&key);

	let scan_epoch = cache_epoch();
	let entries = collect_entries(root, options, ct)?;
	if store {
		FS_CACHE.insert(
			key,
			CacheEntry { created_at: Instant::now(), epoch: scan_epoch, entries: entries.clone() },
		);
		evict_oldest();
	}
	Ok(entries)
}

// ═══════════════════════════════════════════════════════════════════════════
// Invalidation
// ═══════════════════════════════════════════════════════════════════════════

/// Invalidate cache entries whose root contains `target`.
///
/// Removes any cache entry whose root is a prefix of (or equal to) `target`,
/// because a file mutation under that root makes the scan stale.
pub fn invalidate_path(target: &Path) {
	bump_cache_epoch();
	let keys_to_remove: Vec<CacheKey> = FS_CACHE
		.iter()
		.filter(|entry| target.starts_with(&entry.key().root))
		.map(|entry| entry.key().clone())
		.collect();
	for key in keys_to_remove {
		FS_CACHE.remove(&key);
	}
}

/// Clear the entire scan cache.
pub fn invalidate_all() {
	bump_cache_epoch();
	FS_CACHE.clear();
}

#[cfg(test)]
mod tests {
	use std::fs;

	use crate::fs_cache::test_util::TempDirGuard;

	#[test]
	fn force_rescan_respects_skip_node_modules() {
		let root = TempDirGuard::new();
		// Create a nested node_modules with many files
		for i in 0..100 {
			let pkg_dir = root.path().join(format!("node_modules/pkg-{i}"));
			fs::create_dir_all(&pkg_dir).unwrap();
			fs::write(pkg_dir.join("index.js"), "x").unwrap();
		}
		fs::write(root.path().join("app.js"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();

		// With skip: should only get app.js
		let entries = super::force_rescan(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			false,
			&ct,
		)
		.unwrap();
		assert_eq!(entries.len(), 1, "skip=true got: {}", entries.len());
		assert_eq!(entries[0].path, "app.js");

		// Without skip: should get app.js + 100 node_modules files + directories
		let entries = super::force_rescan(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: false,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			false,
			&ct,
		)
		.unwrap();
		assert!(entries.len() > 100, "skip=false got: {}", entries.len());
	}
}
