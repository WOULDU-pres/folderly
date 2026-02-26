use crate::models::{DriveItem, FileItem, FolderItem};
use serde::Serialize;
use std::{
    ffi::OsStr,
    fs::{self, DirEntry, Metadata},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_DIRECTORY_PAGE_SIZE: usize = 200;
const MAX_DIRECTORY_PAGE_SIZE: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPage {
    pub items: Vec<FolderItem>,
    pub offset: usize,
    pub limit: usize,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePage {
    pub items: Vec<FileItem>,
    pub offset: usize,
    pub limit: usize,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub has_more: bool,
}

#[tauri::command]
pub fn get_default_root_path() -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let windows_root = PathBuf::from("C:\\");
        if windows_root.exists() {
            return Ok(windows_root.display().to_string());
        }
    }

    if is_wsl() {
        let wsl_windows_root = PathBuf::from("/mnt/c");
        if wsl_windows_root.exists() {
            return Ok(wsl_windows_root.display().to_string());
        }
    }

    if let Some(home) = dirs::home_dir() {
        return Ok(home.display().to_string());
    }

    Ok("/".to_string())
}

#[tauri::command]
pub fn list_drives() -> Result<Vec<DriveItem>, String> {
    let drives = if cfg!(target_os = "windows") {
        list_windows_drives()
    } else if is_wsl() {
        list_wsl_drives()
    } else {
        vec![DriveItem {
            id: "/".to_string(),
            label: "Root".to_string(),
            path: "/".to_string(),
        }]
    };

    Ok(drives)
}

#[tauri::command]
pub fn get_parent_path(path: String) -> Result<String, String> {
    let current = normalize_existing_directory(&path)?;

    if is_drive_root(&current) {
        return Ok(display_path(&current));
    }

    if let Some(parent) = current.parent() {
        return Ok(display_path(parent));
    }

    Ok(display_path(&current))
}

#[tauri::command]
pub fn list_folders(parent_path: String) -> Result<Vec<FolderItem>, String> {
    let root = normalize_existing_directory(&parent_path)?;

    let mut folders = read_dir_entries(&root)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_dir())
                .map(|metadata| build_folder_metadata(entry, metadata))
        })
        .collect::<Vec<_>>();

    folders.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(folders)
}

#[tauri::command]
pub fn list_files(parent_path: String) -> Result<Vec<FileItem>, String> {
    let root = normalize_existing_directory(&parent_path)?;

    let mut files = read_dir_entries(&root)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| build_file_metadata(entry, metadata))
        })
        .collect::<Vec<_>>();

    files.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(files)
}

#[tauri::command]
pub fn list_folders_paginated(
    parent_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FolderPage, String> {
    let (offset, limit) = normalize_page_options(offset, limit)?;
    let folders = list_folders(parent_path)?;
    let (items, total, next_offset, has_more) = paginate_items(folders, offset, limit);

    Ok(FolderPage {
        items,
        offset,
        limit,
        total,
        next_offset,
        has_more,
    })
}

#[tauri::command]
pub fn list_files_paginated(
    parent_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FilePage, String> {
    let (offset, limit) = normalize_page_options(offset, limit)?;
    let files = list_files(parent_path)?;
    let (items, total, next_offset, has_more) = paginate_items(files, offset, limit);

    Ok(FilePage {
        items,
        offset,
        limit,
        total,
        next_offset,
        has_more,
    })
}

#[tauri::command]
pub fn copy_paths(paths: Vec<String>, destination_dir: String) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    let destination_root = normalize_existing_directory(&destination_dir)?;
    let mut copied_paths = Vec::new();

    for raw_source in paths {
        let source = normalize_existing_path(&raw_source)?;
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("path has no terminal name: {}", display_path(&source)))?
            .to_os_string();
        let destination = unique_destination_path(&destination_root, &file_name);
        ensure_not_descendant_destination(&source, &destination, "copy")?;
        copy_path_recursive(&source, &destination)?;
        copied_paths.push(display_path(&destination));
    }

    Ok(copied_paths)
}

#[tauri::command]
pub fn move_paths(paths: Vec<String>, destination_dir: String) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    let destination_root = normalize_existing_directory(&destination_dir)?;
    let mut moved_paths = Vec::new();

    for raw_source in paths {
        let source = normalize_existing_path(&raw_source)?;
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("path has no terminal name: {}", display_path(&source)))?
            .to_os_string();
        let destination = unique_destination_path(&destination_root, &file_name);
        ensure_not_descendant_destination(&source, &destination, "move")?;

        match fs::rename(&source, &destination) {
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::CrossesDevices => {
                copy_path_recursive(&source, &destination)?;
                remove_path_recursive(&source)?;
            }
            Err(err) => {
                return Err(format!(
                    "failed moving {} to {}: {err}",
                    display_path(&source),
                    display_path(&destination)
                ));
            }
        }

        moved_paths.push(display_path(&destination));
    }

    Ok(moved_paths)
}

