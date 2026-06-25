// DO NOT EDIT: copied from can1357/oh-my-pi commit 15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8 for Atomic issue #1483 parity.
//! Filesystem discovery with glob patterns, ignore semantics, and shared scan
//! caching.
//!
//! # Overview
//! Resolves a search root, obtains scanned entries via [`fs_cache`], applies
//! glob matching plus optional file-type filtering, and optionally streams each
//! accepted match through a callback.
//!
//! The walker always skips `.git`, and skips `node_modules` unless explicitly
//! requested.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use std::{
	cmp::Ordering,
	collections::BinaryHeap,
	path::Path,
	sync::{Arc, Mutex},
};

use globset::GlobSet;
use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkState};
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

// Re-export entry types so existing `glob::FileType` / `glob::GlobMatch` paths still work.
pub use crate::fs_cache::{FileType, GlobMatch};
use crate::{fs_cache, glob_util, task};

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern: String,
	/// Directory to search.
	pub path: String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type: Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive: Option<bool>,
	/// Include hidden files (default: false).
	pub hidden: Option<bool>,
	/// Maximum number of results to return.
	pub max_results: Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore: Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache: Option<bool>,
	/// Sort results by mtime (most recent first) before applying limit.
	pub sort_by_mtime: Option<bool>,
	/// Include `node_modules` entries when the pattern does not explicitly
	/// mention them.
	pub include_node_modules: Option<bool>,
	/// Abort signal for cancelling the operation.
	pub signal: Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms: Option<u32>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches: Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

/// Internal runtime config for a single glob execution.
struct GlobConfig {
	root: std::path::PathBuf,
	pattern: String,
	recursive: bool,
	include_hidden: bool,
	file_type_filter: Option<FileType>,
	max_results: usize,
	use_gitignore: bool,
	mentions_node_modules: bool,
	sort_by_mtime: bool,
	use_cache: bool,
}

#[derive(Clone)]
struct RankedGlobMatch {
	entry: GlobMatch,
}

impl PartialEq for RankedGlobMatch {
	fn eq(&self, other: &Self) -> bool {
		compare_matches_by_rank(&self.entry, &other.entry) == Ordering::Equal
	}
}

impl Eq for RankedGlobMatch {}

impl PartialOrd for RankedGlobMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for RankedGlobMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		if match_is_worse(&self.entry, &other.entry) {
			Ordering::Greater
		} else if match_is_worse(&other.entry, &self.entry) {
			Ordering::Less
		} else {
			Ordering::Equal
		}
	}
}

fn match_mtime(entry: &GlobMatch) -> f64 {
	entry.mtime.unwrap_or(0.0)
}

fn compare_matches_by_rank(a: &GlobMatch, b: &GlobMatch) -> Ordering {
	match_mtime(b).total_cmp(&match_mtime(a)).then_with(|| a.path.cmp(&b.path))
}

fn match_is_worse(a: &GlobMatch, b: &GlobMatch) -> bool {
	compare_matches_by_rank(a, b) == Ordering::Greater
}

/// Returns `true` when `entry` was admitted into the bounded top-`limit` heap
/// (either filling free space or evicting a worse existing entry).
fn push_bounded_match(
	heap: &mut BinaryHeap<RankedGlobMatch>,
	entry: GlobMatch,
	limit: usize,
) -> bool {
	if heap.len() < limit {
		heap.push(RankedGlobMatch { entry });
		return true;
	}

	let Some(worst) = heap.peek() else {
		return false;
	};
	if match_is_worse(&worst.entry, &entry) {
		heap.pop();
		heap.push(RankedGlobMatch { entry });
		return true;
	}
	false
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
	let target_path = root.join(relative_path);
	let metadata = std::fs::metadata(target_path).ok()?;
	if metadata.is_dir() {
		Some(FileType::Dir)
	} else if metadata.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
	let Some(filter) = config.file_type_filter else {
		return Some(entry.file_type);
	};
	if entry.file_type == filter {
		return Some(entry.file_type);
	}
	if entry.file_type != FileType::Symlink {
		return None;
	}
	match filter {
		FileType::File | FileType::Dir => {
			let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
			if resolved == filter { Some(resolved) } else { None }
		},
		FileType::Symlink => None,
	}
}

