mod hud;
mod reply_listener;
mod runtime_run;
#[cfg(test)]
mod test_support;
mod tmux;
mod topology;
mod watchers;

use std::env;
use std::process;

const DEFAULT_TAIL_LINES: usize = 200;
const MIN_TAIL_LINES: usize = 100;
const MAX_TAIL_LINES: usize = 1000;

fn main() {
    if let Err(message) = run(env::args().skip(1).collect()) {
        eprintln!("omx runtime: {message}");
        process::exit(2);
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("--help") | Some("-h") | None => {
            println!("{}", usage());
            Ok(())
        }
        Some("phase1-topology") => {
            let json = args.iter().skip(1).any(|arg| arg == "--json");
            if json {
                println!("{}", topology::phase1_topology_json());
            } else {
                println!("{}", topology::phase1_topology_text());
            }
            Ok(())
        }
        Some("capture-pane") => run_capture_pane(&args[1..]),
        Some("hud-watch") => hud::run_hud_watch(&args[1..]),
        Some("reply-listener") => reply_listener::run_reply_listener(&args[1..]),
        Some("notify-fallback") => watchers::run_notify_fallback(&args[1..]),
        Some("hook-derived") => watchers::run_hook_derived(&args[1..]),
        Some("runtime-run") => runtime_run::run_runtime(&args[1..]),
        Some(command) => Err(format!("unknown command `{command}`\n{}", usage())),
    }
}

fn run_capture_pane(args: &[String]) -> Result<(), String> {
    let mut pane_id: Option<&str> = None;
    let mut tail_lines = DEFAULT_TAIL_LINES;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--pane-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("capture-pane requires a value after --pane-id".to_string());
                };
                pane_id = Some(value);
                index += 2;
            }
            flag if flag.starts_with("--pane-id=") => {
                pane_id = Some(flag.trim_start_matches("--pane-id="));
                index += 1;
            }
            "--tail-lines" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("capture-pane requires a value after --tail-lines".to_string());
                };
                tail_lines = parse_tail_lines(value)?;
                index += 2;
            }
            flag if flag.starts_with("--tail-lines=") => {
                tail_lines = parse_tail_lines(flag.trim_start_matches("--tail-lines="))?;
                index += 1;
            }
            unknown => {
                return Err(format!("unknown capture-pane argument `{unknown}`"));
            }
        }
    }

    let Some(pane_id) = pane_id else {
        return Err("capture-pane requires --pane-id".to_string());
    };

    let output = tmux::capture_pane(pane_id, tail_lines)?;
    print!("{output}");
    Ok(())
}

fn parse_tail_lines(raw: &str) -> Result<usize, String> {
    let parsed = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("invalid --tail-lines value `{raw}`"))?;
    if !(MIN_TAIL_LINES..=MAX_TAIL_LINES).contains(&parsed) {
        return Err(format!(
            "--tail-lines must be between {MIN_TAIL_LINES} and {MAX_TAIL_LINES}"
        ));
    }
    Ok(parsed)
}

fn usage() -> String {
    [
        "Usage:",
        "  omx-runtime phase1-topology [--json]",
        "  omx-runtime capture-pane --pane-id <pane-id> [--tail-lines <100-1000>]",
        "  omx-runtime hud-watch [--once] [--preset <minimal|focused|full>] [--interval-ms <ms>]",
        "  omx-runtime reply-listener",
        "  omx-runtime notify-fallback [--once] --cwd <path> [--notify-script <path>] [--pid-file <path>]",
        "  omx-runtime hook-derived [--once] --cwd <path> [--pid-file <path>]",
        "  omx-runtime runtime-run",
        "",
        "Commands:",
        "  phase1-topology  Show the approved Phase 1 native topology / ownership cut line.",
        "  capture-pane     Native tmux pane capture helper for the Phase 1 control plane.",
        "  hud-watch        Minimal native HUD watch loop for Phase 1 tmux runtime cutover.",
        "  reply-listener   Minimal native reply-listener daemon shell for Phase 1 cutover.",
        "  notify-fallback  Minimal native notify-fallback watcher surface for Phase 1 cutover.",
        "  hook-derived     Minimal native hook-derived watcher surface for Phase 1 cutover.",
        "  runtime-run      Minimal native stdin/stdout contract for MCP team runtime cutover.",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{parse_tail_lines, run};
    use crate::test_support::env_lock;
    use std::path::PathBuf;

    fn with_temp_home<T>(name: &str, f: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root =
            std::env::temp_dir().join(format!("omx-runtime-main-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("expected temp home");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &root);
        let result = f(root.clone());
        if let Some(home) = previous_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn topology_json_command_renders() {
        assert!(run(vec!["phase1-topology".into(), "--json".into()]).is_ok());
    }

    #[test]
    fn capture_pane_requires_pane_id() {
        let err = run(vec!["capture-pane".into()]).expect_err("expected argument error");
        assert!(err.contains("requires --pane-id"));
    }

    #[test]
    fn hud_watch_once_command_renders() {
        assert!(run(vec!["hud-watch".into(), "--once".into()]).is_ok());
    }

    #[test]
    fn runtime_run_requires_json_stdin() {
        let error = run(vec!["runtime-run".into()]).expect_err("expected runtime-run stdin error");
        assert!(error.contains("JSON stdin"));
    }

    #[test]
    fn notify_fallback_once_command_runs() {
        assert!(run(vec![
            "notify-fallback".into(),
            "--once".into(),
            "--cwd=/tmp/repo".into(),
        ])
        .is_ok());
    }

    #[test]
    fn reply_listener_command_runs() {
        with_temp_home("reply-listener", |home| {
            let state_dir = home.join(".omx").join("state");
            std::fs::create_dir_all(&state_dir).expect("expected state dir");
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run(vec!["reply-listener".into(), "--once".into()]).is_ok());
        });
    }

    #[test]
    fn tail_lines_validation_rejects_out_of_range_values() {
        let err = parse_tail_lines("42").expect_err("expected range error");
        assert!(err.contains("between 100 and 1000"));
    }
}
