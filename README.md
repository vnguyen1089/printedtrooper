# Salesforce Inline Editor

Salesforce Inline Editor is a Manifest V3 Chrome extension that adds inline editing to Salesforce Lightning list views and report detail rows.

When the extension is enabled, Salesforce table cells that expose both a record ID and a column label are highlighted. Double-click a highlighted cell to edit the value, then click **Save** to update Salesforce through the REST API using your current browser session.

## How it works

The content script scans Salesforce grids, list tables, and report result tables for:

- a row-level Salesforce record ID
- a column label, field key, or header text

When you edit a cell, the background service worker calls Salesforce REST from the extension context. It resolves the active Salesforce API host from the current tab and Salesforce `sid` cookie so Lightning/console pages do not accidentally call `/services/data` on the wrong host. The API bridge:

1. reads the latest Salesforce REST API version
2. resolves the record's object from the page, row link, or record ID prefix
3. matches the column label/key to an updateable field from object describe metadata
4. PATCHes `/services/data/vXX.X/sobjects/{ObjectApiName}/{RecordId}`

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open a Salesforce Lightning list view or report.
6. Double-click a highlighted cell to edit it inline.

Click the extension icon to toggle the inline-edit layer on or off for the current tab.

## Notes

- Salesforce permissions, field-level security, validation rules, required fields, formulas, rollups, and record locks still apply. If Salesforce rejects an update, the extension shows the API error.
- Report rows must expose a concrete record link or row record ID. Summary, subtotal, grand total, bucket, joined-report, and calculated report cells may not be editable because they do not map to one updateable field on one record.
- Related-object report columns are resolved from the row/cell record context that Salesforce exposes in the DOM. If Salesforce does not expose enough context, the extension refuses to save rather than guessing.
- The extension requests Chrome cookie access only to send the active Salesforce `sid` session to Salesforce REST. It does not store Salesforce data or credentials.