#[tauri::command]
pub fn delete_paths(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    for raw_path in paths {
        let path = normalize_existing_path(&raw_path)?;
        trash::delete(&path)
            .map_err(|err| format!("failed moving {} to trash: {err}", display_path(&path)))?;
    }

    Ok(())
}

#[tauri::command]
pub fn restore_paths_from_trash(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    let targets = paths
        .into_iter()
        .map(|raw_path| {
            let sanitized = sanitize_input_path(&raw_path, "path")?;
            let normalized = if is_wsl() {
                translate_windows_path_to_wsl(sanitized).unwrap_or_else(|| PathBuf::from(sanitized))
            } else {
                PathBuf::from(sanitized)
            };
            Ok::<PathBuf, String>(strip_windows_extended_prefix(&normalized))
        })
        .collect::<Result<Vec<_>, _>>()?;

    #[cfg(any(
        target_os = "windows",
        all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))
    ))]
    {
        use trash::os_limited;

        let mut trash_items = os_limited::list()
            .map_err(|err| format!("failed listing trash items: {err}"))?;
        trash_items.sort_by(|left, right| right.time_deleted.cmp(&left.time_deleted));

        let mut selected = Vec::new();
        for target in &targets {
            let target_key = compare_path_key(target);
            if let Some(index) = trash_items
                .iter()
                .position(|item| compare_path_key(&item.original_path()) == target_key)
            {
                selected.push(trash_items.remove(index));
            } else {
                return Err(format!("path not found in trash: {}", display_path(target)));
            }
        }

        let restored_paths = selected
            .iter()
            .map(|item| display_path(&item.original_path()))
            .collect::<Vec<_>>();

        os_limited::restore_all(selected)
            .map_err(|err| format!("failed restoring trash item: {err}"))?;

        return Ok(restored_paths);
    }

    #[cfg(not(any(
        target_os = "windows",
        all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))
    )))]
    {
        Err("restore from trash is unsupported on this platform".to_string())
    }
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let source = normalize_existing_path(&path)?;
    let trimmed_name = new_name.trim();

    if trimmed_name.is_empty() {
        return Err("new_name must not be empty".to_string());
    }
    if trimmed_name.contains('\0') {
        return Err("new_name contains unsupported null byte".to_string());
    }
    if trimmed_name == "." || trimmed_name == ".." {
        return Err("new_name must not be '.' or '..'".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("new_name must not contain path separators".to_string());
    }

    let parent = source
        .parent()
        .ok_or_else(|| format!("cannot resolve parent path for {}", display_path(&source)))?;
    let destination = parent.join(trimmed_name);

    if destination.exists() {
        return Err(format!(
            "destination already exists: {}",
            display_path(&destination)
        ));
    }

    fs::rename(&source, &destination).map_err(|err| {
        format!(
            "failed renaming {} to {}: {err}",
            display_path(&source),
            display_path(&destination)
        )
    })?;

    Ok(display_path(&destination))
}

#[tauri::command]
pub fn create_folder(parent_path: String, folder_name: String) -> Result<String, String> {
    let parent = normalize_existing_directory(&parent_path)?;
    let trimmed_name = folder_name.trim();

    if trimmed_name.is_empty() {
        return Err("folder_name must not be empty".to_string());
    }
    if trimmed_name.contains('\0') {
        return Err("folder_name contains unsupported null byte".to_string());
    }
    if trimmed_name == "." || trimmed_name == ".." {
        return Err("folder_name must not be '.' or '..'".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("folder_name must not contain path separators".to_string());
    }

    let destination = parent.join(trimmed_name);
    if destination.exists() {
        return Err(format!(
            "folder already exists: {}",
            display_path(&destination)
        ));
    }

    fs::create_dir_all(&destination).map_err(|err| {
        format!(
            "failed creating folder {}: {err}",
            display_path(&destination)
        )
    })?;

    Ok(display_path(&destination))
}

#[tauri::command]
pub fn open_path_in_system(path: String) -> Result<(), String> {
    let normalized = normalize_existing_path(&path)?;

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", display_path(&normalized)))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", display_path(&normalized)))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", display_path(&normalized)))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for open_path_in_system".to_string())
}

fn list_windows_drives() -> Vec<DriveItem> {
    let mut drives = Vec::new();

    for letter in b'A'..=b'Z' {
        let label = format!("{}:", letter as char);
        let path = format!("{label}\\");

        if Path::new(&path).exists() {
            drives.push(DriveItem {
                id: label.clone(),
                label,
                path,
            });
        }
    }

    drives
}

fn list_wsl_drives() -> Vec<DriveItem> {
    let root = PathBuf::from("/mnt");
    let mut drives = Vec::new();

    let Ok(entries) = fs::read_dir(root) else {
        return drives;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_single_letter_drive(&name) {
            continue;
        }

        if let Ok(metadata) = entry.metadata() {
            if !metadata.is_dir() {
                continue;
            }
        } else {
            continue;
        }

        let lower = name.to_ascii_lowercase();
        let upper = name.to_ascii_uppercase();

        drives.push(DriveItem {
            id: upper.clone(),
            label: format!("{upper}:"),
            path: format!("/mnt/{lower}"),
        });
    }

    drives.sort_by(|a, b| a.label.cmp(&b.label));
    drives
}

