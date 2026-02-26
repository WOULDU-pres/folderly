use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const SQLITE_FILE_NAME: &str = "manual_order.db";

fn app_data_dir() -> Result<PathBuf, String> {
    let base = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data)
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".local").join("share")
    } else {
        std::env::current_dir().map_err(|e| format!("failed resolving current directory: {e}"))?
    };

    let dir = base.join("windows-pdf-dir");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed creating app data directory {}: {e}", dir.display()))?;
    Ok(dir)
}

fn db_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(SQLITE_FILE_NAME))
}

fn open_db() -> Result<Connection, String> {
    let connection =
        Connection::open(db_path()?).map_err(|e| format!("failed opening sqlite database: {e}"))?;
    ensure_schema(&connection)?;
    Ok(connection)
}

fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS folder_manual_order (
              parent_path TEXT NOT NULL,
              folder_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              updated_at_epoch_ms INTEGER NOT NULL,
              PRIMARY KEY (parent_path, folder_id)
            );
            CREATE INDEX IF NOT EXISTS idx_folder_manual_order_parent
              ON folder_manual_order(parent_path, position);
            CREATE TABLE IF NOT EXISTS file_manual_order (
              parent_path TEXT NOT NULL,
              file_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              updated_at_epoch_ms INTEGER NOT NULL,
              PRIMARY KEY (parent_path, file_id)
            );
            CREATE INDEX IF NOT EXISTS idx_file_manual_order_parent
              ON file_manual_order(parent_path, position);
            "#,
        )
        .map_err(|e| format!("failed creating folder_manual_order schema: {e}"))
}

#[tauri::command]
pub fn save_manual_order(parent_path: String, ordered_ids: Vec<String>) -> Result<(), String> {
    let normalized_parent = parent_path.trim();
    if normalized_parent.is_empty() {
        return Err("parent_path must not be empty".to_string());
    }

    let mut connection = open_db()?;
    save_manual_order_with_conn(&mut connection, "folder_manual_order", "folder_id", normalized_parent, &ordered_ids)
}

#[tauri::command]
pub fn load_manual_order(parent_path: String) -> Result<Vec<String>, String> {
    let normalized_parent = parent_path.trim();
    if normalized_parent.is_empty() {
        return Err("parent_path must not be empty".to_string());
    }

    let connection = open_db()?;
    load_manual_order_with_conn(&connection, "folder_manual_order", "folder_id", normalized_parent)
}

#[tauri::command]
pub fn save_file_manual_order(parent_path: String, ordered_ids: Vec<String>) -> Result<(), String> {
    let normalized_parent = parent_path.trim();
    if normalized_parent.is_empty() {
        return Err("parent_path must not be empty".to_string());
    }

    let mut connection = open_db()?;
    save_manual_order_with_conn(&mut connection, "file_manual_order", "file_id", normalized_parent, &ordered_ids)
}

#[tauri::command]
pub fn load_file_manual_order(parent_path: String) -> Result<Vec<String>, String> {
    let normalized_parent = parent_path.trim();
    if normalized_parent.is_empty() {
        return Err("parent_path must not be empty".to_string());
    }

    let connection = open_db()?;
    load_manual_order_with_conn(&connection, "file_manual_order", "file_id", normalized_parent)
}

