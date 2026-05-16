# Salesforce 2 Perspective

Salesforce 2 Perspective is a Manifest V3 Chrome extension that opens a right-side panel on Salesforce pages. The panel shows the current:

- Record type
- Profile
- App
- Role
- Page layout

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
- If your Salesforce permissions block a metadata endpoint, the panel still displays the values it can read and lists the blocked endpoint under **Notes**.

## Setup audit trail sync

This repo also includes deployable Salesforce metadata that copies `SetupAuditTrail` rows into a custom reporting object named `Setup_Change__c`.

### Deploy

1. Authenticate to the target org with Salesforce CLI.
2. Deploy the Salesforce source:

   ```sh
   sf project deploy start --source-dir force-app --target-org <alias>
   ```

3. Assign the included permission set to admins who should view or manage the imported records:

   ```sh
   sf org assign permset --name Setup_Change_Audit_Admin --target-org <alias>
   ```

4. Schedule the hourly sync as a user that can view setup and configuration:

   ```sh
   sf apex run --file scripts/apex/scheduleSetupAuditTrailSync.apex --target-org <alias>
   ```

5. Optionally run a one-time seven-day backfill:

   ```sh
   sf apex run --file scripts/apex/runSetupAuditTrailBackfill.apex --target-org <alias>
   ```

### What gets deployed

- `Setup_Change__c` custom object with fields for the original audit id, action, section, display text, created-by user details, delegate user, namespace prefix, and audit timestamp.
- `SetupAuditTrailSync` scheduled Apex class. It queries recent `SetupAuditTrail` records and upserts them by `Audit_Trail_Id__c`, so repeated runs are idempotent.
- `SetupAuditTrailSyncTest` test coverage for upsert behavior, deduplication, truncation, and scheduling.
