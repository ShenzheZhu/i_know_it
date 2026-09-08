# I Know It!

Keep your usual screenshot and paste workflow. A Chrome extension and a small macOS companion prepare the original image and a Markdown context file for pasting into Codex desktop. Click the extension's toolbar button to open a small panel with an **ON / OFF** switch. The choice survives browser restarts.

This is an experimental macOS implementation. Chrome transport and clipboard behavior are tested; the native Codex composer has not been tested interactively. Other agent platforms, including Claude Code terminals, are not yet supported.

## Install once

Requires macOS, Google Chrome, and Apple's Command Line Tools (`xcode-select --install` if missing).

1. Download or clone this repository and run `./install.sh` inside it.
2. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** this folder.
3. Pin **I Know It!** to the toolbar so its switch is always accessible.

The public manifest key keeps the extension ID stable. The installer registers a local Native Messaging executable for Chrome and Chrome for Testing. Chrome starts it when the extension connects and stops it when the connection closes. There is no server, MCP, account, API key, telemetry, or network upload.

## Use

Take a screenshot with your existing tool. Copy it and paste as usual into Codex desktop. There is no new screenshot shortcut, selection overlay, preview page, toast, notification, or image annotation. The switch panel appears only when you click the extension icon; taking a screenshot and pasting remain silent.

With the switch **ON**, a single clipboard image is prepared as two local file attachments while Codex is foreground: `screenshot.png` and `context.md`. Codex's inspected paste handler accepts an image and a nonempty Markdown file together; the Markdown is a file attachment/context reference, not inline text. The actual native composer flow still needs acceptance testing.

With the switch **OFF**, the companion stops handling images and restores any clipboard content it currently owns. Moving to another app also restores the original clipboard representations. The companion checks clipboard ownership before updating or restoring it; macOS does not provide an atomic compare-and-write operation. Existing text and multiple-file copies pass through.

## What the context means

The Markdown contains the image's pixel dimensions, the time the clipboard image was observed, and the foreground app observed then. If that app is Chrome and its page can be read, it also includes the observed URL, title, viewport, scroll position, browser window bounds, zoom, and device pixel ratio.

These are **observations, not verified screenshot provenance**. An ordinary clipboard image does not reveal where it was captured. A copied old image, a delayed screenshot tool, a background window, or a rapid app switch can make the observed app/page differ from the actual source. The screenshot's desktop position and crop origin remain **unknown**. Agents must not treat browser window bounds as a screenshot-to-desktop coordinate transform.

Full-screen and region images retain their size; they are not stretched to a standard screen ratio. Existing PNG bytes are preserved. Single-frame TIFF images with normal orientation are encoded as PNG without resizing. Other image formats and rotated TIFF files pass through unchanged. Window resizing, page reflow, scrolling, display changes, and browser zoom can invalidate old observations; agents should inspect the live screen before clicking.

## Current limits

- A 50 ms clipboard check and app-activation event keep the process passive. An immediate paste before detection can contain only the original image. A late browser response updates the context file, but cannot update a file an agent has already read.
- Chrome must remain running. One Chrome profile owns the companion at a time; use the toolbar switch in that profile. Multiple simultaneous Chrome profiles are not supported.
- Incognito, browser-internal pages, inaccessible pages, and uncertain page/focus transitions do not receive page attribution. DOM content and cross-origin iframe contents are not collected.
- Images above 100 MB, 64 million pixels, or 32,768 pixels on either axis, animated images, concealed/transient clipboard items, and multiple clipboard items pass through unchanged. This may exclude exceptionally large multi-monitor captures.
- Disk failures preserve ordinary paste. Normal disconnect and termination restore owned content. A forced kill or process crash can leave the two generated file references on the clipboard; copying again replaces them.
- macOS spaces, physical monitor switching, third-party screenshot tools, and the real native Codex composer remain unverified. Windows, Linux, remote agents, and Claude Code are not supported by this companion.

Saved images and context stay locally under `~/Library/Application Support/I Know It/captures/`, with private file permissions. They remain until deleted so agent references keep working. Page URLs and titles may contain sensitive information. Disabling the switch stops enrichment; it does not delete prior captures.