fn save_manual_order_with_conn(
    connection: &mut Connection,
    table_name: &str,
    id_column: &str,
    parent_path: &str,
    ordered_ids: &[String],
) -> Result<(), String> {
    ensure_schema(connection)?;
    let tx = connection
        .transaction()
        .map_err(|e| format!("failed creating transaction: {e}"))?;

    let delete_query = format!("DELETE FROM {table_name} WHERE parent_path = ?1");
    tx.execute(delete_query.as_str(), params![parent_path])
        .map_err(|e| format!("failed clearing existing manual order: {e}"))?;

    let mut seen = HashSet::new();
    let updated_at_epoch_ms = now_epoch_ms()?;
    let insert_query = format!(
        "INSERT INTO {table_name}(parent_path, {id_column}, position, updated_at_epoch_ms) VALUES(?1, ?2, ?3, ?4)"
    );

    for (position, item_id) in ordered_ids.iter().enumerate() {
        let normalized_id = item_id.trim();
        if normalized_id.is_empty() || !seen.insert(normalized_id.to_string()) {
            continue;
        }

        tx.execute(
            insert_query.as_str(),
            params![
                parent_path,
                normalized_id,
                position as i64,
                updated_at_epoch_ms
            ],
        )
        .map_err(|e| format!("failed inserting manual order row: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("failed committing manual order transaction: {e}"))
}

fn load_manual_order_with_conn(
    connection: &Connection,
    table_name: &str,
    id_column: &str,
    parent_path: &str,
) -> Result<Vec<String>, String> {
    ensure_schema(connection)?;

    let query = format!(
        "SELECT {id_column} FROM {table_name} WHERE parent_path = ?1 ORDER BY position ASC"
    );
    let mut statement = connection
        .prepare(query.as_str())
        .map_err(|e| format!("failed preparing manual order query: {e}"))?;

    let rows = statement
        .query_map(params![parent_path], |row| row.get::<_, String>(0))
        .map_err(|e| format!("failed loading manual order rows: {e}"))?;

    let mut ordered = Vec::new();
    for row in rows {
        ordered.push(row.map_err(|e| format!("failed parsing manual order row: {e}"))?);
    }

    Ok(ordered)
}

fn now_epoch_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?;

    i64::try_from(duration.as_millis())
        .map_err(|_| "failed converting timestamp into i64 milliseconds".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_round_trip() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        ensure_schema(&connection).expect("schema");

        let ordered_ids = vec!["C:/a".to_string(), "C:/b".to_string()];
        save_manual_order_with_conn(
            &mut connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
            &ordered_ids,
        )
        .expect("save");
        let loaded = load_manual_order_with_conn(
            &connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
        )
        .expect("load");

        assert_eq!(loaded, ordered_ids);
    }

    #[test]
    fn save_overwrites_existing_order() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        ensure_schema(&connection).expect("schema");

        save_manual_order_with_conn(
            &mut connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
            &["first".to_string(), "second".to_string()],
        )
        .expect("first save");

        save_manual_order_with_conn(
            &mut connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
            &["second".to_string(), "first".to_string()],
        )
        .expect("second save");

        let loaded = load_manual_order_with_conn(
            &connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
        )
        .expect("load");
        assert_eq!(loaded, vec!["second".to_string(), "first".to_string()]);
    }

    #[test]
    fn save_skips_empty_and_duplicate_ids() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        ensure_schema(&connection).expect("schema");

        save_manual_order_with_conn(
            &mut connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
            &[
                "alpha".to_string(),
                "".to_string(),
                "alpha".to_string(),
                "beta".to_string(),
            ],
        )
        .expect("save");

        let loaded = load_manual_order_with_conn(
            &connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
        )
        .expect("load");
        assert_eq!(loaded, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn file_and_folder_orders_are_persisted_independently() {
        let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
        ensure_schema(&connection).expect("schema");

        save_manual_order_with_conn(
            &mut connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
            &["folder-a".to_string(), "folder-b".to_string()],
        )
        .expect("save folders");

        save_manual_order_with_conn(
            &mut connection,
            "file_manual_order",
            "file_id",
            "C:/parent/folder-a",
            &["file-2".to_string(), "file-1".to_string()],
        )
        .expect("save files");

        let folder_loaded = load_manual_order_with_conn(
            &connection,
            "folder_manual_order",
            "folder_id",
            "C:/parent",
        )
        .expect("load folders");
        let file_loaded = load_manual_order_with_conn(
            &connection,
            "file_manual_order",
            "file_id",
            "C:/parent/folder-a",
        )
        .expect("load files");

        assert_eq!(folder_loaded, vec!["folder-a".to_string(), "folder-b".to_string()]);
        assert_eq!(file_loaded, vec!["file-2".to_string(), "file-1".to_string()]);
    }
}