/// Filter and collect matching entries from a pre-scanned list.
fn filter_entries(
	entries: &[GlobMatch],
	glob_set: &GlobSet,
	config: &GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut matches = Vec::new();
	if config.max_results == 0 {
		return Ok(matches);
	}

	for entry in entries {
		ct.heartbeat()?;
		if fs_cache::should_skip_path(Path::new(&entry.path), config.mentions_node_modules) {
			// Apply post-scan node_modules policy before glob matching.
			continue;
		}
		if !glob_set.is_match(&entry.path) {
			continue;
		}
		let Some(effective_file_type) = apply_file_type_filter(entry, config) else {
			continue;
		};
		let mut matched_entry = entry.clone();
		matched_entry.file_type = effective_file_type;
		if !config.sort_by_mtime
			&& let Some(callback) = on_match
		{
			callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}

		matches.push(matched_entry);
		// Only early-break when not sorting; mtime sort requires full candidate set.
		if !config.sort_by_mtime && matches.len() >= config.max_results {
			break;
		}
	}
	Ok(matches)
}

struct SortedMatchVisitor<'a> {
	glob_set: &'a GlobSet,
	config: &'a GlobConfig,
	on_match: Option<&'a ThreadsafeFunction<GlobMatch>>,
	top_matches: BinaryHeap<RankedGlobMatch>,
	shared: Arc<Mutex<Vec<GlobMatch>>>,
	error: Arc<Mutex<Option<String>>>,
	ct: &'a task::CancelToken,
	visited: usize,
}

impl Drop for SortedMatchVisitor<'_> {
	fn drop(&mut self) {
		if self.top_matches.is_empty() {
			return;
		}
		let drained = std::mem::take(&mut self.top_matches);
		self
			.shared
			.lock()
			.unwrap_or_else(|poison| poison.into_inner())
			.extend(drained.into_iter().map(|ranked| ranked.entry));
	}
}

impl ParallelVisitor for SortedMatchVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<ignore::DirEntry, ignore::Error>) -> WalkState {
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				*self.error.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;

		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		let Some(mut matched_entry) =
			fs_cache::collect_entry(&self.config.root, &entry, fs_cache::ScanDetail::Full)
		else {
			return WalkState::Continue;
		};
		if fs_cache::should_skip_path(
			Path::new(&matched_entry.path),
			self.config.mentions_node_modules,
		) {
			return WalkState::Continue;
		}
		if !self.glob_set.is_match(&matched_entry.path) {
			return WalkState::Continue;
		}
		let Some(effective_file_type) = apply_file_type_filter(&matched_entry, self.config) else {
			return WalkState::Continue;
		};
		matched_entry.file_type = effective_file_type;
		let streamable = self.on_match.map(|cb| (cb, matched_entry.clone()));
		// Admission into the per-thread heap over-approximates the global top-N,
		// so streamed partials are a superset; callers dedup and re-rank.
		if push_bounded_match(&mut self.top_matches, matched_entry, self.config.max_results)
			&& let Some((callback, payload)) = streamable
		{
			callback.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
		}
		WalkState::Continue
	}
}

struct SortedMatchVisitorBuilder<'a> {
	glob_set: &'a GlobSet,
	config: &'a GlobConfig,
	on_match: Option<&'a ThreadsafeFunction<GlobMatch>>,
	shared: Arc<Mutex<Vec<GlobMatch>>>,
	error: Arc<Mutex<Option<String>>>,
	ct: &'a task::CancelToken,
}

impl<'a> ParallelVisitorBuilder<'a> for SortedMatchVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(SortedMatchVisitor {
			glob_set: self.glob_set,
			config: self.config,
			on_match: self.on_match,
			top_matches: BinaryHeap::with_capacity(self.config.max_results.min(1024)),
			shared: Arc::clone(&self.shared),
			error: Arc::clone(&self.error),
			ct: self.ct,
			visited: 0,
		})
	}
}

