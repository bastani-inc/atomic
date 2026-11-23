use napi_derive::napi;

#[cfg(windows)]
use super::windows::{ContainmentJob, raw};

#[napi]
pub struct ProcessTreeContainment {
	#[cfg(windows)]
	job: Option<ContainmentJob>,
}

#[napi]
impl ProcessTreeContainment {
	#[napi]
	pub fn terminate(&self) -> bool {
		#[cfg(windows)]
		if let Some(job) = &self.job {
			return job.terminate().is_ok();
		}
		false
	}

	#[napi]
	pub fn active_processes(&self) -> napi::Result<u32> {
		#[cfg(windows)]
		if let Some(job) = &self.job {
			return job
				.active()
				.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()));
		}
		Ok(0)
	}

	#[napi]
	pub fn release(&mut self) -> bool {
		#[cfg(windows)]
		if let Some(job) = self.job.take() {
			return job.release().is_ok();
		}
		false
	}

	#[napi]
	pub fn close(&mut self) {
		#[cfg(windows)]
		drop(self.job.take());
	}
}

fn contain_process(pid: u32, allow_breakaway: bool) -> Option<ProcessTreeContainment> {
	#[cfg(windows)]
	{
		use std::os::windows::io::{FromRawHandle, OwnedHandle};
		use windows_sys::Win32::System::Threading::{
			GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
			PROCESS_TERMINATE,
		};
		if pid == 0 {
			return None;
		}
		let process = unsafe {
			OpenProcess(
				PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
				0,
				pid,
			)
		};
		if process.is_null() {
			return None;
		}
		let process = unsafe { OwnedHandle::from_raw_handle(process) };
		if unsafe { GetProcessId(raw(&process)) } != pid {
			return None;
		}
		let job = if allow_breakaway {
			ContainmentJob::create_allowing_breakaway().ok()?
		} else {
			ContainmentJob::create().ok()?
		};
		job.assign(raw(&process)).ok()?;
		Some(ProcessTreeContainment { job: Some(job) })
	}
	#[cfg(not(windows))]
	{
		let _ = (pid, allow_breakaway);
		None
	}
}

#[napi(js_name = "containProcessTree")]
pub fn contain_process_tree(pid: u32) -> Option<ProcessTreeContainment> {
	contain_process(pid, false)
}

/// Like `containProcessTree`, but sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK` so descendants that
/// explicitly ask to leave the job (`CREATE_BREAKAWAY_FROM_JOB`) can start and outlive it, while
/// every non-breakaway descendant remains contained and ends on `terminate()`.
#[napi(js_name = "containProcessTreeAllowingBreakaway")]
pub fn contain_process_tree_allowing_breakaway(pid: u32) -> Option<ProcessTreeContainment> {
	contain_process(pid, true)
}

#[cfg(all(windows, test))]
mod tests {
	use super::{contain_process_tree, contain_process_tree_allowing_breakaway};

	#[test]
	fn rejects_unaligned_pid_that_aliases_a_live_process() {
		let mut cmd = std::process::Command::new("cmd.exe")
			.args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
			.spawn()
			.expect("cmd.exe starts");
		let pid = cmd.id();
		for offset in 1..=3 {
			assert!(
				contain_process_tree(pid | offset).is_none(),
				"containProcessTree must not open aliased pid {}",
				pid | offset
			);
			assert!(
				contain_process_tree_allowing_breakaway(pid | offset).is_none(),
				"containProcessTreeAllowingBreakaway must not open aliased pid {}",
				pid | offset
			);
		}
		let mut tree =
			contain_process_tree_allowing_breakaway(pid).expect("exact live pid can be contained");
		assert!(tree.terminate());
		tree.close();
		let _ = cmd.wait();
	}
}
