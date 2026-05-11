(() => {
  if (window.__salesforceInlineEditorLoaded) {
    window.dispatchEvent(new CustomEvent("sfie:toggle"));
    return;
  }

  window.__salesforceInlineEditorLoaded = true;

  const EDITABLE_CELL_SELECTOR = [
    "td[role='gridcell']",
    "[role='gridcell']:not(th)",
    "td.slds-cell-edit",
    "tbody td"
  ].join(",");
  const RECORD_ID_PATTERN = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
  const IGNORED_FIELD_KEYS = new Set([
    "action",
    "actions",
    "checkbox",
    "createdby",
    "createdbyid",
    "createddate",
    "createdon",
    "lastmodifiedby",
    "lastmodifiedbyid",
    "lastmodifieddate",
    "lastmodifiedon",
    "rowaction",
    "rowactions",
    "rownumber",
    "selectitem",
    "selection"
  ]);
  const NON_EDITABLE_OBJECTS = new Set([
    "Dashboard",
    "Document",
    "Folder",
    "ListView",
    "Report"
  ]);

  let enabled = true;
  let observer = null;
  let scanTimer = null;
  let activeEditor = null;
  let toastHost = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SFIE_TOGGLE") {
      toggleEnabled();
    }
  });

  window.addEventListener("sfie:toggle", toggleEnabled);
  document.addEventListener("dblclick", onCellDoubleClick, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);

  initialize();

  function initialize() {
    injectStyle();
    ensureToastHost();
    setEnabled(true, false);
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    scheduleScan();
    showToast("Salesforce Inline Editor is on. Double-click highlighted cells to edit.", "info");
  }

  function toggleEnabled() {
    setEnabled(!enabled, true);
  }

  function setEnabled(nextEnabled, announce) {
    enabled = Boolean(nextEnabled);
    document.documentElement.classList.toggle("sfie-enabled", enabled);

    if (enabled) {
      scheduleScan();
    } else {
      closeEditor();
      clearCellMarkers();
    }

    if (announce) {
      showToast(`Salesforce Inline Editor ${enabled ? "enabled" : "disabled"}.`, enabled ? "success" : "info");
    }
  }

  function scheduleScan() {
    if (!enabled || scanTimer) {
      return;
    }

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanCells();
    }, 250);
  }

  function scanCells() {
    if (!enabled || !document.body) {
      return;
    }

    const cells = new Set();
    for (const element of document.querySelectorAll(EDITABLE_CELL_SELECTOR)) {
      const cell = normalizeCell(element);
      if (cell) {
        cells.add(cell);
      }
      if (cells.size >= 1500) {
        break;
      }
    }

    for (const cell of cells) {
      if (isLikelyEditableCell(cell) && getCellContext(cell)) {
        markEditable(cell);
      } else {
        unmarkEditable(cell);
      }
    }
  }

  function clearCellMarkers() {
    for (const cell of document.querySelectorAll(".sfie-editable, .sfie-resolving, .sfie-recently-saved")) {
      unmarkEditable(cell);
      cell.classList.remove("sfie-resolving", "sfie-recently-saved");
      cell.removeAttribute("data-sfie-title");
    }
  }

  function markEditable(cell) {
    cell.classList.add("sfie-editable");
    cell.setAttribute("data-sfie-title", "Double-click to edit with Salesforce Inline Editor");
  }

  function unmarkEditable(cell) {
    cell.classList.remove("sfie-editable");
    cell.removeAttribute("data-sfie-title");
  }

  async function onCellDoubleClick(event) {
    if (!enabled) {
      return;
    }

    const cell = normalizeCell(event.target);
    if (!cell || !cell.classList.contains("sfie-editable")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await openEditor(cell);
  }

  function onDocumentKeyDown(event) {
    if (event.key === "Escape" && activeEditor) {
      event.preventDefault();
      closeEditor();
    }
  }

  async function openEditor(cell) {
    const context = getCellContext(cell);
    if (!context) {
      showToast("This cell does not expose enough row and column information to edit.", "error");
      return;
    }

    closeEditor();
    cell.classList.add("sfie-resolving");

    try {
      const response = await salesforceRequest({
        action: "resolveField",
        context
      });

      if (!response.ok) {
        throw new Error(response.error || "Could not resolve this Salesforce field.");
      }

      renderEditor(cell, context, response.result);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      cell.classList.remove("sfie-resolving");
    }
  }

  function renderEditor(cell, context, resolved) {
    const editor = document.createElement("form");
    editor.className = "sfie-editor";
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      saveEditor(editor, cell, context, resolved);
    });

    const title = document.createElement("div");
    title.className = "sfie-editor-title";
    title.textContent = `${resolved.objectApiName}.${resolved.field.name}`;

    const subtitle = document.createElement("div");
    subtitle.className = "sfie-editor-subtitle";
    subtitle.textContent = `${resolved.field.label} (${resolved.field.type})`;

    const control = createFieldControl(resolved.field, getVisibleCellValue(cell));
    control.classList.add("sfie-editor-control");

    const buttons = document.createElement("div");
    buttons.className = "sfie-editor-buttons";

    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeEditor);

    buttons.append(save, cancel);
    editor.append(title, subtitle, control, buttons);
    document.documentElement.append(editor);
    positionEditor(editor, cell);

    activeEditor = {
      cell,
      editor
    };

    window.setTimeout(() => {
      control.focus();
      if (typeof control.select === "function" && control.tagName !== "SELECT") {
        control.select();
      }
    }, 0);
  }

  async function saveEditor(editor, cell, context, resolved) {
    const control = editor.querySelector(".sfie-editor-control");
    const saveButton = editor.querySelector("button[type='submit']");
    const nextValue = control.value;

    saveButton.disabled = true;
    saveButton.textContent = "Saving...";

    try {
      const response = await salesforceRequest({
        action: "updateField",
        context,
        value: nextValue
      });

      if (!response.ok) {
        throw new Error(response.error || "Salesforce rejected the update.");
      }

      updateVisibleCell(cell, displayValueForCell(nextValue, resolved.field));
      cell.classList.add("sfie-recently-saved");
      window.setTimeout(() => cell.classList.remove("sfie-recently-saved"), 1800);
      closeEditor();
      showToast(`Saved ${resolved.field.label}.`, "success");
      scheduleScan();
    } catch (error) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
      showToast(error.message || String(error), "error");
    }
  }

  function closeEditor() {
    if (activeEditor && activeEditor.editor) {
      activeEditor.editor.remove();
    }
    activeEditor = null;
  }

  function createFieldControl(field, currentValue) {
    if (field.type === "boolean") {
      const select = document.createElement("select");
      appendOption(select, "true", "True");
      appendOption(select, "false", "False");
      select.value = /^(true|yes|checked)$/i.test(currentValue) ? "true" : "false";
      return select;
    }

    if (field.picklistValues && field.picklistValues.length) {
      const select = document.createElement("select");
      if (field.nillable) {
        appendOption(select, "", "-- None --");
      }

      for (const option of field.picklistValues) {
        appendOption(select, option.value, option.label || option.value);
      }

      const matchingOption = Array.from(select.options).find((option) => {
        return cleanText(option.value) === cleanText(currentValue) || cleanText(option.textContent) === cleanText(currentValue);
      });
      select.value = matchingOption ? matchingOption.value : "";
      return select;
    }

    if (field.type === "textarea" || field.length > 255) {
      const textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.value = currentValue;
      return textarea;
    }

    const input = document.createElement("input");
    input.type = inputTypeForField(field.type);
    input.value = inputValueForField(currentValue, field.type);
    return input;
  }

  function appendOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  function inputTypeForField(fieldType) {
    if (["currency", "double", "int", "long", "percent"].includes(fieldType)) {
      return "number";
    }
    if (fieldType === "date") {
      return "date";
    }
    if (fieldType === "datetime") {
      return "datetime-local";
    }
    return "text";
  }

  function inputValueForField(value, fieldType) {
    if (fieldType === "date") {
      const match = value.match(/\d{4}-\d{2}-\d{2}/);
      return match ? match[0] : "";
    }

    if (fieldType === "datetime") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      const offset = date.getTimezoneOffset() * 60000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 16);
    }

    if (["currency", "double", "int", "long", "percent"].includes(fieldType)) {
      return value.replace(/[$,%\s]/g, "").replace(/,/g, "");
    }

    return value;
  }

  function displayValueForCell(value, field) {
    if (field.type === "boolean") {
      return value === "true" ? "True" : "False";
    }

    if (field.picklistValues && field.picklistValues.length) {
      const option = field.picklistValues.find((entry) => entry.value === value);
      return option && option.label || value;
    }

    return value;
  }

  function positionEditor(editor, cell) {
    const rect = cell.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 280), 420);
    const left = Math.min(Math.max(rect.left, 12), window.innerWidth - width - 12);
    const top = rect.bottom + 8 <= window.innerHeight - 170
      ? rect.bottom + 8
      : Math.max(12, rect.top - 170);

    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
    editor.style.width = `${width}px`;
  }

  function updateVisibleCell(cell, value) {
    const target = findDisplayTarget(cell);
    if (target) {
      target.textContent = value || "";
      return;
    }

    cell.textContent = value || "";
  }

  function findDisplayTarget(cell) {
    const selectors = [
      "lightning-formatted-text",
      "lightning-formatted-number",
      "lightning-formatted-email",
      "lightning-formatted-url",
      "span.slds-truncate",
      "a[href]",
      "span",
      "div"
    ];

    for (const selector of selectors) {
      const target = cell.querySelector(selector);
      if (target && cleanText(target.textContent || target.getAttribute("title"))) {
        return target;
      }
    }

    return null;
  }

  function getCellContext(cell) {
    const row = findRow(cell);
    if (!row) {
      return null;
    }

    const record = findRecordContext(cell, row);
    if (!record.recordId) {
      return null;
    }

    const column = findColumnContext(cell, row);
    if (!column.fieldApiName && !column.fieldKey && !column.columnLabel && !column.headerText) {
      return null;
    }

    if (isIgnoredField(column.fieldApiName || column.fieldKey || column.columnLabel || column.headerText)) {
      return null;
    }

    const objectApiName = record.objectApiName || objectApiNameFromPageUrl();
    if (isNonEditableObject(objectApiName)) {
      return null;
    }

    return {
      recordId: record.recordId,
      objectApiName,
      fieldApiName: column.fieldApiName,
      fieldKey: column.fieldKey,
      columnLabel: column.columnLabel,
      headerText: column.headerText,
      ariaLabel: column.ariaLabel
    };
  }

  function findRecordContext(cell, row) {
    const cellAttributeRecord = readRecordAttributes(cell);
    if (cellAttributeRecord.recordId) {
      return cellAttributeRecord;
    }

    const rowAttributeRecord = readRecordAttributes(row);
    if (rowAttributeRecord.recordId) {
      return rowAttributeRecord;
    }

    const descendantRecord = readRecordAttributes(findRecordAttributeElement(cell) || findRecordAttributeElement(row));
    if (descendantRecord.recordId) {
      return descendantRecord;
    }

    const links = [
      ...Array.from(cell.querySelectorAll("a[href]")),
      ...Array.from(row.querySelectorAll("a[href]"))
    ];

    for (const link of links) {
      const parsed = parseRecordUrl(link.href || link.getAttribute("href"));
      if (parsed.recordId) {
        return parsed;
      }
    }

    const rowText = `${row.getAttribute("data-row-key-value") || ""} ${row.getAttribute("aria-label") || ""}`;
    const match = rowText.match(/\b([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/);
    return {
      recordId: match ? match[1] : null,
      objectApiName: objectApiNameFromPageUrl()
    };
  }

  function readRecordAttributes(element) {
    if (!element) {
      return {
        recordId: null,
        objectApiName: null
      };
    }

    const names = [
      "data-record-id",
      "data-recordid",
      "data-row-key-value",
      "data-row-key",
      "record-id"
    ];

    for (const name of names) {
      const value = element.getAttribute && element.getAttribute(name);
      if (RECORD_ID_PATTERN.test(value || "")) {
        return {
          recordId: value,
          objectApiName: objectApiNameFromPageUrl()
        };
      }
    }

    return {
      recordId: null,
      objectApiName: null
    };
  }

  function findRecordAttributeElement(root) {
    return root && root.querySelector && root.querySelector([
      "[data-record-id]",
      "[data-recordid]",
      "[data-row-key-value]",
      "[data-row-key]",
      "[record-id]"
    ].join(","));
  }

  function findColumnContext(cell, row) {
    const fieldApiName = firstAttribute(cell, [
      "data-field-name",
      "data-field",
      "field-name"
    ]);
    const fieldKey = firstAttribute(cell, [
      "data-col-key-value",
      "data-column-key",
      "data-column",
      "col-key-value"
    ]);
    const columnLabel = firstAttribute(cell, [
      "data-label",
      "aria-labelledby"
    ]);
    const headerText = headerTextForCell(cell, row);
    const ariaLabel = cleanAriaLabel(cell.getAttribute("aria-label"));

    return {
      fieldApiName: cleanFieldKey(fieldApiName),
      fieldKey: cleanFieldKey(fieldKey),
      columnLabel: labelFromAttribute(columnLabel),
      headerText,
      ariaLabel
    };
  }

  function headerTextForCell(cell, row) {
    const explicitHeaders = cell.getAttribute("headers");
    if (explicitHeaders) {
      const headerText = explicitHeaders
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .map((header) => header && cleanText(header.textContent || header.getAttribute("title")))
        .filter(Boolean)
        .join(" ");
      if (headerText) {
        return headerText;
      }
    }

    const table = cell.closest("table");
    const cellIndex = tableCellIndex(cell, row);
    if (table && cellIndex >= 0) {
      const headers = Array.from(table.querySelectorAll("thead th, [role='columnheader']"));
      const header = headers[cellIndex];
      const text = header && cleanText(header.textContent || header.getAttribute("title") || header.getAttribute("aria-label"));
      if (text) {
        return text;
      }
    }

    const ariaColumn = Number.parseInt(cell.getAttribute("aria-colindex") || "", 10);
    if (Number.isFinite(ariaColumn)) {
      const header = document.querySelector(`[role='columnheader'][aria-colindex='${ariaColumn}']`);
      const text = header && cleanText(header.textContent || header.getAttribute("title") || header.getAttribute("aria-label"));
      if (text) {
        return text;
      }
    }

    return "";
  }

  function tableCellIndex(cell, row) {
    if (typeof cell.cellIndex === "number" && cell.cellIndex >= 0) {
      return cell.cellIndex;
    }

    const cells = Array.from(row.querySelectorAll("td, th, [role='gridcell'], [role='columnheader']"));
    return cells.indexOf(cell);
  }

  function normalizeCell(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    return element.closest("td, [role='gridcell']");
  }

  function findRow(cell) {
    return cell.closest("[role='row'], tr, .slds-hint-parent, .dataRow");
  }

  function isLikelyEditableCell(cell) {
    if (!cell || cell.closest(".sfie-editor") || !isVisible(cell)) {
      return false;
    }

    if (cell.matches("th, [role='columnheader']")) {
      return false;
    }

    const text = getVisibleCellValue(cell);
    const hasOnlyControl = cell.querySelector("button, input[type='checkbox'], input[type='radio']") && text.length < 2;
    if (hasOnlyControl) {
      return false;
    }

    return true;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function getVisibleCellValue(cell) {
    const text = cleanText(cell.innerText || cell.textContent || cell.getAttribute("title"));
    return text.replace(/\bEdit\b$/i, "").trim();
  }

  function firstAttribute(element, names) {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function cleanFieldKey(value) {
    const cleaned = cleanText(value);
    if (!cleaned) {
      return "";
    }

    return cleaned
      .replace(/^.*:/, "")
      .replace(/\.(value|displayValue)$/i, "")
      .trim();
  }

  function labelFromAttribute(value) {
    if (!value) {
      return "";
    }

    if (value.includes(" ")) {
      const labels = value
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .map((element) => element && cleanText(element.textContent || element.getAttribute("title")))
        .filter(Boolean);
      if (labels.length) {
        return labels.join(" ");
      }
    }

    return cleanText(value);
  }

  function cleanAriaLabel(value) {
    return cleanText(value)
      .replace(/\b(row|column)\s+\d+\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isIgnoredField(value) {
    return IGNORED_FIELD_KEYS.has(cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, ""));
  }

  function isNonEditableObject(value) {
    return NON_EDITABLE_OBJECTS.has(cleanText(value));
  }

  function parseRecordUrl(value) {
    if (!value) {
      return {
        recordId: null,
        objectApiName: null
      };
    }

    try {
      const url = new URL(value, window.location.origin);
      const decodedPath = safeDecode(url.pathname);
      const lightningMatch = decodedPath.match(/\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:[/?#]|$)/);
      if (lightningMatch) {
        return {
          objectApiName: lightningMatch[1],
          recordId: lightningMatch[2]
        };
      }

      const classicMatch = decodedPath.match(/^\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:[/?#]|$)/);
      if (classicMatch) {
        return {
          objectApiName: objectApiNameFromPageUrl(),
          recordId: classicMatch[1]
        };
      }

      const anyIdMatch = `${decodedPath}${url.search}${url.hash}`.match(/\b([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/);
      return {
        objectApiName: objectApiNameFromPageUrl(),
        recordId: anyIdMatch ? anyIdMatch[1] : null
      };
    } catch (_error) {
      return {
        recordId: null,
        objectApiName: null
      };
    }
  }

  function objectApiNameFromPageUrl() {
    try {
      const url = new URL(window.location.href);
      const segments = url.pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
      const lightningIndex = segments.indexOf("lightning");
      const lightningSegments = lightningIndex >= 0 ? segments.slice(lightningIndex + 1) : segments;
      const objectIndex = lightningSegments.indexOf("o");
      if (objectIndex >= 0 && lightningSegments[objectIndex + 1]) {
        return lightningSegments[objectIndex + 1];
      }

      const recordIndex = lightningSegments.indexOf("r");
      if (recordIndex >= 0 && lightningSegments[recordIndex + 1]) {
        return lightningSegments[recordIndex + 1];
      }
    } catch (_error) {
      return null;
    }

    return null;
  }

  function salesforceRequest(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "SFIE_API_REQUEST", payload }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response || { ok: false, error: "No response from Salesforce Inline Editor." });
      });
    });
  }

  function ensureToastHost() {
    if (toastHost) {
      return;
    }

    toastHost = document.createElement("div");
    toastHost.className = "sfie-toast-host";
    document.documentElement.append(toastHost);
  }

  function showToast(message, variant) {
    ensureToastHost();
    const toast = document.createElement("div");
    toast.className = `sfie-toast sfie-toast-${variant || "info"}`;
    toast.textContent = message;
    toastHost.append(toast);

    window.setTimeout(() => {
      toast.classList.add("sfie-toast-exit");
      window.setTimeout(() => toast.remove(), 220);
    }, variant === "error" ? 6500 : 3200);
  }

  function injectStyle() {
    if (document.getElementById("sfie-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "sfie-style";
    style.textContent = `
      html.sfie-enabled .sfie-editable {
        outline: 1px dashed rgba(1, 118, 211, 0.42) !important;
        outline-offset: -2px !important;
        position: relative !important;
      }

      html.sfie-enabled .sfie-editable:hover {
        background: rgba(1, 118, 211, 0.08) !important;
        cursor: cell !important;
      }

      html.sfie-enabled .sfie-editable:hover::after {
        background: #0176d3;
        border-radius: 999px;
        bottom: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
        color: #fff;
        content: "Edit";
        font: 700 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 4px 7px;
        pointer-events: none;
        position: absolute;
        right: 4px;
        z-index: 2147483646;
      }

      html.sfie-enabled .sfie-resolving {
        outline-color: #fe9339 !important;
      }

      html.sfie-enabled .sfie-recently-saved {
        animation: sfie-saved-pulse 1.8s ease-out;
      }

      .sfie-editor {
        background: #fff;
        border: 1px solid #d8dde6;
        border-radius: 12px;
        box-shadow: 0 14px 38px rgba(24, 24, 24, 0.26);
        box-sizing: border-box;
        color: #181818;
        display: grid;
        gap: 8px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        padding: 12px;
        position: fixed;
        z-index: 2147483647;
      }

      .sfie-editor-title {
        color: #032d60;
        font-weight: 800;
        overflow-wrap: anywhere;
      }

      .sfie-editor-subtitle {
        color: #706e6b;
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      .sfie-editor-control {
        background: #fff;
        border: 1px solid #747474;
        border-radius: 6px;
        box-sizing: border-box;
        color: #080707;
        font: inherit;
        min-height: 34px;
        padding: 7px 9px;
        width: 100%;
      }

      textarea.sfie-editor-control {
        resize: vertical;
      }

      .sfie-editor-buttons {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      .sfie-editor button {
        appearance: none;
        border: 1px solid #0176d3;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 6px 12px;
      }

      .sfie-editor button[type="submit"] {
        background: #0176d3;
        color: #fff;
      }

      .sfie-editor button[type="button"] {
        background: #fff;
        color: #0176d3;
      }

      .sfie-editor button:disabled {
        cursor: wait;
        opacity: 0.72;
      }

      .sfie-toast-host {
        display: grid;
        gap: 8px;
        pointer-events: none;
        position: fixed;
        right: 18px;
        top: 78px;
        width: min(420px, calc(100vw - 36px));
        z-index: 2147483647;
      }

      .sfie-toast {
        background: #032d60;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(24, 24, 24, 0.24);
        color: #fff;
        font: 700 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 12px 14px;
        transition: opacity 180ms ease, transform 180ms ease;
      }

      .sfie-toast-success {
        background: #2e844a;
      }

      .sfie-toast-error {
        background: #ba0517;
      }

      .sfie-toast-exit {
        opacity: 0;
        transform: translateY(-8px);
      }

      @keyframes sfie-saved-pulse {
        0% {
          background: rgba(46, 132, 74, 0.28);
        }
        100% {
          background: transparent;
        }
      }
    `;
    document.documentElement.append(style);
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }
})();
