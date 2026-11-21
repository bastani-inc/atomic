//! Starts child processes without copying this process's address space.
//!
//! `fork()` copies the parent's page tables before the child can `exec`, which takes time in proportion to the
//! parent's memory (about 50 ms per gigabyte), holds the address-space lock meanwhile, so every other thread that
//! faults a page waits too, and leaves each page the parent then writes to fault once more. A host of several gigabytes
//! that starts a few processes a second, as one running many agents does, spends most of its time there. On Linux this
//! module starts the child as `posix_spawn` does: `clone(CLONE_VM | CLONE_VFORK)` runs it on a small stack of its own,
//! sharing this process's memory, and suspends only the calling thread until the child has called `execve` or exited.
//! Between the two, the child runs only async-signal-safe system calls on memory prepared before the clone: it
//! allocates nothing and takes no lock. A failed step sends its errno to the parent through a close-on-exec pipe,
//! which a successful `execve` closes empty.

use std::ffi::{CString, OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

/// The child's stack: what its steps up to `execve` use, with ample room for the C library's system call wrappers.
const CHILD_STACK_BYTES: usize = 128 * 1024;
/// The search path the C library's `execvp` uses when the environment has no `PATH`.
const DEFAULT_SEARCH_PATH: &str = "/bin:/usr/bin";

/// Which signal dispositions the child resets to their default before `execve`. Handlers never survive `execve`
/// anyway, but one must not run in the child before it, on the memory it shares with this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SignalDefaults {
	/// Signals this process handles, and `SIGPIPE`, which Rust's standard library and Node ignore: as Rust's
	/// `std::process::Command` starts children. Other ignored signals stay ignored.
	Handled,
	/// Every standard signal, as Node's `child_process` starts children.
	All,
}

/// What to run and how. Built before the clone, so the child only reads it.
pub(crate) struct SpawnRequest {
	program: CString,
	argv: Vec<CString>,
	envp: Vec<CString>,
	cwd: Option<CString>,
	new_session: bool,
	signals: SignalDefaults,
	end_with_parent: bool,
	/// Makes the child take the parent-death signal as refused, as a sandbox can refuse it.
	#[cfg(test)]
	refuse_parent_death: bool,
}

impl SpawnRequest {
	/// `program` with `args` (not including `program` itself) and exactly the environment `env`. A program name
	/// without a slash is looked up on the environment's `PATH`, relative entries from `cwd`, as `execvp` would.
	pub(crate) fn new(
		program: &OsStr,
		args: impl IntoIterator<Item = OsString>,
		env: impl IntoIterator<Item = (OsString, OsString)>,
		cwd: Option<&Path>,
		new_session: bool,
		signals: SignalDefaults,
	) -> io::Result<Self> {
		let env: Vec<(OsString, OsString)> = env.into_iter().collect();
		let resolved = resolve_program(program, &env, cwd)?;
		let argv = std::iter::once(program.to_os_string())
			.chain(args)
			.map(c_string)
			.collect::<io::Result<Vec<_>>>()?;
		let envp = env
			.into_iter()
			.map(|(key, value)| {
				let mut entry = key.into_vec();
				entry.push(b'=');
				entry.extend_from_slice(value.as_bytes());
				c_string(OsString::from_vec(entry))
			})
			.collect::<io::Result<Vec<_>>>()?;
		Ok(Self {
			program: c_string(resolved.into_os_string())?,
			argv,
			envp,
			cwd: cwd.map(|path| c_string(path.as_os_str().to_os_string())).transpose()?,
			new_session,
			signals,
			end_with_parent: false,
			#[cfg(test)]
			refuse_parent_death: false,
		})
	}

	/// Ends the child with `SIGKILL` when the thread that starts it ends, as it does when this process ends however it
	/// ends (`PR_SET_PDEATHSIG`). The processes the child starts are not ended with it. Where the system refuses the
	/// request, as a sandbox can, the child runs without it.
	pub(crate) fn ending_with_parent(mut self) -> Self {
		self.end_with_parent = true;
		self
	}

	#[cfg(test)]
	fn refusing_parent_death(mut self) -> Self {
		self.refuse_parent_death = true;
		self
	}
}

