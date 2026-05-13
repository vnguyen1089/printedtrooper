(() => {
  if (window.__salesforce2PerspectiveLoaded) {
    window.dispatchEvent(new CustomEvent("sf2p:toggle"));
    return;
  }

  window.__salesforce2PerspectiveLoaded = true;

  const PANEL_ID = "salesforce-2-perspective-panel";
  let panelHost = null;
  let shadowRoot = null;
  let isOpen = false;
  let lastContext = null;
  let activeTab = "perspective";

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SF2P_TOGGLE_PANEL") {
      togglePanel();
    }
  });

  window.addEventListener("sf2p:toggle", togglePanel);
  window.addEventListener("message", handleWindowMessage);

  function togglePanel() {
    ensurePanel();
    isOpen = !isOpen;
    panelHost.dataset.open = String(isOpen);

    if (isOpen) {
      refreshContext();
    }
  }

  function ensurePanel() {
    if (panelHost) {
      return;
    }

    panelHost = document.createElement("div");
    panelHost.id = PANEL_ID;
    panelHost.dataset.open = "false";
    document.documentElement.appendChild(panelHost);
    shadowRoot = panelHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = styles();

    const container = document.createElement("aside");
    container.className = "sf2p-panel";

    const header = document.createElement("header");
    header.className = "sf2p-header";

    const titleGroup = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "sf2p-eyebrow";
    eyebrow.textContent = "Salesforce";
    const title = document.createElement("h1");
    title.textContent = "Perspectives";
    titleGroup.append(eyebrow, title);

    const actions = document.createElement("div");
    actions.className = "sf2p-actions";
    const saveAs = savePdfControl();
    const refresh = button("Refresh", "sf2p-refresh");
    refresh.addEventListener("click", refreshContext);
    const close = button("Close", "sf2p-close");
    close.addEventListener("click", () => {
      isOpen = false;
      panelHost.dataset.open = "false";
    });
    actions.append(saveAs, refresh, close);
    header.append(titleGroup, actions);

    const body = document.createElement("main");
    body.className = "sf2p-body";
    body.dataset.role = "body";

    container.append(header, body);
    shadowRoot.append(style, container);
    renderEmpty();
  }

  async function refreshContext() {
    ensurePanel();
    renderLoading();

    try {
      const response = await sendMessage({ type: "SF2P_COLLECT_CONTEXT" });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "Salesforce context was not returned.");
      }

      lastContext = response.context;
      renderContext(response.context);
    } catch (error) {
      renderError(error);
    }
  }

  function renderEmpty() {
    const body = getBody();
    replaceChildren(body, sectionIntro("Click Refresh to read the current Salesforce context."));
  }

  function renderLoading() {
    const body = getBody();
    const loading = document.createElement("div");
    loading.className = "sf2p-state";
    const spinner = document.createElement("div");
    spinner.className = "sf2p-spinner";
    const text = document.createElement("p");
    text.textContent = "Reading Salesforce context in the page...";
    loading.append(spinner, text);
    replaceChildren(body, loading);
  }

  function renderError(error) {
    const body = getBody();
    const card = document.createElement("section");
    card.className = "sf2p-error";

    const title = document.createElement("h2");
    title.textContent = "Could not read this page";
    const message = document.createElement("p");
    message.textContent = error && error.message || String(error);
    const hint = document.createElement("p");
    hint.className = "sf2p-muted";
    hint.textContent = "Open a Salesforce page, make sure you are signed in, then try Refresh.";

    card.append(title, message, hint);

    if (lastContext) {
      const previous = document.createElement("p");
      previous.className = "sf2p-muted";
      previous.textContent = "Showing no cached values; refresh will retry the live Salesforce APIs.";
      card.append(previous);
    }

    replaceChildren(body, card);
  }

  function renderContext(context) {
    const body = getBody();
    const fragment = document.createDocumentFragment();

    fragment.append(tabs());

    if (activeTab === "permissionSets") {
      fragment.append(permissionSetsTab(context.permissionSets || []));
      if (context.warnings && context.warnings.length) {
        fragment.append(warningsList(context.warnings));
      }
      replaceChildren(body, fragment);
      return;
    }

    fragment.append(sectionIntro("Current Salesforce perspective"));
    fragment.append(perspectiveTable(context));
    fragment.append(recordSummary(context));

    if (context.warnings && context.warnings.length) {
      fragment.append(warningsList(context.warnings));
    }

    replaceChildren(body, fragment);
  }

  function tabs() {
    const nav = document.createElement("nav");
    nav.className = "sf2p-tabs";
    nav.setAttribute("aria-label", "Salesforce Perspectives tabs");
    nav.append(tabButton("Perspective", "perspective"), tabButton("Permission Sets", "permissionSets"));
    return nav;
  }

  function tabButton(label, tabName) {
    const element = button(label, "sf2p-tab");
    element.dataset.active = String(activeTab === tabName);
    element.setAttribute("aria-pressed", String(activeTab === tabName));
    element.addEventListener("click", () => {
      activeTab = tabName;
      if (lastContext) {
        renderContext(lastContext);
      }
    });
    return element;
  }

  function savePdfControl() {
    const element = button("Save As", "sf2p-save-trigger");
    element.title = "Download detailed PDF";
    element.addEventListener("click", exportDetailedPdf);
    return element;
  }

  function permissionSetsTab(permissionSets) {
    const fragment = document.createDocumentFragment();
    fragment.append(sectionIntro(`${permissionSets.length} permission set${permissionSets.length === 1 ? "" : "s"} assigned to this user`));

    if (!permissionSets.length) {
      fragment.append(fieldCard("Permission Sets", "None returned", "Profile-owned permission sets are excluded."));
      return fragment;
    }

    fragment.append(tableSection(
      "Permission Sets",
      ["Label", "API Name", "Namespace", "Permission Set ID", "Assignment ID"],
      permissionSets.map((permissionSet) => [
        permissionSet.label,
        permissionSet.name,
        permissionSet.namespacePrefix,
        permissionSet.id,
        permissionSet.assignmentId
      ])
    ));

    return fragment;
  }

  function perspectiveTable(context) {
    return tableSection("Details", ["Item", "Value", "API Name / ID", "Page URL"], [
      ["Record Type", context.recordType && context.recordType.name, identifierLine(context.recordType), context.currentUrl],
      ["Profile", context.user && context.user.profileName, context.user && context.user.profileId, context.currentUrl],
      ["App Name", context.app && context.app.name, "", context.currentUrl],
      ["Role", context.user && context.user.roleName, context.user && context.user.roleId, context.currentUrl],
      ["Page Layout", context.pageLayout && context.pageLayout.name, identifierLine(context.pageLayout), context.currentUrl],
      ["Lightning Record Page", context.lightningRecordPage && context.lightningRecordPage.name, identifierLine(context.lightningRecordPage), context.currentUrl]
    ]);
  }

  function tableSection(titleText, headers, rows) {
    const section = document.createElement("section");
    section.className = "sf2p-table-section";
    if (headers.length > 3) {
      section.classList.add("sf2p-wide-table");
    }
    const title = document.createElement("h2");
    title.textContent = titleText;
    const scroller = document.createElement("div");
    scroller.className = "sf2p-table-scroll";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    for (const header of headers) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = header;
      headerRow.append(cell);
    }

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const rowElement = document.createElement("tr");
      for (const value of row) {
        const cell = document.createElement("td");
        cell.textContent = value === "" ? "" : value || "Unavailable";
        rowElement.append(cell);
      }
      tbody.append(rowElement);
    }

    thead.append(headerRow);
    table.append(thead, tbody);
    scroller.append(table);
    section.append(title, scroller);
    return section;
  }

  function identifierLine(value) {
    if (!value) {
      return null;
    }

    return [
      value.apiName && `API Name: ${value.apiName}`,
      value.id,
      value.developerName && value.developerName !== value.apiName ? value.developerName : null,
      value.durableId && value.durableId !== value.id && value.durableId !== value.apiName ? value.durableId : null
    ].filter(Boolean).join(" | ");
  }

  async function exportDetailedPdf() {
    if (!lastContext) {
      await refreshContext();
    }
    if (!lastContext) {
      return;
    }

    const content = buildPdfDocument(buildPdfLines(lastContext));
    downloadFile(content, "application/pdf", `${exportFileBaseName(lastContext)}.pdf`);
  }

  function buildPdfLines(context) {
    const lines = [
      "Salesforce Perspectives Detailed Export",
      `Generated at: ${exportValue(context.generatedAt || new Date().toISOString())}`,
      "",
      "Perspective"
    ];

    for (const row of perspectiveExportRows(context)) {
      lines.push(`${row[0]}: ${exportValue(row[1])}`);
      lines.push(`  API Name / ID: ${exportValue(row[2])}`);
      lines.push(`  Page URL: ${exportValue(row[3])}`);
      lines.push(`  Source: ${exportValue(row[4])}`);
    }

    lines.push("", "Page");
    for (const row of pageExportRows(context)) {
      lines.push(`${row[0]}: ${exportValue(row[1])}`);
    }

    lines.push("", "Permission Sets");
    const permissionSetRows = permissionSetExportRows(context);
    for (const row of permissionSetRows) {
      lines.push(`Label: ${exportValue(row[0])}`);
      lines.push(`  API Name: ${exportValue(row[1])}`);
      lines.push(`  Namespace: ${exportValue(row[2])}`);
      lines.push(`  Permission Set ID: ${exportValue(row[3])}`);
      lines.push(`  Assignment ID: ${exportValue(row[4])}`);
    }

    lines.push("", "Notes");
    for (const row of notesExportRows(context)) {
      lines.push(exportValue(row[0]));
    }

    return lines;
  }

  function perspectiveExportRows(context) {
    return [
      ["Record Type", context.recordType && context.recordType.name, identifierLine(context.recordType), context.currentUrl, context.recordType && context.recordType.source],
      ["Profile", context.user && context.user.profileName, context.user && context.user.profileId, context.currentUrl, context.user && context.user.source],
      ["App Name", context.app && context.app.name, "", context.currentUrl, context.app && context.app.source],
      ["Role", context.user && context.user.roleName, context.user && context.user.roleId, context.currentUrl, context.user && context.user.source],
      ["Page Layout", context.pageLayout && context.pageLayout.name, identifierLine(context.pageLayout), context.currentUrl, context.pageLayout && context.pageLayout.source],
      ["Lightning Record Page", context.lightningRecordPage && context.lightningRecordPage.name, identifierLine(context.lightningRecordPage), context.currentUrl, context.lightningRecordPage && context.lightningRecordPage.source]
    ];
  }

  function pageExportRows(context) {
    return [
      ["Object", context.record && context.record.objectApiName],
      ["Record ID", context.record && context.record.id],
      ["Page type", context.record && context.record.pageType],
      ["Org host", context.org && context.org.host],
      ["API version", context.org && context.org.apiVersion],
      ["Current URL", context.currentUrl],
      ["Read at", context.generatedAt]
    ];
  }

  function permissionSetExportRows(context) {
    const permissionSets = context.permissionSets || [];
    if (!permissionSets.length) {
      return [["None returned", "", "", "", ""]];
    }

    return permissionSets.map((permissionSet) => [
      permissionSet.label,
      permissionSet.name,
      permissionSet.namespacePrefix,
      permissionSet.id,
      permissionSet.assignmentId
    ]);
  }

  function notesExportRows(context) {
    const warnings = context.warnings || [];
    return warnings.length ? warnings.map((warning) => [warning]) : [["No notes."]];
  }

  function buildPdfDocument(lines) {
    const pages = paginatePdfLines(lines);
    const objects = [];
    const pageObjectIds = [];

    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push("");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    for (const pageLines of pages) {
      const pageId = objects.length + 1;
      const contentId = pageId + 1;
      pageObjectIds.push(pageId);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
      objects.push(pdfStreamForLines(pageLines));
    }

    objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;

    return serializePdf(objects);
  }

  function paginatePdfLines(lines) {
    const wrapped = lines.flatMap((line) => wrapPdfLine(line, 95));
    const pages = [];
    for (let index = 0; index < wrapped.length; index += 45) {
      pages.push(wrapped.slice(index, index + 45));
    }
    return pages.length ? pages : [["No data available."]];
  }

  function wrapPdfLine(line, maxLength) {
    const value = String(line || "");
    if (value.length <= maxLength) {
      return [value];
    }

    const chunks = [];
    let remaining = value;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = `  ${remaining.slice(maxLength)}`;
    }
    chunks.push(remaining);
    return chunks;
  }

  function pdfStreamForLines(lines) {
    const commands = ["BT", "/F1 10 Tf", "50 750 Td", "14 TL"];
    for (const line of lines) {
      commands.push(`(${escapePdfText(line)}) Tj`, "T*");
    }
    commands.push("ET");
    const stream = commands.join("\n");
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  function serializePdf(objects) {
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (let index = 0; index < objects.length; index += 1) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return pdf;
  }

  function escapePdfText(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
  }

  function exportValue(value) {
    if (value === "") {
      return "";
    }
    return value || "Unavailable";
  }

  function exportFileBaseName(context) {
    const timestamp = String(context.generatedAt || new Date().toISOString()).replace(/[:.]/g, "-");
    return `salesforce-perspectives-${timestamp}`;
  }

  function downloadFile(content, mimeType, fileName) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sectionIntro(text) {
    const section = document.createElement("section");
    section.className = "sf2p-intro";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    section.append(paragraph);
    return section;
  }

  function fieldCard(label, value, detail) {
    const section = document.createElement("section");
    section.className = "sf2p-card";

    const fieldLabel = document.createElement("div");
    fieldLabel.className = "sf2p-label";
    fieldLabel.textContent = label;

    const fieldValue = document.createElement("div");
    fieldValue.className = "sf2p-value";
    fieldValue.textContent = value || "Unavailable";

    section.append(fieldLabel, fieldValue);

    if (detail) {
      const detailElement = document.createElement("div");
      detailElement.className = "sf2p-detail";
      detailElement.textContent = detail;
      section.append(detailElement);
    }

    return section;
  }

  function recordSummary(context) {
    const section = document.createElement("section");
    section.className = "sf2p-summary";

    const title = document.createElement("h2");
    title.textContent = "Page";
    section.append(title);

    const rows = [
      ["Object", context.record && context.record.objectApiName],
      ["Record ID", context.record && context.record.id],
      ["Page type", context.record && context.record.pageType],
      ["Org host", context.org && context.org.host],
      ["API version", context.org && context.org.apiVersion],
      ["Read at", context.generatedAt]
    ];

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "sf2p-row";
      const rowLabel = document.createElement("span");
      rowLabel.textContent = label;
      const rowValue = document.createElement("strong");
      rowValue.textContent = value || "Unavailable";
      row.append(rowLabel, rowValue);
      section.append(row);
    }

    return section;
  }

  function warningsList(warnings) {
    const section = document.createElement("section");
    section.className = "sf2p-warnings";
    const title = document.createElement("h2");
    title.textContent = "Notes";
    const list = document.createElement("ul");

    for (const warning of warnings.slice(0, 8)) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }

    if (warnings.length > 8) {
      const item = document.createElement("li");
      item.textContent = `${warnings.length - 8} more notes omitted.`;
      list.append(item);
    }

    section.append(title, list);
    return section;
  }

  function button(label, className) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    return element;
  }

  function getBody() {
    return shadowRoot.querySelector("[data-role='body']");
  }

  function replaceChildren(parent, child) {
    parent.textContent = "";
    parent.append(child);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function handleWindowMessage(event) {
    if (event.source !== window) {
      return;
    }

    const detail = event.data || {};
    if (!detail || detail.source !== "sf2p" || detail.type !== "api-request" || !detail.requestId || !detail.path) {
      return;
    }

    try {
      const response = await sendMessage({
        type: "SF2P_API_FETCH",
        path: detail.path,
        currentUrl: window.location.href
      });
      dispatchApiResponse(detail.requestId, response || { ok: false, error: "No API response returned." });
    } catch (error) {
      dispatchApiResponse(detail.requestId, { ok: false, error: error.message || String(error) });
    }
  }

  function dispatchApiResponse(requestId, response) {
    window.postMessage({
      source: "sf2p",
      type: "api-response",
      requestId,
      response
    }, window.location.origin);
  }

  function styles() {
    return `
      :host {
        all: initial;
      }

      .sf2p-panel {
        background: #f7f9fb;
        border-left: 1px solid #d8dde6;
        box-shadow: -10px 0 30px rgba(24, 24, 24, 0.18);
        color: #181818;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        height: 100vh;
        line-height: 1.4;
        position: fixed;
        right: 0;
        top: 0;
        transform: translateX(105%);
        transition: transform 160ms ease;
        width: min(420px, 92vw);
        z-index: 2147483647;
      }

      :host([data-open="true"]) .sf2p-panel {
        transform: translateX(0);
      }

      .sf2p-header {
        align-items: center;
        background: linear-gradient(135deg, #0176d3, #032d60);
        color: #fff;
        display: flex;
        justify-content: space-between;
        padding: 18px;
      }

      .sf2p-eyebrow {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        opacity: 0.8;
        text-transform: uppercase;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: 22px;
        font-weight: 700;
      }

      h2 {
        font-size: 14px;
        margin-bottom: 8px;
      }

      .sf2p-actions {
        display: flex;
        gap: 8px;
      }

      button {
        appearance: none;
        background: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-radius: 999px;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        padding: 7px 10px;
      }

      button:hover {
        background: rgba(255, 255, 255, 0.22);
      }

      .sf2p-tabs {
        background: #fff;
        border-bottom: 1px solid #d8dde6;
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
        padding: 12px 16px 0;
      }

      .sf2p-tab {
        background: #f3f3f3;
        border: 1px solid #c9c9c9;
        border-bottom: 0;
        border-radius: 10px 10px 0 0;
        color: #032d60;
        padding: 10px;
      }

      .sf2p-tab:hover,
      .sf2p-tab[data-active="true"] {
        background: #eef4ff;
        border-color: #aacbff;
        color: #0176d3;
      }

      .sf2p-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 12px;
        overflow: auto;
        padding: 16px;
      }

      .sf2p-intro,
      .sf2p-card,
      .sf2p-table-section,
      .sf2p-summary,
      .sf2p-warnings,
      .sf2p-error,
      .sf2p-state {
        background: #fff;
        border: 1px solid #e5e5e5;
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(24, 24, 24, 0.04);
        padding: 14px;
      }

      .sf2p-intro {
        background: #eef4ff;
        border-color: #aacbff;
        color: #032d60;
        font-weight: 600;
      }

      .sf2p-label {
        color: #5c5c5c;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .sf2p-value {
        color: #080707;
        font-size: 18px;
        font-weight: 750;
        margin-top: 4px;
        overflow-wrap: anywhere;
      }

      .sf2p-detail,
      .sf2p-muted {
        color: #706e6b;
        font-size: 12px;
        margin-top: 6px;
        overflow-wrap: anywhere;
      }

      .sf2p-table-scroll {
        overflow-x: auto;
      }

      table {
        border-collapse: collapse;
        table-layout: fixed;
        width: 100%;
      }

      .sf2p-wide-table table {
        min-width: 640px;
      }

      th,
      td {
        border-top: 1px solid #f0f0f0;
        font-size: 12px;
        padding: 9px 8px;
        text-align: left;
        vertical-align: top;
      }

      th {
        color: #5c5c5c;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      td {
        color: #181818;
        overflow-wrap: anywhere;
      }

      .sf2p-row {
        align-items: start;
        border-top: 1px solid #f0f0f0;
        display: grid;
        gap: 10px;
        grid-template-columns: 90px 1fr;
        padding: 8px 0;
      }

      .sf2p-row span {
        color: #5c5c5c;
        font-size: 12px;
      }

      .sf2p-row strong {
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .sf2p-warnings {
        background: #fff8e6;
        border-color: #f9e3b6;
      }

      .sf2p-warnings ul {
        margin: 0;
        padding-left: 18px;
      }

      .sf2p-warnings li {
        color: #5c3b00;
        font-size: 12px;
        margin: 5px 0;
        overflow-wrap: anywhere;
      }

      .sf2p-error {
        background: #fef1ee;
        border-color: #ea001e;
      }

      .sf2p-error h2 {
        color: #ba0517;
      }

      .sf2p-state {
        align-items: center;
        display: flex;
        gap: 12px;
      }

      .sf2p-spinner {
        animation: sf2p-spin 1s linear infinite;
        border: 3px solid #d8dde6;
        border-top-color: #0176d3;
        border-radius: 50%;
        height: 22px;
        width: 22px;
      }

      @keyframes sf2p-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;
  }
})();
