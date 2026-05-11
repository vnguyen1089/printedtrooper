const SALESFORCE_HOST_SUFFIXES = [
  ".salesforce.com",
  ".my.salesforce.com",
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
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content.js"]
      });
      await sendToggle(tab.id);
    } catch (injectionError) {
      console.error("Salesforce Perspectives could not open the side panel.", injectionError);
      await flashBadge("!");
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SF2P_COLLECT_CONTEXT") {
    return false;
  }

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "Could not identify the Salesforce tab." });
    return false;
  }

  collectContext(tabId)
    .then((context) => sendResponse({ ok: true, context }))
    .catch((error) => {
      console.error("Salesforce Perspectives collection failed.", error);
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
  await chrome.tabs.sendMessage(tabId, { type: "SF2P_TOGGLE_PANEL" });
}

async function flashBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#ba0517" });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }, 2000);
}

async function collectContext(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: collectSalesforcePerspectiveInPage
  });

  if (!result || !result.result) {
    throw new Error("Salesforce did not return any page context.");
  }

  if (!result.result.ok) {
    throw new Error(result.result.error || "Salesforce page context collection failed.");
  }

  return enrichContextFromBackground(result.result);
}

async function enrichContextFromBackground(pageContext) {
  if (!needsBackgroundEnrichment(pageContext)) {
    return pageContext;
  }

  const warnings = [...(pageContext.warnings || [])];

  try {
    const apiClient = await createSalesforceApiClient(pageContext.currentUrl);
    if (!apiClient) {
      warnings.push("Background API fallback: no Salesforce API session cookie was available for the org host.");
      return withWarnings(pageContext, summarizeWarnings(warnings));
    }

    const apiVersion = await apiClient.getLatestApiVersion(pageContext.org && pageContext.org.apiVersion);
    const parsedPage = {
      recordId: pageContext.record && pageContext.record.id || null,
      objectApiName: pageContext.record && pageContext.record.objectApiName || null
    };

    const user = await resolveUserFromApi(apiClient, apiVersion, pageContext.user, warnings);
    const objectInfo = parsedPage.objectApiName
      ? await attemptBackground(warnings, "Background object info", () => apiClient.fetchJson(`/services/data/v${apiVersion}/ui-api/object-info/${encodeURIComponent(parsedPage.objectApiName)}`))
      : null;
    const recordType = await resolveRecordTypeFromApi(apiClient, apiVersion, parsedPage, objectInfo, pageContext.recordType, warnings);
    const pageLayout = await resolvePageLayoutFromApi(apiClient, apiVersion, parsedPage, user, recordType, pageContext.pageLayout, warnings);

    return {
      ...pageContext,
      org: {
        ...(pageContext.org || {}),
        apiVersion,
        apiHost: apiClient.origin
      },
      user,
      recordType,
      pageLayout,
      warnings: summarizeWarnings(warnings)
    };
  } catch (error) {
    warnings.push(`Background API fallback: ${error.message || String(error)}`);
    return withWarnings(pageContext, summarizeWarnings(warnings));
  }
}

function needsBackgroundEnrichment(context) {
  const values = [
    context.recordType && context.recordType.name,
    context.user && context.user.profileName,
    context.user && context.user.roleName,
    context.pageLayout && context.pageLayout.name
  ];
  return values.some((value) => !value || value === "Unavailable");
}

async function createSalesforceApiClient(currentUrl) {
  const origins = apiOriginsForUrl(currentUrl);

  for (const origin of origins) {
    const token = await readSalesforceSessionToken(origin);
    const candidates = token ? [token, null] : [null];

    for (const candidateToken of candidates) {
      const client = new SalesforceApiClient(origin, candidateToken);
      if (await client.canAuthenticate()) {
        return client;
      }
    }
  }

  return null;
}

