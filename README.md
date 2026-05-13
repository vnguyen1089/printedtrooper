# Salesforce 2 Perspective

Salesforce 2 Perspective is a Manifest V3 Chrome extension that opens a right-side panel on Salesforce pages. The panel shows the current:

- Record type
- Profile
- Lightning application
- Role
- Page layout
- Lightning record page and API name
- Assigned permission sets

## How it works

The content script only owns the side-panel UI. When you click the extension icon, the background service worker toggles the panel and handles collection requests.

Salesforce API calls are executed by the background service worker through `chrome.scripting.executeScript` with `world: "MAIN"`. That injected function runs inside the Salesforce page context, so calls to `/services/data/...` are same-origin and use the browser's existing Salesforce session.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open a Salesforce Lightning or Classic page and click the **Salesforce 2 Perspective** extension icon.

## Notes

- The page layout lookup uses the Tooling API `ProfileLayout` assignment when Salesforce allows it, then falls back to UI API layout metadata.
- App detection uses the Lightning URL or navigation DOM first, then attempts to enrich that value with Tooling API `AppDefinition`.
- Lightning record page detection reads FlexiPage assignment metadata when Tooling API metadata is available, then falls back to FlexiPage candidates for the current object.
- Permission sets are listed from `PermissionSetAssignment`, excluding profile-owned permission sets.
- If your Salesforce permissions block a metadata endpoint, the panel still displays the values it can read and lists the blocked endpoint under **Notes**.
