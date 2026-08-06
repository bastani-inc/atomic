// Sync entry points and option resolution for native grep.

use std::{
	path::Path,
	sync::atomic::{AtomicU64, Ordering},
};

use grep_matcher::Matcher;
use napi::{
	bindgen_prelude::{Error, Result},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};

use super::{
	DEFAULT_NATIVE_GREP_MAX_COUNT, GrepConfig, GrepMatch, GrepOutputMode, GrepResult, OutputMode,
	SearchOptions, SearchParams, SearchResult, empty_search_result,
	engine::run_search,
	fs::{
		ReadFile, collect_files, matches_type_filter, read_file_bytes, resolve_search_path,
		resolve_type_filter,
	},
	output::{aggregate_parallel_results, push_content_matches, to_public_match},
	pattern::build_matcher,
	walk::{run_parallel_search, run_streaming_grep},
};
use crate::{fs_cache, glob_util, task};

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

const fn parse_output_mode(mode: Option<GrepOutputMode>) -> OutputMode {
	match mode {
		None | Some(GrepOutputMode::Content) => OutputMode::Content,
		Some(GrepOutputMode::Count) => OutputMode::Count,
		Some(GrepOutputMode::FilesWithMatches) => OutputMode::FilesWithMatches,
	}
}

fn resolve_context(
	context: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
) -> (u32, u32) {
	if context_before.is_some() || context_after.is_some() {
		(context_before.unwrap_or(0), context_after.unwrap_or(0))
	} else {
		let value = context.unwrap_or(0);
		(value, value)
	}
}

// ---------------------------------------------------------------------------
// Sync entry points
// ---------------------------------------------------------------------------

pub(super) fn search_sync(content: &[u8], options: SearchOptions) -> SearchResult {
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

pub(super) fn grep_sync(
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
			let file_name_matches =
				search_path.file_name().map(Path::new).is_some_and(|path| glob_set.is_match(path));
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

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{ffi::CString, os::unix::ffi::OsStrExt};
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::grep_sync;
	use crate::{
		grep::{GrepConfig, GrepOutputMode},
		task,
	};

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let pid = std::process::id();
			let path = std::env::temp_dir().join(format!("pi-grep-test-{pid}-{nanos}-{seq}"));
			fs::create_dir_all(&path).expect("create temp test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn write_file(path: &Path, content: &str) {
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent).expect("create parent directories for test file");
		}
		fs::write(path, content).expect("write test file");
	}

	#[cfg(unix)]
	fn make_fifo(path: &Path) {
		let fifo_path =
			CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL bytes");
		// SAFETY: `fifo_path` is a valid CString (NUL-terminated, no interior NULs),
		// so `as_ptr()` yields a valid C string pointer. `0o600` is a valid mode.
		// The CString is alive for the duration of the call.
		let rc = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
		assert_eq!(rc, 0, "create fifo: {}", std::io::Error::last_os_error());
	}

	#[cfg(unix)]
	fn base_grep_config(path: &Path) -> GrepConfig {
		GrepConfig {
			pattern: "needle".to_string(),
			path: path.to_string_lossy().into_owned(),
			cwd: None,
			glob: None,
			type_filter: None,
			ignore_case: None,
			multiline: None,
			hidden: None,
			gitignore: Some(false),
			cache: Some(false),
			max_count: None,
			offset: None,
			context_before: None,
			context_after: None,
			context: None,
			max_columns: None,
			mode: None,
			max_count_per_file: None,
		}
	}

	#[cfg(unix)]
	#[test]
	fn grep_directory_skips_fifo_entries() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("regular.txt"), "needle\n");
		make_fifo(&root.path().join("skip-me.fifo"));

		let result = grep_sync(base_grep_config(root.path()), None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 1);
		assert_eq!(result.files_with_matches, 1);
		assert_eq!(result.files_searched, 1);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "regular.txt");
	}

	#[cfg(unix)]
	#[test]
	fn grep_directory_applies_offset_and_limit_in_walker_order() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("b.txt"), "needle b1\n");
		write_file(&root.path().join("c.txt"), "haystack\n");

		let mut config = base_grep_config(root.path());
		config.max_count = Some(2);
		config.offset = Some(1);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 3);
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
		assert_eq!(result.matches.len(), 2);
		assert_eq!(result.matches[0].path, "a.txt");
		assert_eq!(result.matches[0].line, "needle a2");
		assert_eq!(result.matches[1].path, "b.txt");
		assert_eq!(result.matches[1].line, "needle b1");
	}

	#[cfg(unix)]
	#[test]
	fn grep_count_mode_limit_applies_to_matches_not_files() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle a1\nneedle a2\n");
		write_file(&root.path().join("b.txt"), "needle b1\n");

		let mut config = base_grep_config(root.path());
		config.mode = Some(GrepOutputMode::Count);
		config.max_count = Some(2);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		assert_eq!(result.total_matches, 3);
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "a.txt");
		assert_eq!(result.matches[0].match_count, Some(2));
	}

	#[cfg(unix)]
	#[test]
	fn grep_streaming_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("regular.txt"), "needle\n");

		let ct = task::CancelToken::new(Some(0), None);
		std::thread::sleep(Duration::from_millis(1));
		let result = grep_sync(base_grep_config(root.path()), None, ct);

		let Err(err) = result else {
			panic!("pre-cancelled grep should fail before returning matches");
		};
		assert!(
			err.to_string().contains("timed out"),
			"expected timeout cancellation error, got: {err}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn grep_special_root_path_returns_empty_result() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("direct.fifo");
		make_fifo(&fifo);

		let result = grep_sync(base_grep_config(&fifo), None, task::CancelToken::default())
			.expect("special-file grep should return an empty result");

		assert!(result.matches.is_empty());
		assert_eq!(result.total_matches, 0);
		assert_eq!(result.files_with_matches, 0);
		assert_eq!(result.files_searched, 0);
		assert_eq!(result.limit_reached, None);
	}

	#[cfg(unix)]
	#[test]
	fn grep_multiline_matches_cross_line_patterns() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("code.txt"), "fn foo() {\n  return 1;\n}\n");

		let mut config = base_grep_config(root.path());
		config.pattern = r"foo\(\) \{\n  return".to_string();
		config.multiline = Some(true);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("multiline grep should succeed");

		assert_eq!(result.total_matches, 1, "cross-line pattern should match across lines");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "code.txt");
		assert_eq!(result.matches[0].line_number, 1);
	}

	#[cfg(unix)]
	#[test]
	fn grep_per_file_max_count_preserves_file_diversity() {
		let root = TempDirGuard::new();
		write_file(&root.path().join("a.txt"), "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n");
		write_file(&root.path().join("z.txt"), "needle z\n");

		let mut config = base_grep_config(root.path());
		config.max_count = Some(4);
		config.max_count_per_file = Some(2);

		let result = grep_sync(config, None, task::CancelToken::default())
			.expect("directory grep should succeed");

		let paths: Vec<&str> = result.matches.iter().map(|matched| matched.path.as_str()).collect();
		assert_eq!(paths, ["a.txt", "a.txt", "z.txt"], "hot file must not starve later files");
		assert_eq!(result.files_with_matches, 2);
		assert_eq!(result.limit_reached, Some(true));
	}
}
