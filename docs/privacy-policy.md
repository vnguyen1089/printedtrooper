# Salesforce Perspectives Privacy Policy

Effective date: May 15, 2026

Salesforce Perspectives is a Chrome extension that helps signed-in Salesforce users view Salesforce page context in an organized format.

## Summary

Salesforce Perspectives does not collect, sell, rent, share, transmit to the developer, or store personal data or Salesforce data on any external server controlled by the developer.

The extension only displays information that is already accessible to the signed-in Salesforce user in their Salesforce organization. The purpose of the extension is to organize that existing Salesforce information in a convenient browser panel.

## User data handled by the extension

When the user opens or refreshes the extension on a Salesforce page, Salesforce Perspectives may handle the following information from the current Salesforce session and page:

- Salesforce page URL for the active Salesforce tab.
- Salesforce record identifiers and object names for the current page.
- Salesforce metadata and context already available to the signed-in user, such as record type, app name, profile, role, page layout, Lightning record page, permission set assignments, API version, and org host.
- Salesforce session cookies only as needed to authenticate requests back to the user's own Salesforce organization.
- Locally generated export content if the user clicks **Save As**.

Salesforce Perspectives does not intentionally access unrelated websites, non-Salesforce browsing history, advertising identifiers, financial information, health information, or user-entered passwords.

## How user data is collected

Salesforce Perspectives handles data only when the user interacts with the extension on a Salesforce page, such as opening the panel, clicking **Refresh**, switching tabs inside the panel, or clicking **Save As**.

The extension collects data by:

- Reading the active Salesforce page URL and page context.
- Reading Salesforce page metadata that is already rendered or available to the signed-in user.
- Calling Salesforce REST, SOAP, Tooling, and UI APIs for the user's current Salesforce organization using the user's existing Salesforce browser session.

The extension does not use analytics SDKs, tracking pixels, advertising scripts, or external collection services.

## How the extension uses data

Salesforce Perspectives uses the handled data only to provide its single purpose: displaying organized Salesforce context for the current page.

Specifically, the extension uses the data to:

- Show the current Salesforce record, app, user, permission, layout, and Lightning page context.
- Display notes when a Salesforce endpoint is blocked or unavailable.
- Generate a local Word-compatible export if the user clicks **Save As**.
- Confirm that the active tab is a Salesforce page before running the extension.

Salesforce Perspectives does not use user data for advertising, user profiling, credit decisions, resale, analytics, or unrelated purposes.

## How user data is shared

Salesforce Perspectives does not share user data with the developer, advertising networks, data brokers, analytics providers, or other third parties.

The only external service contacted for Salesforce data is the user's own Salesforce organization, through Salesforce domains such as `salesforce.com`, `my.salesforce.com`, and `lightning.force.com`. These requests are necessary to display the Salesforce context that the signed-in user is already authorized to access.

Parties that may receive requests:

- Salesforce and the user's Salesforce organization, for authenticated Salesforce API requests required to display the panel data.

Parties that do not receive user data from Salesforce Perspectives:

- The extension developer.
- Advertising networks.
- Analytics providers.
- Data brokers.
- Other third-party services.

## Data storage and retention

Salesforce Perspectives does not store Salesforce data or personal data on developer-controlled servers.

Data displayed in the panel is held temporarily in the browser while the panel is open or until the page/extension state changes. If the user generates a Word-compatible export, that file is downloaded directly to the user's computer and is controlled by the user. The extension does not upload, retain, or transmit the exported file.

## Local exports

If the user clicks **Save As**, Salesforce Perspectives generates a Word-compatible document locally in the browser. The exported file is downloaded directly to the user's computer. The extension does not upload, transmit to the developer, or retain the exported document.

## Authentication and cookies

Salesforce Perspectives may use the user's existing Salesforce browser session to call Salesforce APIs for the current Salesforce organization. This is used only to retrieve and display Salesforce context in the extension panel.

Salesforce session cookies are used only for authentication to Salesforce. They are not stored by the extension, sent to the developer, sold, or shared with advertising, analytics, or data broker services.

## Third parties

Salesforce Perspectives does not send data to third-party analytics, advertising, tracking, or external processing services.

## Chrome Web Store Limited Use

Salesforce Perspectives' use of user data is limited to providing and improving its single purpose: organizing and displaying Salesforce context that is already accessible to the signed-in user. Salesforce Perspectives does not transfer, sell, or use user data for personalized advertising, data brokerage, credit-worthiness, or unrelated purposes.

The use of information received from Chrome APIs and Salesforce APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Remote code

Salesforce Perspectives does not load or execute remote JavaScript or WebAssembly. All executable extension code is included in the extension package.

## Security

Salesforce API requests are made over HTTPS to Salesforce domains. The extension does not publicly disclose authentication information and does not intentionally expose Salesforce session cookies or Salesforce data outside the user's browser and Salesforce organization.

## Contact

For privacy questions about Salesforce Perspectives, contact the extension owner through the Chrome Web Store listing or the repository where the extension is distributed.
