use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::models::SharedClipboardState;

const SHARED_CLIPBOARD_EVENT: &str = "shared-clipboard-changed";
const SECONDARY_WINDOW_LABEL: &str = "secondary";

pub struct AppSharedClipboard(pub Mutex<Option<SharedClipboardState>>);

impl Default for AppSharedClipboard {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn normalize_clipboard_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            normalized.push(trimmed.to_string());
        }
    }

    normalized
}

#[tauri::command]
pub fn get_shared_clipboard(
    clipboard: State<'_, AppSharedClipboard>,
) -> Result<Option<SharedClipboardState>, String> {
    let guard = clipboard
        .0
        .lock()
        .map_err(|_| "failed to access shared clipboard state".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn set_shared_clipboard(
    app: AppHandle,
    clipboard: State<'_, AppSharedClipboard>,
    mode: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let normalized_mode = mode.trim().to_ascii_lowercase();
    if normalized_mode != "copy" && normalized_mode != "cut" {
        return Err("clipboard mode must be either 'copy' or 'cut'".to_string());
    }

    let normalized_paths = normalize_clipboard_paths(paths);
    if normalized_paths.is_empty() {
        return Err("clipboard paths must not be empty".to_string());
    }

    let next_state = SharedClipboardState {
        mode: normalized_mode,
        paths: normalized_paths,
    };

    {
        let mut guard = clipboard
            .0
            .lock()
            .map_err(|_| "failed to access shared clipboard state".to_string())?;
        *guard = Some(next_state.clone());
    }

    app.emit(SHARED_CLIPBOARD_EVENT, Some(next_state))
        .map_err(|err| format!("failed to emit clipboard update event: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_shared_clipboard(
    app: AppHandle,
    clipboard: State<'_, AppSharedClipboard>,
) -> Result<(), String> {
    {
        let mut guard = clipboard
            .0
            .lock()
            .map_err(|_| "failed to access shared clipboard state".to_string())?;
        *guard = None;
    }

    app.emit::<Option<SharedClipboardState>>(SHARED_CLIPBOARD_EVENT, None)
        .map_err(|err| format!("failed to emit clipboard clear event: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_secondary_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) {
        window
            .show()
            .map_err(|err| format!("failed showing secondary window: {err}"))?;
        window
            .set_focus()
            .map_err(|err| format!("failed focusing secondary window: {err}"))?;
        return Ok(());
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == SECONDARY_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| "secondary window config not found".to_string())?;

    tauri::WebviewWindowBuilder::from_config(&app, &window_config)
        .map_err(|err| format!("failed creating secondary window builder: {err}"))?
        .build()
        .map_err(|err| format!("failed opening secondary window: {err}"))?;

    if let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) {
        let _ = window.set_focus();
    }

    Ok(())
}
