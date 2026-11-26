//! Ends supervised commands' sessions when the host process dies (#5057).
//!
//! A host killed with SIGKILL, by the OOM killer, or by an exit that skips owner close cannot clean up its commands.
//! One small `/bin/sh` guardian per host, in a session of its own, holds the read end of a socket whose only write
//! end the host holds. The host tells it which sessions to watch. When the host dies the kernel closes its end, the
//! guardian reads end-of-file and kills every process still in a watched session, then exits.
//!
//! A session ID names one session only while it has members; once the last is gone a new process with that PID can
//! lead an unrelated session. So a session is unwatched as soon as its cleanup confirms it empty, and the guardian
//! records the leader's start time when it is told to watch it and skips a session whose leader PID now names a
//! different process. A guardian that dies first (a command ran `pkill sh`) closes its end of the socket; the host
//! notices at once, starts another and tells it every session still watched.
//!
//! The guardian also watches single processes that run in the host's own session and process group, such as an
//! extension's `pi.exec` command: when the host dies it kills each one whose PID still names the process it was told
//! about, together with the processes below it in its process group, read while it still runs. macOS has no
//! parent-death signal, and on Linux that signal would end the command before the processes it started could be read.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "macos")]
const DARWIN_SESSION_SCAN: &str = r#"
function run(sessions) {
	ObjC.bindFunction('getsid', ['int', ['int']]);
	ObjC.bindFunction('kill', ['int', ['int', 'int']]);
	const SIGKILL = 9;
	const watched = new Set(sessions.map(Number));
	const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	const table = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
	let hit = false;
	for (const row of table.split('\n')) {
		const fields = row.trim().split(/\s+/);
		const pid = Number(fields[0]);
		if (pid > 1 && fields[3] && fields[3][0] !== 'Z' && watched.has($.getsid(pid))) {
			if ($.kill(pid, SIGKILL) === 0) hit = true;
		}
	}
	return hit ? 'hit' : 'quiet';
}
"#;

#[cfg(any(target_os = "macos", test))]
const DARWIN_FALLBACK_PIDS: &str = r#"
BEGIN {
	n = split(sessions, ids, / +/)
	for (i = 1; i <= n; i++) if (ids[i] > 1) groups[ids[i]] = selected[ids[i]] = 1
}
$1 > 1 && NF == 4 {
	parent[$1] = $2
	if ($3 in groups) selected[$1] = 1
	if ($4 !~ /^Z/) live[$1] = 1
}
END {
	do {
		changed = 0
		for (pid in parent) if (!(pid in selected) && (parent[pid] in selected)) {
			selected[pid] = 1
			changed = 1
		}
	} while (changed)
	for (pid in selected) if (pid in live) print pid
}
"#;

