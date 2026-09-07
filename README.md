# I Know It!

A dependency-free Chrome extension that captures a webpage region, saves a PNG, and copies Markdown with its source metadata and actual local file path. Paste it into Codex or Claude Code running on the same computer so the agent can read the image.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `i_know_it` folder containing this file.
3. Pin the extension to the toolbar.

## Use

1. On the webpage you want to capture, click the extension icon or press `Alt+Shift+S` (`Option+Shift+S` on Mac). Change conflicting shortcuts at `chrome://extensions/shortcuts`.
2. Drag to select a region on the frozen screenshot. Release to save the image and copy its context automatically. You can also use the button to capture the entire visible page.
3. Paste into your local agent's input, add your request after **My feedback**, and send.

PNGs are saved under `i_know_it/` in Chrome's download directory. The copied text includes the actual absolute path, URL, page title, UTC timestamp, viewport and document coordinates, scroll position, zoom, and image dimensions.

The clipboard contains **Markdown text and an image path**, not an image attachment or separate PNG and TXT attachments. Your input may not show an image preview; the agent reads the image from its path after you send the message. Agents running in the cloud or on an SSH host cannot directly access this computer's files. Local agents need permission to read the download directory.

Only the current viewport is captured. There is no scrolling capture, DOM or React analysis, native app capture, or system screenshot monitoring. Chrome internal pages and other pages that block script injection show an error. Standard browser page zoom is supported; reset trackpad pinch zoom before capturing.

Coordinates describe the page at capture time. Window size, fullscreen, display density, and browser zoom can change the viewport; cropping uses the actual screenshot dimensions to map back to CSS pixels. Resizing the preview window during a drag cancels that selection so you can draw it again.

No network service, MCP, API key, third-party dependencies, or telemetry. The extension reads the current page only when you trigger a capture. The downloads permission saves its screenshots and retrieves their actual file paths; it does not read other downloads. Screenshots remain on disk until you delete them.

## Checks

Run `node check.mjs` to check selection scaling, scroll coordinates, Markdown output, and five viewport/density/zoom combinations.

Browser acceptance checks passed in a separate Chrome for Testing profile: toolbar capture, cropping, PNG saving, absolute paths, clipboard text and ordinary paste, visible-page capture, 800×600 / 1200×800 / 1920×1080 viewports, 125% zoom, cancellation during resize, Escape, and restricted-page errors. A local Codex CLI run received the generated Markdown and correctly read a random code and button label present only in the screenshot.

Native Codex desktop input automation was unavailable. Claude Code acceptance stopped at an expired OAuth token before image reading. Neither native input flow is claimed as verified. Physical monitor switching and OS fullscreen transitions have not been tested.

## License

MIT.
