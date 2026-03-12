use omx_cli::team_layout::{HudModeOverride, sync_prompt_layout_from_state};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;

fn temp_dir(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("omx-team-layout-lines-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn proof_and_runtime_lines_include_no_tmux_and_expected_fields() {
    let cwd = temp_dir("lines");
    let team_root = cwd.join(".omx/state/team/prompty");
    let state_root = cwd.join(".omx/state");
    fs::create_dir_all(&team_root).expect("team root");

    fs::write(
        team_root.join("config.json"),
        r#"{"name":"prompty","worker_launch_mode":"prompt","runtime_session_id":"prompt-prompty","tmux_session":null,"workers":[{"name":"worker-1"}]}"#,
    )
    .expect("config");
    fs::write(
        team_root.join("phase.json"),
        r#"{"current_phase":"team-exec"}"#,
    )
    .expect("phase");

    let env = BTreeMap::from([
        (OsString::from("COLUMNS"), OsString::from("150")),
        (OsString::from("LINES"), OsString::from("40")),
    ]);

    let snapshot = sync_prompt_layout_from_state(
        &team_root,
        &state_root,
        "spawn",
        HudModeOverride::Inline,
        Some(&env),
    )
    .expect("sync")
    .expect("snapshot");

    let proof = snapshot.proof_line();
    assert!(proof.contains("operator:"), "{proof}");
    assert!(proof.contains("no_tmux=true"), "{proof}");
    assert!(proof.contains("viewport=150x40"), "{proof}");

    let runtime = snapshot.runtime_line();
    assert!(runtime.contains("runtime:"), "{runtime}");
    assert!(runtime.contains("session=prompt-prompty"), "{runtime}");
    assert!(runtime.contains("no_tmux=true"), "{runtime}");
    assert!(runtime.contains("hud_mode=inline"), "{runtime}");
}
