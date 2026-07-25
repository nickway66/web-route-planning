from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def function_block(source: str, function_name: str, next_function_name: str) -> str:
    start = source.index(f"function {function_name}")
    end = source.index(f"function {next_function_name}", start)
    return source[start:end]


def test_unauthenticated_boot_requires_a_non_dismissible_login_dialog():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    render_dialog = function_block(source, "renderAuthDialog", "openAuthDialog")
    boot = source[source.index("async function boot()") :]

    assert "authRequired: false" in source
    assert 'openAuthDialog("login", { required: true })' in boot
    assert "const required = state.authRequired" in render_dialog
    required_branch = render_dialog[render_dialog.index("const required = state.authRequired") :]
    assert 'required ? "" : \'<button data-auth-action="close"' in required_branch
    assert 'appShell?.toggleAttribute("inert", required)' in render_dialog


def test_auth_dialog_cannot_be_dismissed_while_authentication_is_required():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    bind_events = function_block(source, "bindEvents", "boot")

    close_handler_start = bind_events.index('if (action === "close")')
    close_handler = bind_events[close_handler_start : bind_events.index('} else if (action === "switch")', close_handler_start)]
    assert "if (state.authRequired) return;" in close_handler
    assert "event.preventDefault()" in bind_events
    assert "state.authRequired" in bind_events


def test_required_auth_dialog_has_modal_semantics_and_receives_focus():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    render_dialog = function_block(source, "renderAuthDialog", "openAuthDialog")

    assert 'role="dialog"' in render_dialog
    assert 'aria-modal="true"' in render_dialog
    assert 'aria-labelledby="auth-dialog-title"' in render_dialog
    assert '<h2 id="auth-dialog-title">' in render_dialog
    assert "focusAuthDialogEmail(dialog);" in render_dialog
    assert 'input[name="email"]' in source
    assert ".focus()" in source


def test_required_auth_dialog_keeps_tab_focus_inside_without_inert_support():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    render_dialog = function_block(source, "renderAuthDialog", "openAuthDialog")
    bind_events = function_block(source, "bindEvents", "boot")

    assert 'appShell?.setAttribute("aria-hidden", String(required));' in render_dialog
    assert "function keepFocusInRequiredAuthDialog" in source
    assert "event.key !== \"Tab\"" in source
    assert "event.shiftKey" in source
    assert "keepFocusInRequiredAuthDialog(event);" in bind_events


def test_required_auth_dialog_uses_the_last_control_for_shift_tab_from_background_focus():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    focus_guard = function_block(source, "keepFocusInRequiredAuthDialog", "bindEvents")
    background_fallback = focus_guard[
        focus_guard.index("if (currentIndex < 0)") : focus_guard.index("const nextIndex", focus_guard.index("if (currentIndex < 0)"))
    ]

    assert "event.shiftKey ? focusable.length - 1 : 0" in background_fallback


def test_successful_authentication_and_logout_toggle_the_gate():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    submit_handler = function_block(source, "handleAuthSubmit", "buildLayout")
    bind_events = function_block(source, "bindEvents", "boot")

    assert "state.authRequired = false;" in submit_handler
    logout_start = bind_events.index('if (action === "logout")')
    logout_handler = bind_events[logout_start : bind_events.index('if (action === "login"', logout_start)]
    assert "clearAuthSession();" in logout_handler
    assert 'openAuthDialog("login", { required: true });' in logout_handler