function apiOriginsForUrl(currentUrl) {
  const origins = [];

  try {
    const url = new URL(currentUrl);
    addOrigin(origins, url.origin);

    const hostname = url.hostname.toLowerCase();
    if (hostname.endsWith(".lightning.force.com")) {
      addOrigin(origins, `https://${hostname.replace(/\.lightning\.force\.com$/, ".my.salesforce.com")}`);
    }
    if (hostname.endsWith(".my.salesforce.com")) {
      addOrigin(origins, url.origin);
    }
    if (hostname.endsWith(".salesforce.com") && !hostname.endsWith(".my.salesforce.com")) {
      addOrigin(origins, url.origin);
    }
  } catch (_error) {
    // The caller handles the lack of a usable API origin.
  }

  return origins;
}

function addOrigin(origins, origin) {
  if (origin && !origins.includes(origin)) {
    origins.push(origin);
  }
}

async function readSalesforceSessionToken(origin) {
  try {
    const cookies = await chrome.cookies.getAll({ url: origin });
    const sid = cookies.find((cookie) => cookie.name === "sid")
      || cookies.find((cookie) => cookie.name.toLowerCase().startsWith("sid"));
    return sid && sid.value || null;
  } catch (_error) {
    return null;
  }
}

class SalesforceApiClient {
  constructor(origin, token) {
    this.origin = origin;
    this.token = token;
  }

  async canAuthenticate() {
    try {
      await this.fetchJson("/services/oauth2/userinfo");
      return true;
    } catch (_error) {
      try {
        const response = await this.query("60.0", "SELECT Id FROM User LIMIT 1");
        return Boolean(response && Array.isArray(response.records));
      } catch (__error) {
        return false;
      }
    }
  }

  async getLatestApiVersion(fallbackVersion) {
    const versions = await this.fetchJson("/services/data/");
    if (!Array.isArray(versions) || versions.length === 0) {
      return fallbackVersion || "60.0";
    }

    return versions
      .map((version) => version.version)
      .filter(Boolean)
      .sort((left, right) => Number.parseFloat(right) - Number.parseFloat(left))[0] || fallbackVersion || "60.0";
  }

  async query(apiVersion, soql) {
    return this.fetchJson(`/services/data/v${apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  }

  async toolingQuery(apiVersion, soql) {
    return this.fetchJson(`/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  }

  async fetchJson(path) {
    const headers = {
      "Accept": "application/json"
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.origin}${path}`, {
      method: "GET",
      credentials: "include",
      headers
    });
    const text = await response.text();
    const body = parseJsonBody(text);

    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${salesforceErrorMessageForBackground(body)}`);
    }

    return body;
  }
}

async function resolveUserFromApi(apiClient, apiVersion, existingUser, warnings) {
  const userId = existingUser && existingUser.id;
  if (!userId || !isSalesforceIdForBackground(userId)) {
    return existingUser || unavailableUser("No current user id was found in the Salesforce page.");
  }

  const soql = [
    "SELECT Id, Name, ProfileId, Profile.Name, UserRoleId, UserRole.Name",
    "FROM User",
    `WHERE Id = '${soqlStringForBackground(userId)}'`,
    "LIMIT 1"
  ].join(" ");
  const response = await attemptBackground(warnings, "Background user profile and role", () => apiClient.query(apiVersion, soql));
  const record = response && response.records && response.records[0];

  if (!record) {
    return existingUser || unavailableUser("Background User query returned no rows.");
  }

  return {
    id: record.Id,
    name: record.Name,
    profileId: record.ProfileId || null,
    profileName: record.Profile && record.Profile.Name || "Unavailable",
    roleId: record.UserRoleId || null,
    roleName: record.UserRole && record.UserRole.Name || "No role assigned",
    source: "Background REST SOQL User query"
  };
}

