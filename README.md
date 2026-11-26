# LinkedIn Saved Posts Manager

A zero-dependency Manifest V3 Chrome extension to **export** your LinkedIn saved posts to JSON and **automatically unsave** them on `https://www.linkedin.com/my-items/saved-posts/`.

## Files

- `manifest.json` — Manifest V3 configuration (`storage`, `activeTab`, `https://www.linkedin.com/*`, and `content.js` on `/my-items/saved-posts/*`).
- `popup.html` / `popup.css` / `popup.js` — Extension popup UI for scraping saved posts, downloading JSON, loading target JSON files, configuring run limits/delays, and tracking live progress.
- `content.js` — DOM automation script for scraping saved posts (`author_name`, `author_headline`, `author_profile_url`, `author_profile_image_url`, `connection_degree`, `is_company_post`, `post_urn`, `post_url`, `post_text`, `post_image_url`, `post_image_alt`, `has_image`, `has_video`, `posted_date` decoded from the activity URN, `posted_time`) and unsaving matching posts (Dry Run highlight or Live click of **Unsave** / **Dejar de guardar**).

## Installation (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked** and select this repository folder (`linkedin-chrome-ext`).

## Usage

1. Open [https://www.linkedin.com/my-items/saved-posts/](https://www.linkedin.com/my-items/saved-posts/) in your active Chrome tab.
2. Click the extension icon in the toolbar to open the popup.
3. **Export**: Click **Scrape Posts** to collect your saved posts across lazy-loaded batches. Once finished (or stopped), click **Download JSON** to save a backup file, and optionally **Load as Targets** to queue them for unsaving.
4. **Or Load JSON**: Select one or more `.json` files containing `post_urn` entries.
5. **Unsave**:
   - (Recommended) Check **Dry Run (highlight matches only)** and click **Start Unsaving** to verify matched cards are outlined in green.
   - Uncheck **Dry Run**, adjust **Max posts per run** (default `25`) and **Delay range** (default `0.8`–`1.5`s), and click **Start Unsaving**.
6. **Clear History**: Prompts for confirmation and clears all exported posts, target URNs, and unsaved history from `chrome.storage.local`.

## Inspecting Logs in DevTools

- **Content script (`content.js`) logs**:
  1. On the `linkedin.com/my-items/saved-posts/` tab, open Chrome DevTools (`Cmd+Option+I` on macOS, `Ctrl+Shift+I` on Windows/Linux).
  2. Open the **Console** tab and filter for `[LinkedIn Unsave Automator]`.
- **Popup (`popup.js`) logs**:
  1. Right-click the extension icon (or inside the open popup) and select **Inspect**.
  2. Check the **Console** tab for popup UI or storage errors.
