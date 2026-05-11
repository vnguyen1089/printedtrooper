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

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SF2P_TOGGLE_PANEL") {
      togglePanel();
    }
  });

  window.addEventListener("sf2p:toggle", togglePanel);

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
    title.textContent = "2 Perspective";
    titleGroup.append(eyebrow, title);

    const actions = document.createElement("div");
    actions.className = "sf2p-actions";
    const refresh = button("Refresh", "sf2p-refresh");
    refresh.addEventListener("click", refreshContext);
    const close = button("Close", "sf2p-close");
    close.addEventListener("click", () => {
      isOpen = false;
      panelHost.dataset.open = "false";
    });
    actions.append(refresh, close);
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

    fragment.append(sectionIntro("Current Salesforce perspective"));
    fragment.append(fieldCard("Record Type", context.recordType && context.recordType.name, context.recordType && detailLine(context.recordType)));
    fragment.append(fieldCard("Profile", context.user && context.user.profileName, context.user && detailLine({ id: context.user.profileId, source: context.user.source })));
    fragment.append(fieldCard("App", context.app && context.app.name, context.app && detailLine(context.app)));
    fragment.append(fieldCard("Role", context.user && context.user.roleName, context.user && detailLine({ id: context.user.roleId, source: context.user.source })));
    fragment.append(fieldCard("Page Layout", context.pageLayout && context.pageLayout.name, context.pageLayout && detailLine(context.pageLayout)));
    fragment.append(recordSummary(context));

    if (context.warnings && context.warnings.length) {
      fragment.append(warningsList(context.warnings));
    }

    replaceChildren(body, fragment);
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
    const section = document.createElement("details");
    section.className = "sf2p-warnings";
    const title = document.createElement("h2");
    title.textContent = "Diagnostics";
    const summary = document.createElement("summary");
    summary.textContent = "Show diagnostics";
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

    section.append(summary, title, list);
    return section;
  }

  function detailLine(value) {
    const parts = [];
    if (value.id) {
      parts.push(value.id);
    }
    if (value.developerName) {
      parts.push(value.developerName);
    }
    if (value.durableId && value.durableId !== value.id) {
      parts.push(value.durableId);
    }
    if (value.source) {
      parts.push(value.source);
    }
    return parts.join(" | ");
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

      .sf2p-warnings summary {
        color: #5c3b00;
        cursor: pointer;
        font-size: 13px;
        font-weight: 700;
      }

      .sf2p-warnings h2 {
        margin-top: 10px;
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