/// Reads `+ <sid> <cgroup or -> [<start time, for tests>]` and `- <sid>` lines until end-of-file. On `+` it records the leader's start time
/// (field 22 of `/proc/<sid>/stat` on Linux, `ps -o lstart=` elsewhere). At end-of-file it keeps each session whose
/// leader is gone or still has that start time, freezes the session's cgroup if it has one and kills the members it
/// lists, then SIGKILLs every process in those sessions. macOS uses `getsid` through the system Objective-C bridge;
/// elsewhere it runs `pkill -s` or scans `/proc`. Three passes in a row must find none before the scan stops.
///
/// `+p <pid> - [<start time, for tests>]` and `-p <pid>` watch and unwatch a single process the same way. At
/// end-of-file, before the sessions, each watched process that still has its recorded start time is SIGKILLed with
/// the processes below it in its process group; one that is gone, or whose PID now names another process, is skipped.
const SCRIPT: &str = r#"trap '' HUP INT QUIT TERM PIPE TSTP TTIN TTOU
darwin_scanner=${1:-}
darwin_fallback_pids=${2:-}
darwin_fallback=0
ident() {
	v=
	if [ -r /proc/self/stat ]; then
		read -r l < "/proc/$1/stat" && set -- ${l##*) } && v=${20}
	else
		v=$(/bin/ps -o lstart= -p "$1")
	fi
}
matching_sessions() {
	matched=' '
	for id in "$@"; do
		ident "$id"
		eval "w=\$i_$id"
		if [ -z "$v" ] || [ "$v" = "$w" ]; then matched="$matched$id "; fi
	done
}
darwin_scan() {
	if [ "$darwin_fallback" = 0 ]; then
		if table=$(/bin/ps -axo pid=,ppid=,pgid=,stat=) &&
			result=$(printf '%s\n' "$table" | /usr/bin/osascript -l JavaScript -e "$darwin_scanner" "$@"); then
			case $result in hit) return 0 ;; quiet) return 1 ;; esac
		fi
		darwin_fallback=1
		/usr/bin/logger -t atomic-task-guardian 'macOS session scan failed; falling back to process groups and descendants'
	fi
	table=$(/bin/ps -axo pid=,ppid=,pgid=,stat=)
	pids=$(printf '%s\n' "$table" | /usr/bin/awk -v sessions="$*" "$darwin_fallback_pids")
	found=0
	for pid in $pids; do kill -KILL "$pid" 2>/dev/null && found=1; done
	for id in "$@"; do kill -KILL -- "-$id" 2>/dev/null && found=1; done
	[ "$found" = 1 ]
}
process_table() {
	if [ -r /proc/self/stat ]; then
		for f in /proc/[0-9]*/stat; do
			read -r l < "$f" || continue
			pid=${f#/proc/}
			set -- ${l##*) }
			echo "${pid%/stat} $2 $3"
		done
	else
		/bin/ps -axo pid=,ppid=,pgid=
	fi
}
end_processes() {
	sel=' '
	for id in "$@"; do
		ident "$id"
		eval "w=\$j_$id"
		if [ -n "$v" ] && [ "$v" = "$w" ]; then sel="$sel$id "; fi
	done
	[ "$sel" = ' ' ] && return
	table=$(process_table)
	while read -r pid ppid pgid; do
		case $sel in *" $pid "*) eval "g_$pid=\$pgid" ;; esac
	done <<TABLE
$table
TABLE
	pass=0
	while [ $pass -lt 2 ]; do
		pass=$((pass+1))
		grown=1
		while [ $grown = 1 ]; do
			grown=0
			while read -r pid ppid pgid; do
				case $sel in *" $pid "*) continue ;; esac
				case $sel in *" $ppid "*) ;; *) continue ;; esac
				eval "g=\${g_$ppid:-}"
				[ "$pgid" = "$g" ] || continue
				sel="$sel$pid "
				eval "g_$pid=\$g"
				grown=1
			done <<TABLE
$table
TABLE
		done
		for pid in $sel; do kill -KILL "$pid" 2>/dev/null; done
		table=$(process_table)
	done
}
s=' '
procs=' '
while read -r op id cg recorded; do
	case $op in
	+) case $s in *" $id "*) ;; *) s="$s$id "; ident "$id"; v=${recorded:-$v}; eval "i_$id=\$v; c_$id=\$cg" ;; esac ;;
	-) case $s in *" $id "*) s="${s%% $id *} ${s#* $id }" ;; esac ;;
	+p) case $procs in *" $id "*) ;; *) procs="$procs$id "; ident "$id"; v=${recorded:-$v}; eval "j_$id=\$v" ;; esac ;;
	-p) case $procs in *" $id "*) procs="${procs%% $id *} ${procs#* $id }" ;; esac ;;
	esac
