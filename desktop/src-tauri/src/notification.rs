use tauri::{AppHandle, Emitter, Manager};

const MAX_TITLE_BYTES: usize = 256;
const MAX_BODY_BYTES: usize = 4 * 1024;
const MAX_TARGET_BYTES: usize = 16 * 1024;
const MAX_ACTION_LABEL_BYTES: usize = 64;
const OPEN_ACTION: &str = "open-session";
const OPEN_EVENT: &str = "shell-notification-open";
const ERROR_EVENT: &str = "shell-notification-error";
const RESPONSE_ERROR_MESSAGE: &str = "The notification response could not be handled.";

fn validate_required_text<'a>(
    value: &'a str,
    maximum_bytes: usize,
    error_code: &str,
) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{error_code}: value must not be empty"));
    }
    if value.len() > maximum_bytes {
        return Err(format!("{error_code}: value exceeds {maximum_bytes} bytes"));
    }
    Ok(value)
}

fn validate_target(target: &str) -> Result<(), String> {
    if target.len() > MAX_TARGET_BYTES {
        return Err(format!(
            "notification_target_too_long: maximum is {MAX_TARGET_BYTES} bytes"
        ));
    }
    Ok(())
}

fn opens_target(response: &notify_rust::NotificationResponse) -> bool {
    matches!(response, notify_rust::NotificationResponse::Default)
        || matches!(response, notify_rust::NotificationResponse::Action(action) if action == OPEN_ACTION)
}

