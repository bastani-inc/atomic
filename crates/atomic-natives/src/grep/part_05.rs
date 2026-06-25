// @generated split fragment copied from can1357/oh-my-pi for Atomic issue #1483 parity.
// DO NOT EDIT directly; update the vendored source and re-split.
fn search_sync(content: &[u8], options: SearchOptions) -> SearchResult {
	let ignore_case = options.ignore_case.unwrap_or(false);
	let multiline = options.multiline.unwrap_or(false);
	let mode = parse_output_mode(options.mode);
	let matcher = match build_matcher(&options.pattern, ignore_case, multiline) {
		Ok(matcher) => matcher,
		Err(err) => return empty_search_result(Some(err.to_string())),
	};

	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let max_columns = options.max_columns;
	let max_count = options.max_count.map(u64::from).or(Some(DEFAULT_NATIVE_GREP_MAX_COUNT));
	let offset = options.offset.unwrap_or(0) as u64;
	let params = SearchParams {
		context_before,
		context_after,
		max_columns,
		mode,
		max_count,
		max_count_per_file: None,
		offset,
		multiline,
	};
	let result = match run_search(&matcher, content, params) {
		Ok(result) => result,
		Err(err) => return empty_search_result(Some(err.to_string())),
	};

	SearchResult {
		matches: result.matches.into_iter().map(to_public_match).collect(),
		match_count: crate::clamp_u32(result.match_count),
		limit_reached: result.limit_reached,
		error: None,
	}
}

