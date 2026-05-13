# Salesforce Perspectives

Salesforce Perspectives is a Manifest V3 Chrome extension that opens a right-side panel on Salesforce pages. The panel shows the current:

- Record type
- Profile
- App name
- Role
- Page layout
- Lightning record page and API name
- Assigned permission sets

## How it works

The content script owns the side-panel UI. When you click the extension icon, the background service worker toggles the panel and handles collection requests.

Salesforce API calls are executed through `chrome.scripting.executeScript` with `world: "MAIN"`. The injected function runs inside the Salesforce page context and prefers the matching Salesforce API host for Lightning pages; if that fails, it asks the background service worker to retry through the extension's host permissions and Salesforce session cookies.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open a Salesforce Lightning or Classic page and click the **Salesforce Perspectives** extension icon.

## Notes

- The page layout lookup uses the Tooling API `ProfileLayout` assignment when Salesforce allows it, then falls back to UI API layout metadata.
- App name detection mirrors the visible functional Salesforce app name in the top-left header, such as Sales, Service, or Marketing.
- Lightning record page detection reads FlexiPage assignment metadata when Tooling API metadata is available, then falls back to FlexiPage candidates for the current object.
- Permission sets are listed from `PermissionSetAssignment`, excluding profile-owned permission sets.
- If your Salesforce permissions block a metadata endpoint, the panel still displays the values it can read and lists the blocked endpoint under **Notes**.
