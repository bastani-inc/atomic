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

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock, Mutex},
	time::{Duration, Instant},
};

use dashmap::DashMap;
use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{env_uint, task};

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

#[derive(Clone)]
struct CacheEntry {
	created_at: Instant,
	entries: Vec<GlobMatch>,
}

static FS_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>> = LazyLock::new(DashMap::new);

/// Result of a cache-aware scan, including the age of the cached data.
pub struct ScanResult {
	/// Scanned filesystem entries.
	pub entries: Vec<GlobMatch>,
	/// How old the cached data is in milliseconds (0 = freshly scanned).
	pub cache_age_ms: u64,
}

fn evict_oldest() {
	if FS_CACHE.len() > *MAX_CACHE_ENTRIES
		&& let Some(oldest_key) = FS_CACHE
			.iter()
			.min_by_key(|entry| entry.value().created_at)
			.map(|entry| entry.key().clone())
	{
		FS_CACHE.remove(&oldest_key);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Path utilities
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve a search path string to a canonical `PathBuf` (must be a directory).
pub fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	let root = if candidate.is_absolute() {
		candidate
	} else {
		let cwd = std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
		cwd.join(candidate)
	};
	let metadata = std::fs::metadata(&root)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	if !metadata.is_dir() {
		return Err(Error::from_reason("Search path must be a directory".to_string()));
	}
	Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
	let relative = path.strip_prefix(root).unwrap_or(path);
	if cfg!(windows) {
		let relative = relative.to_string_lossy();
		if relative.contains('\\') { Cow::Owned(relative.replace('\\', "/")) } else { relative }
	} else {
		relative.to_string_lossy()
	}
}

pub fn contains_component(path: &Path, target: &str) -> bool {
	path
		.components()
		.any(|component| component.as_os_str().to_str().is_some_and(|value| value == target))
}

pub fn should_skip_path(path: &Path, mentions_node_modules: bool) -> bool {
	// Always skip VCS internals; they are noise for user-facing discovery.
	if contains_component(path, ".git") {
		return true;
	}
	if !mentions_node_modules && contains_component(path, "node_modules") {
		// Skip node_modules by default unless explicitly requested/pattern-matched.
		return true;
	}
	false
}

fn file_type_from_std(file_type: std::fs::FileType) -> Option<FileType> {
	if file_type.is_symlink() {
		Some(FileType::Symlink)
	} else if file_type.is_dir() {
		Some(FileType::Dir)
	} else if file_type.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn mtime_ms(metadata: &std::fs::Metadata) -> Option<f64> {
	metadata
		.modified()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_millis() as f64)
}

pub fn classify_file_type(path: &Path) -> Option<(FileType, Option<f64>, Option<u64>)> {
	let metadata = std::fs::symlink_metadata(path).ok()?;
	let file_type = file_type_from_std(metadata.file_type())?;
	let size = if file_type == FileType::File { Some(metadata.len()) } else { None };
	Some((file_type, mtime_ms(&metadata), size))
}

// ═══════════════════════════════════════════════════════════════════════════
// Walker + collection
// ═══════════════════════════════════════════════════════════════════════════

/// Builds a deterministic filesystem walker configured for visibility and
/// ignore rules.
///
/// When `skip_node_modules` is true, `node_modules` directories are pruned at
/// traversal time (not just filtered post-scan). `.git` is always skipped.
#[allow(clippy::fn_params_excessive_bools, reason = "matches WalkBuilder option fields")]
pub fn build_walker(
	root: &Path,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	follow_links: bool,
) -> WalkBuilder {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(!include_hidden)
		.follow_links(follow_links)
		.sort_by_file_path(|a, b| a.cmp(b))
		// filter_entry controls whether to yield an entry AND whether to descend
		// into a directory. Returning false for a directory skips the entire subtree.
		.filter_entry(move |entry| {
			let name = entry.file_name().to_str().unwrap_or_default();
			// Always skip .git
			if name == ".git" {
				return false;
			}
			// Skip node_modules when skip_node_modules is true
			if skip_node_modules && name == "node_modules" {
				return false;
			}
			true
		});

	if use_gitignore {
		// Honor repository and global ignore files for repo-like behavior.
		builder
			.git_ignore(true)
			.git_exclude(true)
			.git_global(true)
			.ignore(true)
			.parents(true)
			.require_git(false);
	} else {
		// Disable all ignore sources for exhaustive filesystem traversal.
		builder.git_ignore(false).git_exclude(false).git_global(false).ignore(false).parents(false);
	}

	builder
}

struct EntryVisitor<'a> {
	root: &'a Path,
	detail: ScanDetail,
	ct: &'a task::CancelToken,
	entries: Vec<GlobMatch>,
	shared_entries: Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	error: Arc<Mutex<Option<String>>>,
	visited: usize,
}

