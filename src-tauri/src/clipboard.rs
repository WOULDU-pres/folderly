use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const SHARED_CLIPBOARD_EVENT: &str = "app://shared-clipboard-updated";
const SECONDARY_WINDOW_LABEL: &str = "secondary";
static SECONDARY_WINDOW_OPENING: AtomicBool = AtomicBool::new(false);

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
    if let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(SECONDARY_WINDOW_LABEL.to_string());
    }

    if !SECONDARY_WINDOW_OPENING
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_ok()
    {
        return Ok(SECONDARY_WINDOW_LABEL.to_string());
    }

    let build = WebviewWindowBuilder::new(&app, SECONDARY_WINDOW_LABEL, WebviewUrl::default())
        .title("Windows PDF Directory Explorer (Window 2)")
        .inner_size(1480.0, 860.0)
        .min_inner_size(1160.0, 640.0)
        .resizable(true)
        .build();

    SECONDARY_WINDOW_OPENING.store(false, Ordering::Release);

    match build {
        Ok(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            Ok(SECONDARY_WINDOW_LABEL.to_string())
        }
        Err(err) => {
            if let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                Ok(SECONDARY_WINDOW_LABEL.to_string())
            } else {
                Err(format!("failed opening second window: {err}"))
            }
        }
    }
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
