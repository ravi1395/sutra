//! macOS Dock right-click menu: recents + New Window, wired to the launcher
//! funnel. Tauri (via tao/wry) owns the `NSApplication` delegate and relies
//! on it for `RunEvent::Opened` etc., so we must not replace it. Instead we
//! inject `applicationDockMenu:` (and two action selectors) into the
//! delegate's existing class at runtime via `objc2::ffi::class_addMethod` —
//! a category added dynamically rather than a swizzle-and-replace. The menu
//! is rebuilt from `app_state::recents_list()` on every invocation (no
//! caching), so a folder opened in any window shows up without a restart.
#![cfg(target_os = "macos")]

use core::fmt::Write as _;
use std::ffi::CString;

use objc2::encode::{Encode, EncodeArguments, EncodeReturn};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, MethodImplementation, ProtocolObject, Sel};
use objc2::{sel, MainThreadMarker, Message};
use objc2_app_kit::{NSApplication, NSApplicationDelegate, NSMenu, NSMenuItem};
use objc2_foundation::NSString;

/// Installs the Dock menu bridge. Call once from `setup()`. Best-effort: if
/// there is no delegate yet (unexpected on macOS) or we're off the main
/// thread, this logs and does nothing rather than panic — a missing Dock
/// menu is a cosmetic regression, not a launch-blocking one.
pub fn install(_app: &tauri::AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[dock_menu] install() called off the main thread; skipping");
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else {
        eprintln!("[dock_menu] NSApplication has no delegate yet; Dock menu not installed");
        return;
    };
    // The delegate instance's class -- Tao's/Tauri's own delegate class. We
    // add methods to it in place; we never allocate or install a new one.
    let cls: &'static AnyClass = any_object(&delegate).class();
    let cls_ptr = cls as *const AnyClass as *mut AnyClass;

    unsafe {
        add_method(
            cls_ptr,
            sel!(applicationDockMenu:),
            application_dock_menu
                as extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSApplication) -> *mut NSMenu,
        );
        add_method(
            cls_ptr,
            sel!(sutraDockOpenRecent:),
            dock_open_recent as extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSMenuItem),
        );
        add_method(
            cls_ptr,
            sel!(sutraDockNewWindow:),
            dock_new_window as extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSMenuItem),
        );
    }

    // `-[NSApplication setDelegate:]` (called by tao before this `setup()`
    // hook runs) can snapshot which optional NSApplicationDelegate methods
    // the object responds to at that moment -- before we added
    // `applicationDockMenu:` above. Re-setting the same delegate forces
    // AppKit to re-check `respondsToSelector:`, without installing a
    // different delegate object.
    ns_app.setDelegate(Some(&delegate));
}

/// Adds `imp` as selector `sel` on `cls`, computing the ObjC type encoding
/// from `F`'s own signature (mirrors what `objc2::runtime::ClassBuilder`
/// does internally for classes it defines) so the string can never drift
/// out of sync with the Rust function signature above.
///
/// # Safety
/// `cls` must be a valid, already-registered class pointer, and `imp`'s
/// signature must match what callers of `sel` on that class expect.
unsafe fn add_method<F: MethodImplementation>(cls: *mut AnyClass, sel: Sel, imp: F) {
    let types = type_encoding::<F>();
    let ok = objc2::ffi::class_addMethod(cls, sel, imp.__imp(), types.as_ptr());
    if !ok.as_bool() {
        eprintln!("[dock_menu] class_addMethod failed for {sel} (selector already defined?)");
    }
}

/// Reinterprets any retained ObjC object as `&AnyObject`. Every objc2 wrapper
/// type is a same-layout handle to the underlying object, so this pointer
/// cast is exactly what `Retained::downcast` does internally; it sidesteps
/// `AsRef` chains that only cover a type's *declared* superclass list (e.g.
/// `NSString` implements `AsRef<NSObject>` but not `AsRef<AnyObject>`).
fn any_object<T: ?Sized + Message>(r: &Retained<T>) -> &AnyObject {
    let ptr: *const AnyObject = Retained::as_ptr(r).cast();
    unsafe { &*ptr }
}

