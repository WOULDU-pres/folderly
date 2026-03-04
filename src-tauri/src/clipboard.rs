use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const SHARED_CLIPBOARD_EVENT: &str = "app://shared-clipboard-updated";
const SECONDARY_WINDOW_LABEL_PREFIX: &str = "secondary-window-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedClipboardPayload {
    pub mode: SharedClipboardMode,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SharedClipboardMode {
    Copy,
    Cut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedClipboardEventPayload {
    clipboard: Option<SharedClipboardPayload>,
}

#[derive(Default)]
pub struct SharedClipboardState(pub Mutex<Option<SharedClipboardPayload>>);

#[tauri::command]
pub fn get_shared_clipboard(
    state: State<'_, SharedClipboardState>,
) -> Result<Option<SharedClipboardPayload>, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "failed acquiring shared clipboard lock".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn set_shared_clipboard(
    app: AppHandle,
    state: State<'_, SharedClipboardState>,
    clipboard: Option<SharedClipboardPayload>,
) -> Result<(), String> {
    set_shared_clipboard_internal(&app, &state, clipboard)
}

#[tauri::command]
pub fn clear_shared_clipboard(
    app: AppHandle,
    state: State<'_, SharedClipboardState>,
) -> Result<(), String> {
    set_shared_clipboard_internal(&app, &state, None)
}

#[tauri::command]
pub async fn open_second_window(app: AppHandle) -> Result<String, String> {
    let next_window_index = next_secondary_window_index(app.webview_windows().keys().map(String::as_str));
    let window_label = secondary_window_label(next_window_index);
    let window_title = format!(
        "Windows PDF Directory Explorer (Window {})",
        next_window_index + 1
    );

    let build = WebviewWindowBuilder::new(&app, window_label.clone(), WebviewUrl::default())
        .title(window_title)
        .inner_size(1480.0, 860.0)
        .min_inner_size(1160.0, 640.0)
        .resizable(true)
        .build();

    match build {
        Ok(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            Ok(window_label)
        }
        Err(err) => Err(format!("failed opening new window: {err}")),
    }
}

fn secondary_window_label(index: usize) -> String {
    format!("{SECONDARY_WINDOW_LABEL_PREFIX}{index}")
}

fn next_secondary_window_index<'a>(labels: impl IntoIterator<Item = &'a str>) -> usize {
    let mut next_index = 1usize;

    for label in labels {
        if label == "secondary" {
            next_index = next_index.max(2);
            continue;
        }

        if let Some(raw_index) = label.strip_prefix(SECONDARY_WINDOW_LABEL_PREFIX) {
            if let Ok(index) = raw_index.parse::<usize>() {
                next_index = next_index.max(index.saturating_add(1));
            }
        }
    }

    next_index
}

fn set_shared_clipboard_internal(
    app: &AppHandle,
    state: &State<'_, SharedClipboardState>,
    clipboard: Option<SharedClipboardPayload>,
) -> Result<(), String> {
    let normalized = normalize_shared_clipboard(clipboard)?;

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "failed acquiring shared clipboard lock".to_string())?;
        *guard = normalized.clone();
    }

    app.emit(
        SHARED_CLIPBOARD_EVENT,
        SharedClipboardEventPayload {
            clipboard: normalized,
        },
    )
    .map_err(|err| format!("failed emitting clipboard event: {err}"))
}

fn normalize_shared_clipboard(
    clipboard: Option<SharedClipboardPayload>,
) -> Result<Option<SharedClipboardPayload>, String> {
    let Some(mut value) = clipboard else {
        return Ok(None);
    };

    let mut deduped = Vec::new();
    for path in value.paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let candidate = trimmed.to_string();
        if !deduped.contains(&candidate) {
            deduped.push(candidate);
        }
    }

    if deduped.is_empty() {
        return Err("clipboard paths must not be empty".to_string());
    }

    value.paths = deduped;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::{next_secondary_window_index, secondary_window_label};

    #[test]
    fn next_secondary_window_index_starts_at_one() {
        let labels = ["main"];
        assert_eq!(next_secondary_window_index(labels), 1);
    }

    #[test]
    fn next_secondary_window_index_advances_without_limit() {
        let labels = [
            "main",
            "secondary",
            "secondary-window-1",
            "secondary-window-2",
            "secondary-window-7",
        ];
        assert_eq!(next_secondary_window_index(labels), 8);
    }

    #[test]
    fn secondary_window_label_uses_numeric_suffix() {
        assert_eq!(secondary_window_label(12), "secondary-window-12");
    }
}
