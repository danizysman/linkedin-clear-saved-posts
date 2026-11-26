# LinkedIn Saved Posts Unsave Automator

A zero-dependency Manifest V3 Chrome extension that loads JSON files exported by **LinkedIn Saved Post Hero** and automatically unsaves matching posts on `https://www.linkedin.com/my-items/saved-posts/`.

## Files

- `manifest.json` — Manifest V3 configuration (`storage`, `activeTab`, `https://www.linkedin.com/*`, and `content.js` on `/my-items/saved-posts/*`).
- `popup.html` / `popup.css` / `popup.js` — Extension popup UI for loading JSON exports, configuring run limits/delays, and tracking live progress.
- `content.js` — DOM automation script that matches saved-post `post_urn`s, highlights matches in Dry Run mode, or opens each card's overflow menu to click **Unsave** / **Dejar de guardar** in Live mode.

## Installation (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked** and select this repository folder (`linkedin-chrome-ext`).

## Usage

1. Open [https://www.linkedin.com/my-items/saved-posts/](https://www.linkedin.com/my-items/saved-posts/) in your active Chrome tab.
2. Click the extension icon in the toolbar to open the popup.
3. Select one or more `.json` files exported by LinkedIn Saved Post Hero.
4. (Recommended) Check **Dry Run (highlight matches only)** and click **Start Unsaving** to verify matched cards are outlined in green.
5. Uncheck **Dry Run**, adjust **Max posts per run** (default `25`) and **Delay range** (default `2.5`–`4.5`s), and click **Start Unsaving**.

## Inspecting Logs in DevTools

- **Content script (`content.js`) logs**:
  1. On the `linkedin.com/my-items/saved-posts/` tab, open Chrome DevTools (`Cmd+Option+I` on macOS, `Ctrl+Shift+I` on Windows/Linux).
  2. Open the **Console** tab and filter for `[LinkedIn Unsave Automator]`.
- **Popup (`popup.js`) logs**:
  1. Right-click the extension icon (or inside the open popup) and select **Inspect**.
  2. Check the **Console** tab for popup UI or storage errors.