fn c_string(text: OsString) -> io::Result<CString> {
	CString::new(text.into_vec()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

/// The environment this process would hand a child, with `overrides` applied over it unless `inherit` is false.
pub(crate) fn child_environment(
	inherit: bool,
	overrides: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
	let mut env: Vec<(OsString, OsString)> =
		if inherit { std::env::vars_os().collect() } else { Vec::new() };
	for (key, value) in overrides {
		match env.iter_mut().find(|(existing, _)| *existing == key) {
			Some(entry) => entry.1 = value,
			None => env.push((key, value)),
		}
	}
	env
}

/// Where `execvp` would find `program`: itself when it names a path, else the first executable regular file on the
/// search path. Missing everywhere is `ENOENT`, or `EACCES` when a match was found that may not be executed.
fn resolve_program(
	program: &OsStr,
	env: &[(OsString, OsString)],
	cwd: Option<&Path>,
) -> io::Result<PathBuf> {
	if program.is_empty() {
		return Err(io::Error::from_raw_os_error(libc::ENOENT));
	}
	if program.as_bytes().contains(&b'/') {
		return Ok(PathBuf::from(program));
	}
	let search = env
		.iter()
		.find(|(key, _)| key == "PATH")
		.map_or_else(|| OsString::from(DEFAULT_SEARCH_PATH), |(_, value)| value.clone());
	let mut denied = false;
	for entry in search.as_bytes().split(|byte| *byte == b':') {
		let directory =
			if entry.is_empty() { Path::new(".") } else { Path::new(OsStr::from_bytes(entry)) };
		let candidate = directory.join(program);
		let checked = match cwd {
			Some(cwd) if candidate.is_relative() => cwd.join(&candidate),
			_ => candidate.clone(),
		};
		let Ok(metadata) = std::fs::metadata(&checked) else { continue };
		if !metadata.is_file() {
			continue;
		}
		let Ok(path) = CString::new(checked.as_os_str().as_bytes()) else { continue };
		if unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0 {
			return Ok(checked);
		}
		denied = true;
	}
	Err(io::Error::from_raw_os_error(if denied { libc::EACCES } else { libc::ENOENT }))
}

/// Everything the child reads, as raw pointers into memory the suspended parent keeps alive.
struct ChildArgs {
	program: *const libc::c_char,
	argv: *const *const libc::c_char,
	envp: *const *const libc::c_char,
	cwd: *const libc::c_char,
	stdio: [RawFd; 3],
	new_session: bool,
	cgroup_procs: RawFd,
	signals: SignalDefaults,
	/// This process, when the child is to end with it; 0 otherwise.
	end_with: libc::pid_t,
	#[cfg(test)]
	refuse_parent_death: bool,
	/// The write end of the error pipe, close-on-exec.
	error: RawFd,
	empty_mask: libc::sigset_t,
}

/// Sends `errno` to the parent and exits. Async-signal-safe.
unsafe fn fail(args: &ChildArgs, errno: libc::c_int) -> ! {
	unsafe {
		let bytes = errno.to_ne_bytes();
		let _ = libc::write(args.error, bytes.as_ptr().cast(), bytes.len());
		libc::_exit(127)
	}
}

fn errno() -> libc::c_int {
	io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)
}

/// The child, from the clone to `execve`. Only async-signal-safe calls, on memory prepared before the clone.
extern "C" fn child_main(arg: *mut libc::c_void) -> libc::c_int {
	unsafe {
		let args = &*(arg as *const ChildArgs);
		// Every signal is blocked from before the clone. Put back the defaults first, so that no handler of this
		// process can run in the child once they are unblocked.
		let mut current: libc::sigaction = std::mem::zeroed();
		let mut default: libc::sigaction = std::mem::zeroed();
		default.sa_sigaction = libc::SIG_DFL;
		for signal in 1..libc::SIGRTMAX() + 1 {
			if signal == libc::SIGKILL || signal == libc::SIGSTOP {
				continue;
			}
			let reset = (args.signals == SignalDefaults::All && signal < 32)
				|| signal == libc::SIGPIPE
				|| (libc::sigaction(signal, std::ptr::null(), &mut current) == 0
					&& current.sa_sigaction != libc::SIG_DFL
					&& current.sa_sigaction != libc::SIG_IGN);
			if reset {
				// The C library refuses its own internal signals; those are never delivered here.
				libc::sigaction(signal, &default, std::ptr::null_mut());
			}
		}
		if args.new_session && libc::setsid() < 0 {
			fail(args, errno());
		}
		if args.end_with != 0 {
			#[cfg(test)]
			let refused = args.refuse_parent_death;
			#[cfg(not(test))]
			let refused = false;
			// A refused request leaves the child running without it, as it ran before.
			let requested = !refused
				&& libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) == 0;
			// A parent that ended before the request was made sends no signal: end as it would have.
			if requested && libc::getppid() != args.end_with {
				fail(args, libc::ESRCH);
			}
		}
		if args.cgroup_procs >= 0 {
			// A refusal leaves the child where it was, which the caller checks afterwards.
			let _ = libc::write(args.cgroup_procs, b"0".as_ptr().cast(), 1);
		}
		// Move a source descriptor out of 0..=2 first, so that placing one never overwrites another.
		let mut stdio = args.stdio;
		for fd in &mut stdio {
			if (0..3).contains(fd) {
				let moved = libc::fcntl(*fd, libc::F_DUPFD_CLOEXEC, 3);
				if moved < 0 {
					fail(args, errno());
				}
				*fd = moved;
			}
		}
		for (target, source) in stdio.into_iter().enumerate() {
			if libc::dup2(source, target as RawFd) < 0 {
				fail(args, errno());
			}
		}
		if !args.cwd.is_null() && libc::chdir(args.cwd) < 0 {
			fail(args, errno());
		}
		if libc::sigprocmask(libc::SIG_SETMASK, &args.empty_mask, std::ptr::null_mut()) < 0 {
			fail(args, errno());
		}
		libc::execve(args.program, args.argv, args.envp);
		fail(args, errno())
	}
}