Run `./uninstall.sh`, then disable or remove the extension, to remove the companion. Saved captures are retained.

## Checks

```sh
node check.cjs
xcrun swiftc native/main.swift -o /tmp/i-know-it-check
/tmp/i-know-it-check --self-test
```

The extension check covers correlated context, zoom and negative window coordinates, focus/tab races, restricted pages, persisted switches, rapid setting changes, and disabled restarts. The native check uses an isolated named pasteboard to exercise original-image preservation, destination changes, toggle restoration, late context, and newer-copy ownership. It does not touch the system clipboard.

With Playwright and its Chromium browser available, run `node check-popup.cjs` to check the switch panel. It loads the actual popup HTML and background JavaScript in an isolated local fixture and covers clicking, keyboard control, saved state, interrupted replies, light/dark themes, and narrow widths. This check does not install the extension, touch the system clipboard, or establish native Codex composer acceptance.

A separate integration check is available as `node check-browser.cjs` after installing the companion and making Playwright with Chrome for Testing available. It uses a separate browser profile and an instrumented copy of the extension. It temporarily writes fixture file URLs to the system clipboard, pastes into a local test page, and restores the prior clipboard only if no newer copy replaced it. Close other loaded instances of this extension before running it because only one native connection can own the clipboard bridge.

The September 7, 2026 run on macOS 26.6.2 / Chrome for Testing 151.0.7922.34 verified a real native-host context request and an ordinary paste containing both PNG and Markdown with identical bytes. This does not establish native Codex composer acceptance.

For an automated artifact check using Codex CLI, run `node check-agent.cjs` with Playwright and an authenticated `codex` command available. Set `CODEX_BINARY` if the CLI is installed elsewhere. This calls Codex with a generated test image, so normal account usage applies. The check compiles the real native clipboard engine with a private-pasteboard fixture, verifies byte preservation and Retina dimensions, and asks Codex to read a random visual code and the generated Markdown. It never opens Codex desktop or changes the system clipboard.

On September 8, 2026, this check passed: Codex CLI read the image code, observed URL, 1200 × 800 dimensions, and unknown crop origin correctly. Additional regression checks found and fixed stale screenshots being reapplied after clipboard ownership loss and old replies reaching a replacement native connection. Extension invalidation also now leaves passive page handlers silent. Malformed input, message-size limits, late replies, disabling, and reconnect checks pass. Native Codex desktop acceptance is still blocked by the available automation policy; a CLI result does not prove the desktop paste flow.

The extended checks can be run without accessing Codex desktop or the everyday Chrome profile:

```sh
node check-process.cjs
node check-images.cjs
node check-install.cjs
```

`check-process.cjs` runs the native executable with only its pasteboard, app observation, and support directory redirected to fixtures. It checks split pipe messages, EOF, SIGTERM, SIGINT, malformed input, OFF, a newer copy during shutdown, a broken output pipe, and a competing host. Every image write includes a 200 ms gap after clearing the pasteboard, covering screenshot tools that supply image data later without another change count. `check-images.cjs` checks byte preservation and metadata for nine sizes from 1 × 1 to 7680 × 4320, plus rejection of a valid image above the 64-million-pixel limit. `check-install.cjs` runs real Swift compilation and registration commands inside a temporary Application Support tree, covering reinstallation, validation, permissions, failures, foreign files, symlinks, and uninstall retention.

The native self-test also covers 4,096 deterministic state transitions (seed `0x494B49`). This reproduced and fixed an older image being reapplied after a duplicate enable message. Extension checks cover fractional zoom/viewport offsets, closed or navigating tabs, changing incognito flags, and storage failures. If Chrome cannot read saved settings, the extension starts OFF; a storage write failure does not disable the live switch, but persistence remains unavailable until a later write succeeds.

GitHub Actions runs the extension, native state, process, image-size, and installer checks on macOS 14 (Apple silicon) and macOS 15 (Intel), plus popup interaction checks in Chromium on Linux, for every push and pull request. These jobs use private fixtures and temporary installation directories; they do not need a Codex account or control a desktop agent.

## License

MIT.
