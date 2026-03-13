use std::fs::{create_dir_all, write};
use std::path::Path;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherOptions {
    pub cwd: Option<String>,
    pub pid_file: Option<String>,
    pub notify_script: Option<String>,
    pub parent_pid: Option<u32>,
    pub max_lifetime_ms: Option<u64>,
    pub once: bool,
}

pub fn run_notify_fallback(args: &[String]) -> Result<(), String> {
    let options = parse_watcher_args(args, true)?;
    maybe_write_pid_file(&options)?;
    if options.once {
        return Ok(());
    }

    sleep_until_limit(options.max_lifetime_ms);
    Ok(())
}

pub fn run_hook_derived(args: &[String]) -> Result<(), String> {
    let options = parse_watcher_args(args, false)?;
    maybe_write_pid_file(&options)?;
    if options.once {
        return Ok(());
    }

    sleep_until_limit(options.max_lifetime_ms);
    Ok(())
}

fn parse_watcher_args(
    args: &[String],
    allow_notify_script: bool,
) -> Result<WatcherOptions, String> {
    let mut cwd = None;
    let mut pid_file = None;
    let mut notify_script = None;
    let mut parent_pid = None;
    let mut max_lifetime_ms = None;
    let mut once = false;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--once" => {
                once = true;
                index += 1;
            }
            "--cwd" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("watcher requires a value after --cwd".to_string());
                };
                cwd = Some(value.clone());
                index += 2;
            }
            "--pid-file" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("watcher requires a value after --pid-file".to_string());
                };
                pid_file = Some(value.clone());
                index += 2;
            }
            "--notify-script" if allow_notify_script => {
                let Some(value) = args.get(index + 1) else {
                    return Err("watcher requires a value after --notify-script".to_string());
                };
                notify_script = Some(value.clone());
                index += 2;
            }
            "--parent-pid" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("watcher requires a value after --parent-pid".to_string());
                };
                parent_pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| format!("invalid --parent-pid value `{value}`"))?,
                );
                index += 2;
            }
            "--max-lifetime-ms" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("watcher requires a value after --max-lifetime-ms".to_string());
                };
                max_lifetime_ms = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| format!("invalid --max-lifetime-ms value `{value}`"))?,
                );
                index += 2;
            }
            flag if flag.starts_with("--cwd=") => {
                cwd = Some(flag.trim_start_matches("--cwd=").to_string());
                index += 1;
            }
            flag if flag.starts_with("--pid-file=") => {
                pid_file = Some(flag.trim_start_matches("--pid-file=").to_string());
                index += 1;
            }
            flag if allow_notify_script && flag.starts_with("--notify-script=") => {
                notify_script = Some(flag.trim_start_matches("--notify-script=").to_string());
                index += 1;
            }
            flag if flag.starts_with("--parent-pid=") => {
                let value = flag.trim_start_matches("--parent-pid=");
                parent_pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| format!("invalid --parent-pid value `{value}`"))?,
                );
                index += 1;
            }
            flag if flag.starts_with("--max-lifetime-ms=") => {
                let value = flag.trim_start_matches("--max-lifetime-ms=");
                max_lifetime_ms = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| format!("invalid --max-lifetime-ms value `{value}`"))?,
                );
                index += 1;
            }
            unknown => return Err(format!("unknown watcher argument `{unknown}`")),
        }
    }

    Ok(WatcherOptions {
        cwd,
        pid_file,
        notify_script,
        parent_pid,
        max_lifetime_ms,
        once,
    })
}

fn maybe_write_pid_file(options: &WatcherOptions) -> Result<(), String> {
    let Some(pid_path) = options.pid_file.as_ref() else {
        return Ok(());
    };

    let path = Path::new(pid_path);
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|err| format!("failed creating pid-file parent: {err}"))?;
    }
    let payload = format!(
        "{{\"pid\":{},\"started_at\":\"native-runtime\"}}\n",
        std::process::id()
    );
    write(path, payload).map_err(|err| format!("failed writing pid-file: {err}"))
}

fn sleep_until_limit(limit_ms: Option<u64>) {
    let sleep_ms = limit_ms.unwrap_or(50);
    thread::sleep(Duration::from_millis(sleep_ms.min(50)));
}

#[cfg(test)]
mod tests {
    use super::{run_hook_derived, run_notify_fallback};
    use std::fs::read_to_string;

    #[test]
    fn notify_fallback_once_writes_pid_file() {
        let dir = std::env::temp_dir().join(format!("omx-notify-{}", std::process::id()));
        let pid_file = dir.join("notify.pid");
        let _ = std::fs::remove_dir_all(&dir);
        run_notify_fallback(&[
            "--once".into(),
            "--cwd".into(),
            "/tmp/repo".into(),
            "--notify-script".into(),
            "/tmp/notify.js".into(),
            "--pid-file".into(),
            pid_file.display().to_string(),
        ])
        .expect("expected notify fallback to succeed");
        let content = read_to_string(pid_file).expect("expected pid file");
        assert!(content.contains("\"pid\":"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hook_derived_once_accepts_minimal_args() {
        assert!(run_hook_derived(&["--once".into(), "--cwd=/tmp/repo".into()]).is_ok());
    }
}