/// Walk the tree in parallel, keeping a bounded top-`max_results` heap per
/// worker. The union of per-thread heaps always contains the global top-N;
/// `run_glob` re-sorts and truncates afterwards, so the final ranking is
/// deterministic (mtime desc, path tiebreak) regardless of walk order.
fn collect_sorted_matches_uncached(
	glob_set: &GlobSet,
	config: &GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut builder = fs_cache::build_walker(
		&config.root,
		config.include_hidden,
		config.use_gitignore,
		!config.mentions_node_modules,
		false,
	);
	let workers = fs_cache::grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}
	let shared = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let mut visitor_builder = SortedMatchVisitorBuilder {
		glob_set,
		config,
		on_match,
		shared: Arc::clone(&shared),
		error: Arc::clone(&error),
		ct,
	};
	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().unwrap_or_else(|poison| poison.into_inner()).take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut matches =
		std::mem::take(&mut *shared.lock().unwrap_or_else(|poison| poison.into_inner()));
	matches.sort_by(compare_matches_by_rank);
	matches.truncate(config.max_results);
	Ok(matches)
}

/// Executes matching/filtering over scanned entries and optionally streams each
/// hit.
fn run_glob(
	config: GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: task::CancelToken,
) -> Result<GlobResult> {
	let glob_set = glob_util::compile_glob(&config.pattern, config.recursive)?;
	if config.max_results == 0 {
		return Ok(GlobResult { matches: Vec::new(), total_matches: 0 });
	}

	let skip_node_modules = config.use_gitignore && !config.mentions_node_modules;
	let scan_options = fs_cache::ScanOptions {
		include_hidden: config.include_hidden,
		use_gitignore: config.use_gitignore,
		skip_node_modules,
		follow_links: false,
		detail: if config.sort_by_mtime {
			fs_cache::ScanDetail::Full
		} else {
			fs_cache::ScanDetail::Minimal
		},
	};
	let streams_bounded_sorted_partials =
		config.sort_by_mtime && !config.use_cache && config.max_results != usize::MAX;
	let mut matches = if streams_bounded_sorted_partials {
		collect_sorted_matches_uncached(&glob_set, &config, on_match, &ct)?
	} else if config.use_cache {
		let scan = fs_cache::get_or_scan(&config.root, scan_options, &ct)?;
		let mut matches = filter_entries(&scan.entries, &glob_set, &config, on_match, &ct)?;
		// Empty-result recheck: if we got zero matches from a cached scan that's old
		// enough, force a rescan and try once more before returning empty.
		if matches.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
			let fresh = fs_cache::force_rescan(&config.root, scan_options, true, &ct)?;
			matches = filter_entries(&fresh, &glob_set, &config, on_match, &ct)?;
		}
		matches
	} else {
		let fresh = fs_cache::force_rescan(&config.root, scan_options, false, &ct)?;
		filter_entries(&fresh, &glob_set, &config, on_match, &ct)?
	};

	if config.sort_by_mtime {
		// Sorting mode: rank by mtime descending, then apply max-results truncation.
		matches.sort_by(compare_matches_by_rank);
		matches.truncate(config.max_results);
		if !streams_bounded_sorted_partials && let Some(callback) = on_match {
			for matched_entry in &matches {
				callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
	}
	let total_matches = matches.len().min(u32::MAX as usize) as u32;
	Ok(GlobResult { matches, total_matches })
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, scans entries, applies glob and optional file-type
/// filters, and optionally streams each accepted match through `on_match`.
///
/// If `sortByMtime` is enabled with a finite `maxResults`, uncached scans keep
/// only the current top results while traversing instead of collecting the full
/// tree.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob(
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> task::Promise<GlobResult> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
	} = options;

	let pattern = pattern.trim();
	let pattern = if pattern.is_empty() { "*" } else { pattern };
	let pattern = pattern.to_string();

	let ct = task::CancelToken::new(timeout_ms, signal);

	task::blocking("glob", ct, move |ct| {
		run_glob(
			GlobConfig {
				root: fs_cache::resolve_search_path(&path)?,
				include_hidden: hidden.unwrap_or(false),
				file_type_filter: file_type,
				recursive: recursive.unwrap_or(true),
				max_results: max_results.map_or(usize::MAX, |value| value as usize),
				use_gitignore: gitignore.unwrap_or(true),
				mentions_node_modules: include_node_modules
					.unwrap_or_else(|| pattern.contains("node_modules")),
				sort_by_mtime: sort_by_mtime.unwrap_or(false),
				use_cache: cache.unwrap_or(false),
				pattern,
			},
			on_match.as_ref(),
			ct,
		)
	})
}