async function resolveRecordTypeFromApi(apiClient, apiVersion, parsedPage, objectInfo, existingRecordType, warnings) {
  if (!parsedPage.recordId || !parsedPage.objectApiName) {
    return existingRecordType;
  }

  let recordTypeId = existingRecordType && existingRecordType.id || null;

  if (!recordTypeId) {
    const fields = encodeURIComponent(`${parsedPage.objectApiName}.RecordTypeId`);
    const uiRecord = await attemptBackground(
      warnings,
      "Background UI API record type field",
      () => apiClient.fetchJson(`/services/data/v${apiVersion}/ui-api/records/${encodeURIComponent(parsedPage.recordId)}?fields=${fields}`)
    );

    if (uiRecord && uiRecord.fields && uiRecord.fields.RecordTypeId) {
      recordTypeId = uiRecord.fields.RecordTypeId.value || null;
    }
  }

  if (!recordTypeId && isSafeObjectApiNameForBackground(parsedPage.objectApiName)) {
    const soql = [
      "SELECT RecordTypeId",
      `FROM ${parsedPage.objectApiName}`,
      `WHERE Id = '${soqlStringForBackground(parsedPage.recordId)}'`,
      "LIMIT 1"
    ].join(" ");
    const response = await attemptBackground(warnings, "Background record type SOQL fallback", () => apiClient.query(apiVersion, soql));
    const record = response && response.records && response.records[0];
    recordTypeId = record && record.RecordTypeId || null;
  }

  if (recordTypeId && objectInfo && objectInfo.recordTypeInfos && objectInfo.recordTypeInfos[recordTypeId]) {
    const recordTypeInfo = objectInfo.recordTypeInfos[recordTypeId];
    return {
      id: recordTypeId,
      name: recordTypeInfo.name || recordTypeInfo.developerName || recordTypeId,
      developerName: recordTypeInfo.developerName || null,
      source: "Background UI API object info"
    };
  }

  if (!recordTypeId && objectInfo && objectInfo.recordTypeInfos) {
    const master = Object.values(objectInfo.recordTypeInfos).find((recordTypeInfo) => recordTypeInfo.master);
    if (master) {
      return {
        id: master.recordTypeId || null,
        name: master.name || "Master",
        developerName: master.developerName || "Master",
        source: "Background UI API object info"
      };
    }
  }

  return existingRecordType || {
    id: recordTypeId,
    name: recordTypeId || "Unavailable",
    developerName: null,
    source: recordTypeId ? "Background RecordTypeId field" : "Record type was not available"
  };
}

async function resolvePageLayoutFromApi(apiClient, apiVersion, parsedPage, user, recordType, existingPageLayout, warnings) {
  if (!parsedPage.objectApiName || !user || !user.profileId) {
    return existingPageLayout;
  }

  const recordTypeCondition = recordType && recordType.id
    ? `RecordTypeId = '${soqlStringForBackground(recordType.id)}'`
    : "RecordTypeId = null";
  const assignmentQuery = [
    "SELECT Id, LayoutId, Layout.Name, ProfileId, RecordTypeId, TableEnumOrId",
    "FROM ProfileLayout",
    `WHERE ProfileId = '${soqlStringForBackground(user.profileId)}'`,
    `AND TableEnumOrId = '${soqlStringForBackground(parsedPage.objectApiName)}'`,
    `AND ${recordTypeCondition}`,
    "LIMIT 1"
  ].join(" ");
  let response = await attemptBackground(warnings, "Background Tooling ProfileLayout assignment", () => apiClient.toolingQuery(apiVersion, assignmentQuery));
  let assignment = response && response.records && response.records[0];

  if (!assignment && recordType && recordType.id) {
    const fallbackQuery = [
      "SELECT Id, LayoutId, Layout.Name, ProfileId, RecordTypeId, TableEnumOrId",
      "FROM ProfileLayout",
      `WHERE ProfileId = '${soqlStringForBackground(user.profileId)}'`,
      `AND TableEnumOrId = '${soqlStringForBackground(parsedPage.objectApiName)}'`,
      "AND RecordTypeId = null",
      "LIMIT 1"
    ].join(" ");
    response = await attemptBackground(warnings, "Background Tooling default ProfileLayout assignment", () => apiClient.toolingQuery(apiVersion, fallbackQuery));
    assignment = response && response.records && response.records[0];
  }

  if (assignment) {
    return {
      id: assignment.LayoutId || assignment.Id || null,
      name: assignment.Layout && assignment.Layout.Name || assignment.LayoutId || "Assigned layout",
      source: "Background Tooling API ProfileLayout assignment"
    };
  }

  const recordTypeParam = recordType && recordType.id ? `&recordTypeId=${encodeURIComponent(recordType.id)}` : "";
  const layout = await attemptBackground(
    warnings,
    "Background UI API layout fallback",
    () => apiClient.fetchJson(`/services/data/v${apiVersion}/ui-api/layout/${encodeURIComponent(parsedPage.objectApiName)}/Full/View?formFactor=Large${recordTypeParam}`)
  );

  if (layout) {
    return {
      id: layout.id || null,
      name: layout.name || layout.fullName || "Resolved by UI API",
      source: "Background UI API layout fallback"
    };
  }

  return existingPageLayout;
}