fn is_single_letter_drive(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphabetic()) && chars.next().is_none()
}

fn is_drive_root(path: &Path) -> bool {
    let sanitized = strip_windows_extended_prefix(path);

    if cfg!(target_os = "windows") {
        let text = sanitized.display().to_string();
        let chars: Vec<char> = text.chars().collect();
        if chars.len() == 3
            && chars[0].is_ascii_alphabetic()
            && chars[1] == ':'
            && (chars[2] == '\\' || chars[2] == '/')
        {
            return true;
        }
    }

    if is_wsl() {
        let normalized = sanitized.display().to_string();
        let parts = normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        return parts.len() == 2 && parts[0] == "mnt" && is_single_letter_drive(parts[1]);
    }

    false
}

fn sanitize_input_path<'a>(raw_path: &'a str, field_name: &str) -> Result<&'a str, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }
    if trimmed.contains('\0') {
        return Err(format!("{field_name} contains unsupported null byte"));
    }
    Ok(trimmed)
}

fn to_io_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return with_windows_extended_prefix(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_path_buf()
    }
}

fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }

    path.to_path_buf()
}

fn display_path(path: &Path) -> String {
    strip_windows_extended_prefix(path).display().to_string()
}

fn compare_path_key(path: &Path) -> String {
    let display = display_path(path);
    let normalized = display.replace('\\', "/");
    if cfg!(target_os = "windows") {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

#[cfg(target_os = "windows")]
fn with_windows_extended_prefix(path: &Path) -> PathBuf {
    const LONG_PATH_THRESHOLD: usize = 240;

    let as_string = path.to_string_lossy();

    if as_string.len() < LONG_PATH_THRESHOLD
        || as_string.starts_with(r"\\?\")
        || as_string.starts_with(r"\\.\")
    {
        return path.to_path_buf();
    }

    let normalized = as_string.replace('/', r"\");

    if let Some(stripped_unc) = normalized.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{stripped_unc}"));
    }

    let mut chars = normalized.chars();
    let drive = chars.next();
    let colon = chars.next();

    if matches!(drive, Some(value) if value.is_ascii_alphabetic()) && colon == Some(':') {
        return PathBuf::from(format!(r"\\?\{normalized}"));
    }

    path.to_path_buf()
}

fn normalize_existing_directory(parent_path: &str) -> Result<PathBuf, String> {
    let trimmed = sanitize_input_path(parent_path, "parent_path")?;
    let normalized_input = strip_windows_verbatim_prefix(trimmed);
    let direct = PathBuf::from(&normalized_input);
    if direct.exists() && direct.is_dir() {
        return Ok(to_io_path(&direct));
    }

    if is_wsl() {
        if let Some(mapped) = translate_windows_path_to_wsl(&normalized_input) {
            if mapped.exists() && mapped.is_dir() {
                return Ok(to_io_path(&mapped));
            }
        }
    }

    Err(format!("directory does not exist: {normalized_input}"))
}

fn normalize_existing_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = sanitize_input_path(raw_path, "path")?;
    let normalized_input = strip_windows_verbatim_prefix(trimmed);
    let direct = PathBuf::from(&normalized_input);
    if direct.exists() {
        return Ok(to_io_path(&direct));
    }

    if is_wsl() {
        if let Some(mapped) = translate_windows_path_to_wsl(&normalized_input) {
            if mapped.exists() {
                return Ok(to_io_path(&mapped));
            }
        }
    }

    Err(format!("path does not exist: {normalized_input}"))
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        return rest.to_string();
    }

    path.to_string()
}

fn unique_destination_path(destination_root: &Path, source_name: &OsStr) -> PathBuf {
    let preferred = destination_root.join(source_name);
    if !preferred.exists() {
        return preferred;
    }

    let source_name_string = source_name.to_string_lossy();
    let source_path_like = Path::new(source_name_string.as_ref());
    let stem = source_path_like
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let extension = source_path_like
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 1..10_000 {
        let candidate_name = if extension.is_empty() {
            format!("{stem} ({counter})")
        } else {
            format!("{stem} ({counter}).{extension}")
        };
        let candidate_path = destination_root.join(candidate_name);
        if !candidate_path.exists() {
            return candidate_path;
        }
    }

    destination_root.join(format!("{stem}-copy"))
}

fn ensure_not_descendant_destination(
    source: &Path,
    destination: &Path,
    operation_name: &str,
) -> Result<(), String> {
    if source.is_dir() && destination.starts_with(source) {
        return Err(format!(
            "cannot {operation_name} {} into its own descendant {}",
            display_path(source),
            display_path(destination)
        ));
    }

    Ok(())
}

fn copy_single_file_with_retry(source: &Path, destination: &Path) -> Result<(), String> {
    const MAX_RETRIES: u32 = 3;
    let mut last_err = String::new();

    for attempt in 0..MAX_RETRIES {
        match fs::copy(source, destination) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_err = format!(
                    "failed copying file {} -> {}: {err}",
                    display_path(source),
                    display_path(destination)
                );
                let is_transient = matches!(
                    err.kind(),
                    ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
                ) || err.raw_os_error().map_or(false, |code| {
                    // Windows sharing violation (ERROR_SHARING_VIOLATION = 32)
                    // Windows lock violation (ERROR_LOCK_VIOLATION = 33)
                    code == 32 || code == 33
                });

                if !is_transient || attempt + 1 == MAX_RETRIES {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt as u64 + 1)));
            }
        }
    }

    Err(last_err)
}

