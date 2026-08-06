// DO NOT EDIT: copied from can1357/oh-my-pi commit 15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8 for Atomic issue #1483 parity.
// Shared filesystem scan cache for discovery tools (glob, fd).
//
// Provides a TTL-based cache of scanned directory entries, with:
// - Global policy (no per-call TTL tuning)
// - Explicit invalidation for agent file mutations
// - Empty-result fast recheck to avoid stale negatives
//
// # Policy Configuration (environment overrides)
// - `FS_SCAN_CACHE_TTL_MS`       – default `1000`
// - `FS_SCAN_EMPTY_RECHECK_MS`   – default `200`
// - `FS_SCAN_CACHE_MAX_ENTRIES`   – default `16`

use std::path::PathBuf;

use napi_derive::napi;

// ═══════════════════════════════════════════════════════════════════════════
// Public types (re-exported by glob for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File = 1,
	/// Directory.
	Dir = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path: String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch (from
	/// `symlink_metadata`).
	pub mtime: Option<f64>,
	/// File size in bytes for regular files.
	pub size: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ScanDetail {
	Minimal,
	Full,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ScanOptions {
	pub include_hidden: bool,
	pub use_gitignore: bool,
	pub skip_node_modules: bool,
	pub follow_links: bool,
	pub detail: ScanDetail,
}

/// Invalidate the filesystem scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations (write, edit, rename,
/// delete).
#[napi]
pub fn invalidate_fs_scan_cache(path: Option<String>) {
	match path {
		Some(p) => {
			let candidate = PathBuf::from(&p);
			let absolute = if candidate.is_absolute() {
				candidate
			} else if let Ok(cwd) = std::env::current_dir() {
				cwd.join(candidate)
			} else {
				PathBuf::from(&p)
			};
			let target = std::fs::canonicalize(&absolute)
				.or_else(|_| {
					absolute
						.parent()
						.and_then(|parent| std::fs::canonicalize(parent).ok())
						.and_then(|parent| absolute.file_name().map(|name| parent.join(name)))
						.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
				})
				.unwrap_or(absolute);
			invalidate_path(&target);
		},
		None => invalidate_all(),
	}
}

mod cache;
mod paths;
mod policy;
#[cfg(test)]
mod test_util;
mod walker;

pub use cache::{ScanResult, force_rescan, get_or_scan, invalidate_all, invalidate_path};
pub use paths::{
	classify_file_type, contains_component, normalize_relative_path, resolve_search_path,
	should_skip_path,
};
pub use policy::{cache_ttl_ms, empty_recheck_ms, grep_workers, max_cache_entries};
pub use walker::build_walker;
pub(crate) use walker::collect_entry;