async function attemptBackground(warnings, label, task) {
  try {
    return await task();
  } catch (error) {
    warnings.push(`${label}: ${error.message || String(error)}`);
    return null;
  }
}

function withWarnings(context, warnings) {
  return {
    ...context,
    warnings
  };
}

function summarizeWarnings(warnings) {
  const unique = [...new Set(warnings.filter(Boolean))];
  const sessionFailures = unique.filter((warning) => /Session expired or invalid|INVALID_SESSION_ID|Failed to fetch/i.test(warning));
  const otherWarnings = unique.filter((warning) => !sessionFailures.includes(warning));

  if (sessionFailures.length > 0) {
    otherWarnings.push(
      "Lightning REST session was not API-enabled, so Salesforce Perspectives tried the background API-host fallback."
    );
  }

  return otherWarnings.slice(0, 10);
}

function unavailableUser(source) {
  return {
    id: null,
    name: "Unavailable",
    profileId: null,
    profileName: "Unavailable",
    roleId: null,
    roleName: "Unavailable",
    source
  };
}

function parseJsonBody(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function isSalesforceIdForBackground(value) {
  return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

function isSafeObjectApiNameForBackground(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

function soqlStringForBackground(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function salesforceErrorMessageForBackground(body) {
  if (Array.isArray(body)) {
    return body.map((entry) => entry && entry.message || JSON.stringify(entry)).join("; ");
  }
  if (body && typeof body === "object") {
    return body.message || body.error_description || body.error || JSON.stringify(body);
  }
  return body || "No response body";
}

async function collectSalesforcePerspectiveInPage() {
  const warnings = [];
  const generatedAt = new Date().toISOString();

  try {
    const parsedPage = parseSalesforcePage();
    const apiVersion = await getLatestApiVersion();
    let user = await getCurrentUser(apiVersion);

    if (!parsedPage.objectApiName && parsedPage.recordId) {
      const objectFromPrefix = await resolveObjectFromRecordPrefix(apiVersion, parsedPage.recordId);
      if (objectFromPrefix) {
        parsedPage.objectApiName = objectFromPrefix;
      }
    }

    const objectInfo = parsedPage.objectApiName
      ? await attempt("Object info", () => apiFetch(`/services/data/v${apiVersion}/ui-api/object-info/${encodeURIComponent(parsedPage.objectApiName)}`))
      : null;

    const recordType = await resolveRecordType(apiVersion, parsedPage, objectInfo);
    const pageLayout = await resolvePageLayout(apiVersion, parsedPage, user, recordType);

    return {
      ok: true,
      generatedAt,
      currentUrl: window.location.href,
      org: {
        host: window.location.host,
        apiVersion
      },
      user,
      record: {
        id: parsedPage.recordId || null,
        objectApiName: parsedPage.objectApiName || null,
        pageType: parsedPage.pageType || "unknown"
      },
      recordType,
      pageLayout,
      warnings
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      generatedAt,
      currentUrl: window.location.href,
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

  async function getCurrentUser(apiVersion) {
    const pageUser = getUserFromPageGlobals();
    const pageUserId = pageUser.id;
    const userInfo = await attempt("OAuth user info", () => apiFetch("/services/oauth2/userinfo"));
    const userId = pageUserId || userInfo && (userInfo.user_id || userInfo.userId || idFromIdentityUrl(userInfo.sub));

    if (!userId || !isSalesforceId(userId)) {
      return {
        id: userId || null,
        name: userInfo && (userInfo.name || userInfo.preferred_username) || "Unavailable",
        profileId: null,
        profileName: "Unavailable",
        roleId: null,
        roleName: "Unavailable",
        source: "OAuth userinfo; SOQL user lookup unavailable"
      };
    }

    const soql = [
      "SELECT Id, Name, ProfileId, Profile.Name, UserRoleId, UserRole.Name",
      "FROM User",
      `WHERE Id = '${soqlString(userId)}'`,
      "LIMIT 1"
    ].join(" ");
    const response = await attempt("User profile and role", () => query(apiVersion, soql));
    const record = response && response.records && response.records[0];

    if (!record) {
      return {
        id: userId,
        name: pageUser.name || userInfo && (userInfo.name || userInfo.preferred_username) || "Unavailable",
        profileId: pageUser.profileId || null,
        profileName: pageUser.profileName || "Unavailable",
        roleId: pageUser.roleId || null,
        roleName: pageUser.roleName || "Unavailable",
        source: pageUser.profileName || pageUser.roleName
          ? "Lightning page current-user globals"
          : "Current user id; SOQL user lookup returned no rows"
      };
    }

    return {
      id: record.Id,
      name: record.Name,
      profileId: record.ProfileId || null,
      profileName: record.Profile && record.Profile.Name || "Unavailable",
      roleId: record.UserRoleId || null,
      roleName: record.UserRole && record.UserRole.Name || "No role assigned",
      source: "REST SOQL User query"
    };
  }

  async function resolveObjectFromRecordPrefix(apiVersion, recordId) {
    const prefix = recordId.slice(0, 3);
    const describe = await attempt("Global object describe", () => apiFetch(`/services/data/v${apiVersion}/sobjects/`));
    const match = describe && Array.isArray(describe.sobjects)
      ? describe.sobjects.find((object) => object.keyPrefix === prefix)
      : null;
    return match && match.name || null;
  }

  async function resolveRecordType(apiVersion, parsedPage, objectInfo) {
    if (!parsedPage.recordId || !parsedPage.objectApiName) {
      return {
        id: null,
        name: "Not on a record page",
        developerName: null,
        source: "URL context"
      };
    }

    let recordTypeId = null;
    const fields = encodeURIComponent(`${parsedPage.objectApiName}.RecordTypeId`);
    const uiRecord = await attempt(
      "UI API record type field",
      () => apiFetch(`/services/data/v${apiVersion}/ui-api/records/${encodeURIComponent(parsedPage.recordId)}?fields=${fields}`)
    );

    if (uiRecord && uiRecord.fields && uiRecord.fields.RecordTypeId) {
      recordTypeId = uiRecord.fields.RecordTypeId.value || null;
    }

    if (!recordTypeId && isSafeObjectApiName(parsedPage.objectApiName)) {
      const soql = [
        "SELECT RecordTypeId",
        `FROM ${parsedPage.objectApiName}`,
        `WHERE Id = '${soqlString(parsedPage.recordId)}'`,
        "LIMIT 1"
      ].join(" ");
      const response = await attempt("Record type SOQL fallback", () => query(apiVersion, soql));
      const record = response && response.records && response.records[0];
      recordTypeId = record && record.RecordTypeId || null;
    }

    if (recordTypeId && objectInfo && objectInfo.recordTypeInfos && objectInfo.recordTypeInfos[recordTypeId]) {
      const recordTypeInfo = objectInfo.recordTypeInfos[recordTypeId];
      return {
        id: recordTypeId,
        name: recordTypeInfo.name || recordTypeInfo.developerName || recordTypeId,
        developerName: recordTypeInfo.developerName || null,
        source: "UI API object info"
      };
    }

    if (!recordTypeId && objectInfo && objectInfo.recordTypeInfos) {
      const recordTypes = Object.values(objectInfo.recordTypeInfos);
      const master = recordTypes.find((recordTypeInfo) => recordTypeInfo.master);
      if (master) {
        return {
          id: master.recordTypeId || null,
          name: master.name || "Master",
          developerName: master.developerName || "Master",
          source: "UI API object info"
        };
      }
    }

    return {
      id: recordTypeId,
      name: recordTypeId ? recordTypeId : "Unavailable",
      developerName: null,
      source: recordTypeId ? "RecordTypeId field" : "Record type was not available for this object"
    };
  }

  async function resolvePageLayout(apiVersion, parsedPage, user, recordType) {
    if (!parsedPage.objectApiName || !user || !user.profileId) {
      return {
        id: null,
        name: "Unavailable",
        source: "Need an object and profile to resolve layout assignment"
      };
    }

    const recordTypeCondition = recordType && recordType.id
      ? `RecordTypeId = '${soqlString(recordType.id)}'`
      : "RecordTypeId = null";
    const assignmentQuery = [
      "SELECT Id, LayoutId, Layout.Name, ProfileId, RecordTypeId, TableEnumOrId",
      "FROM ProfileLayout",
      `WHERE ProfileId = '${soqlString(user.profileId)}'`,
      `AND TableEnumOrId = '${soqlString(parsedPage.objectApiName)}'`,
      `AND ${recordTypeCondition}`,
      "LIMIT 1"
    ].join(" ");

    let response = await attempt("Tooling ProfileLayout assignment", () => toolingQuery(apiVersion, assignmentQuery));
    let assignment = response && response.records && response.records[0];

    if (!assignment && recordType && recordType.id) {
      const fallbackQuery = [
        "SELECT Id, LayoutId, Layout.Name, ProfileId, RecordTypeId, TableEnumOrId",
        "FROM ProfileLayout",
        `WHERE ProfileId = '${soqlString(user.profileId)}'`,
        `AND TableEnumOrId = '${soqlString(parsedPage.objectApiName)}'`,
        "AND RecordTypeId = null",
        "LIMIT 1"
      ].join(" ");
      response = await attempt("Tooling default ProfileLayout assignment", () => toolingQuery(apiVersion, fallbackQuery));
      assignment = response && response.records && response.records[0];
    }

    if (assignment) {
      return {
        id: assignment.LayoutId || assignment.Id || null,
        name: assignment.Layout && assignment.Layout.Name || assignment.LayoutId || "Assigned layout",
        source: "Tooling API ProfileLayout assignment"
      };
    }

    const recordTypeParam = recordType && recordType.id ? `&recordTypeId=${encodeURIComponent(recordType.id)}` : "";
    const layout = await attempt(
      "UI API layout fallback",
      () => apiFetch(`/services/data/v${apiVersion}/ui-api/layout/${encodeURIComponent(parsedPage.objectApiName)}/Full/View?formFactor=Large${recordTypeParam}`)
    );

    if (layout) {
      return {
        id: layout.id || null,
        name: layout.name || layout.fullName || "Resolved by UI API",
        source: "UI API layout fallback"
      };
    }

    return {
      id: null,
      name: "Unavailable",
      source: "No layout assignment was returned"
    };
  }

  async function apiFetch(path) {
    const response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        "Accept": "application/json"
      }
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

  async function query(apiVersion, soql) {
    return apiFetch(`/services/data/v${apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  }

  async function toolingQuery(apiVersion, soql) {
    return apiFetch(`/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  }

  async function attempt(label, task) {
    try {
      return await task();
    } catch (error) {
      warnings.push(`${label}: ${error.message || String(error)}`);
      return null;
    }
  }

  function parseSalesforcePage() {
    const url = new URL(window.location.href);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
    const result = {
      recordId: null,
      objectApiName: null,
      appKey: null,
      pageType: "unknown"
    };

    const lightningIndex = segments.indexOf("lightning");
    if (lightningIndex >= 0) {
      readLightningSegments(segments.slice(lightningIndex + 1), result);
    }

    if (!result.recordId) {
      const classicRecordMatch = url.pathname.match(/^\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:[/?#]|$)/);
      if (classicRecordMatch) {
        result.recordId = classicRecordMatch[1];
        result.pageType = "classicRecord";
      }
    }

    if (!result.recordId) {
      const decodedLocation = safeDecode(`${url.pathname}${url.search}${url.hash}`);
      const recordMatch = decodedLocation.match(/\b([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/);
      if (recordMatch) {
        result.recordId = recordMatch[1];
        result.pageType = result.pageType === "unknown" ? "recordFromUrl" : result.pageType;
      }
    }

    return result;
  }

  function readLightningSegments(segments, result) {
    if (!segments.length) {
      return;
    }

    if (segments[0] === "app") {
      result.appKey = segments[1] || null;
      readLightningSegments(segments.slice(2), result);
      return;
    }

    if (segments[0] === "r") {
      result.objectApiName = segments[1] || result.objectApiName;
      result.recordId = isSalesforceId(segments[2]) ? segments[2] : result.recordId;
      result.pageType = "record";
      return;
    }

    if (segments[0] === "o") {
      result.objectApiName = segments[1] || result.objectApiName;
      result.pageType = "object";
      return;
    }

    if (segments[0] === "setup" && segments[1] === "ObjectManager") {
      result.objectApiName = segments[2] || result.objectApiName;
      result.pageType = "setupObjectManager";
    }
  }

  function getUserFromPageGlobals() {
    const candidates = [];
    const values = {
      id: null,
      name: null,
      profileId: null,
      profileName: null,
      roleId: null,
      roleName: null
    };

    try {
      if (window.$A && typeof window.$A.get === "function") {
        candidates.push(window.$A.get("$SObjectType.CurrentUser.Id"));
        values.name = cleanText(window.$A.get("$SObjectType.CurrentUser.Name")) || values.name;
        values.profileId = window.$A.get("$SObjectType.CurrentUser.ProfileId") || values.profileId;
        values.profileName = cleanText(window.$A.get("$SObjectType.CurrentUser.Profile.Name")) || values.profileName;
        values.roleId = window.$A.get("$SObjectType.CurrentUser.UserRoleId") || values.roleId;
        values.roleName = cleanText(window.$A.get("$SObjectType.CurrentUser.UserRole.Name")) || values.roleName;
      }
    } catch (_error) {
      // Ignore framework access errors from partially loaded Lightning pages.
    }

    try {
      candidates.push(window.UserContext && window.UserContext.userId);
      candidates.push(window.SfdcApp && window.SfdcApp.userId);
      candidates.push(window.sfdcPage && window.sfdcPage.userId);
      values.name = values.name || cleanText(window.UserContext && window.UserContext.name);
      values.profileId = values.profileId || window.UserContext && window.UserContext.profileId;
      values.profileName = values.profileName || cleanText(window.UserContext && window.UserContext.profileName);
      values.roleId = values.roleId || window.UserContext && window.UserContext.roleId;
      values.roleName = values.roleName || cleanText(window.UserContext && window.UserContext.roleName);
    } catch (_error) {
      // Ignore page-global access errors.
    }

    values.id = candidates.find((candidate) => isSalesforceId(candidate)) || null;
    return values;
  }

  function idFromIdentityUrl(value) {
    if (!value) {
      return null;
    }
    const match = String(value).match(/\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)$/);
    return match ? match[1] : null;
  }

  function isSalesforceId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
  }

  function isSafeObjectApiName(value) {
    return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
  }

  function soqlString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
}