fn copy_path_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_symlink() {
        return Ok(());
    }

    if source.is_file() {
        return copy_single_file_with_retry(source, destination);
    }

    if !source.is_dir() {
        return Err(format!("unsupported path type: {}", display_path(source)));
    }

    // Iterative breadth-first copy using a stack to avoid stack overflow on deep trees
    let mut stack: Vec<(PathBuf, PathBuf)> =
        vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut errors: Vec<String> = Vec::new();

    while let Some((src_dir, dst_dir)) = stack.pop() {
        fs::create_dir_all(&dst_dir).map_err(|err| {
            format!(
                "failed creating destination directory {}: {err}",
                display_path(&dst_dir)
            )
        })?;

        let entries = match fs::read_dir(&src_dir) {
            Ok(entries) => entries,
            Err(err) => {
                errors.push(format!(
                    "failed reading directory {}: {err}",
                    display_path(&src_dir)
                ));
                continue;
            }
        };

        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(err) => {
                    errors.push(format!(
                        "failed reading entry in {}: {err}",
                        display_path(&src_dir)
                    ));
                    continue;
                }
            };

            let child_source = entry.path();
            let child_destination = dst_dir.join(entry.file_name());

            // Skip symlinks to avoid loops and broken references
            if child_source.is_symlink() {
                continue;
            }

            if child_source.is_dir() {
                stack.push((child_source, child_destination));
            } else if child_source.is_file() {
                if let Err(err) = copy_single_file_with_retry(&child_source, &child_destination) {
                    errors.push(err);
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        let count = errors.len();
        let detail = errors.into_iter().take(5).collect::<Vec<_>>().join("\n");
        Err(format!(
            "{count} error(s) during copy:\n{detail}{}",
            if count > 5 { "\n..." } else { "" }
        ))
    }
}

fn remove_path_recursive(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("failed deleting directory {}: {err}", display_path(path)))?;
        return Ok(());
    }

    if path.is_file() {
        fs::remove_file(path)
            .map_err(|err| format!("failed deleting file {}: {err}", display_path(path)))?;
        return Ok(());
    }

    Err(format!("unsupported path type: {}", display_path(path)))
}

fn translate_windows_path_to_wsl(path: &str) -> Option<PathBuf> {
    let normalized = strip_windows_verbatim_prefix(path).replace('\\', "/");
    let mut chars = normalized.chars();

    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }

    let rest = chars.as_str().trim_start_matches('/');
    let drive_lower = drive.to_ascii_lowercase();

    if rest.is_empty() {
        Some(PathBuf::from(format!("/mnt/{drive_lower}")))
    } else {
        Some(PathBuf::from(format!("/mnt/{drive_lower}/{rest}")))
    }
}

#[tauri::command]
pub fn get_quick_access_paths() -> Result<Vec<DriveItem>, String> {
    let mut items: Vec<DriveItem> = Vec::new();

    if cfg!(target_os = "windows") {
        if let Some(home) = dirs::home_dir() {
            let desktop = home.join("Desktop");
            if desktop.exists() {
                items.push(DriveItem {
                    id: "quick:desktop".to_string(),
                    label: "바탕화면".to_string(),
                    path: desktop.display().to_string(),
                });
            }
            let downloads = home.join("Downloads");
            if downloads.exists() {
                items.push(DriveItem {
                    id: "quick:downloads".to_string(),
                    label: "다운로드".to_string(),
                    path: downloads.display().to_string(),
                });
            }
        }
    } else if is_wsl() {
        // Try to find the Windows user home via /mnt/c/Users
        let users_dir = PathBuf::from("/mnt/c/Users");
        if users_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&users_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == "Public"
                        || name == "Default"
                        || name == "Default User"
                        || name == "All Users"
                        || name.starts_with('.')
                    {
                        continue;
                    }
                    let user_dir = entry.path();
                    let desktop = user_dir.join("Desktop");
                    let downloads = user_dir.join("Downloads");
                    if desktop.exists() || downloads.exists() {
                        if desktop.exists() {
                            items.push(DriveItem {
                                id: "quick:desktop".to_string(),
                                label: "바탕화면".to_string(),
                                path: desktop.display().to_string(),
                            });
                        }
                        if downloads.exists() {
                            items.push(DriveItem {
                                id: "quick:downloads".to_string(),
                                label: "다운로드".to_string(),
                                path: downloads.display().to_string(),
                            });
                        }
                        break; // Use the first real user found
                    }
                }
            }
        }
    } else {
        if let Some(home) = dirs::home_dir() {
            let desktop = home.join("Desktop");
            if desktop.exists() {
                items.push(DriveItem {
                    id: "quick:desktop".to_string(),
                    label: "바탕화면".to_string(),
                    path: desktop.display().to_string(),
                });
            }
            let downloads = home.join("Downloads");
            if downloads.exists() {
                items.push(DriveItem {
                    id: "quick:downloads".to_string(),
                    label: "다운로드".to_string(),
                    path: downloads.display().to_string(),
                });
            }
        }
    }

    Ok(items)
}

fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() {
        return true;
    }

    fs::read_to_string("/proc/version")
        .map(|version| version.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

fn read_dir_entries(root: &Path) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(root)
        .map_err(|err| format!("failed reading directory {}: {err}", display_path(root)))?;

    let mut collected = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| {
            format!(
                "failed reading entry in directory {}: {err}",
                display_path(root)
            )
        })?;
        collected.push(entry);
    }

    Ok(collected)
}

fn normalize_page_options(
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<(usize, usize), String> {
    let offset = offset.unwrap_or(0);
    let requested_limit = limit.unwrap_or(DEFAULT_DIRECTORY_PAGE_SIZE);
    if requested_limit == 0 {
        return Err("limit must be greater than 0".to_string());
    }
    let limit = requested_limit.min(MAX_DIRECTORY_PAGE_SIZE);
    Ok((offset, limit))
}

fn paginate_items<T>(
    items: Vec<T>,
    offset: usize,
    limit: usize,
) -> (Vec<T>, usize, Option<usize>, bool) {
    let total = items.len();
    if offset >= total {
        return (Vec::new(), total, None, false);
    }

    let end = offset.saturating_add(limit).min(total);
    let has_more = end < total;
    let page = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = has_more.then_some(end);

    (page, total, next_offset, has_more)
}

fn build_folder_metadata(entry: DirEntry, metadata: Metadata) -> FolderItem {
    let path = entry.path();
    let path_string = display_path(&path);

    FolderItem {
        id: path_string.clone(),
        name: entry.file_name().to_string_lossy().to_string(),
        path: path_string,
        modified_at: modified_at_epoch_seconds(&metadata).unwrap_or_default(),
        is_hidden: is_hidden(&entry, &metadata),
    }
}

fn build_file_metadata(entry: DirEntry, metadata: Metadata) -> FileItem {
    let path = entry.path();
    let path_string = display_path(&path);

    FileItem {
        id: path_string.clone(),
        name: entry.file_name().to_string_lossy().to_string(),
        path: path_string,
        ext: path
            .extension()
            .map(|segment| segment.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default(),
        size: metadata.len(),
        modified_at: modified_at_epoch_seconds(&metadata).unwrap_or_default(),
        is_hidden: is_hidden(&entry, &metadata),
    }
}

fn is_hidden(entry: &DirEntry, _metadata: &Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if _metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            return true;
        }
    }

    let name = entry.file_name().to_string_lossy().to_string();
    name.starts_with('.')
}

fn modified_at_epoch_seconds(metadata: &Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(system_time_to_epoch_seconds)
}

