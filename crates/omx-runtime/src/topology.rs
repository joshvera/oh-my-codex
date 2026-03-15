const OWNERSHIP_ROWS: [(&str, &str, &str); 6] = [
    (
        "launcher_boundary",
        "omx-runtime",
        "Single native launcher owns runtime/control-plane entrypoints; Node remains install-time only.",
    ),
    (
        "hud_watch_render",
        "omx-runtime hud",
        "Rust owns the guarded hud-watch launch seam; TypeScript still owns full HUD state/render behavior.",
    ),
    (
        "team_supervision",
        "omx-runtime supervisor",
        "Rust owns runtime-run startup plus bounded monitor/shutdown slices, but full lifecycle parity still lives in the TypeScript SSOT.",
    ),
    (
        "pane_observation",
        "omx-runtime tmux",
        "Rust-native tmux pane capture / observation primitives back pane inspection and idle heuristics.",
    ),
    (
        "watcher_loops",
        "omx-runtime supervisor",
        "Reply-listener owns a meaningful native slice, but fallback/derived watcher behavior remains parity-incomplete relative to the TypeScript watcher scripts.",
    ),
    (
        "state_contract",
        ".omx/state",
        "Phase 1 preserves existing state roots where possible; native code is a bounded writer/observer of record without implying complete behavioral cutover.",
    ),
];

pub fn phase1_topology_text() -> String {
    let mut out = String::from("Phase 1 topology: single native launcher (Option A)\n");
    for (surface, owner, note) in OWNERSHIP_ROWS {
        out.push_str(&format!("- {surface}: {owner} — {note}\n"));
    }
    out
}

pub fn phase1_topology_json() -> String {
    let rows = OWNERSHIP_ROWS
        .iter()
        .map(|(surface, owner, note)| {
            format!(
                "{{\"surface\":\"{}\",\"owner\":\"{}\",\"note\":\"{}\"}}",
                escape_json(surface),
                escape_json(owner),
                escape_json(note)
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"decision\":\"single-native-launcher\",\"phase\":\"phase1-control-plane\",\"rows\":[{rows}]}}"
    )
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::{phase1_topology_json, phase1_topology_text};

    #[test]
    fn text_output_mentions_single_native_launcher() {
        assert!(phase1_topology_text().contains("single native launcher"));
    }

    #[test]
    fn json_output_mentions_team_supervision_row() {
        let output = phase1_topology_json();
        assert!(output.contains("\"surface\":\"team_supervision\""));
        assert!(output.contains("\"decision\":\"single-native-launcher\""));
    }

    #[test]
    fn topology_text_uses_bounded_truthful_claims() {
        let output = phase1_topology_text();
        assert!(output.contains("bounded monitor/shutdown slices"));
        assert!(output.contains("TypeScript SSOT"));
        assert!(output.contains("guarded hud-watch launch seam"));
        assert!(output.contains("parity-incomplete"));
        assert!(!output.contains("Rust-native team lifecycle, polling, stale-worker detection, and shutdown ownership."));
        assert!(!output.contains("Fallback watcher, derived watcher, and reply polling loops move behind one native lifecycle owner."));
    }
}
