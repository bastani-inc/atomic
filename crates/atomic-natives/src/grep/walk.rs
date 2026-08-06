// Directory traversal orchestration for native grep.

use std::{
	path::Path,
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
	},
};

use globset::GlobSet;
use grep_matcher::Matcher;
use grep_searcher::Searcher;
use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkState};
use napi::bindgen_prelude::{Error, Result};
use rayon::prelude::*;

use super::{
	DEFAULT_NATIVE_GREP_MAX_COUNT, OutputMode, SearchParams,
	engine::{
		CollectedMatch, SearchResultInternal, build_searcher_for_params, per_file_params,
		run_search_slice,
	},
	fs::{FileEntry, ReadFile, TypeFilter, matches_type_filter, read_file_bytes},
};
use crate::{fs_cache, task};

pub(super) struct FileSearchResult {
	pub(super) relative_path: String,
	pub(super) matches: Vec<CollectedMatch>,
	pub(super) match_count: u64,
	pub(super) limit_reached: bool,
}

// ---------------------------------------------------------------------------
// File / directory search orchestration
// ---------------------------------------------------------------------------

pub(super) fn run_parallel_search(
	entries: &[FileEntry],
	matcher: &grep_regex::RegexMatcher,
	params: SearchParams,
	skipped_oversized: &AtomicU64,
) -> Vec<FileSearchResult> {
	let file_params = per_file_params(params);
	let raw: Vec<Option<FileSearchResult>> = entries
		.par_iter()
		.map_init(
			|| build_searcher_for_params(file_params),
			|searcher, entry| {
				let bytes = match read_file_bytes(&entry.path).ok()? {
					ReadFile::Bytes(bytes) => bytes,
					ReadFile::Oversized => {
						skipped_oversized.fetch_add(1, Ordering::Relaxed);
						return None;
					},
					ReadFile::Skipped => return None,
				};
				let search = if file_params.mode == OutputMode::FilesWithMatches {
					let matched = matcher.is_match(bytes.as_slice()).ok()?;
					SearchResultInternal {
						matches: Vec::new(),
						match_count: u64::from(matched),
						collected: u64::from(matched),
						limit_reached: false,
					}
				} else {
					run_search_slice(searcher, matcher, bytes.as_slice(), file_params).ok()?
				};
				Some(FileSearchResult {
					relative_path: entry.relative_path.clone(),
					matches: search.matches,
					match_count: search.match_count,
					limit_reached: search.limit_reached,
				})
			},
		)
		.collect();

	raw.into_iter().flatten().collect()
}

fn reserve_streaming_budget(budget: &AtomicU64, requested: u64) -> u64 {
	let requested = requested.max(1);
	loop {
		let current = budget.load(Ordering::Relaxed);
		if current == 0 {
			return 0;
		}
		let allowed = current.min(requested);
		if budget
			.compare_exchange(current, current - allowed, Ordering::Relaxed, Ordering::Relaxed)
			.is_ok()
		{
			return allowed;
		}
	}
}

struct StreamingGrepVisitor<'a> {
	root: &'a Path,
	matcher: &'a grep_regex::RegexMatcher,
	glob_set: Option<&'a GlobSet>,
	type_filter: Option<&'a TypeFilter>,
	params: SearchParams,
	searcher: Searcher,
	results: Vec<FileSearchResult>,
	shared_results: Arc<Mutex<Vec<Vec<FileSearchResult>>>>,
	error: Arc<Mutex<Option<String>>>,
	collection_budget: Arc<AtomicU64>,
	skipped_oversized: Arc<AtomicU64>,
	ct: &'a task::CancelToken,
	visited: usize,
}

impl Drop for StreamingGrepVisitor<'_> {
	fn drop(&mut self) {
		if self.results.is_empty() {
			return;
		}
		let results = std::mem::take(&mut self.results);
		self.shared_results.lock().unwrap_or_else(|poison| poison.into_inner()).push(results);
	}
}