fn system_time_to_epoch_seconds(time: SystemTime) -> Option<i64> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_secs()).ok()
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let normalized = normalize_existing_path(&path)?;
    fs::read(&normalized)
        .map_err(|e| format!("Failed to read file {}: {e}", display_path(&normalized)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("valid system time")
                .as_nanos();
            let unique = format!("windows-pdf-dir-{prefix}-{now}-{}", std::process::id());
            let path = std::env::temp_dir().join(unique);

            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn list_folders_returns_only_directories_sorted_by_name() {
        let temp_dir = TempDirGuard::new("list-folders");
        let root = temp_dir.path();

        fs::create_dir_all(root.join("Zoo")).expect("create Zoo");
        fs::create_dir_all(root.join("alpha")).expect("create alpha");
        fs::create_dir_all(root.join("beta")).expect("create beta");
        fs::write(root.join("notes.txt"), "hello").expect("create file");

        let folders = list_folders(root.display().to_string()).expect("list folders");
        let names = folders
            .iter()
            .map(|folder| folder.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["alpha", "beta", "Zoo"]);
        assert!(folders.iter().all(|folder| !folder.id.is_empty()));
    }

    #[test]
    fn list_files_returns_only_files_with_extension_and_size() {
        let temp_dir = TempDirGuard::new("list-files");
        let root = temp_dir.path();

        fs::create_dir_all(root.join("inner")).expect("create inner folder");
        fs::write(root.join("README"), "no extension").expect("create README");
        fs::write(root.join("photo.JPG"), "12345").expect("create photo");
        fs::write(root.join("report.pdf"), "abc").expect("create report");

        let files = list_files(root.display().to_string()).expect("list files");

        let names = files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["photo.JPG", "README", "report.pdf"]);

        let photo = files
            .iter()
            .find(|file| file.name == "photo.JPG")
            .expect("photo entry");
        assert_eq!(photo.ext, "jpg");
        assert_eq!(photo.size, 5);

        let readme = files
            .iter()
            .find(|file| file.name == "README")
            .expect("readme entry");
        assert_eq!(readme.ext, "");
    }

    #[test]
    fn list_files_supports_unicode_and_special_character_names_basic() {
        let temp_dir = TempDirGuard::new("list-files-special-chars");
        let root = temp_dir.path();

        let names = [
            "한글 문서.pdf",
            "space name.txt",
            "A&B #1(초안).md",
            "emoji-📄.csv",
        ];

        for name in names {
            fs::write(root.join(name), "sample").expect("create fixture file");
        }

        let files = list_files(root.display().to_string()).expect("list files");

        for expected in names {
            assert!(
                files.iter().any(|entry| entry.name == expected),
                "missing file entry for {expected}"
            );
        }
    }

    #[test]
    fn list_folders_paginated_returns_slice_and_metadata() {
        let temp_dir = TempDirGuard::new("list-folders-paginated");
        let root = temp_dir.path();

        fs::create_dir_all(root.join("alpha")).expect("create alpha");
        fs::create_dir_all(root.join("beta")).expect("create beta");
        fs::create_dir_all(root.join("gamma")).expect("create gamma");
        fs::create_dir_all(root.join("zeta")).expect("create zeta");
        fs::write(root.join("notes.txt"), "hello").expect("create file");

        let page = list_folders_paginated(root.display().to_string(), Some(1), Some(2))
            .expect("list page");
        let names = page
            .items
            .iter()
            .map(|folder| folder.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["beta", "gamma"]);
        assert_eq!(page.offset, 1);
        assert_eq!(page.limit, 2);
        assert_eq!(page.total, 4);
        assert_eq!(page.next_offset, Some(3));
        assert!(page.has_more);
    }

    #[test]
    fn list_files_paginated_rejects_zero_limit() {
        let temp_dir = TempDirGuard::new("list-files-paginated-invalid");
        let root = temp_dir.path();
        fs::write(root.join("one.txt"), "1").expect("create file");

        let err = list_files_paginated(root.display().to_string(), Some(0), Some(0))
            .expect_err("zero limit should fail");
        assert!(err.contains("limit must be greater than 0"));
    }

    #[test]
    fn list_files_paginated_clamps_limit_and_handles_offset_bounds() {
        let temp_dir = TempDirGuard::new("list-files-paginated");
        let root = temp_dir.path();
        fs::write(root.join("a.txt"), "1").expect("create a");
        fs::write(root.join("b.txt"), "2").expect("create b");

        let first = list_files_paginated(
            root.display().to_string(),
            Some(0),
            Some(MAX_DIRECTORY_PAGE_SIZE + 500),
        )
        .expect("first page");
        assert_eq!(first.limit, MAX_DIRECTORY_PAGE_SIZE);
        assert_eq!(first.total, 2);
        assert_eq!(first.items.len(), 2);
        assert!(!first.has_more);
        assert_eq!(first.next_offset, None);

        let second = list_files_paginated(root.display().to_string(), Some(10), Some(10))
            .expect("second page");
        assert_eq!(second.items.len(), 0);
        assert_eq!(second.total, 2);
        assert_eq!(second.next_offset, None);
        assert!(!second.has_more);
    }

    #[test]
    fn list_folders_rejects_non_directory_input() {
        let temp_dir = TempDirGuard::new("validation");
        let file_path = temp_dir.path().join("single-file.txt");
        fs::write(&file_path, "x").expect("create file");

        let err = list_folders(file_path.display().to_string()).expect_err("must reject file path");
        assert!(err.contains("directory"));
    }

    #[test]
    fn list_files_rejects_empty_parent_path() {
        let err = list_files("   ".to_string()).expect_err("must reject blank input");
        assert!(err.contains("parent_path"));
    }

    #[test]
    fn list_files_supports_unicode_and_special_character_names() {
        let temp_dir = TempDirGuard::new("unicode-special");
        let root = temp_dir.path();
        let names = [
            "한글 파일.pdf",
            "emoji😀(샘플).txt",
            "space & hash #1.md",
            "alpha.txt",
        ];

        for name in names {
            fs::write(root.join(name), "sample").expect("create unicode/special file");
        }

        let files = list_files(root.display().to_string()).expect("list files");
        let listed_names = files
            .iter()
            .map(|item| item.name.clone())
            .collect::<Vec<_>>();

        assert!(listed_names.iter().any(|name| name == "한글 파일.pdf"));
        assert!(listed_names.iter().any(|name| name == "emoji😀(샘플).txt"));
        assert!(listed_names.iter().any(|name| name == "space & hash #1.md"));
    }

    #[test]
    fn normalize_existing_path_rejects_null_bytes() {
        let err =
            normalize_existing_path("C:\\temp\0bad").expect_err("null byte path must be rejected");
        assert!(err.contains("null byte"));
    }

    #[test]
    fn copy_paths_copies_file_into_destination_directory() {
        let source_root = TempDirGuard::new("copy-source");
        let destination_root = TempDirGuard::new("copy-dest");

        let source_file = source_root.path().join("sample.txt");
        fs::write(&source_file, "sample-content").expect("write source file");

        let copied = copy_paths(
            vec![source_file.display().to_string()],
            destination_root.path().display().to_string(),
        )
        .expect("copy paths");

        assert_eq!(copied.len(), 1);
        let copied_path = PathBuf::from(&copied[0]);
        assert!(copied_path.exists());
        let copied_text = fs::read_to_string(copied_path).expect("read copied file");
        assert_eq!(copied_text, "sample-content");
    }

    #[test]
    fn move_paths_moves_file_into_destination_directory() {
        let source_root = TempDirGuard::new("move-source");
        let destination_root = TempDirGuard::new("move-dest");

        let source_file = source_root.path().join("move-me.txt");
        fs::write(&source_file, "move-content").expect("write source file");

        let moved = move_paths(
            vec![source_file.display().to_string()],
            destination_root.path().display().to_string(),
        )
        .expect("move paths");

        assert_eq!(moved.len(), 1);
        assert!(!source_file.exists());
        assert!(PathBuf::from(&moved[0]).exists());
    }

    #[test]
    fn copy_paths_rejects_copying_folder_into_its_descendant() {
        let root = TempDirGuard::new("copy-descendant");
        let source_folder = root.path().join("source");
        let child_folder = source_folder.join("child");
        fs::create_dir_all(&child_folder).expect("create folders");
        fs::write(source_folder.join("file.txt"), "sample").expect("create source file");

        let err = copy_paths(
            vec![source_folder.display().to_string()],
            child_folder.display().to_string(),
        )
        .expect_err("copy into descendant should fail");

        assert!(err.contains("cannot copy"));
    }

    #[test]
    fn move_paths_rejects_moving_folder_into_its_descendant() {
        let root = TempDirGuard::new("move-descendant");
        let source_folder = root.path().join("source");
        let child_folder = source_folder.join("child");
        fs::create_dir_all(&child_folder).expect("create folders");
        fs::write(source_folder.join("file.txt"), "sample").expect("create source file");

        let err = move_paths(
            vec![source_folder.display().to_string()],
            child_folder.display().to_string(),
        )
        .expect_err("move into descendant should fail");

        assert!(err.contains("cannot move"));
    }

    #[test]
    fn rename_path_renames_existing_file() {
        let temp_dir = TempDirGuard::new("rename-file");
        let source_file = temp_dir.path().join("before.txt");
        fs::write(&source_file, "rename-content").expect("write source file");

        let renamed = rename_path(source_file.display().to_string(), "after.txt".to_string())
            .expect("rename path");
        let renamed_path = PathBuf::from(&renamed);

        assert!(!source_file.exists());
        assert!(renamed_path.exists());
        assert_eq!(
            renamed_path.file_name().and_then(|v| v.to_str()),
            Some("after.txt")
        );
    }

    #[test]
    fn rename_path_supports_unicode_and_special_characters() {
        let temp_dir = TempDirGuard::new("rename-special");
        let source_file = temp_dir.path().join("before.txt");
        fs::write(&source_file, "rename-content").expect("write source file");

        let target_name = "한글 #샘플 (v1).txt";
        let renamed = rename_path(source_file.display().to_string(), target_name.to_string())
            .expect("rename with unicode/special chars");
        let renamed_path = PathBuf::from(&renamed);

        assert!(!source_file.exists());
        assert!(renamed_path.exists());
        assert_eq!(
            renamed_path.file_name().and_then(|v| v.to_str()),
            Some(target_name)
        );
    }

    #[test]
    fn create_folder_creates_directory_under_parent_path() {
        let temp_dir = TempDirGuard::new("create-folder");
        let created = create_folder(
            temp_dir.path().display().to_string(),
            "new-folder".to_string(),
        )
        .expect("create folder");

        let created_path = PathBuf::from(created);
        assert!(created_path.exists());
        assert!(created_path.is_dir());
    }

    #[test]
    fn create_folder_rejects_dot_dot_and_null_byte() {
        let temp_dir = TempDirGuard::new("create-folder-invalid");
        let parent = temp_dir.path().display().to_string();

        let dot_err = create_folder(parent.clone(), ".".to_string()).expect_err("dot must fail");
        assert!(dot_err.contains("must not be '.' or '..'"));

        let dotdot_err =
            create_folder(parent.clone(), "..".to_string()).expect_err("dotdot must fail");
        assert!(dotdot_err.contains("must not be '.' or '..'"));

        let null_err =
            create_folder(parent, "bad\0name".to_string()).expect_err("null byte must fail");
        assert!(null_err.contains("null byte"));
    }

    #[test]
    fn delete_paths_rejects_empty_paths() {
        let err = delete_paths(Vec::new()).expect_err("must reject empty paths");
        assert!(err.contains("paths must not be empty"));
    }

    #[test]
    fn delete_paths_rejects_nonexistent_path() {
        let temp_dir = TempDirGuard::new("delete-missing");
        let missing = temp_dir.path().join("missing-file.txt");
        let err = delete_paths(vec![missing.display().to_string()])
            .expect_err("must reject missing path");
        assert!(err.contains("path does not exist"));
    }

    #[test]
    fn delete_paths_moves_file_to_trash() {
        let temp_dir = TempDirGuard::new("delete-file");
        let target_file = temp_dir.path().join("trash.txt");
        fs::write(&target_file, "trash-content").expect("write file");

        delete_paths(vec![target_file.display().to_string()]).expect("delete path");
        assert!(!target_file.exists());
    }

    #[test]
    fn delete_paths_moves_directory_to_trash() {
        let temp_dir = TempDirGuard::new("delete-directory");
        let target_dir = temp_dir.path().join("nested");
        let target_file = target_dir.join("sample.txt");
        fs::create_dir_all(&target_dir).expect("create nested dir");
        fs::write(&target_file, "sample").expect("write nested file");

        delete_paths(vec![target_dir.display().to_string()]).expect("delete directory path");
        assert!(!target_dir.exists());
    }

    #[test]
    fn restore_paths_from_trash_rejects_empty_paths() {
        let err = restore_paths_from_trash(Vec::new()).expect_err("must reject empty paths");
        assert!(err.contains("paths must not be empty"));
    }

    #[cfg(any(
        target_os = "windows",
        all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))
    ))]
    #[test]
    fn restore_paths_from_trash_restores_deleted_file() {
        let temp_dir = TempDirGuard::new("restore-trash-file");
        let target_file = temp_dir.path().join("restore-me.txt");
        fs::write(&target_file, "restore-content").expect("write file");

        let original_path = target_file.display().to_string();
        delete_paths(vec![original_path.clone()]).expect("delete path");
        assert!(!target_file.exists());

        let restored = restore_paths_from_trash(vec![original_path.clone()])
            .expect("restore from trash");
        assert_eq!(restored, vec![original_path]);
        assert!(target_file.exists());
    }

    #[test]
    fn translate_windows_path_to_wsl_works_for_drive_root_and_nested_paths() {
        let root = translate_windows_path_to_wsl("C:\\").expect("root conversion");
        assert_eq!(root, PathBuf::from("/mnt/c"));

        let nested = translate_windows_path_to_wsl("D:\\Users\\Alice\\Documents")
            .expect("nested conversion");
        assert_eq!(nested, PathBuf::from("/mnt/d/Users/Alice/Documents"));
    }

    #[test]
    fn translate_windows_path_to_wsl_supports_verbatim_and_special_chars() {
        let prefixed = translate_windows_path_to_wsl(r"\\?\C:\Users\테스트\emoji😀\A & B #1.pdf")
            .expect("verbatim conversion");
        assert_eq!(
            prefixed,
            PathBuf::from("/mnt/c/Users/테스트/emoji😀/A & B #1.pdf")
        );
    }

    #[test]
    fn strip_windows_verbatim_prefix_handles_drive_and_unc_prefixes() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\nested\path"),
            r"C:\nested\path"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\nested"),
            r"\\server\share\nested"
        );
    }

    #[test]
    fn translate_windows_path_to_wsl_accepts_verbatim_prefix() {
        let nested = translate_windows_path_to_wsl(r"\\?\C:\Users\한글\A&B #1(초안)\emoji-📄.txt")
            .expect("verbatim path conversion");
        assert_eq!(
            nested,
            PathBuf::from("/mnt/c/Users/한글/A&B #1(초안)/emoji-📄.txt")
        );
    }

    #[test]
    fn single_letter_drive_detection_works() {
        assert!(is_single_letter_drive("c"));
        assert!(is_single_letter_drive("D"));
        assert!(!is_single_letter_drive("cd"));
        assert!(!is_single_letter_drive("1"));
    }

    #[test]
    fn normalize_existing_directory_accepts_windows_style_path_in_wsl() {
        if is_wsl() && Path::new("/mnt/c").exists() {
            let normalized = normalize_existing_directory("C:\\").expect("translate C drive root");
            assert_eq!(normalized, PathBuf::from("/mnt/c"));
        }
    }

    #[test]
    fn list_drives_includes_c_on_wsl_when_available() {
        if is_wsl() && Path::new("/mnt/c").exists() {
            let drives = list_drives().expect("list drives");
            assert!(drives
                .iter()
                .any(|drive| drive.label.eq_ignore_ascii_case("C:")));
        }
    }
}
