use gio::glib;
use gio::prelude::*;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::{restore_window, AppState, LOG_EVENT};

// GTK 的 AppIndicator 使用这份接口；创建图标对象不代表已有展示它的系统宿主。
const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const HOST_PROPERTY: &str = "IsStatusNotifierHostRegistered";

fn adopt(app: &AppHandle, available: bool) {
    let state = app.state::<AppState>();
    state.restorable.store(available, Ordering::Release);
    if !available && state.tray_hidden.load(Ordering::Acquire) && !state.confirmed_quit() {
        restore_window(app);
    }
}

fn known(app: &AppHandle, available: bool) {
    app.state::<AppState>()
        .tray_host_revision
        .fetch_add(1, Ordering::AcqRel);
    adopt(app, available);
}

fn failed(app: &AppHandle, error: impl std::fmt::Display) {
    let _ = app.emit(
        LOG_EVENT,
        format!("the system tray host is not available: {error}"),
    );
    known(app, false);
}

fn refresh(app: &AppHandle, proxy: &gio::DBusProxy) {
    let owner = proxy.name_owner();
    if owner.is_none() {
        known(app, false);
        return;
    }
    let revision = app
        .state::<AppState>()
        .tray_host_revision
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    let app = app.clone();
    let observed = proxy.clone();
    proxy.call(
        "org.freedesktop.DBus.Properties.Get",
        Some(&(WATCHER, HOST_PROPERTY).to_variant()),
        gio::DBusCallFlags::NO_AUTO_START,
        2_000,
        gio::Cancellable::NONE,
        move |result| {
            let state = app.state::<AppState>();
            // 宿主变化或新的读取使旧响应失效，旧的成功不能恢复已经失效的隐藏权限。
            if state.confirmed_quit()
                || state.tray_host_revision.load(Ordering::Acquire) != revision
                || observed.name_owner() != owner
            {
                return;
            }
            match result {
                Ok(reply) => match reply
                    .get::<(glib::Variant,)>()
                    .and_then(|(value,)| value.get::<bool>())
                {
                    Some(available) => adopt(&app, available),
                    None => failed(&app, "the host registration property is not a boolean"),
                },
                Err(error) => failed(&app, error),
            };
        },
    );
}

fn cached(app: &AppHandle, proxy: &gio::DBusProxy) {
    if proxy.name_owner().is_none() {
        known(app, false);
        return;
    }
    match proxy.cached_property(HOST_PROPERTY) {
        Some(value) => match value.get::<bool>() {
            Some(available) => known(app, available),
            None => failed(app, "the host registration property is not a boolean"),
        },
        None => refresh(app, proxy),
    }
}

pub fn watch(app: &AppHandle) {
    let app = app.clone();
    // GIO 在 GTK 主上下文异步连接与读取；没有 Session D-Bus 时仍保留可访问窗口。
    gio::DBusProxy::for_bus(
        gio::BusType::Session,
        gio::DBusProxyFlags::DO_NOT_AUTO_START,
        None,
        WATCHER,
        WATCHER_PATH,
        WATCHER,
        gio::Cancellable::NONE,
        move |result| {
            let proxy = match result {
                Ok(proxy) => proxy,
                Err(error) => {
                    failed(&app, error);
                    return;
                }
            };
            if app.state::<AppState>().confirmed_quit() {
                return;
            }
            let owner_app = app.clone();
            proxy.connect_g_name_owner_notify(move |proxy| cached(&owner_app, proxy));

            let property_app = app.clone();
            let weak = proxy.downgrade();
            proxy.connect_local("g-properties-changed", false, move |_| {
                if let Some(proxy) = weak.upgrade() {
                    cached(&property_app, &proxy);
                }
                None
            });

            let signal_app = app.clone();
            proxy.connect_g_signal(move |proxy, _, signal, _| {
                if matches!(
                    signal,
                    "StatusNotifierHostRegistered" | "StatusNotifierHostUnregistered"
                ) {
                    refresh(&signal_app, proxy);
                }
            });
            cached(&app, &proxy);
            match app.state::<AppState>().tray_host_proxy.lock() {
                Ok(mut slot) => *slot = Some(proxy),
                Err(error) => failed(&app, error),
            };
        },
    );
}
