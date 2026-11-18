//! The scheduling priority of the calling thread. A thread that sleeps until it is sent work, such as a SQLite
//! connection's thread, waits on Windows behind every busy thread of its priority once the CPUs are oversubscribed: a
//! whole scheduler quantum per wake-up, tens to hundreds of milliseconds (#5376). Above-normal priority lets it run
//! as soon as it is woken. On Linux it waits out the slice of the busy thread it wakes behind, about 3 ms; a short
//! slice of its own lets it run first.
use napi_derive::napi;

/// Raises the calling thread, and only it, to above-normal priority on Windows; returns whether it did. Does nothing
/// and returns false on other platforms, where raising a thread's priority needs a privilege a process lacks.
#[napi(js_name = "raiseCurrentThreadPriority")]
pub fn raise_current_thread_priority() -> bool {
	raise()
}

/// The calling thread's priority relative to its process's priority class on Windows (0 is normal, 1 above normal);
/// 0 on other platforms.
#[napi(js_name = "currentThreadPriority")]
pub fn current_thread_priority() -> i32 {
	current()
}

#[cfg(windows)]
fn raise() -> bool {
	use windows_sys::Win32::System::Threading::{
		GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
	};
	unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) != 0 }
}

#[cfg(not(windows))]
fn raise() -> bool {
	false
}

#[cfg(windows)]
fn current() -> i32 {
	use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadPriority};
	unsafe { GetThreadPriority(GetCurrentThread()) }
}

#[cfg(not(windows))]
fn current() -> i32 {
	0
}

/// The scheduler time slice, in nanoseconds, the calling thread asks for on Linux.
const SHORT_SLICE_NS: u64 = 100_000;

/// On Linux 6.12 and later, asks the scheduler for a short time slice (0.1 ms) for the calling thread, and only it, so
/// that when it is woken it runs before a busy thread finishes its slice instead of waiting out about 3 ms behind it
/// (#5376). Keeps the thread's policy and nice value, and does not pass the request on to processes it starts. Returns
/// whether the kernel took the request; any failure, such as an older kernel or a policy that is not the default one,
/// leaves everything as it was and returns false. Does nothing and returns false on other platforms.
#[napi(js_name = "shortenCurrentThreadSlice")]
pub fn shorten_current_thread_slice() -> bool {
	shorten(&LinuxScheduler)
}

/// The calling thread's time slice in nanoseconds, as Linux 6.12 and later report it: the one it asked for, or the default one; 0 on earlier kernels and elsewhere.
#[napi(js_name = "currentThreadSlice")]
pub fn current_thread_slice() -> i64 {
	slice(&LinuxScheduler)
}

/// `struct sched_attr`, as the `sched_getattr` and `sched_setattr` system calls take it (`SCHED_ATTR_SIZE_VER1`).
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SchedAttr {
	size: u32,
	sched_policy: u32,
	sched_flags: u64,
	sched_nice: i32,
	sched_priority: u32,
	sched_runtime: u64,
	sched_deadline: u64,
	sched_period: u64,
	sched_util_min: u32,
	sched_util_max: u32,
}

/// The calling thread's scheduling attributes, read and written.
trait Scheduler {
	fn get(&self) -> Option<SchedAttr>;
	fn set(&self, attr: &SchedAttr) -> bool;
}

struct LinuxScheduler;

#[cfg(target_os = "linux")]
impl Scheduler for LinuxScheduler {
	fn get(&self) -> Option<SchedAttr> {
		let mut attr = SchedAttr::default();
		let size = std::mem::size_of::<SchedAttr>() as libc::c_uint;
		let read =
			unsafe { libc::syscall(libc::SYS_sched_getattr, 0, &mut attr as *mut SchedAttr, size, 0) };
		(read == 0).then_some(attr)
	}

	fn set(&self, attr: &SchedAttr) -> bool {
		unsafe { libc::syscall(libc::SYS_sched_setattr, 0, attr as *const SchedAttr, 0) == 0 }
	}
}

#[cfg(not(target_os = "linux"))]
impl Scheduler for LinuxScheduler {
	fn get(&self) -> Option<SchedAttr> {
		None
	}

	fn set(&self, _attr: &SchedAttr) -> bool {
		false
	}
}

/// `SCHED_OTHER`, the default policy, the only one this asks a slice for.
const SCHED_OTHER: u32 = 0;
/// `SCHED_FLAG_RESET_ON_FORK`: a process or thread the caller starts does not take the request with it.
const SCHED_FLAG_RESET_ON_FORK: u64 = 0x01;

fn shorten(scheduler: &impl Scheduler) -> bool {
	let Some(current) = scheduler.get() else {
		return false;
	};
	if current.sched_policy != SCHED_OTHER {
		return false;
	}
	let wanted = SchedAttr {
		size: std::mem::size_of::<SchedAttr>() as u32,
		sched_policy: SCHED_OTHER,
		sched_flags: SCHED_FLAG_RESET_ON_FORK,
		sched_nice: current.sched_nice,
		sched_runtime: SHORT_SLICE_NS,
		..SchedAttr::default()
	};
	scheduler.set(&wanted)
}

fn slice(scheduler: &impl Scheduler) -> i64 {
	scheduler.get().map_or(0, |attr| attr.sched_runtime as i64)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::RefCell;

	struct Recorded {
		current: Option<SchedAttr>,
		accept: bool,
		written: RefCell<Option<SchedAttr>>,
	}

	impl Scheduler for Recorded {
		fn get(&self) -> Option<SchedAttr> {
			self.current
		}

		fn set(&self, attr: &SchedAttr) -> bool {
			*self.written.borrow_mut() = Some(*attr);
			self.accept
		}
	}

	fn thread(policy: u32, nice: i32) -> SchedAttr {
		SchedAttr { sched_policy: policy, sched_nice: nice, ..SchedAttr::default() }
	}

	#[test]
	fn asks_for_a_short_slice_keeping_policy_and_nice_and_not_for_children() {
		let scheduler = Recorded {
			current: Some(thread(SCHED_OTHER, 5)),
			accept: true,
			written: RefCell::default(),
		};
		assert!(shorten(&scheduler));
		let written = scheduler.written.borrow().expect("asked the kernel");
		assert_eq!(written.sched_policy, SCHED_OTHER);
		assert_eq!(written.sched_nice, 5);
		assert_eq!(written.sched_runtime, SHORT_SLICE_NS);
		assert_eq!(written.sched_flags, SCHED_FLAG_RESET_ON_FORK);
	}

	#[test]
	fn a_refused_request_is_reported_and_nothing_else_happens() {
		let scheduler = Recorded {
			current: Some(thread(SCHED_OTHER, 0)),
			accept: false,
			written: RefCell::default(),
		};
		assert!(!shorten(&scheduler));
	}

	#[test]
	fn an_unreadable_thread_or_another_policy_is_left_alone() {
		let unreadable = Recorded { current: None, accept: true, written: RefCell::default() };
		assert!(!shorten(&unreadable));
		assert!(unreadable.written.borrow().is_none());
		let batch =
			Recorded { current: Some(thread(3, 0)), accept: true, written: RefCell::default() };
		assert!(!shorten(&batch));
		assert!(batch.written.borrow().is_none());
	}
}