fn type_encoding<F: MethodImplementation>() -> CString {
    let mut types = format!(
        "{}{}{}",
        F::Return::ENCODING_RETURN,
        <*mut AnyObject>::ENCODING,
        Sel::ENCODING,
    );
    for enc in F::Arguments::ENCODINGS {
        write!(&mut types, "{enc}").expect("formatting an Encoding cannot fail");
    }
    CString::new(types).expect("ObjC type encodings never contain NUL")
}

// The three methods below take raw (rather than reference) pointers for
// every parameter past `self`. This is deliberate: a fn-pointer type with
// two or more independently-elided reference lifetimes (self *and* an
// argument) gets promoted to an unsatisfiable `for<'a, 'b> ...` bound when
// used as a `MethodImplementation`, which the concrete function value can
// never prove ("implementation is not general enough"). Raw pointers carry
// no lifetime, so the bound is trivially satisfied; we deref them by hand
// once we're inside, where AppKit's calling convention guarantees validity.

/// `applicationDockMenu:` — AppKit calls this on the delegate every time the
/// user right-clicks (or the Dock long-press invokes) the app's Dock icon.
extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut NSApplication,
) -> *mut NSMenu {
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    Retained::autorelease_return(build_menu(mtm))
}

/// Rebuilds: recents (freshest first, per `recents_list()`'s own order) each
/// carrying its path via `representedObject`, then a separator, then New
/// Window. Fresh read every call -- no cache.
fn build_menu(mtm: MainThreadMarker) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    let recents = crate::app_state::recents_list();

    for recent in &recents {
        let title = NSString::from_str(&recent.name);
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &title,
                Some(sel!(sutraDockOpenRecent:)),
                &NSString::from_str(""),
            )
        };
        let path = NSString::from_str(&recent.path);
        let target = menu_action_target(mtm);
        unsafe {
            item.setRepresentedObject(Some(any_object(&path)));
            item.setTarget(Some(any_object(&target)));
        }
        menu.addItem(&item);
    }

    if !recents.is_empty() {
        menu.addItem(&NSMenuItem::separatorItem(mtm));
    }

    let new_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("New Window"),
            Some(sel!(sutraDockNewWindow:)),
            &NSString::from_str(""),
        )
    };
    let target = menu_action_target(mtm);
    unsafe { new_item.setTarget(Some(any_object(&target))) };
    menu.addItem(&new_item);

    menu
}

/// The delegate doubles as our menu items' action target -- it already has
/// the `sutraDock*:` selectors added in `install()`, and it outlives every
/// menu we hand back to AppKit.
fn menu_action_target(mtm: MainThreadMarker) -> Retained<ProtocolObject<dyn NSApplicationDelegate>> {
    NSApplication::sharedApplication(mtm)
        .delegate()
        .expect("delegate present (install() already checked this)")
}

/// Recents row action: focus the owning window if the root is already open
/// in some process, else spawn a new one -- via the same funnel every other
/// launch path uses.
extern "C-unwind" fn dock_open_recent(_this: *mut AnyObject, _cmd: Sel, sender: *mut NSMenuItem) {
    // SAFETY: AppKit always passes a valid, non-null sender to an action method.
    let sender = unsafe { &*sender };
    let path = sender
        .representedObject()
        .and_then(|obj| obj.downcast::<NSString>().ok())
        .map(|s| s.to_string());
    let _ = crate::launcher::warm_launch(path.as_deref(), false);
}

/// "New Window" row action: always spawns/opens an untitled window.
extern "C-unwind" fn dock_new_window(_this: *mut AnyObject, _cmd: Sel, _sender: *mut NSMenuItem) {
    let _ = crate::launcher::warm_launch(None, true);
}
