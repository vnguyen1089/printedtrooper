const SALESFORCE_HOST_SUFFIXES = [
  ".salesforce.com",
  ".force.com",
  ".lightning.force.com",
  ".visualforce.com",
  ".salesforce-sites.com",
  ".my.site.com"
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isSalesforceUrl(tab.url)) {
    await flashBadge("!");
    return;
  }

  try {
    await sendToggle(tab.id);
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content.js"]
      });
      await sendToggle(tab.id);
    } catch (injectionError) {
      console.error("Salesforce Inline Editor could not start.", injectionError);
      await flashBadge("!");
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SFIE_API_REQUEST") {
    return false;
  }

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "Could not identify the Salesforce tab." });
    return false;
  }

  runSalesforceApiRequest(tabId, message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("Salesforce Inline Editor request failed.", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

function isSalesforceUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const { protocol, hostname } = new URL(url);
    const normalizedHost = hostname.toLowerCase();
    return protocol === "https:" && SALESFORCE_HOST_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix));
  } catch (_error) {
    return false;
  }
}

async function sendToggle(tabId) {
  await chrome.tabs.sendMessage(tabId, { type: "SFIE_TOGGLE" });
}

async function flashBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#ba0517" });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }, 2000);
}

async function runSalesforceApiRequest(tabId, payload) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: salesforceApiBridge,
    args: [payload]
  });

  if (!result || !result.result) {
    return { ok: false, error: "Salesforce did not return a response." };
  }

  return result.result;
}

