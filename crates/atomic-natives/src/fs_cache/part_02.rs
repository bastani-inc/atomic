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
	FS_CACHE.remove(&key);

	let entries = collect_entries(root, options, ct)?;
	if store {
		let now = Instant::now();
		FS_CACHE.insert(key, CacheEntry { created_at: now, entries: entries.clone() });
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
	FS_CACHE.clear();
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

	use super::classify_file_type;

	static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			let timestamp = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!("pi-fs-cache-test-{timestamp}-{counter}"));
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
	#[test]
	fn classify_file_type_skips_fifo() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("skip-me.fifo");
		make_fifo(&fifo);

		assert_eq!(classify_file_type(&fifo), None);
	}

	#[test]
	fn build_walker_skips_git_and_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git/objects")).unwrap();
		fs::write(root.path().join(".git/objects/a.txt"), "git obj").unwrap();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		// skip_node_modules: true -> should only see real.txt
		let walker = super::build_walker(root.path(), true, false, true, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| e.path().strip_prefix(root.path()).unwrap().to_string_lossy().into_owned())
			.collect();
		assert!(
			!paths.iter().any(|p| p.contains("node_modules") || p.contains(".git")),
			"expected no .git or node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == "real.txt"), "expected real.txt, got: {paths:?}");

		// skip_node_modules: false -> should see node_modules but not .git
		let walker = super::build_walker(root.path(), true, false, false, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| e.path().strip_prefix(root.path()).unwrap().to_string_lossy().into_owned())
			.collect();
		assert!(
			!paths.iter().any(|p| p.contains(".git")),
			"expected no .git entries, got: {paths:?}"
		);
		assert!(
			paths.iter().any(|p| p.contains("node_modules")),
			"expected node_modules entries, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_skips_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let entries = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
		assert!(
			!paths.iter().any(|p| p.contains("node_modules")),
			"expected no node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == &"real.txt"), "expected real.txt, got: {paths:?}");
	}

	#[test]
	fn collect_entries_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::new(Some(0), None);
		std::thread::sleep(Duration::from_millis(1));
		let result = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Minimal,
			},
			&ct,
		);

		let Err(err) = result else {
			panic!("pre-cancelled scans should fail before returning entries");
		};
		assert!(
			err.to_string().contains("timed out"),
			"expected timeout cancellation error, got: {err}"
		);
	}

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

	#[test]
	fn scan_detail_controls_metadata_collection() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let minimal = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Minimal,
			},
			&ct,
		)
		.unwrap();
		let minimal_file =
			minimal.iter().find(|entry| entry.path == "real.txt").expect("minimal scan includes file");
		assert_eq!(minimal_file.mtime, None);
		assert_eq!(minimal_file.size, None);

		let full = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let full_file =
			full.iter().find(|entry| entry.path == "real.txt").expect("full scan includes file");
		assert!(full_file.mtime.is_some(), "full scan should include mtime");
		assert_eq!(full_file.size, Some(2.0));
	}
}
