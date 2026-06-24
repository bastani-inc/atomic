fn build_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<grep_regex::RegexMatcher> {
	let sanitized = sanitize_braces(pattern);
	match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => Ok(matcher),
		Err(err) => {
			let message = err.to_string();
			if message.contains("unclosed group") || message.contains("unopened group") {
				let escaped = escape_unescaped_parentheses(sanitized.as_ref());
				if escaped.as_ref() != sanitized.as_ref() {
					return build_regex_matcher(escaped.as_ref(), ignore_case, multiline)
						.map_err(|retry_err| Error::from_reason(format!("Regex error: {retry_err}")));
				}
			}
			Err(Error::from_reason(format!("Regex error: {message}")))
		},
	}
}

// ---------------------------------------------------------------------------
// File / directory search orchestration
// ---------------------------------------------------------------------------

fn per_file_params(params: SearchParams) -> SearchParams {
	let file_limit = match params.mode {
		OutputMode::Content => {
			let global = params.max_count.map(|max| max.saturating_add(params.offset));
			match (global, params.max_count_per_file) {
				(Some(global), Some(per_file)) => Some(global.min(per_file)),
				(global, per_file) => global.or(per_file),
			}
		},
		OutputMode::Count => None,
		OutputMode::FilesWithMatches => Some(1),
	};
	SearchParams { max_count: file_limit, offset: 0, ..params }
}

fn run_parallel_search(
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
		let search = if self.params.mode == OutputMode::FilesWithMatches {
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
			skipped_oversized: Arc::clone(&self.skipped_oversized),
			ct: self.ct,
			visited: 0,
		})
	}
}

fn run_streaming_grep(
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
	let skipped_oversized = Arc::new(AtomicU64::new(0));
	let mut visitor_builder = StreamingGrepVisitorBuilder {
		root: search_path,
		matcher,
		glob_set,
		type_filter,
		params: file_params,
		shared_results: Arc::clone(&shared_results),
		error: Arc::clone(&error),
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

fn push_count_match(matches: &mut Vec<GrepMatch>, path: String, match_count: u64) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: Some(crate::clamp_u32(match_count)),
	});
}

fn push_file_match(matches: &mut Vec<GrepMatch>, path: String) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: None,
	});
}

fn aggregate_parallel_results(
	results: Vec<FileSearchResult>,
	params: SearchParams,
) -> (Vec<GrepMatch>, u64, u32, u32, bool) {
	let SearchParams { mode, max_count, offset, .. } = params;
	let mut matches = Vec::new();
	let mut total_matches = 0u64;
	let mut files_with_matches = 0u32;
	let files_searched = crate::clamp_u32(results.len() as u64);
	let mut skipped = 0u64;
	let mut emitted = 0u64;
	let mut limit_reached = false;

	for result in results {
		if result.match_count == 0 {
			continue;
		}

		let file_match_start = total_matches;
		let file_match_count = result.match_count;
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(file_match_count);

		match mode {
			OutputMode::Content => {
				let mut selected_matches = Vec::new();
				for matched in result.matches {
					if skipped < offset {
						skipped += 1;
						continue;
					}
					if let Some(max) = max_count
						&& emitted >= max
					{
						limit_reached = true;
						break;
					}
					selected_matches.push(matched);
					emitted += 1;
				}
				if !selected_matches.is_empty() {
					push_content_matches(&mut matches, result.relative_path, selected_matches);
				}
				if result.limit_reached && skipped >= offset {
					limit_reached = true;
				}
			},
			OutputMode::Count => {
				let skipped_in_file = offset.saturating_sub(file_match_start).min(file_match_count);
				let available = file_match_count.saturating_sub(skipped_in_file);
				if available == 0 {
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				let remaining = max_count.map_or(available, |max| max.saturating_sub(emitted));
				if remaining == 0 {
					limit_reached = true;
					continue;
				}
				push_count_match(&mut matches, result.relative_path, result.match_count);
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					limit_reached = true;
				}
			},
			OutputMode::FilesWithMatches => {
				if skipped < offset {
					skipped += 1;
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				push_file_match(&mut matches, result.relative_path);
				emitted += 1;
			},
		}
	}

	if let Some(max) = max_count
		&& emitted >= max
	{
		limit_reached = true;
	}

	if max_count == Some(0) {
		limit_reached = files_with_matches > 0;
	}

	(matches, total_matches, files_with_matches, files_searched, limit_reached)
}

// ---------------------------------------------------------------------------
// Sync entry points
// ---------------------------------------------------------------------------