impl ParallelVisitor for StreamingGrepVisitor<'_> {
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
		if !entry.file_type().is_some_and(|file_type| file_type.is_file()) {
			return WalkState::Continue;
		}

		let relative = fs_cache::normalize_relative_path(self.root, entry.path());
		if relative.is_empty() {
			return WalkState::Continue;
		}
		if let Some(glob_set) = self.glob_set
			&& !glob_set.is_match(Path::new(relative.as_ref()))
		{
			return WalkState::Continue;
		}
		if let Some(filter) = self.type_filter
			&& !matches_type_filter(entry.path(), filter)
		{
			return WalkState::Continue;
		}

		let bytes = match read_file_bytes(entry.path()) {
			Ok(ReadFile::Bytes(bytes)) => bytes,
			Ok(ReadFile::Oversized) => {
				self.skipped_oversized.fetch_add(1, Ordering::Relaxed);
				return WalkState::Continue;
			},
			Ok(ReadFile::Skipped) | Err(_) => return WalkState::Continue,
		};
		let mut search = if self.params.mode == OutputMode::FilesWithMatches {
			let Ok(matched) = self.matcher.is_match(bytes.as_slice()) else {
				return WalkState::Continue;
			};
			SearchResultInternal {
				matches: Vec::new(),
				match_count: u64::from(matched),
				collected: u64::from(matched),
				limit_reached: false,
			}
		} else {
			let Ok(search) =
				run_search_slice(&mut self.searcher, self.matcher, bytes.as_slice(), self.params)
			else {
				return WalkState::Continue;
			};
			search
		};
		if search.match_count == 0 {
			return WalkState::Continue;
		}
		let requested = match self.params.mode {
			OutputMode::Content => search.matches.len() as u64,
			OutputMode::Count | OutputMode::FilesWithMatches => 1,
		};
		let allowed = reserve_streaming_budget(&self.collection_budget, requested);
		if allowed == 0 {
			return WalkState::Quit;
		}
		if self.params.mode == OutputMode::Content && allowed < requested {
			search.matches.truncate(allowed as usize);
			search.limit_reached = true;
		}
		self.results.push(FileSearchResult {
			relative_path: relative.into_owned(),
			matches: search.matches,
			match_count: search.match_count,
			limit_reached: search.limit_reached,
		});
		WalkState::Continue
	}
}

struct StreamingGrepVisitorBuilder<'a> {
	root: &'a Path,
	matcher: &'a grep_regex::RegexMatcher,
	glob_set: Option<&'a GlobSet>,
	type_filter: Option<&'a TypeFilter>,
	params: SearchParams,
	shared_results: Arc<Mutex<Vec<Vec<FileSearchResult>>>>,
	error: Arc<Mutex<Option<String>>>,
	collection_budget: Arc<AtomicU64>,
	skipped_oversized: Arc<AtomicU64>,
	ct: &'a task::CancelToken,
}

impl<'a> ParallelVisitorBuilder<'a> for StreamingGrepVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(StreamingGrepVisitor {
			root: self.root,
			matcher: self.matcher,
			glob_set: self.glob_set,
			type_filter: self.type_filter,
			params: self.params,
			searcher: build_searcher_for_params(self.params),
			results: Vec::new(),
			shared_results: Arc::clone(&self.shared_results),
			error: Arc::clone(&self.error),
			collection_budget: Arc::clone(&self.collection_budget),
			skipped_oversized: Arc::clone(&self.skipped_oversized),
			ct: self.ct,
			visited: 0,
		})
	}
}

pub(super) fn run_streaming_grep(
	search_path: &Path,
	matcher: &grep_regex::RegexMatcher,
	glob_set: Option<&GlobSet>,
	type_filter: Option<&TypeFilter>,
	params: SearchParams,
	scan_options: fs_cache::ScanOptions,
	ct: &task::CancelToken,
) -> Result<(Vec<FileSearchResult>, u64)> {
	let mut builder = fs_cache::build_walker(
		search_path,
		scan_options.include_hidden,
		scan_options.use_gitignore,
		scan_options.skip_node_modules,
		scan_options.follow_links,
	);
	let workers = fs_cache::grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}
	let file_params = per_file_params(params);
	let shared_results = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let collection_budget = Arc::new(AtomicU64::new(
		params
			.max_count
			.unwrap_or(DEFAULT_NATIVE_GREP_MAX_COUNT)
			.saturating_add(params.offset)
			.saturating_add(1024),
	));
	let skipped_oversized = Arc::new(AtomicU64::new(0));
	let mut visitor_builder = StreamingGrepVisitorBuilder {
		root: search_path,
		matcher,
		glob_set,
		type_filter,
		params: file_params,
		shared_results: Arc::clone(&shared_results),
		error: Arc::clone(&error),
		collection_budget: Arc::clone(&collection_budget),
		skipped_oversized: Arc::clone(&skipped_oversized),
		ct,
	};
	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().unwrap_or_else(|poison| poison.into_inner()).take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut results: Vec<FileSearchResult> = shared_results
		.lock()
		.unwrap_or_else(|poison| poison.into_inner())
		.drain(..)
		.flatten()
		.collect();
	results.sort_unstable_by(|a, b| a.relative_path.cmp(&b.relative_path));
	Ok((results, skipped_oversized.load(Ordering::Relaxed)))
}