async function salesforceApiBridge(payload) {
  const warnings = [];

  try {
    if (!payload || !payload.action) {
      throw new Error("No Salesforce Inline Editor action was provided.");
    }

    const apiVersion = await getLatestApiVersion();

    if (payload.action === "resolveField") {
      const resolved = await resolveField(apiVersion, payload.context || {});
      return {
        ok: true,
        apiVersion,
        result: resolved,
        warnings
      };
    }

    if (payload.action === "updateField") {
      const resolved = await resolveField(apiVersion, payload.context || {});
      const parsedValue = parseFieldValue(payload.value, resolved.field);

      await apiFetch(`/services/data/v${apiVersion}/sobjects/${encodeURIComponent(resolved.objectApiName)}/${encodeURIComponent(resolved.recordId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          [resolved.field.name]: parsedValue
        })
      });

      return {
        ok: true,
        apiVersion,
        result: {
          ...resolved,
          savedValue: parsedValue
        },
        warnings
      };
    }

    throw new Error(`Unsupported Salesforce Inline Editor action: ${payload.action}`);
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      warnings
    };
  }

  async function getLatestApiVersion() {
    const versions = await attempt("API versions", () => apiFetch("/services/data/"));
    if (!Array.isArray(versions) || versions.length === 0) {
      warnings.push("Could not read /services/data/. Falling back to API v60.0.");
      return "60.0";
    }

    const latest = versions
      .map((version) => version.version)
      .filter(Boolean)
      .sort((left, right) => Number.parseFloat(right) - Number.parseFloat(left))[0];

    return latest || "60.0";
  }

  async function resolveField(apiVersion, context) {
    const recordId = normalizeId(context.recordId);
    if (!recordId) {
      throw new Error("This row does not expose a Salesforce record ID.");
    }

    const objectApiName = context.objectApiName || await resolveObjectFromRecordPrefix(apiVersion, recordId);
    if (!objectApiName) {
      throw new Error(`Could not resolve the object type for record ${recordId}.`);
    }

    const describe = await apiFetch(`/services/data/v${apiVersion}/sobjects/${encodeURIComponent(objectApiName)}/describe`);
    const field = findField(describe.fields || [], context);
    if (!field) {
      throw new Error(fieldNotFoundMessage(objectApiName, context, describe.fields || []));
    }

    if (!field.updateable) {
      throw new Error(`${field.label || field.name} (${field.name}) is not updateable for ${objectApiName}.`);
    }

    if (field.calculated || field.autoNumber) {
      throw new Error(`${field.label || field.name} (${field.name}) is calculated or auto-numbered and cannot be edited.`);
    }

    return {
      recordId,
      objectApiName,
      field: {
        name: field.name,
        label: field.label || field.name,
        type: field.type,
        updateable: Boolean(field.updateable),
        nillable: Boolean(field.nillable),
        length: field.length || null,
        picklistValues: Array.isArray(field.picklistValues)
          ? field.picklistValues
              .filter((entry) => entry && entry.active !== false)
              .map((entry) => ({
                label: entry.label || entry.value,
                value: entry.value
              }))
          : []
      }
    };
  }

  async function resolveObjectFromRecordPrefix(apiVersion, recordId) {
    const prefix = recordId.slice(0, 3);
    const describe = await apiFetch(`/services/data/v${apiVersion}/sobjects/`);
    const match = describe && Array.isArray(describe.sobjects)
      ? describe.sobjects.find((object) => object.keyPrefix === prefix)
      : null;
    return match && match.name || null;
  }

  function findField(fields, context) {
    const candidates = candidateNames(context);
    const updateableFields = fields.filter((field) => field && field.updateable);
    const allFields = updateableFields.length ? updateableFields : fields;

    for (const candidate of candidates) {
      const exactName = allFields.find((field) => lower(field.name) === lower(candidate));
      if (exactName) {
        return exactName;
      }
    }

    for (const candidate of candidates) {
      const exactLabel = allFields.find((field) => lower(field.label) === lower(candidate));
      if (exactLabel) {
        return exactLabel;
      }
    }

    const normalizedCandidates = candidates.map((candidate) => normalizeLabel(candidate)).filter(Boolean);
    for (const candidate of normalizedCandidates) {
      const normalizedLabel = allFields.find((field) => normalizeLabel(field.label) === candidate);
      if (normalizedLabel) {
        return normalizedLabel;
      }
    }

    for (const candidate of normalizedCandidates) {
      const normalizedName = allFields.find((field) => normalizeLabel(field.name) === candidate);
      if (normalizedName) {
        return normalizedName;
      }
    }

    return null;
  }

  function candidateNames(context) {
    const raw = [
      context.fieldApiName,
      context.fieldKey,
      context.columnLabel,
      context.headerText,
      context.ariaLabel
    ];
    const candidates = [];

    for (const value of raw) {
      if (!value || typeof value !== "string") {
        continue;
      }

      const cleaned = cleanColumnLabel(value);
      if (cleaned) {
        candidates.push(cleaned);
      }

      if (value.includes(".")) {
        const parts = value.split(".").map((part) => cleanColumnLabel(part)).filter(Boolean);
        candidates.push(parts[parts.length - 1]);
      }

      if (value.includes(":")) {
        const parts = value.split(":").map((part) => cleanColumnLabel(part)).filter(Boolean);
        candidates.push(parts[parts.length - 1]);
      }
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  function cleanColumnLabel(value) {
    return String(value || "")
      .replace(/\b(sorted|ascending|descending|editable|read only|read-only)\b/gi, " ")
      .replace(/\b(row|column)\s+\d+\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[*:.\-\s]+|[*:.\-\s]+$/g, "");
  }

  function normalizeLabel(value) {
    return cleanColumnLabel(value)
      .toLowerCase()
      .replace(/__c$/i, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  function fieldNotFoundMessage(objectApiName, context, fields) {
    const candidates = candidateNames(context);
    const examples = fields
      .filter((field) => field && field.updateable)
      .slice(0, 8)
      .map((field) => `${field.label || field.name} (${field.name})`)
      .join(", ");

    return [
      `Could not match column "${candidates[0] || "unknown"}" to an updateable ${objectApiName} field.`,
      examples ? `Examples of updateable fields: ${examples}.` : ""
    ].filter(Boolean).join(" ");
  }

  function parseFieldValue(rawValue, field) {
    const value = rawValue == null ? "" : String(rawValue).trim();
    if (value === "") {
      if (!field.nillable) {
        throw new Error(`${field.label || field.name} is required and cannot be blank.`);
      }
      return null;
    }

    if (field.type === "boolean") {
      if (/^(true|yes|y|1|checked)$/i.test(value)) {
        return true;
      }
      if (/^(false|no|n|0|unchecked)$/i.test(value)) {
        return false;
      }
      throw new Error(`${field.label || field.name} expects true or false.`);
    }

    if (["currency", "double", "percent"].includes(field.type)) {
      const numeric = Number(value.replace(/[$,%\s]/g, "").replace(/,/g, ""));
      if (!Number.isFinite(numeric)) {
        throw new Error(`${field.label || field.name} expects a number.`);
      }
      return numeric;
    }

    if (["int", "long"].includes(field.type)) {
      const integer = Number.parseInt(value.replace(/[,\s]/g, ""), 10);
      if (!Number.isFinite(integer)) {
        throw new Error(`${field.label || field.name} expects a whole number.`);
      }
      return integer;
    }

    if (field.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${field.label || field.name} expects a date in YYYY-MM-DD format.`);
      }
      return value;
    }

    if (field.type === "datetime") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`${field.label || field.name} expects a valid date and time.`);
      }
      return parsed.toISOString();
    }

    if (field.type === "reference" && !/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value)) {
      throw new Error(`${field.label || field.name} expects a Salesforce record ID.`);
    }

    return value;
  }

  async function apiFetch(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        "Accept": "application/json",
        ...options.headers
      },
      body: options.body
    });

    const text = await response.text();
    let body = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_error) {
        body = text;
      }
    }

    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${salesforceErrorMessage(body)}`);
    }

    return body;
  }

  async function attempt(label, task) {
    try {
      return await task();
    } catch (error) {
      warnings.push(`${label}: ${error.message || String(error)}`);
      return null;
    }
  }

  function normalizeId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value) ? value : null;
  }

  function lower(value) {
    return String(value || "").toLowerCase();
  }

  function salesforceErrorMessage(body) {
    if (Array.isArray(body)) {
      return body.map((entry) => entry && entry.message || JSON.stringify(entry)).join("; ");
    }
    if (body && typeof body === "object") {
      return body.message || body.error_description || body.error || JSON.stringify(body);
    }
    return body || "No response body";
  }
}