impl Drop for EntryVisitor<'_> {
	fn drop(&mut self) {
		if self.entries.is_empty() {
			return;
		}
		let entries = std::mem::take(&mut self.entries);
		self.shared_entries.lock().expect("entry collection lock poisoned").push(entries);
	}
}

impl ParallelVisitor for EntryVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<ignore::DirEntry, ignore::Error>) -> WalkState {
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				*self.error.lock().expect("error lock poisoned") = Some(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;

		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		if let Some(entry) = collect_entry(self.root, &entry, self.detail) {
			self.entries.push(entry);
		}
		WalkState::Continue
	}
}

struct EntryVisitorBuilder<'a> {
	root: &'a Path,
	detail: ScanDetail,
	ct: &'a task::CancelToken,
	shared_entries: Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	error: Arc<Mutex<Option<String>>>,
}

impl<'a> ParallelVisitorBuilder<'a> for EntryVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(EntryVisitor {
			root: self.root,
			detail: self.detail,
			ct: self.ct,
			entries: Vec::new(),
			shared_entries: Arc::clone(&self.shared_entries),
			error: Arc::clone(&self.error),
			visited: 0,
		})
	}
}

/// Scans filesystem entries and records normalized relative paths with file
/// metadata.
fn collect_entries(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut builder = build_walker(
		root,
		options.include_hidden,
		options.use_gitignore,
		options.skip_node_modules,
		options.follow_links,
	);
	let workers = grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}
	let shared_entries = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let mut visitor_builder = EntryVisitorBuilder {
		root,
		detail: options.detail,
		ct,
		shared_entries: Arc::clone(&shared_entries),
		error: Arc::clone(&error),
	};
	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().expect("error lock poisoned").take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut entries: Vec<GlobMatch> =
		shared_entries.lock().expect("entry collection lock poisoned").drain(..).flatten().collect();
	entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	Ok(entries)
}

pub(crate) fn collect_entry(
	root: &Path,
	entry: &ignore::DirEntry,
	detail: ScanDetail,
) -> Option<GlobMatch> {
	let path = entry.path();
	let relative = normalize_relative_path(root, path);
	if relative.is_empty() {
		// Ignore the synthetic root entry ("" relative path).
		return None;
	}

	let (file_type, mtime, size) = match detail {
		ScanDetail::Minimal => {
			let file_type = file_type_from_std(entry.file_type()?)?;
			(file_type, None, None)
		},
		ScanDetail::Full => {
			let metadata = entry.metadata().or_else(|_| std::fs::symlink_metadata(path)).ok()?;
			let file_type = file_type_from_std(metadata.file_type())?;
			let size = if file_type == FileType::File { Some(metadata.len() as f64) } else { None };
			(file_type, mtime_ms(&metadata), size)
		},
	};

	Some(GlobMatch { path: relative.into_owned(), file_type, mtime, size })
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache API
// ═══════════════════════════════════════════════════════════════════════════

/// Returns scanned entries using the global TTL cache policy.
///
/// The returned [`ScanResult::cache_age_ms`] lets callers implement
/// empty-result fast recheck: if a query produces zero matches and the cache is
/// older than [`empty_recheck_ms()`], call [`force_rescan`] before returning
/// empty.
pub fn get_or_scan(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<ScanResult> {
	let ttl = *CACHE_TTL_MS;
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
		let age = now.duration_since(entry.created_at);
		if age < Duration::from_millis(ttl) {
			return Ok(ScanResult {
				entries: entry.entries.clone(),
				cache_age_ms: age.as_millis() as u64,
			});
		}
		drop(entry);
		FS_CACHE.remove(&key);
	}

	let entries = collect_entries(root, options, ct)?;
	FS_CACHE.insert(key, CacheEntry { created_at: now, entries: entries.clone() });
	evict_oldest();
	Ok(ScanResult { entries, cache_age_ms: 0 })
}