done
end_processes $procs
matching_sessions $s
k=$matched
[ "$k" = ' ' ] && exit 0
for id in $k; do
	eval "cg=\$c_$id"
	[ -n "$cg" ] && [ "$cg" != - ] && [ -w "$cg/cgroup.freeze" ] || continue
	echo 1 > "$cg/cgroup.freeze"
	f=0; n=0
	while [ "$f" != 1 ] && [ $n -lt 2000 ]; do
		while read -r key val; do [ "$key" = frozen ] && f=$val; done < "$cg/cgroup.events"
		n=$((n+1))
	done
	while read -r p; do
		read -r l < "/proc/$p/stat" || continue
		set -- ${l##*) }
		[ "$4" = "$id" ] && kill -KILL "$p"
	done < "$cg/cgroup.procs"
	echo 0 > "$cg/cgroup.freeze"
	rmdir "$cg"
done
quiet=0; pass=0
while [ $quiet -lt 3 ] && [ $pass -lt 50 ]; do
	pass=$((pass+1)); hit=0
	if [ -n "$darwin_scanner" ]; then
		matching_sessions $k
		k=$matched
		[ "$k" = ' ' ] && break
		darwin_scan $k && hit=1
	elif command -v pkill >/dev/null; then
		for id in $k; do pkill -KILL -s "$id" && hit=1; done
	elif [ -r /proc/self/stat ]; then
		for f in /proc/[0-9]*/stat; do
			read -r l < "$f" || continue
			set -- ${l##*) }
			case $k in *" $4 "*) p=${f#/proc/}; kill -KILL "${p%/stat}" && hit=1 ;; esac
		done
	fi
	if [ $hit = 1 ]; then quiet=0; else quiet=$((quiet+1)); fi
done
"#;

struct Guardian {
	child: Child,
	host: UnixStream,
}
/// What the host knows of a watched session: its leader's start time and its cgroup.
struct Watched {
	start: Option<u64>,
	cgroup: Option<PathBuf>,
}
struct State {
	guardian: Option<Guardian>,
	watched: BTreeMap<libc::pid_t, Watched>,
	/// Single processes in the host's own session, each killed with the processes below it in its group.
	processes: BTreeSet<libc::pid_t>,
}
impl State {
	fn watches_any(&self) -> bool {
		!self.watched.is_empty() || !self.processes.is_empty()
	}
}
static STATE: Mutex<State> =
	Mutex::new(State { guardian: None, watched: BTreeMap::new(), processes: BTreeSet::new() });

fn lock() -> std::sync::MutexGuard<'static, State> {
	STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn line(session: libc::pid_t, watched: &Watched) -> String {
	let cgroup =
		watched.cgroup.as_ref().map_or_else(|| "-".into(), |path| path.display().to_string());
	format!("+ {session} {cgroup}\n")
}

fn spawn() -> io::Result<Guardian> {
	use std::os::unix::process::CommandExt;
	let (host, guardian) = UnixStream::pair()?;
	#[cfg(target_os = "macos")]
	{
		let on: libc::c_int = 1;
		unsafe {
			libc::setsockopt(
				host.as_raw_fd(),
				libc::SOL_SOCKET,
				libc::SO_NOSIGPIPE,
				(&on as *const libc::c_int).cast(),
				std::mem::size_of::<libc::c_int>() as libc::socklen_t,
			)
		};
	}
	host.set_nonblocking(true)?;
	let mut command = Command::new("/bin/sh");
	command
		.arg("-c")
		.arg(SCRIPT)
		.stdin(Stdio::from(std::os::fd::OwnedFd::from(guardian)))
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.current_dir("/");
	#[cfg(target_os = "macos")]
	command.args(["task-guardian", DARWIN_SESSION_SCAN, DARWIN_FALLBACK_PIDS]);
	// A session of its own: terminal signals and the host's process-group signals never reach it.
	unsafe {
		command.pre_exec(|| {
			if libc::setsid() < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let child = command.spawn()?;
	let monitor = host.try_clone();
	let id = child.id();
	if let Ok(monitor) = monitor {
		let _ = std::thread::Builder::new()
			.name("task-guardian".into())
			.spawn(move || replace_when_dead(&monitor, id));
	}
	Ok(Guardian { child, host })
}

/// Waits until the guardian `id` closes its end of the socket, which it does only by exiting, then starts another
/// for the sessions still watched, unless the host replaced it meanwhile.
fn replace_when_dead(monitor: &UnixStream, id: u32) {
	let mut poll = libc::pollfd { fd: monitor.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	loop {
		let ready = unsafe { libc::poll(&mut poll, 1, -1) };
		if ready > 0 {
			break;
		}
		if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
			return;
		}
	}
	// A guardian that cannot start at all must not be restarted in a tight loop.
	std::thread::sleep(Duration::from_millis(20));
	let mut state = lock();
	if state.guardian.as_ref().is_none_or(|guardian| guardian.child.id() != id) {
		return;
	}
	if let Some(mut dead) = state.guardian.take() {
		let _ = dead.child.kill();
		let _ = dead.child.wait();
	}
	if state.watches_any() {
		let _ = guardian(&mut state);
	}
}

/// Drops a guardian that can no longer be told what to watch. SIGKILL first: closing the socket while it lives would
/// read as the host's death and kill every watched session.
fn discard(state: &mut State) {
	if let Some(mut guardian) = state.guardian.take() {
		let _ = guardian.child.kill();
		let _ = guardian.child.wait();
	}
}

fn send(guardian: &mut Guardian, line: &str) -> bool {
	let bytes = line.as_bytes();
	#[cfg(target_os = "linux")]
	{
		let sent = unsafe {
			libc::send(
				guardian.host.as_raw_fd(),
				bytes.as_ptr().cast(),
				bytes.len(),
				libc::MSG_NOSIGNAL,
			)
		};
		sent == bytes.len() as isize
	}
	#[cfg(not(target_os = "linux"))]
	{
		use std::io::Write;
		guardian.host.write_all(bytes).is_ok()
	}
}

/// A live guardian that has every watched session, starting one when there is none or the last one died.
fn guardian(state: &mut State) -> Option<&mut Guardian> {
	let dead = match &mut state.guardian {
		Some(guardian) => !matches!(guardian.child.try_wait(), Ok(None)),
		None => true,
	};
	if dead {
		discard(state);
		state.guardian = Some(spawn().ok()?);
		let lines: String = state
			.watched
			.iter()
			.map(|(session, watched)| line(*session, watched))
			.chain(state.processes.iter().map(|pid| format!("+p {pid} -\n")))
			.collect();
		if !lines.is_empty() && !send(state.guardian.as_mut()?, &lines) {
			discard(state);
			return None;
		}
	}
	state.guardian.as_mut()
}

/// Kills `session`, and every process its cgroup lists in it, if the host dies before [`unwatch`]. Best effort:
/// without a guardian the command still runs. Must run while the leader is unreaped, so that its start time is its own.
pub(super) fn watch(session: libc::pid_t, cgroup: Option<PathBuf>) {
	let mut state = lock();
	if state.watched.contains_key(&session) {
		return;
	}
	let watched = Watched { start: super::session::start_time(session), cgroup };
	let entry = line(session, &watched);
	let sent = guardian(&mut state).is_none_or(|guardian| send(guardian, &entry));
	state.watched.insert(session, watched);
	if !sent {
		// The replacement is told every watched session, this one included.
		discard(&mut state);
		let _ = guardian(&mut state);
	}
}

/// Stops watching `session`, as soon as its cleanup confirmed it empty.
pub(super) fn unwatch(session: libc::pid_t) {
	let mut state = lock();
	if state.watched.remove(&session).is_none() {
		return;
	}
	let sent =
		state.guardian.as_mut().is_none_or(|current| send(current, &format!("- {session}\n")));
	if !sent {
		discard(&mut state);
		if state.watches_any() {
			let _ = guardian(&mut state);
		}
	}
}

/// What [`queue_process_watch`] hands its thread.
enum ProcessOp {
	Watch(libc::pid_t),
	Unwatch(libc::pid_t),
}
static PROCESS_OPS: Mutex<Option<std::sync::mpsc::Sender<ProcessOp>>> = Mutex::new(None);

/// Runs [`watch_process`] (`watch`) or [`unwatch_process`] for `pid` on a thread of its own, in the order of the
/// calls, so that the caller, the JavaScript thread, never waits for a guardian to start: starting one forks this
/// process. Inline where that thread cannot start.
pub(super) fn queue_process_watch(pid: libc::pid_t, watch: bool) {
	let op = if watch { ProcessOp::Watch(pid) } else { ProcessOp::Unwatch(pid) };
	let mut ops = PROCESS_OPS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
	if ops.is_none() {
		let (sender, receiver) = std::sync::mpsc::channel::<ProcessOp>();
		let started =
			std::thread::Builder::new().name("task-guardian-processes".into()).spawn(move || {
				for op in receiver {
					match op {
						ProcessOp::Watch(pid) => watch_process(pid),
						ProcessOp::Unwatch(pid) => unwatch_process(pid),
					}
				}
			});
		if started.is_ok() {
			*ops = Some(sender);
		}
	}
	let op = match ops.as_ref() {
		Some(sender) => match sender.send(op) {
			Ok(()) => return,
			Err(std::sync::mpsc::SendError(op)) => op,
		},
		None => op,
	};
	drop(ops);
	match op {
		ProcessOp::Watch(pid) => watch_process(pid),
		ProcessOp::Unwatch(pid) => unwatch_process(pid),
	}
}

/// Kills `pid`, a running child of the host in the host's own session, and the processes below it in its process
/// group, if the host dies before [`unwatch_process`]. The guardian records `pid`'s start time when it reads this, so
/// a PID handed to another process by the time the host dies is spared. Best effort: without a guardian `pid` runs on.
pub(super) fn watch_process(pid: libc::pid_t) {
	let mut state = lock();
	if !state.processes.insert(pid) {
		return;
	}
	let entry = format!("+p {pid} -\n");
	if !guardian(&mut state).is_none_or(|guardian| send(guardian, &entry)) {
		// The replacement is told every watched process, this one included.
		discard(&mut state);
		let _ = guardian(&mut state);
	}
}

/// Stops watching `pid`, as soon as it exited: what it left running is not the guardian's to end.
pub(super) fn unwatch_process(pid: libc::pid_t) {
	let mut state = lock();
	if !state.processes.remove(&pid) {
		return;
	}
	let sent = state.guardian.as_mut().is_none_or(|current| send(current, &format!("-p {pid}\n")));
	if !sent {
		discard(&mut state);
		if state.watches_any() {
			let _ = guardian(&mut state);
		}
	}
}

/// Whether `session` is watched; for tests.
#[cfg(test)]
pub(super) fn watching(session: libc::pid_t) -> bool {
	lock().watched.contains_key(&session)
}

/// Synchronously sends SIGKILL to every process in every watched session, for a host about to exit without closing
/// its task owners, skipping a session whose leader PID now names another process. Each session's cleanup still
/// confirms it empty and unwatches it as usual.
pub(super) fn kill_watched() {
	let watched: Vec<(libc::pid_t, Option<u64>)> =
		lock().watched.iter().map(|(session, watched)| (*session, watched.start)).collect();
	for (session, start) in watched {
		kill_session(session, start);
	}
}

/// SIGKILLs every process in `session`, unless its leader's PID now names a process that did not start at `start`.
fn kill_session(session: libc::pid_t, start: Option<u64>) {
	let now = super::session::start_time(session);
	if now.is_some() && now != start {
		return;
	}
	let _ = unsafe { libc::kill(-session, libc::SIGKILL) };
	for _ in 0..3 {
		super::session::signal_outside_group(session, libc::SIGKILL);
	}
}

#[cfg(test)]
pub(super) mod testing {
	use super::*;

	#[test]
	fn darwin_fallback_finds_group_members_and_their_descendants_5057() {
		use std::io::Write;

		let mut awk = Command::new("/usr/bin/awk")
			.args(["-v", "sessions=100 200", DARWIN_FALLBACK_PIDS])
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		awk.stdin
			.take()
			.unwrap()
			.write_all(
				b"1 0 1 Ss\n100 1 100 Ss\n105 1 100 S\n107 105 107 S\n108 107 108 S\n109 100 109 Z\n210 200 210 S\n211 1 200 S\n300 1 300 Ss\n301 300 301 S\n",
			)
			.unwrap();
		let output = awk.wait_with_output().unwrap();
		assert!(output.status.success());
		let mut pids: Vec<_> = std::str::from_utf8(&output.stdout).unwrap().lines().collect();
		pids.sort_unstable();
		assert_eq!(pids, ["100", "105", "107", "108", "210", "211"]);
	}

	/// Starts a guardian of its own, tells it to watch `session` as the host would, and closes the socket as a dying
	/// host does, then waits for it to finish. `recorded` replaces the leader start time the guardian would record,
	/// as when the leader exited and its PID was handed to another process before the host died.
	pub(in crate::task_supervisor) fn guardian_after_host_death(
		session: libc::pid_t,
		recorded: Option<&str>,
	) {
		let line = match recorded {
			Some(start) => format!("+ {session} - {start}\n"),
			None => format!("+ {session} -\n"),
		};
		guardian_told_then_host_death(&line);
	}

	/// Starts a guardian of its own, sends it `lines` as the host would, closes the socket as a dying host does, and
	/// waits for it to finish.
	fn guardian_told_then_host_death(lines: &str) {
		let mut guardian = spawn().unwrap();
		assert!(send(&mut guardian, lines));
		let Guardian { mut child, host } = guardian;
		// The guardian's monitor holds another descriptor of the socket, so closing this one is not enough.
		let _ = host.shutdown(std::net::Shutdown::Write);
		let _ = child.wait();
	}
	/// A shell that runs, as a `pi.exec` command does, in its parent's session and process group, and starts two
	/// processes: one in its group and one in a group of its own (job control).
	struct HostCommand {
		root: Child,
		in_group: libc::pid_t,
		other_group: libc::pid_t,
	}
	impl HostCommand {
		fn start() -> Self {
			use std::io::BufRead;
			let mut root = Command::new("/bin/sh")
				.args(["-c", "sleep 30 & echo $!; set -m; sleep 30 & echo $!; wait"])
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.spawn()
				.unwrap();
			let mut lines = io::BufReader::new(root.stdout.take().unwrap()).lines();
			let mut pid = || lines.next().unwrap().unwrap().trim().parse::<libc::pid_t>().unwrap();
			let (in_group, other_group) = (pid(), pid());
			let command = Self { root, in_group, other_group };
			assert_eq!(unsafe { libc::getpgid(command.in_group) }, unsafe { libc::getpgrp() });
			assert_ne!(unsafe { libc::getpgid(command.other_group) }, unsafe { libc::getpgrp() });
			command
		}
		fn pid(&self) -> libc::pid_t {
			self.root.id() as libc::pid_t
		}
		/// Whether the shell and the process in its group are still running after `within`, and the other one.
		fn running_after(&mut self, within: Duration) -> (bool, bool, bool) {
			let deadline = std::time::Instant::now() + within;
			loop {
				let root = matches!(self.root.try_wait(), Ok(None));
				let state = (root, runs(self.in_group), runs(self.other_group));
				if (!state.0 && !state.1) || std::time::Instant::now() >= deadline {
					return state;
				}
				std::thread::sleep(Duration::from_millis(20));
			}
		}
	}
	impl Drop for HostCommand {
		fn drop(&mut self) {
			for pid in [self.in_group, self.other_group] {
				unsafe { libc::kill(pid, libc::SIGKILL) };
			}
			let _ = self.root.kill();
			let _ = self.root.wait();
		}
	}
	/// Whether `pid` names a process that is not a zombie: one its new parent reaps once it ended.
	fn runs(pid: libc::pid_t) -> bool {
		let state = Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output();
		state.is_ok_and(|output| {
			let stat = String::from_utf8_lossy(&output.stdout);
			!stat.trim().is_empty() && !stat.trim().starts_with('Z')
		})
	}

	// A command in the host's own session (an extension's `pi.exec` command) ends with the process it started in its
	// group when the host dies. A program it started in a group of its own keeps running, and a command whose PID now
	// names another process is spared.
	#[test]
	fn guardian_ends_a_watched_process_and_its_group_descendants_when_the_host_dies() {
		let mut command = HostCommand::start();
		guardian_told_then_host_death(&format!("+p {} - 1\n", command.pid()));
		assert_eq!(
			command.running_after(Duration::from_millis(300)),
			(true, true, true),
			"the guardian killed a process whose PID it was told named another process"
		);
		guardian_told_then_host_death(&format!("+p {} -\n-p {}\n", command.pid(), command.pid()));
		assert_eq!(
			command.running_after(Duration::from_millis(300)),
			(true, true, true),
			"the guardian killed a process it no longer watched"
		);
		guardian_told_then_host_death(&format!("+p {} -\n", command.pid()));
		assert_eq!(
			command.running_after(Duration::from_secs(5)),
			(false, false, true),
			"the guardian ended the command and the process in its group, and only those"
		);
	}

	/// What the crash kill does for one watched session whose leader was recorded as starting at `start`.
	pub(in crate::task_supervisor) fn crash_kill(session: libc::pid_t, start: u64) {
		kill_session(session, Some(start));
	}
}
