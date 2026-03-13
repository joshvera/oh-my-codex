use std::env;
use std::ffi::OsString;
use std::fs::{create_dir_all, read_dir, read_to_string, remove_dir_all, write};
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRunInput {
    pub team_name: String,
    pub agent_types: Vec<String>,
    pub tasks: Vec<RuntimeTaskInput>,
    pub cwd: String,
    pub worker_count: usize,
    pub poll_interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeTaskInput {
    pub subject: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeStartResult {
    pane_ids: Vec<String>,
    leader_pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeMonitorSnapshot {
    phase: String,
    pending: usize,
    in_progress: usize,
    completed: usize,
    failed: usize,
    dead_workers: Vec<String>,
    monitor_ms: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskResult {
    task_id: String,
    status: String,
    summary: String,
}

pub fn run_runtime(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err(format!(
            "runtime-run does not accept positional arguments yet: {}",
            args.join(" ")
        ));
    }

    let raw_input = read_runtime_input_raw()?;
    let input = parse_runtime_input(&raw_input)?;
    write_panes_sidecar_placeholder()?;

    let start_result = start_team(&input)?;
    write_panes_sidecar(&start_result.pane_ids, &start_result.leader_pane_id)?;

    let started_at = Instant::now();
    loop {
        sleep(Duration::from_millis(input.poll_interval_ms));

        let snapshot = match monitor_team(&input)? {
            Some(snapshot) => snapshot,
            None => continue,
        };

        let live_panes = read_live_pane_state(&input);
        if let Some((ref pane_ids, ref leader_pane_id)) = live_panes {
            let _ = write_panes_sidecar(pane_ids, leader_pane_id);
        }

        eprintln!(
            "[runtime-run] phase={} pending={} inProgress={} completed={} failed={} dead={} monitorMs={}",
            snapshot.phase,
            snapshot.pending,
            snapshot.in_progress,
            snapshot.completed,
            snapshot.failed,
            snapshot.dead_workers.len(),
            snapshot.monitor_ms,
        );

        if snapshot.phase == "complete" {
            shutdown_and_emit_result(&input, "completed", started_at.elapsed().as_secs_f64())?;
            return Ok(());
        }
        if snapshot.phase == "failed" || snapshot.phase == "cancelled" {
            shutdown_and_emit_result(&input, "failed", started_at.elapsed().as_secs_f64())?;
            return Err("runtime-run observed terminal failure phase".to_string());
        }

        let has_outstanding_work = snapshot.pending + snapshot.in_progress > 0;
        let live_worker_pane_count = live_panes.map(|(pane_ids, _)| pane_ids.len()).unwrap_or(0);
        let (dead_worker_failure, fixing_with_no_workers) = detect_dead_worker_failure(
            snapshot.dead_workers.len(),
            live_worker_pane_count,
            has_outstanding_work,
            &snapshot.phase,
        );
        if dead_worker_failure || fixing_with_no_workers {
            eprintln!(
                "[runtime-run] Failure detected: deadWorkerFailure={} fixingWithNoWorkers={}",
                dead_worker_failure, fixing_with_no_workers,
            );
            shutdown_and_emit_result(&input, "failed", started_at.elapsed().as_secs_f64())?;
            return Err("runtime-run detected dead worker failure".to_string());
        }
    }
}

fn start_team(input: &RuntimeRunInput) -> Result<RuntimeStartResult, String> {
    let sanitized_team_name = sanitize_team_name(&input.team_name)?;
    ensure_tmux_available()?;
    ensure_inside_tmux()?;

    let worker_clis = normalize_agent_types(&input.agent_types, input.worker_count)?;
    let start_task = input
        .tasks
        .iter()
        .map(|task| task.subject.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    let created_at = iso_timestamp();
    let team_state_root = PathBuf::from(&input.cwd).join(".omx").join("state");
    let team_root = team_state_root.join("team").join(&sanitized_team_name);
    if team_root.exists() {
        return Err(format!(
            "team state already exists for {} at {}",
            sanitized_team_name,
            team_root.display()
        ));
    }

    initialize_team_state(
        &sanitized_team_name,
        &start_task,
        input,
        &worker_clis,
        &team_state_root,
        &created_at,
    )?;

    let session =
        match create_team_session(&sanitized_team_name, input, &worker_clis, &team_state_root) {
            Ok(session) => session,
            Err(error) => {
                let _ = remove_dir_all(&team_root);
                return Err(error);
            }
        };

    finalize_team_state(
        &sanitized_team_name,
        &start_task,
        input,
        &worker_clis,
        &team_state_root,
        &created_at,
        &session,
    )?;

    send_worker_bootstrap_prompts(&sanitized_team_name, input, &session.worker_pane_ids)?;

    Ok(RuntimeStartResult {
        pane_ids: session.worker_pane_ids,
        leader_pane_id: session.leader_pane_id,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerCli {
    Codex,
    Claude,
    Gemini,
}

impl WorkerCli {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TeamSessionStart {
    team_target: String,
    leader_pane_id: String,
    worker_pane_ids: Vec<String>,
}

fn sanitize_team_name(name: &str) -> Result<String, String> {
    let lowered = name.to_ascii_lowercase();
    let mut out = String::new();
    let mut last_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let truncated = trimmed
        .chars()
        .take(30)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if truncated.is_empty() {
        Err("sanitizeTeamName: empty after sanitization".to_string())
    } else {
        Ok(truncated)
    }
}

fn normalize_agent_types(raw: &[String], worker_count: usize) -> Result<Vec<WorkerCli>, String> {
    let providers = raw
        .iter()
        .map(|entry| match entry.trim().to_ascii_lowercase().as_str() {
            "codex" => Ok(WorkerCli::Codex),
            "claude" => Ok(WorkerCli::Claude),
            "gemini" => Ok(WorkerCli::Gemini),
            other => Err(format!(
                "Invalid agentTypes entries: {other}. Expected codex|claude|gemini."
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;

    if providers.len() != 1 && providers.len() != worker_count {
        return Err(format!(
            "agentTypes length must be 1 or {worker_count}; received {}.",
            providers.len()
        ));
    }

    if providers.len() == 1 {
        Ok(vec![providers[0]; worker_count])
    } else {
        Ok(providers)
    }
}

fn initialize_team_state(
    team_name: &str,
    start_task: &str,
    input: &RuntimeRunInput,
    worker_clis: &[WorkerCli],
    team_state_root: &PathBuf,
    created_at: &str,
) -> Result<(), String> {
    let team_root = team_state_root.join("team").join(team_name);
    let workers_root = team_root.join("workers");
    let tasks_root = team_root.join("tasks");
    let claims_root = team_root.join("claims");
    let mailbox_root = team_root.join("mailbox");
    let dispatch_root = team_root.join("dispatch");
    let events_root = team_root.join("events");
    let approvals_root = team_root.join("approvals");

    for dir in [
        &workers_root,
        &tasks_root,
        &claims_root,
        &mailbox_root,
        &dispatch_root,
        &events_root,
        &approvals_root,
    ] {
        create_dir_all(dir).map_err(|err| format!("failed creating {}: {err}", dir.display()))?;
    }
    write(
        dispatch_root.join("requests.json"),
        "[]
",
    )
    .map_err(|err| format!("failed writing dispatch requests: {err}"))?;

    for (index, task) in input.tasks.iter().enumerate() {
        let body = format!(
            "{{\"id\":{},\"subject\":{},\"description\":{},\"status\":\"pending\",\"depends_on\":[],\"version\":1,\"created_at\":{}}}
",
            json_string(&(index + 1).to_string()),
            json_string(&task.subject),
            json_string(&task.description),
            json_string(created_at),
        );
        write(tasks_root.join(format!("task-{}.json", index + 1)), body)
            .map_err(|err| format!("failed writing task state: {err}"))?;
    }

    for (index, worker_cli) in worker_clis.iter().enumerate() {
        let worker_name = format!("worker-{}", index + 1);
        let worker_dir = workers_root.join(&worker_name);
        create_dir_all(&worker_dir)
            .map_err(|err| format!("failed creating worker dir {}: {err}", worker_dir.display()))?;
        write(
            worker_dir.join("status.json"),
            format!(
                "{{\"state\":\"idle\",\"updated_at\":{}}}
",
                json_string(created_at)
            ),
        )
        .map_err(|err| format!("failed writing worker status: {err}"))?;
        write(
            worker_dir.join("inbox.md"),
            generate_worker_inbox(team_name, &worker_name, input, *worker_cli),
        )
        .map_err(|err| format!("failed writing worker inbox: {err}"))?;
    }

    write_phase_state(team_name, &input.cwd, "team-exec", true)?;

    let worker_json = (1..=input.worker_count)
        .map(|index| {
            format!(
                "{{\"name\":{},\"index\":{},\"role\":\"executor\",\"worker_cli\":{},\"assigned_tasks\":[]}}",
                json_string(&format!("worker-{index}")),
                index,
                json_string(worker_clis[index - 1].as_str()),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let team_state_root_str = team_state_root.to_string_lossy().to_string();
    let leader_worker = env::var("OMX_TEAM_WORKER").unwrap_or_else(|_| "leader-fixed".to_string());

    let config = format!(
        "{{\"name\":{},\"task\":{},\"agent_type\":\"executor\",\"worker_launch_mode\":\"interactive\",\"lifecycle_profile\":\"default\",\"worker_count\":{},\"max_workers\":20,\"workers\":[{}],\"created_at\":{},\"tmux_session\":{},\"next_task_id\":{},\"leader_cwd\":{},\"team_state_root\":{},\"workspace_mode\":\"single\",\"leader_pane_id\":null,\"hud_pane_id\":null,\"resize_hook_name\":null,\"resize_hook_target\":null,\"next_worker_index\":{}}}
",
        json_string(team_name),
        json_string(start_task),
        input.worker_count,
        worker_json,
        json_string(created_at),
        json_string(&format!("omx-team-{team_name}")),
        input.tasks.len() + 1,
        json_string(&input.cwd),
        json_string(&team_state_root_str),
        input.worker_count + 1,
    );
    write(team_root.join("config.json"), config)
        .map_err(|err| format!("failed writing team config: {err}"))?;

    let manifest = format!(
        "{{\"schema_version\":2,\"name\":{},\"task\":{},\"leader\":{{\"session_id\":{},\"worker_id\":{},\"role\":\"leader\"}},\"policy\":{{\"display_mode\":\"split_pane\",\"worker_launch_mode\":\"interactive\",\"dispatch_mode\":\"hook_preferred_with_fallback\",\"dispatch_ack_timeout_ms\":2000}},\"governance\":{{\"delegation_only\":false,\"plan_approval_required\":false,\"nested_teams_allowed\":false,\"one_team_per_leader_session\":true,\"cleanup_requires_all_workers_inactive\":true}},\"lifecycle_profile\":\"default\",\"permissions_snapshot\":{{\"approval_mode\":{},\"sandbox_mode\":{},\"network_access\":true}},\"tmux_session\":{},\"worker_count\":{},\"workers\":[{}],\"next_task_id\":{},\"created_at\":{},\"leader_cwd\":{},\"team_state_root\":{},\"workspace_mode\":\"single\",\"leader_pane_id\":null,\"hud_pane_id\":null,\"resize_hook_name\":null,\"resize_hook_target\":null,\"next_worker_index\":{}}}
",
        json_string(team_name),
        json_string(start_task),
        json_string(&format!("native-runtime-{team_name}")),
        json_string(&leader_worker),
        json_string(&env::var("CODEX_APPROVAL_MODE").unwrap_or_else(|_| "never".to_string())),
        json_string(&env::var("CODEX_SANDBOX_MODE").unwrap_or_else(|_| "danger-full-access".to_string())),
        json_string(&format!("omx-team-{team_name}")),
        input.worker_count,
        worker_json,
        input.tasks.len() + 1,
        json_string(created_at),
        json_string(&input.cwd),
        json_string(&team_state_root_str),
        input.worker_count + 1,
    );
    write(team_root.join("manifest.v2.json"), manifest)
        .map_err(|err| format!("failed writing team manifest: {err}"))?;

    Ok(())
}

fn finalize_team_state(
    team_name: &str,
    start_task: &str,
    input: &RuntimeRunInput,
    worker_clis: &[WorkerCli],
    team_state_root: &PathBuf,
    created_at: &str,
    session: &TeamSessionStart,
) -> Result<(), String> {
    let team_root = team_state_root.join("team").join(team_name);
    let workers_json = session
        .worker_pane_ids
        .iter()
        .enumerate()
        .map(|(index, pane_id)| {
            let worker_name = format!("worker-{}", index + 1);
            let pid = get_pane_pid(pane_id).unwrap_or(0);
            let identity = format!(
                "{{\"name\":{},\"index\":{},\"role\":\"executor\",\"worker_cli\":{},\"assigned_tasks\":[],\"pid\":{},\"pane_id\":{},\"working_dir\":{},\"team_state_root\":{}}}
",
                json_string(&worker_name),
                index + 1,
                json_string(worker_clis[index].as_str()),
                pid,
                json_string(pane_id),
                json_string(&input.cwd),
                json_string(&team_state_root.to_string_lossy()),
            );
            let worker_dir = team_root.join("workers").join(&worker_name);
            let _ = write(worker_dir.join("identity.json"), &identity);
            format!(
                "{{\"name\":{},\"index\":{},\"role\":\"executor\",\"worker_cli\":{},\"assigned_tasks\":[],\"pid\":{},\"pane_id\":{},\"working_dir\":{},\"team_state_root\":{}}}",
                json_string(&worker_name),
                index + 1,
                json_string(worker_clis[index].as_str()),
                pid,
                json_string(pane_id),
                json_string(&input.cwd),
                json_string(&team_state_root.to_string_lossy()),
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    let base_tmux_session = session
        .team_target
        .split(':')
        .next()
        .unwrap_or(&session.team_target)
        .to_string();
    let leader_worker = env::var("OMX_TEAM_WORKER").unwrap_or_else(|_| "leader-fixed".to_string());

    let config = format!(
        "{{\"name\":{},\"task\":{},\"agent_type\":\"executor\",\"worker_launch_mode\":\"interactive\",\"lifecycle_profile\":\"default\",\"worker_count\":{},\"max_workers\":20,\"workers\":[{}],\"created_at\":{},\"tmux_session\":{},\"next_task_id\":{},\"leader_cwd\":{},\"team_state_root\":{},\"workspace_mode\":\"single\",\"leader_pane_id\":{},\"hud_pane_id\":null,\"resize_hook_name\":null,\"resize_hook_target\":null,\"next_worker_index\":{}}}
",
        json_string(team_name),
        json_string(start_task),
        input.worker_count,
        workers_json,
        json_string(created_at),
        json_string(&base_tmux_session),
        input.tasks.len() + 1,
        json_string(&input.cwd),
        json_string(&team_state_root.to_string_lossy()),
        json_string(&session.leader_pane_id),
        input.worker_count + 1,
    );
    write(team_root.join("config.json"), config)
        .map_err(|err| format!("failed updating team config: {err}"))?;

    let manifest = format!(
        "{{\"schema_version\":2,\"name\":{},\"task\":{},\"leader\":{{\"session_id\":{},\"worker_id\":{},\"role\":\"leader\"}},\"policy\":{{\"display_mode\":\"split_pane\",\"worker_launch_mode\":\"interactive\",\"dispatch_mode\":\"hook_preferred_with_fallback\",\"dispatch_ack_timeout_ms\":2000}},\"governance\":{{\"delegation_only\":false,\"plan_approval_required\":false,\"nested_teams_allowed\":false,\"one_team_per_leader_session\":true,\"cleanup_requires_all_workers_inactive\":true}},\"lifecycle_profile\":\"default\",\"permissions_snapshot\":{{\"approval_mode\":{},\"sandbox_mode\":{},\"network_access\":true}},\"tmux_session\":{},\"worker_count\":{},\"workers\":[{}],\"next_task_id\":{},\"created_at\":{},\"leader_cwd\":{},\"team_state_root\":{},\"workspace_mode\":\"single\",\"leader_pane_id\":{},\"hud_pane_id\":null,\"resize_hook_name\":null,\"resize_hook_target\":null,\"next_worker_index\":{}}}
",
        json_string(team_name),
        json_string(start_task),
        json_string(&format!("native-runtime-{team_name}")),
        json_string(&leader_worker),
        json_string(&env::var("CODEX_APPROVAL_MODE").unwrap_or_else(|_| "never".to_string())),
        json_string(&env::var("CODEX_SANDBOX_MODE").unwrap_or_else(|_| "danger-full-access".to_string())),
        json_string(&base_tmux_session),
        input.worker_count,
        workers_json,
        input.tasks.len() + 1,
        json_string(created_at),
        json_string(&input.cwd),
        json_string(&team_state_root.to_string_lossy()),
        json_string(&session.leader_pane_id),
        input.worker_count + 1,
    );
    write(team_root.join("manifest.v2.json"), manifest)
        .map_err(|err| format!("failed updating team manifest: {err}"))?;

    Ok(())
}

fn generate_worker_inbox(
    team_name: &str,
    worker_name: &str,
    input: &RuntimeRunInput,
    worker_cli: WorkerCli,
) -> String {
    let task_list = input
        .tasks
        .iter()
        .enumerate()
        .map(|(index, task)| {
            format!(
                "- **Task {}**: {}
  Description: {}
  Status: pending",
                index + 1,
                task.subject,
                task.description,
            )
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        );

    format!(
        r#"# Worker Assignment: {worker_name}

**Team:** {team_name}
**Role:** executor
**Worker Name:** {worker_name}
**CLI:** {worker_cli}

## Available Team Tasks

{task_list}

## Instructions

1. Read this inbox first, then read the first ready task from .omx/state/team/{team_name}/tasks/task-<id>.json.
2. Send startup ACK to the lead mailbox before task work:
   omx team api send-message --input "{{"team_name":"{team_name}","from_worker":"{worker_name}","to_worker":"leader-fixed","body":"ACK: {worker_name} initialized"}}" --json
3. Claim the first non-blocked task via omx team api claim-task, complete it, and report concrete progress back to leader-fixed.
4. When notified, read mailbox messages with omx team api mailbox-list and mark them delivered.
5. Continue assigned work or the next feasible task until the lead says stop.
"#,
        worker_name = worker_name,
        team_name = team_name,
        worker_cli = worker_cli.as_str(),
        task_list = task_list,
    )
}

fn ensure_tmux_available() -> Result<(), String> {
    let output = Command::new("tmux")
        .arg("-V")
        .output()
        .map_err(|err| format!("failed to launch tmux: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("tmux is not available".to_string())
    }
}

fn ensure_inside_tmux() -> Result<(), String> {
    if env::var("TMUX")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err("team mode requires running inside tmux leader pane".to_string())
    }
}

fn create_team_session(
    team_name: &str,
    input: &RuntimeRunInput,
    worker_clis: &[WorkerCli],
    team_state_root: &PathBuf,
) -> Result<TeamSessionStart, String> {
    let tmux_pane_target = env::var("TMUX_PANE").ok();
    let mut args = vec!["display-message".to_string(), "-p".to_string()];
    if let Some(target) = tmux_pane_target
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        args.push("-t".to_string());
        args.push(target.clone());
    }
    args.push("#S:#I #{pane_id}".to_string());
    let context = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|err| format!("failed to detect current tmux target: {err}"))?;
    if !context.status.success() {
        return Err(String::from_utf8_lossy(&context.stderr).trim().to_string());
    }
    let context_stdout = String::from_utf8_lossy(&context.stdout).trim().to_string();
    let mut context_parts = context_stdout.split_whitespace();
    let session_and_window = context_parts.next().unwrap_or_default();
    let leader_pane_id = context_parts.next().unwrap_or_default().to_string();
    let mut sw_parts = session_and_window.split(':');
    let session_name = sw_parts.next().unwrap_or_default();
    let window_index = sw_parts.next().unwrap_or_default();
    if session_name.is_empty() || window_index.is_empty() || !leader_pane_id.starts_with('%') {
        return Err(format!(
            "failed to parse current tmux target: {context_stdout}"
        ));
    }
    let team_target = format!("{session_name}:{window_index}");

    let mut worker_pane_ids = Vec::new();
    let mut rollback_pane_ids: Vec<String> = Vec::new();
    let mut right_stack_root: Option<String> = None;

    for (index, worker_cli) in worker_clis.iter().enumerate() {
        let split_direction = if index == 0 { "-h" } else { "-v" };
        let split_target = right_stack_root.as_deref().unwrap_or(&leader_pane_id);
        let command =
            build_worker_start_command(team_name, index + 1, *worker_cli, input, team_state_root);
        let output = Command::new("tmux")
            .args([
                "split-window",
                split_direction,
                "-t",
                split_target,
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-c",
                &input.cwd,
                &command,
            ])
            .output()
            .map_err(|err| format!("failed to create worker pane {}: {err}", index + 1))?;
        if !output.status.success() {
            for pane_id in rollback_pane_ids.iter() {
                let _ = kill_tmux_pane(pane_id);
            }
            return Err(format!(
                "failed to create worker pane {}: {}",
                index + 1,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let pane_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !pane_id.starts_with('%') {
            for pane_id in rollback_pane_ids.iter() {
                let _ = kill_tmux_pane(pane_id);
            }
            return Err(format!(
                "failed to capture worker pane id for worker {}",
                index + 1
            ));
        }
        if index == 0 {
            right_stack_root = Some(pane_id.clone());
        }
        rollback_pane_ids.push(pane_id.clone());
        worker_pane_ids.push(pane_id);
    }

    let _ = Command::new("tmux")
        .args(["select-layout", "-t", &team_target, "main-vertical"])
        .output();
    let _ = Command::new("tmux")
        .args(["select-pane", "-t", &leader_pane_id])
        .output();
    sleep(Duration::from_millis(500));

    Ok(TeamSessionStart {
        team_target,
        leader_pane_id,
        worker_pane_ids,
    })
}

fn resolve_worker_command(worker_cli: WorkerCli) -> String {
    match worker_cli {
        WorkerCli::Codex => env::var("OMX_LEADER_CLI_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_string()),
        _ => worker_cli.as_str().to_string(),
    }
}

fn build_worker_start_command(
    team_name: &str,
    worker_index: usize,
    worker_cli: WorkerCli,
    input: &RuntimeRunInput,
    team_state_root: &PathBuf,
) -> String {
    let shell = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let rc_prefix = if shell.ends_with("zsh") {
        "if [ -f ~/.zshrc ]; then source ~/.zshrc; fi; "
    } else if shell.ends_with("bash") {
        "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; "
    } else {
        ""
    };
    let worker_name = format!("worker-{worker_index}");
    let cli_command = shell_quote_single(&resolve_worker_command(worker_cli));
    let launch_args = env::var("OMX_TEAM_WORKER_LAUNCH_ARGS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" {value}"))
        .unwrap_or_default();
    let inner = format!(
        "{rc_prefix}exec {cli_command}{launch_args}",
        rc_prefix = rc_prefix,
        cli_command = cli_command,
        launch_args = launch_args,
    );
    let env_parts = vec![
        format!(
            "OMX_TEAM_WORKER={}",
            shell_quote_single(&format!("{team_name}/{worker_name}"))
        ),
        format!(
            "OMX_TEAM_STATE_ROOT={}",
            shell_quote_single(&team_state_root.to_string_lossy())
        ),
        format!("OMX_TEAM_LEADER_CWD={}", shell_quote_single(&input.cwd)),
        format!(
            "OMX_TEAM_WORKER_CLI={}",
            shell_quote_single(worker_cli.as_str())
        ),
    ];
    format!(
        "env {} {} -lc {}",
        env_parts.join(" "),
        shell_quote_single(&shell),
        shell_quote_single(&inner),
    )
}

fn shell_quote_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn get_pane_pid(pane_id: &str) -> Option<u64> {
    let output = Command::new("tmux")
        .args(["list-panes", "-t", pane_id, "-F", "#{pane_pid}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn send_worker_bootstrap_prompts(
    team_name: &str,
    input: &RuntimeRunInput,
    worker_pane_ids: &[String],
) -> Result<(), String> {
    sleep(Duration::from_millis(1500));
    for (index, pane_id) in worker_pane_ids.iter().enumerate() {
        let worker_name = format!("worker-{}", index + 1);
        let prompt = format!(
            "Read .omx/state/team/{team_name}/workers/{worker_name}/inbox.md, start work now, report concrete progress, then continue assigned work or next feasible task."
        );
        crate::tmux::send_to_pane(pane_id, &prompt, true)?;
    }
    let _ = input;
    Ok(())
}

fn iso_timestamp() -> String {
    let output = Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    "1970-01-01T00:00:00Z".to_string()
}

fn monitor_team(input: &RuntimeRunInput) -> Result<Option<RuntimeMonitorSnapshot>, String> {
    let team_dir = team_dir(&input.team_name, &input.cwd);
    if !team_dir.exists() {
        return Ok(None);
    }

    let task_statuses = list_task_statuses(&input.team_name, &input.cwd);
    let pending = task_statuses
        .iter()
        .filter(|status| status.as_str() == "pending")
        .count();
    let blocked = task_statuses
        .iter()
        .filter(|status| status.as_str() == "blocked")
        .count();
    let in_progress = task_statuses
        .iter()
        .filter(|status| status.as_str() == "in_progress")
        .count();
    let completed = task_statuses
        .iter()
        .filter(|status| status.as_str() == "completed")
        .count();
    let failed = task_statuses
        .iter()
        .filter(|status| status.as_str() == "failed")
        .count();

    let worker_infos = list_worker_infos(&input.team_name, &input.cwd);
    let dead_workers = worker_infos
        .iter()
        .filter(|worker| !worker.alive)
        .map(|worker| worker.name.clone())
        .collect::<Vec<_>>();

    let all_tasks_terminal = pending == 0 && blocked == 0 && in_progress == 0;
    let dead_worker_stall =
        !worker_infos.is_empty() && dead_workers.len() >= worker_infos.len() && !all_tasks_terminal;

    let phase = if dead_worker_stall {
        "failed".to_string()
    } else if all_tasks_terminal && failed == 0 {
        "complete".to_string()
    } else if all_tasks_terminal && failed > 0 {
        "team-fix".to_string()
    } else {
        "team-exec".to_string()
    };

    write_phase_state(&input.team_name, &input.cwd, &phase, failed == 0)?;

    Ok(Some(RuntimeMonitorSnapshot {
        phase,
        pending,
        in_progress,
        completed,
        failed,
        dead_workers,
        monitor_ms: 0,
    }))
}

fn shutdown_and_emit_result(
    input: &RuntimeRunInput,
    status: &str,
    duration_seconds: f64,
) -> Result<(), String> {
    let ralph = read_linked_ralph_profile(&input.team_name, &input.cwd);
    let force = status != "completed";
    match shutdown_team(&input.team_name, &input.cwd, force, ralph) {
        Ok(()) => {}
        Err(error)
            if !force
                && (error.contains("shutdown_gate_blocked")
                    || error.contains("shutdown_rejected")) =>
        {
            shutdown_team(&input.team_name, &input.cwd, true, ralph)?;
        }
        Err(error) => {
            eprintln!("[runtime-run] shutdownTeam error: {error}");
        }
    }

    let task_results = collect_task_results(input);
    print!(
        "{{\"status\":{},\"teamName\":{},\"taskResults\":{},\"duration\":{},\"workerCount\":{}}}\n",
        json_string(status),
        json_string(&input.team_name),
        json_task_results(&task_results),
        duration_seconds,
        input.worker_count,
    );
    Ok(())
}

fn shutdown_team(team_name: &str, cwd: &str, force: bool, ralph: bool) -> Result<(), String> {
    let statuses = list_task_statuses(team_name, cwd);
    let pending = statuses
        .iter()
        .filter(|status| status.as_str() == "pending")
        .count();
    let blocked = statuses
        .iter()
        .filter(|status| status.as_str() == "blocked")
        .count();
    let in_progress = statuses
        .iter()
        .filter(|status| status.as_str() == "in_progress")
        .count();
    let failed = statuses
        .iter()
        .filter(|status| status.as_str() == "failed")
        .count();

    if !force {
        let has_active_work = pending > 0 || blocked > 0 || in_progress > 0;
        if has_active_work || (failed > 0 && !ralph) {
            return Err(format!(
                "shutdown_gate_blocked:pending={pending},blocked={blocked},in_progress={in_progress},failed={failed}"
            ));
        }
    }

    let config_path = team_dir(team_name, cwd).join("config.json");
    if let Ok(raw) = read_to_string(&config_path) {
        for pane_id in extract_object_string_values(&raw, "pane_id") {
            let _ = kill_tmux_pane(&pane_id);
        }
        if let Some(hud_pane_id) = extract_json_string(&raw, "hud_pane_id") {
            let _ = kill_tmux_pane(&hud_pane_id);
        }
        if let Some(hook_target) = extract_json_string(&raw, "resize_hook_target") {
            if let Some(hook_name) = extract_json_string(&raw, "resize_hook_name") {
                let _ = unregister_resize_hook(&hook_target, &hook_name);
            }
        }
    }

    let team_root = team_dir(team_name, cwd);
    if team_root.exists() {
        remove_dir_all(&team_root).map_err(|err| format!("cleanupTeamState failed: {err}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkerMonitorInfo {
    name: String,
    alive: bool,
}

fn team_dir(team_name: &str, cwd: &str) -> PathBuf {
    PathBuf::from(cwd)
        .join(".omx")
        .join("state")
        .join("team")
        .join(team_name)
}

fn list_task_statuses(team_name: &str, cwd: &str) -> Vec<String> {
    let tasks_dir = team_dir(team_name, cwd).join("tasks");
    let Ok(entries) = read_dir(tasks_dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| read_to_string(entry.path()).ok())
        .filter_map(|raw| extract_json_string(&raw, "status"))
        .collect()
}

fn list_worker_infos(team_name: &str, cwd: &str) -> Vec<WorkerMonitorInfo> {
    let workers_dir = team_dir(team_name, cwd).join("workers");
    let Ok(entries) = read_dir(workers_dir) else {
        return Vec::new();
    };

    let mut workers = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
        else {
            continue;
        };
        let identity_raw = read_to_string(path.join("identity.json")).unwrap_or_default();
        let pane_id = extract_json_string(&identity_raw, "pane_id");
        let pid = extract_json_number(&identity_raw, "pid");
        let alive = if let Some(pane_id) = pane_id {
            is_tmux_pane_alive(&pane_id)
        } else if let Some(pid) = pid {
            is_pid_alive(pid as i32)
        } else {
            false
        };
        workers.push(WorkerMonitorInfo { name, alive });
    }
    workers
}

fn write_phase_state(
    team_name: &str,
    cwd: &str,
    phase: &str,
    no_failed_tasks: bool,
) -> Result<(), String> {
    let phase_path = team_dir(team_name, cwd).join("phase.json");
    let current_fix_attempt = if phase == "team-fix" { 1 } else { 0 };
    let max_fix_attempts = if no_failed_tasks { 3 } else { 3 };
    write(
        phase_path,
        format!(
            "{{\"current_phase\":{},\"max_fix_attempts\":{},\"current_fix_attempt\":{},\"transitions\":[],\"updated_at\":{}}}\n",
            json_string(phase),
            max_fix_attempts,
            current_fix_attempt,
            json_string("native-runtime"),
        ),
    )
    .map_err(|err| format!("failed writing phase state: {err}"))
}

fn is_tmux_pane_alive(pane_id: &str) -> bool {
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-t",
            pane_id,
            "-F",
            "#{pane_dead} #{pane_pid}",
        ])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let mut parts = line.split_whitespace();
    let pane_dead = parts.next().unwrap_or_default();
    let pid = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    pane_dead != "1" && pid > 0 && is_pid_alive(pid)
}

fn is_pid_alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn kill_tmux_pane(pane_id: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-pane", "-t", pane_id])
        .output()
        .map_err(|err| format!("failed to launch tmux: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn unregister_resize_hook(hook_target: &str, hook_name: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["set-hook", "-u", "-t", hook_target, hook_name])
        .output()
        .map_err(|err| format!("failed to launch tmux: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn read_live_pane_state(input: &RuntimeRunInput) -> Option<(Vec<String>, String)> {
    let config_path = PathBuf::from(&input.cwd)
        .join(".omx")
        .join("state")
        .join("team")
        .join(&input.team_name)
        .join("config.json");
    let raw = read_to_string(config_path).ok()?;
    Some((
        extract_object_string_values(&raw, "pane_id"),
        extract_json_string(&raw, "leader_pane_id").unwrap_or_default(),
    ))
}

fn read_linked_ralph_profile(team_name: &str, cwd: &str) -> bool {
    let config_path = PathBuf::from(cwd)
        .join(".omx")
        .join("state")
        .join("team")
        .join(team_name)
        .join("config.json");
    read_to_string(config_path)
        .ok()
        .and_then(|raw| extract_json_string(&raw, "lifecycle_profile"))
        .map(|profile| profile == "linked_ralph")
        .unwrap_or(false)
}

fn collect_task_results(input: &RuntimeRunInput) -> Vec<TaskResult> {
    let tasks_dir = PathBuf::from(&input.cwd)
        .join(".omx")
        .join("state")
        .join("team")
        .join(&input.team_name)
        .join("tasks");
    let Ok(entries) = read_dir(tasks_dir) else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(&OsString::from("json")) {
            continue;
        }
        let Ok(raw) = read_to_string(&path) else {
            continue;
        };
        let task_id = extract_json_string(&raw, "id")
            .or_else(|| {
                path.file_stem()
                    .map(|stem| stem.to_string_lossy().replace("task-", ""))
            })
            .unwrap_or_default();
        let status = extract_json_string(&raw, "status").unwrap_or_else(|| "unknown".to_string());
        let summary = extract_json_string(&raw, "result")
            .or_else(|| extract_json_string(&raw, "summary"))
            .unwrap_or_default();
        results.push(TaskResult {
            task_id,
            status,
            summary,
        });
    }
    results.sort_by(|left, right| left.task_id.cmp(&right.task_id));
    results
}

fn detect_dead_worker_failure(
    dead_worker_count: usize,
    live_worker_pane_count: usize,
    has_outstanding_work: bool,
    phase: &str,
) -> (bool, bool) {
    let all_workers_dead =
        live_worker_pane_count > 0 && dead_worker_count >= live_worker_pane_count;
    (
        all_workers_dead && has_outstanding_work,
        phase == "team-fix" && all_workers_dead,
    )
}

fn write_panes_sidecar_placeholder() -> Result<(), String> {
    let Some(job_id) = env::var("OMX_JOB_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    let Some(jobs_dir) = env::var("OMX_JOBS_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };

    let jobs_path = PathBuf::from(jobs_dir);
    create_dir_all(&jobs_path).map_err(|err| format!("failed creating OMX_JOBS_DIR: {err}"))?;
    let panes_path = jobs_path.join(format!("{job_id}-panes.json"));
    if panes_path.exists() {
        return Ok(());
    }
    write(&panes_path, "{\"paneIds\":[],\"leaderPaneId\":\"\"}\n")
        .map_err(|err| format!("failed writing panes sidecar: {err}"))
}

fn write_panes_sidecar(pane_ids: &[String], leader_pane_id: &str) -> Result<(), String> {
    let Some(job_id) = env::var("OMX_JOB_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    let Some(jobs_dir) = env::var("OMX_JOBS_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };

    let jobs_path = PathBuf::from(jobs_dir);
    create_dir_all(&jobs_path).map_err(|err| format!("failed creating OMX_JOBS_DIR: {err}"))?;
    let panes_path = jobs_path.join(format!("{job_id}-panes.json"));
    write(
        panes_path,
        format!(
            "{{\"paneIds\":{},\"leaderPaneId\":{}}}\n",
            json_string_array(pane_ids),
            json_string(leader_pane_id),
        ),
    )
    .map_err(|err| format!("failed writing panes sidecar: {err}"))
}

fn read_runtime_input_raw() -> Result<String, String> {
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .map_err(|err| format!("failed reading runtime-run stdin: {err}"))?;
    Ok(raw)
}

pub fn parse_runtime_input(raw: &str) -> Result<RuntimeRunInput, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("runtime-run requires JSON stdin".to_string());
    }

    let team_name = sanitize_team_name(
        &extract_json_string(trimmed, "teamName")
            .ok_or_else(|| "runtime-run missing teamName".to_string())?,
    )?;
    let cwd =
        extract_json_string(trimmed, "cwd").ok_or_else(|| "runtime-run missing cwd".to_string())?;
    let agent_types = extract_string_array(trimmed, "agentTypes");
    if agent_types.is_empty() {
        return Err("runtime-run missing agentTypes".to_string());
    }
    let tasks = extract_tasks(trimmed);
    if tasks.is_empty() {
        return Err("runtime-run missing tasks".to_string());
    }
    let worker_count = extract_json_number(trimmed, "workerCount")
        .map(|value| value as usize)
        .unwrap_or(agent_types.len());
    let poll_interval_ms = extract_json_number(trimmed, "pollIntervalMs").unwrap_or(5_000);

    Ok(RuntimeRunInput {
        team_name,
        agent_types,
        tasks,
        cwd,
        worker_count,
        poll_interval_ms,
    })
}

fn json_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

fn json_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| json_string(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn json_task_array(values: &[RuntimeTaskInput]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| format!(
                "{{\"subject\":{},\"description\":{}}}",
                json_string(&value.subject),
                json_string(&value.description),
            ))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn json_task_results(values: &[TaskResult]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| format!(
                "{{\"taskId\":{},\"status\":{},\"summary\":{}}}",
                json_string(&value.task_id),
                json_string(&value.status),
                json_string(&value.summary),
            ))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_index = raw.find(&needle)?;
    let after_key = &raw[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let value_start = after_key[colon_index + 1..].trim_start();
    if value_start.starts_with("null") {
        return None;
    }
    if !value_start.starts_with('"') {
        return None;
    }

    let mut escaped = false;
    let mut value = String::new();
    for ch in value_start[1..].chars() {
        if escaped {
            value.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }
    None
}

fn extract_json_number(raw: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let key_index = raw.find(&needle)?;
    let after_key = &raw[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let value_start = after_key[colon_index + 1..].trim_start();
    let digits: String = value_start
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok()
}

fn extract_string_array(raw: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let Some(key_index) = raw.find(&needle) else {
        return Vec::new();
    };
    let after_key = &raw[key_index + needle.len()..];
    let Some(colon_index) = after_key.find(':') else {
        return Vec::new();
    };
    let value_start = after_key[colon_index + 1..].trim_start();
    let Some(array_body) = slice_array_body(value_start) else {
        return Vec::new();
    };

    split_json_array_entries(array_body)
        .into_iter()
        .filter_map(|entry| {
            let trimmed = entry.trim();
            if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
                Some(trimmed[1..trimmed.len() - 1].to_string())
            } else {
                None
            }
        })
        .collect()
}

fn extract_object_string_values(raw: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let mut values = Vec::new();
    let mut slice = raw;
    while let Some(index) = slice.find(&needle) {
        let after = &slice[index..];
        if let Some(value) = extract_json_string(after, key) {
            if !value.trim().is_empty() {
                values.push(value);
            }
        }
        slice = &after[needle.len()..];
    }
    values
}

fn extract_tasks(raw: &str) -> Vec<RuntimeTaskInput> {
    let needle = "\"tasks\"";
    let Some(key_index) = raw.find(needle) else {
        return Vec::new();
    };
    let after_key = &raw[key_index + needle.len()..];
    let Some(colon_index) = after_key.find(':') else {
        return Vec::new();
    };
    let value_start = after_key[colon_index + 1..].trim_start();
    let Some(array_body) = slice_array_body(value_start) else {
        return Vec::new();
    };

    let mut tasks = Vec::new();
    for object in split_json_array_entries(array_body) {
        let normalized = object.trim().trim_start_matches('{').trim_end_matches('}');
        let subject = extract_json_string(normalized, "subject");
        let description = extract_json_string(normalized, "description");
        if let (Some(subject), Some(description)) = (subject, description) {
            tasks.push(RuntimeTaskInput {
                subject,
                description,
            });
        }
    }
    tasks
}

fn split_json_array_entries(body: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut start = 0_usize;

    for (index, ch) in body.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                entries.push(body[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }

    if start < body.len() {
        entries.push(body[start..].trim());
    }
    entries
        .into_iter()
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn slice_array_body(value_start: &str) -> Option<&str> {
    if !value_start.starts_with('[') {
        return None;
    }

    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in value_start.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&value_start[1..index]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        collect_task_results, detect_dead_worker_failure, extract_string_array,
        parse_runtime_input, read_linked_ralph_profile, split_json_array_entries,
        write_panes_sidecar_placeholder, RuntimeRunInput, RuntimeTaskInput,
    };
    use crate::test_support::env_lock;
    use std::env;
    use std::fs::{create_dir_all, read_to_string, write};
    use std::path::PathBuf;

    #[test]
    fn parses_minimal_runtime_run_input() {
        let parsed = parse_runtime_input(
            r#"{"teamName":"alpha","agentTypes":["codex"],"tasks":[{"subject":"one","description":"desc"}],"cwd":"/tmp/repo"}"#,
        )
        .expect("expected runtime-run input to parse");

        assert_eq!(parsed.team_name, "alpha");
        assert_eq!(parsed.agent_types, vec!["codex".to_string()]);
        assert_eq!(parsed.tasks.len(), 1);
        assert_eq!(parsed.cwd, "/tmp/repo");
        assert_eq!(parsed.worker_count, 1);
        assert_eq!(parsed.poll_interval_ms, 5_000);
    }

    #[test]
    fn rejects_missing_team_name() {
        let error = parse_runtime_input(
            r#"{"agentTypes":["codex"],"tasks":[{"subject":"one","description":"desc"}],"cwd":"/tmp/repo"}"#,
        )
        .expect_err("expected missing teamName error");
        assert!(error.contains("teamName"));
    }

    #[test]
    fn supports_commas_inside_task_descriptions() {
        let parsed = parse_runtime_input(
            r#"{"teamName":"alpha","agentTypes":["codex"],"tasks":[{"subject":"one","description":"desc, with comma"},{"subject":"two","description":"next"}],"cwd":"/tmp/repo"}"#,
        )
        .expect("expected parse");
        assert_eq!(parsed.tasks.len(), 2);
        assert_eq!(parsed.tasks[0].description, "desc, with comma");
    }

    #[test]
    fn split_json_array_entries_handles_nested_objects() {
        let entries = split_json_array_entries(
            r#"{"subject":"one","description":"a,b"},{"subject":"two","description":"c"}"#,
        );
        assert_eq!(entries.len(), 2);
        assert!(entries[0].contains("a,b"));
    }

    #[test]
    fn detects_dead_worker_failure_from_live_pane_count() {
        let stale_snapshot_behavior = detect_dead_worker_failure(2, 3, true, "team-exec");
        assert_eq!(stale_snapshot_behavior.0, false);

        let live_behavior = detect_dead_worker_failure(2, 2, true, "team-exec");
        assert_eq!(live_behavior.0, true);
        assert_eq!(live_behavior.1, false);
    }

    #[test]
    fn reads_linked_ralph_profile_from_team_config() {
        let temp =
            std::env::temp_dir().join(format!("omx-runtime-run-linked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let config_dir = temp.join(".omx").join("state").join("team").join("alpha");
        create_dir_all(&config_dir).expect("expected config dir");
        write(
            config_dir.join("config.json"),
            r#"{"lifecycle_profile":"linked_ralph"}"#,
        )
        .expect("expected config");

        assert!(read_linked_ralph_profile(
            "alpha",
            temp.to_string_lossy().as_ref()
        ));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn collects_task_results_from_state_files() {
        let temp =
            std::env::temp_dir().join(format!("omx-runtime-run-tasks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let tasks_dir = temp
            .join(".omx")
            .join("state")
            .join("team")
            .join("alpha")
            .join("tasks");
        create_dir_all(&tasks_dir).expect("expected task dir");
        write(
            tasks_dir.join("task-1.json"),
            r#"{"id":"1","status":"completed","result":"done"}"#,
        )
        .expect("expected task file");

        let results = collect_task_results(&RuntimeRunInput {
            team_name: "alpha".into(),
            agent_types: vec!["codex".into()],
            tasks: vec![RuntimeTaskInput {
                subject: "one".into(),
                description: "desc".into(),
            }],
            cwd: temp.to_string_lossy().into_owned(),
            worker_count: 1,
            poll_interval_ms: 100,
        });
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].task_id, "1");
        assert_eq!(results[0].summary, "done");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn extracts_string_arrays_with_multiple_entries() {
        let values = extract_string_array(r#"{"paneIds":["%1","%2"]}"#, "paneIds");
        assert_eq!(values, vec!["%1".to_string(), "%2".to_string()]);
    }

    #[test]
    fn writes_panes_sidecar_placeholder_when_job_env_is_present() {
        let _guard = env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let temp = std::env::temp_dir().join(format!("omx-runtime-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        unsafe { env::set_var("OMX_JOB_ID", "job-1") };
        unsafe { env::set_var("OMX_JOBS_DIR", &temp) };

        write_panes_sidecar_placeholder().expect("expected panes sidecar write");

        let content = read_to_string(PathBuf::from(&temp).join("job-1-panes.json"))
            .expect("expected panes file content");
        assert!(content.contains("\"paneIds\":[]"));
        assert!(content.contains("\"leaderPaneId\":\"\""));

        unsafe { env::remove_var("OMX_JOB_ID") };
        unsafe { env::remove_var("OMX_JOBS_DIR") };
        let _ = std::fs::remove_dir_all(&temp);
    }
}