/// A stack for the child, unmapped when dropped.
struct ChildStack {
	base: *mut libc::c_void,
	size: usize,
}
impl ChildStack {
	fn new(size: usize) -> io::Result<Self> {
		let base = unsafe {
			libc::mmap(
				std::ptr::null_mut(),
				size,
				libc::PROT_READ | libc::PROT_WRITE,
				libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_STACK,
				-1,
				0,
			)
		};
		if base == libc::MAP_FAILED {
			return Err(io::Error::last_os_error());
		}
		Ok(Self { base, size })
	}
	/// The stack grows down on every architecture Linux runs this on; mmap returns page-aligned memory.
	fn top(&self) -> *mut libc::c_void {
		unsafe { self.base.cast::<u8>().add(self.size).cast() }
	}
}
impl Drop for ChildStack {
	fn drop(&mut self) {
		unsafe { libc::munmap(self.base, self.size) };
	}
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
	let mut fds = [0 as RawFd; 2];
	if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// Starts `request` with `stdio` as its standard input, output and error, moving it into the cgroup whose
/// `cgroup.procs` is open as `cgroup_procs` before it runs anything. Returns its process ID once it has called
/// `execve`; the caller reaps it. Every descriptor this process opened stays out of the child, as all are
/// close-on-exec.
pub(crate) fn spawn(
	request: &SpawnRequest,
	stdio: [RawFd; 3],
	cgroup_procs: Option<RawFd>,
) -> io::Result<libc::pid_t> {
	let argv: Vec<*const libc::c_char> = request
		.argv
		.iter()
		.map(|arg| arg.as_ptr())
		.chain(std::iter::once(std::ptr::null()))
		.collect();
	let envp: Vec<*const libc::c_char> = request
		.envp
		.iter()
		.map(|entry| entry.as_ptr())
		.chain(std::iter::once(std::ptr::null()))
		.collect();
	let (error_reader, error_writer) = pipe()?;
	let stack = ChildStack::new(CHILD_STACK_BYTES)?;
	let mut args = ChildArgs {
		program: request.program.as_ptr(),
		argv: argv.as_ptr(),
		envp: envp.as_ptr(),
		cwd: request.cwd.as_ref().map_or(std::ptr::null(), |cwd| cwd.as_ptr()),
		stdio,
		new_session: request.new_session,
		cgroup_procs: cgroup_procs.unwrap_or(-1),
		signals: request.signals,
		end_with: if request.end_with_parent { unsafe { libc::getpid() } } else { 0 },
		#[cfg(test)]
		refuse_parent_death: request.refuse_parent_death,
		error: error_writer.as_raw_fd(),
		empty_mask: unsafe { std::mem::zeroed() },
	};
	let pid = unsafe {
		libc::sigemptyset(&mut args.empty_mask);
		let mut all: libc::sigset_t = std::mem::zeroed();
		let mut previous: libc::sigset_t = std::mem::zeroed();
		libc::sigfillset(&mut all);
		libc::pthread_sigmask(libc::SIG_SETMASK, &all, &mut previous);
		let pid = libc::clone(
			child_main,
			stack.top(),
			libc::CLONE_VM | libc::CLONE_VFORK | libc::SIGCHLD,
			(&mut args as *mut ChildArgs).cast(),
		);
		let cloned = if pid < 0 { Err(io::Error::last_os_error()) } else { Ok(pid) };
		libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
		cloned
	};
	drop(stack);
	drop(error_writer);
	let pid = pid?;
	// The child has called `execve`, which closed its copy of the pipe, or failed and exited.
	let mut bytes = [0u8; std::mem::size_of::<libc::c_int>()];
	let mut read = 0;
	while read < bytes.len() {
		let count = unsafe {
			libc::read(error_reader.as_raw_fd(), bytes[read..].as_mut_ptr().cast(), bytes.len() - read)
		};
		if count < 0 && errno() == libc::EINTR {
			continue;
		}
		if count <= 0 {
			break;
		}
		read += count as usize;
	}
	if read == 0 {
		return Ok(pid);
	}
	let mut status = 0;
	while unsafe { libc::waitpid(pid, &mut status, 0) } < 0 && errno() == libc::EINTR {}
	Err(io::Error::from_raw_os_error(if read == bytes.len() {
		libc::c_int::from_ne_bytes(bytes)
	} else {
		libc::EIO
	}))
}

/// A child started by [`spawn`], reaped by [`SpawnedChild::try_wait`] or [`SpawnedChild::wait`].
pub(crate) struct SpawnedChild {
	pid: libc::pid_t,
	status: Option<ExitStatus>,
}
impl SpawnedChild {
	pub(crate) fn new(pid: libc::pid_t) -> Self {
		Self { pid, status: None }
	}
	pub(crate) fn id(&self) -> u32 {
		self.pid as u32
	}
	fn reap(&mut self, flags: libc::c_int) -> io::Result<Option<ExitStatus>> {
		if let Some(status) = self.status {
			return Ok(Some(status));
		}
		let mut status = 0;
		loop {
			let reaped = unsafe { libc::waitpid(self.pid, &mut status, flags) };
			if reaped < 0 {
				let error = io::Error::last_os_error();
				if error.raw_os_error() == Some(libc::EINTR) {
					continue;
				}
				return Err(error);
			}
			if reaped == 0 {
				return Ok(None);
			}
			let exit = ExitStatus::from_raw(status);
			self.status = Some(exit);
			return Ok(Some(exit));
		}
	}
	/// Reaps the child if it has exited, without waiting.
	pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
		self.reap(libc::WNOHANG)
	}
	/// Waits for the child to exit and reaps it.
	pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
		self.reap(0).map(|status| status.expect("a blocking wait returns a status"))
	}
	/// Sends `signal` to the child unless it was already reaped, whose process ID may name another process by now.
	pub(crate) fn kill(&self, signal: libc::c_int) -> io::Result<()> {
		if self.status.is_some() {
			return Ok(());
		}
		if unsafe { libc::kill(self.pid, signal) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
}

/// Pipes for a child's standard streams: the child's ends, then this process's.
pub(crate) struct StdioPipes {
	pub(crate) child: [OwnedFd; 3],
	pub(crate) stdin: OwnedFd,
	pub(crate) stdout: OwnedFd,
	pub(crate) stderr: OwnedFd,
}
pub(crate) fn stdio_pipes() -> io::Result<StdioPipes> {
	let (stdin_child, stdin) = pipe()?;
	let (stdout, stdout_child) = pipe()?;
	let (stderr, stderr_child) = pipe()?;
	Ok(StdioPipes { child: [stdin_child, stdout_child, stderr_child], stdin, stdout, stderr })
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Read;

	fn request(program: &str, args: &[&str], cwd: Option<&Path>) -> io::Result<SpawnRequest> {
		SpawnRequest::new(
			OsStr::new(program),
			args.iter().map(OsString::from),
			child_environment(true, []),
			cwd,
			false,
			SignalDefaults::All,
		)
	}

	fn run(request: &SpawnRequest) -> (ExitStatus, String) {
		let pipes = stdio_pipes().unwrap();
		let pid = spawn(
			request,
			[pipes.child[0].as_raw_fd(), pipes.child[1].as_raw_fd(), pipes.child[2].as_raw_fd()],
			None,
		)
		.unwrap();
		let StdioPipes { child, stdin, stdout, .. } = pipes;
		drop(child);
		drop(stdin);
		let mut output = String::new();
		std::fs::File::from(stdout).read_to_string(&mut output).unwrap();
		(SpawnedChild::new(pid).wait().unwrap(), output)
	}

	#[test]
	fn runs_a_program_from_the_search_path_in_its_directory() {
		let directory = std::env::temp_dir().canonicalize().unwrap();
		let (status, output) =
			run(&request("sh", &["-c", "pwd; echo \"$0\""], Some(&directory)).unwrap());
		assert!(status.success());
		assert_eq!(output, format!("{}\nsh\n", directory.display()));
	}

	/// Starts `request` from a thread of its own, which then ends; returns the child's status once it ended.
	fn status_after_the_starting_thread_ended(request: SpawnRequest) -> ExitStatus {
		let pid = std::thread::spawn(move || {
			let pipes = stdio_pipes().unwrap();
			spawn(
				&request,
				[pipes.child[0].as_raw_fd(), pipes.child[1].as_raw_fd(), pipes.child[2].as_raw_fd()],
				None,
			)
			.unwrap()
		})
		.join()
		.unwrap();
		SpawnedChild::new(pid).wait().unwrap()
	}

	#[test]
	fn a_child_started_to_end_with_its_parent_ends_when_the_thread_that_started_it_ends() {
		let status = status_after_the_starting_thread_ended(
			request("sleep", &["30"], None).unwrap().ending_with_parent(),
		);
		assert_eq!(status.signal(), Some(libc::SIGKILL));
	}

	#[test]
	fn a_child_whose_parent_death_signal_is_refused_runs_without_it() {
		let status = status_after_the_starting_thread_ended(
			request("sleep", &["0.2"], None).unwrap().ending_with_parent().refusing_parent_death(),
		);
		assert_eq!(status.code(), Some(0));
	}

	#[test]
	fn a_child_outlives_the_thread_that_started_it_unless_it_was_started_to_end_with_it() {
		let status =
			status_after_the_starting_thread_ended(request("sleep", &["0.2"], None).unwrap());
		assert_eq!(status.code(), Some(0));
	}

	#[test]
	fn reports_the_exit_code_and_the_signal() {
		assert_eq!(run(&request("/bin/sh", &["-c", "exit 7"], None).unwrap()).0.code(), Some(7));
		assert_eq!(
			run(&request("/bin/sh", &["-c", "kill -TERM $$"], None).unwrap()).0.signal(),
			Some(libc::SIGTERM)
		);
	}

	#[test]
	fn a_missing_program_or_directory_is_an_error_and_leaves_no_child() {
		let missing = request("atomic-no-such-program", &[], None).err().unwrap();
		assert_eq!(missing.raw_os_error(), Some(libc::ENOENT));
		let request =
			request("/bin/sh", &["-c", "true"], Some(Path::new("/nonexistent-atomic-dir"))).unwrap();
		let pipes = stdio_pipes().unwrap();
		let fds =
			[pipes.child[0].as_raw_fd(), pipes.child[1].as_raw_fd(), pipes.child[2].as_raw_fd()];
		// A child that never reaches exec keeps the name of the thread that started it.
		let name = c"spawn-no-child";
		unsafe { libc::prctl(libc::PR_SET_NAME, name.as_ptr()) };
		assert_eq!(spawn(&request, fds, None).err().unwrap().raw_os_error(), Some(libc::ENOENT));
		// The child that failed to change directory was reaped: no process of that name is left.
		let own = std::process::id().to_string();
		let left = std::fs::read_dir("/proc").unwrap().filter_map(Result::ok).filter(|entry| {
			let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
			let (comm, rest) = stat.split_once(") ").map_or(("", ""), |(head, rest)| {
				(head.split_once(" (").map_or("", |(_, comm)| comm), rest)
			});
			comm == "spawn-no-child" && rest.split_whitespace().nth(1) == Some(own.as_str())
		});
		assert_eq!(left.count(), 0);
	}

	#[test]
	fn the_child_starts_with_default_signals_and_none_blocked() {
		// SIGPIPE is ignored by the Rust test harness; the child must start with it at its default.
		let (_, output) = run(
			&request("/bin/sh", &["-c", "grep -E '^(SigBlk|SigIgn)' /proc/self/status"], None)
				.unwrap(),
		);
		for line in output.lines() {
			let mask = u64::from_str_radix(line.split_whitespace().nth(1).unwrap(), 16).unwrap();
			assert_eq!(mask & (1 << (libc::SIGPIPE - 1)), 0, "{line}");
			if line.starts_with("SigBlk") {
				assert_eq!(mask, 0, "{line}");
			}
		}
	}

	#[test]
	fn a_new_session_is_led_by_the_child() {
		let pipes = stdio_pipes().unwrap();
		let mut request = request("/bin/sh", &["-c", "ps -o sid= -p $$"], None).unwrap();
		request.new_session = true;
		let pid = spawn(
			&request,
			[pipes.child[0].as_raw_fd(), pipes.child[1].as_raw_fd(), pipes.child[2].as_raw_fd()],
			None,
		)
		.unwrap();
		let StdioPipes { child, stdin, stdout, .. } = pipes;
		drop(child);
		drop(stdin);
		let mut output = String::new();
		std::fs::File::from(stdout).read_to_string(&mut output).unwrap();
		SpawnedChild::new(pid).wait().unwrap();
		assert_eq!(output.trim(), pid.to_string());
	}
}
