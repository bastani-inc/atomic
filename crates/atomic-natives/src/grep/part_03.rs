#[cfg(test)]
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

	use super::{
		GrepConfig, GrepOutputMode, escape_unescaped_parentheses, grep_sync, sanitize_braces,
	};
	use crate::task;

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

	#[test]
	fn preserves_unicode_property_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek}").as_ref(), r"\p{Greek}");
	}

	#[test]
	fn preserves_hex_brace_escapes() {
		assert_eq!(sanitize_braces(r"\x{41}").as_ref(), r"\x{41}");
	}

	#[test]
	fn preserves_malformed_braced_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek").as_ref(), r"\p{Greek");
	}

	#[test]
	fn escapes_non_quantifier_braces() {
		assert_eq!(sanitize_braces("${platform}").as_ref(), "$\\{platform\\}");
	}

	#[test]
	fn preserves_valid_quantifiers() {
		assert_eq!(sanitize_braces("a{2,4}").as_ref(), "a{2,4}");
	}

	#[test]
	fn preserves_escaped_parentheses() {
		assert_eq!(escape_unescaped_parentheses(r"foo\(bar\)").as_ref(), r"foo\(bar\)");
	}

	#[test]
	fn escapes_literal_parentheses() {
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider(").as_ref(),
			r"fetchAnthropicProvider\("
		);
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider()").as_ref(),
			r"fetchAnthropicProvider\(\)"
		);
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