fn grep_sync(
	options: GrepConfig,
	on_match: Option<&ThreadsafeFunction<GrepMatch>>,
	ct: task::CancelToken,
) -> Result<GrepResult> {
	let search_path = resolve_search_path(&options.path)?;
	let metadata = std::fs::metadata(&search_path)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	let ignore_case = options.ignore_case.unwrap_or(false);
	let multiline = options.multiline.unwrap_or(false);
	let output_mode = parse_output_mode(options.mode);
	let matcher = build_matcher(&options.pattern, ignore_case, multiline)?;

	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let (context_before, context_after) =
		if output_mode == OutputMode::Content { (context_before, context_after) } else { (0, 0) };
	let max_columns = options.max_columns;
	let max_count = options.max_count.map(u64::from).or(Some(DEFAULT_NATIVE_GREP_MAX_COUNT));
	let offset = options.offset.unwrap_or(0) as u64;
	let include_hidden = options.hidden.unwrap_or(true);
	let use_gitignore = options.gitignore.unwrap_or(true);
	let use_cache = options.cache.unwrap_or(false);
	let glob_set = glob_util::try_compile_glob(options.glob.as_deref(), true)?;
	let type_filter = resolve_type_filter(options.type_filter.as_deref());

	let params = SearchParams {
		context_before,
		context_after,
		max_columns,
		mode: output_mode,
		max_count,
		max_count_per_file: options.max_count_per_file.map(u64::from),
		offset,
		multiline,
	};

	if !metadata.is_file() && !metadata.is_dir() {
		return Ok(GrepResult {
			matches: Vec::new(),
			total_matches: 0,
			files_with_matches: 0,
			files_searched: 0,
			limit_reached: None,
			skipped_oversized: None,
		});
	}

	if metadata.is_file() {
		if let Some(filter) = type_filter.as_ref()
			&& !matches_type_filter(&search_path, filter)
		{
			return Ok(GrepResult {
				matches: Vec::new(),
				total_matches: 0,
				files_with_matches: 0,
				files_searched: 0,
				limit_reached: None,
				skipped_oversized: None,
			});
		}
		if let Some(glob_set) = glob_set.as_ref() {
			let file_name_matches = search_path
				.file_name()
				.map(Path::new)
				.is_some_and(|path| glob_set.is_match(path));
			let cwd_relative_matches = options
				.cwd
				.as_deref()
				.and_then(|cwd| search_path.strip_prefix(Path::new(cwd)).ok())
				.is_some_and(|path| glob_set.is_match(path));
			if !file_name_matches && !cwd_relative_matches && !glob_set.is_match(&search_path) {
				return Ok(GrepResult {
					matches: Vec::new(),
					total_matches: 0,
					files_with_matches: 0,
					files_searched: 0,
					limit_reached: None,
					skipped_oversized: None,
				});
			}
		}

		let bytes = match read_file_bytes(&search_path) {
			Ok(ReadFile::Bytes(bytes)) => bytes,
			Ok(ReadFile::Oversized) => {
				return Ok(GrepResult {
					matches: Vec::new(),
					total_matches: 0,
					files_with_matches: 0,
					files_searched: 0,
					limit_reached: None,
					skipped_oversized: Some(1),
				});
			},
			Ok(ReadFile::Skipped) | Err(_) => {
				return Ok(GrepResult {
					matches: Vec::new(),
					total_matches: 0,
					files_with_matches: 0,
					files_searched: 0,
					limit_reached: None,
					skipped_oversized: None,
				});
			},
		};

		if output_mode == OutputMode::FilesWithMatches && max_count.is_none() && offset == 0 {
			let matched = matcher
				.is_match(bytes.as_slice())
				.map_err(|err| Error::from_reason(format!("Search failed: {err}")))?;
			if !matched {
				return Ok(GrepResult {
					matches: Vec::new(),
					total_matches: 0,
					files_with_matches: 0,
					files_searched: 1,
					limit_reached: None,
					skipped_oversized: None,
				});
			}

			let path_string = search_path.to_string_lossy().into_owned();
			return Ok(GrepResult {
				matches: vec![GrepMatch {
					path: path_string,
					line_number: 0,
					line: String::new(),
					context_before: None,
					context_after: None,
					truncated: None,
					match_count: None,
				}],
				total_matches: 1,
				files_with_matches: 1,
				files_searched: 1,
				limit_reached: None,
				skipped_oversized: None,
			});
		}

		let search = run_search(&matcher, bytes.as_slice(), params)
			.map_err(|err| Error::from_reason(format!("Search failed: {err}")))?;

		if search.match_count == 0 {
			return Ok(GrepResult {
				matches: Vec::new(),
				total_matches: 0,
				files_with_matches: 0,
				files_searched: 1,
				limit_reached: None,
				skipped_oversized: None,
			});
		}

		let path_string = search_path.to_string_lossy().into_owned();
		let mut matches = Vec::new();
		match output_mode {
			OutputMode::Content => {
				push_content_matches(&mut matches, path_string, search.matches);
			},
			OutputMode::Count => {
				matches.push(GrepMatch {
					path: path_string,
					line_number: 0,
					line: String::new(),
					context_before: None,
					context_after: None,
					truncated: None,
					match_count: Some(crate::clamp_u32(search.match_count)),
				});
			},
			OutputMode::FilesWithMatches => {
				matches.push(GrepMatch {
					path: path_string,
					line_number: 0,
					line: String::new(),
					context_before: None,
					context_after: None,
					truncated: None,
					match_count: None,
				});
			},
		}

		let limit_reached =
			search.limit_reached || max_count.is_some_and(|max| search.collected >= max);

		if let Some(callback) = on_match {
			for grep_match in &matches {
				callback.call(Ok(grep_match.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
		return Ok(GrepResult {
			matches,
			total_matches: crate::clamp_u32(search.match_count),
			files_with_matches: 1,
			files_searched: 1,
			limit_reached: if limit_reached { Some(true) } else { None },
			skipped_oversized: None,
		});
	}

	let mentions_node_modules = options.glob.as_deref().is_some_and(|g| g.contains("node_modules"));
	let scan_options = fs_cache::ScanOptions {
		include_hidden,
		use_gitignore,
		skip_node_modules: use_gitignore && !mentions_node_modules,
		follow_links: false,
		detail: fs_cache::ScanDetail::Minimal,
	};
	let entries = if use_cache {
		let scan = fs_cache::get_or_scan(&search_path, scan_options, &ct)?;
		let mut entries =
			collect_files(&search_path, &scan.entries, glob_set.as_ref(), type_filter.as_ref());
		if entries.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
			let fresh = fs_cache::force_rescan(&search_path, scan_options, true, &ct)?;
			entries = collect_files(&search_path, &fresh, glob_set.as_ref(), type_filter.as_ref());
		}
		Some(entries)
	} else {
		None
	};

	let results = if let Some(entries) = entries {
		// Check cancellation before heavy work
		ct.heartbeat()?;
		if entries.is_empty() {
			return Ok(GrepResult {
				matches: Vec::new(),
				total_matches: 0,
				files_with_matches: 0,
				files_searched: 0,
				limit_reached: None,
				skipped_oversized: None,
			});
		}
		let skipped = AtomicU64::new(0);
		let results = run_parallel_search(&entries, &matcher, params, &skipped);
		(results, skipped.load(Ordering::Relaxed))
	} else {
		run_streaming_grep(
			&search_path,
			&matcher,
			glob_set.as_ref(),
			type_filter.as_ref(),
			params,
			scan_options,
			&ct,
		)?
	};
	let (results, skipped_oversized) = results;
	let (matches, total_matches, files_with_matches, files_searched, limit_reached) =
		aggregate_parallel_results(results, params);

	// Fire callbacks after aggregation so offset/limit semantics match returned
	// results.
	if let Some(callback) = on_match {
		for grep_match in &matches {
			callback.call(Ok(grep_match.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	Ok(GrepResult {
		matches,
		total_matches: crate::clamp_u32(total_matches),
		files_with_matches,
		files_searched,
		limit_reached: if limit_reached { Some(true) } else { None },
		skipped_oversized: if skipped_oversized > 0 {
			Some(crate::clamp_u32(skipped_oversized))
		} else {
			None
		},
	})
}

// ---------------------------------------------------------------------------
// N-API exports
// ---------------------------------------------------------------------------

/// Search content for a pattern (one-shot, compiles pattern each time).
/// For repeated searches with the same pattern, use [`grep`] with file filters.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `options`: Regex settings, context, and output mode.
///
/// # Returns
/// Match list plus counts/limit status; errors are surfaced in `error`.
#[napi]
pub fn search(content: Either<JsString, Uint8Array>, options: SearchOptions) -> SearchResult {
	match &content {
		Either::A(js_str) => {
			let utf8 = match js_str.into_utf8() {
				Ok(utf8) => utf8,
				Err(err) => return empty_search_result(Some(err.to_string())),
			};
			search_sync(utf8.as_slice(), options)
		},
		Either::B(buf) => search_sync(buf.as_ref(), options),
	}
}

/// Quick check if content matches a pattern.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `pattern`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `ignore_case`: Case-insensitive matching.
/// - `multiline`: Enable multiline regex mode.
///
/// # Returns
/// True if any match exists; false on no match.
#[napi]
pub fn has_match(
	content: Either<JsString, Uint8Array>,
	pattern: Either<JsString, Uint8Array>,
	ignore_case: Option<bool>,
	multiline: Option<bool>,
) -> Result<bool> {
	// Hold JsStringUtf8 on the stack and borrow - no copy
	let content_utf8;
	let content_slice: &[u8] = match &content {
		Either::A(js_str) => {
			content_utf8 = js_str.into_utf8()?;
			content_utf8.as_slice()
		},
		Either::B(buf) => buf.as_ref(),
	};

	let pattern_utf8;
	let pattern_string;
	let pattern_ref: &str = match &pattern {
		Either::A(js_str) => {
			pattern_utf8 = js_str.into_utf8()?;
			pattern_utf8.as_str()?
		},
		Either::B(buf) => {
			pattern_string = std::str::from_utf8(buf.as_ref())
				.map_err(|err| Error::from_reason(format!("Invalid UTF-8 in pattern: {err}")))?
				.to_owned();
			&pattern_string
		},
	};

	let matcher =
		build_matcher(pattern_ref, ignore_case.unwrap_or(false), multiline.unwrap_or(false))?;
	Ok(matcher.is_match(content_slice).unwrap_or(false))
}

/// Search files for a regex pattern.
///
/// # Arguments
/// - `options`: Pattern, path, filters, and output mode.
/// - `on_match`: Optional callback invoked per match/result.
///
/// # Returns
/// Aggregated results across matching files.
#[napi]
pub fn grep(
	options: GrepOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GrepMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GrepMatch>>,
) -> task::Promise<GrepResult> {
	let GrepOptions {
		pattern,
		path,
		cwd,
		glob,
		r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
		max_count_per_file,
		timeout_ms,
		signal,
	} = options;

	let config = GrepConfig {
		pattern,
		path,
		cwd,
		glob,
		type_filter: r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		max_count_per_file,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
	};
	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("grep", ct, move |ct| grep_sync(config, on_match.as_ref(), ct))
}