fn restore_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is not available".to_string())?;
    window
        .unminimize()
        .map_err(|error| format!("the main window could not be restored: {error}"))?;
    window
        .show()
        .map_err(|error| format!("the main window could not be shown: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("the main window could not be focused: {error}"))?;
    Ok(())
}

fn handle_response(
    app: &AppHandle,
    target: &str,
    response: &notify_rust::NotificationResponse,
) -> Result<(), String> {
    if !opens_target(response) {
        return Ok(());
    }
    restore_window(app)?;
    if target.is_empty() {
        return Ok(());
    }
    app.emit_to("main", OPEN_EVENT, target).map_err(|error| {
        format!("the notification target could not be sent to the main window: {error}")
    })
}

#[tauri::command]
pub async fn show_notification(
    app: AppHandle,
    title: String,
    body: String,
    target: String,
    open_label: String,
) -> Result<(), String> {
    let title = validate_required_text(&title, MAX_TITLE_BYTES, "notification_title_invalid")?;
    let body = validate_required_text(&body, MAX_BODY_BYTES, "notification_body_invalid")?;
    let open_label = validate_required_text(
        &open_label,
        MAX_ACTION_LABEL_BYTES,
        "notification_action_label_invalid",
    )?;
    validate_target(&target)?;

    #[cfg(target_os = "macos")]
    configure_macos_application(&app)?;

    let mut notification = notify_rust::Notification::new();
    notification
        .summary(title)
        .body(body)
        .auto_icon()
        .action(OPEN_ACTION, open_label);

    #[cfg(target_os = "windows")]
    {
        use std::path::MAIN_SEPARATOR as SEP;

        let executable = tauri::utils::platform::current_exe().map_err(|error| {
            format!("the notification app identity could not be resolved: {error}")
        })?;
        let executable_directory = executable
            .parent()
            .ok_or_else(|| "the notification executable has no parent directory".to_string())?
            .display()
            .to_string();
        if !(executable_directory.ends_with(format!("{SEP}target{SEP}debug").as_str())
            || executable_directory.ends_with(format!("{SEP}target{SEP}release").as_str()))
        {
            notification.app_id(&app.config().identifier);
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    notification.appname(&app.config().identifier);

    let handle = notification
        .show()
        .map_err(|error| format!("notification_show_failed: {error}"))?;
    let response_app = app.clone();
    let response_result = tauri::async_runtime::spawn_blocking(move || {
        let mut response_result = Ok(());
        handle
            .wait_for_response(|response: &notify_rust::NotificationResponse| {
                response_result = handle_response(&response_app, &target, response);
            })
            .map_err(|error| format!("notification_response_failed: {error}"))?;
        response_result
    })
    .await;

    let response_result = match response_result {
        Ok(result) => result,
        Err(error) => {
            let _ = app.emit(ERROR_EVENT, RESPONSE_ERROR_MESSAGE);
            return Err(format!("notification_response_worker_failed: {error}"));
        }
    };

    if let Err(error) = response_result {
        let _ = app.emit(ERROR_EVENT, RESPONSE_ERROR_MESSAGE);
        return Err(error);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_application(app: &AppHandle) -> Result<(), String> {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    const DEV_APP_DIRECTORY: &str = "notification-identity";
    const DEV_BUNDLE_NAME: &str = "ligule.app";
    const LAUNCH_SERVICES_REGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    static CONFIGURATION: OnceLock<Result<(), String>> = OnceLock::new();

    fn escape_plist_value(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn create_dev_bundle(
        executable: &Path,
        identifier: &str,
        app_name: &str,
    ) -> Result<PathBuf, String> {
        let executable_directory = executable
            .parent()
            .ok_or_else(|| "the notification executable has no parent directory".to_string())?;
        let bundle = executable_directory
            .join(DEV_APP_DIRECTORY)
            .join(DEV_BUNDLE_NAME);
        let contents = bundle.join("Contents");
        let macos = contents.join("MacOS");
        fs::create_dir_all(&macos).map_err(|error| {
            format!("the development notification bundle could not be created: {error}")
        })?;

        let executable_name = executable
            .file_name()
            .ok_or_else(|| "the notification executable has no file name".to_string())?;
        let bundled_executable = macos.join(executable_name);
        match fs::symlink_metadata(&bundled_executable) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let current_target = fs::read_link(&bundled_executable).map_err(|error| {
                    format!(
                        "the development notification executable link could not be read: {error}"
                    )
                })?;
                if current_target != executable {
                    fs::remove_file(&bundled_executable).map_err(|error| {
                        format!("the development notification executable link could not be replaced: {error}")
                    })?;
                    symlink(executable, &bundled_executable).map_err(|error| {
                        format!("the development notification executable link could not be created: {error}")
                    })?;
                }
            }
            Ok(_) => {
                return Err(format!(
                    "the development notification executable path is not a symbolic link: {}",
                    bundled_executable.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                symlink(executable, &bundled_executable).map_err(|error| {
                    format!("the development notification executable link could not be created: {error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "the development notification executable link could not be inspected: {error}"
                ));
            }
        }

        let executable_name = escape_plist_value(&executable_name.to_string_lossy());
        let identifier = escape_plist_value(identifier);
        let app_name = escape_plist_value(app_name);
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleDisplayName</key><string>{app_name}</string><key>CFBundleExecutable</key><string>{executable_name}</string><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleName</key><string>{app_name}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"
        );
        fs::write(contents.join("Info.plist"), plist).map_err(|error| {
            format!("the development notification app metadata could not be written: {error}")
        })?;
        Ok(bundle)
    }

    fn register_dev_application(app: &AppHandle) -> Result<(), String> {
        let executable = tauri::utils::platform::current_exe().map_err(|error| {
            format!("the notification executable could not be resolved: {error}")
        })?;
        let app_name = app
            .config()
            .product_name
            .as_deref()
            .ok_or_else(|| "the notification application has no product name".to_string())?;
        let bundle = create_dev_bundle(&executable, &app.config().identifier, app_name)?;
        let output = Command::new(LAUNCH_SERVICES_REGISTER)
            .arg("-lint")
            .arg("-f")
            .arg(&bundle)
            .output()
            .map_err(|error| {
                format!("Launch Services registration could not be started: {error}")
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!(
                    "Launch Services registration failed with status {}",
                    output.status
                )
            } else {
                format!("Launch Services registration failed: {stderr}")
            });
        }
        Ok(())
    }

    CONFIGURATION
        .get_or_init(|| {
            if tauri::is_dev() {
                register_dev_application(app)?;
            }
            notify_rust::set_application(&app.config().identifier).map_err(|error| {
                format!("the notification application identity could not be configured: {error}")
            })
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::{
        opens_target, validate_required_text, validate_target, MAX_TARGET_BYTES, MAX_TITLE_BYTES,
        OPEN_ACTION,
    };
    use notify_rust::{CloseReason, NotificationResponse};

    #[test]
    fn notification_target_is_kept_opaque_and_limited_by_bytes() {
        let target = "{\"sessionId\":\"session-1\",\"projectRoot\":\"C:/work\"}";
        assert!(validate_target(target).is_ok());
        assert!(validate_target("").is_ok());
        assert!(validate_target(&"x".repeat(MAX_TARGET_BYTES + 1)).is_err());
    }

    #[test]
    fn notification_text_has_stable_errors_and_byte_limits() {
        assert_eq!(
            validate_required_text("  ", MAX_TITLE_BYTES, "notification_title_invalid")
                .unwrap_err(),
            "notification_title_invalid: value must not be empty"
        );
        assert!(validate_required_text(
            &"x".repeat(MAX_TITLE_BYTES + 1),
            MAX_TITLE_BYTES,
            "notification_title_invalid"
        )
        .unwrap_err()
        .starts_with("notification_title_invalid:"));
    }

    #[test]
    fn only_default_activation_and_the_open_action_open_a_target() {
        assert!(opens_target(&NotificationResponse::Default));
        assert!(opens_target(&NotificationResponse::Action(
            OPEN_ACTION.to_string()
        )));
        assert!(!opens_target(&NotificationResponse::Action(
            "other".to_string()
        )));
        assert!(!opens_target(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }
}
