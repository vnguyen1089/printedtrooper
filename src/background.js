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
  if (!message) {
    return false;
  }

  if (message.type === "SF2P_API_FETCH") {
    apiFetchFromExtension(message.currentUrl || sender.tab && sender.tab.url, message.path)
      .then((body) => sendResponse({ ok: true, body }))
      .catch((error) => {
        console.error("Salesforce Perspectives API proxy failed.", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message.type !== "SF2P_COLLECT_CONTEXT") {
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

  return result.result;
}

async function apiFetchFromExtension(currentUrl, path) {
  const urls = salesforceApiUrlsFromUrl(currentUrl, path);
  const errors = [];

  for (const url of urls) {
    const sessionIds = await getSessionIdsForUrls([currentUrl, url]);

    try {
      const attempts = [
        { label: "cookie session", authorization: null },
        ...sessionIds.map((sessionId, index) => ({
          label: `sid cookie ${index + 1}`,
          authorization: `Bearer ${sessionId}`
        }))
      ];

      for (const attempt of attempts) {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "Accept": "application/json",
            ...(attempt.authorization ? { "Authorization": attempt.authorization } : {})
          }
        });
        const body = await parseResponseBody(response);

        if (response.ok) {
          return body;
        }

        const message = `${displayExtensionApiUrl(url)} (${attempt.label}) returned ${response.status}: ${salesforceApiErrorMessage(body)}`;
        errors.push(message);
        if (!shouldTryNextExtensionApiUrl(response.status)) {
          break;
        }
      }
    } catch (error) {
      errors.push(`${displayExtensionApiUrl(url)}: ${error.message || String(error)}`);
    }
  }

  throw new Error(errors.join("; ") || "Salesforce API proxy could not reach an API host.");
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

async function getSessionIdsForUrls(urls) {
  if (!chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    return [];
  }

  const values = [];
  for (const url of urls.filter(Boolean)) {
    try {
      const parsed = new URL(url);
      const exactCookies = await chrome.cookies.getAll({ url: `${parsed.origin}/`, name: "sid" });
      values.push(...exactCookies.map((cookie) => cookie.value));

      const domainParts = parsed.hostname.split(".");
      for (let index = 0; index < domainParts.length - 1; index += 1) {
        const domain = domainParts.slice(index).join(".");
        const domainCookies = await chrome.cookies.getAll({ domain, name: "sid" });
        values.push(...domainCookies.map((cookie) => cookie.value));
      }
    } catch (_error) {
      // Ignore malformed URLs and cookie access failures for individual hosts.
    }
  }

  return uniqueExtensionValues(values);
}

function salesforceApiUrlsFromUrl(currentUrl, path) {
  if (/^https?:\/\//i.test(path)) {
    return [path];
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origins = [];

  try {
    const parsed = new URL(currentUrl);
    const apiOrigin = salesforceApiOriginFromHost(parsed.hostname);
    if (apiOrigin) {
      origins.push(apiOrigin);
    }
    origins.push(parsed.origin);
  } catch (_error) {
    // Fall through to the relative path if URL parsing fails.
  }

  return uniqueExtensionValues(origins).map((origin) => `${origin}${normalizedPath}`);
}

function salesforceApiOriginFromHost(host) {
  const normalizedHost = String(host || "").toLowerCase();
  if (normalizedHost.endsWith(".lightning.force.com")) {
    return `https://${host.replace(/\.lightning\.force\.com$/i, ".my.salesforce.com")}`;
  }
  if (
    normalizedHost.endsWith(".my.salesforce.com") ||
    normalizedHost.endsWith(".salesforce.com") ||
    normalizedHost.endsWith(".force.com")
  ) {
    return `https://${host}`;
  }
  return null;
}

function shouldTryNextExtensionApiUrl(status) {
  return status === 401 || status === 403 || status === 404;
}

function displayExtensionApiUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_error) {
    return url;
  }
}

function salesforceApiErrorMessage(body) {
  if (Array.isArray(body)) {
    return body.map((entry) => entry && entry.message || JSON.stringify(entry)).join("; ");
  }
  if (body && typeof body === "object") {
    return body.message || body.error_description || body.error || JSON.stringify(body);
  }
  return body || "No response body";
}

function uniqueExtensionValues(values) {
  return [...new Set(values.filter(Boolean))];
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
    const app = await resolveCurrentApp(apiVersion, parsedPage);
    const pageLayout = await resolvePageLayout(apiVersion, parsedPage, user, recordType);
    const lightningRecordPage = await resolveLightningRecordPage(apiVersion, parsedPage, user, recordType, app);
    const permissionSets = await getPermissionSets(apiVersion, user);

    return {
      ok: true,
      generatedAt,
      currentUrl: window.location.href,
      org: {
        host: window.location.host,
        apiVersion
      },
      user,
      app,
      lightningRecordPage,
      record: {
        id: parsedPage.recordId || null,
        objectApiName: parsedPage.objectApiName || null,
        pageType: parsedPage.pageType || "unknown"
      },
      recordType,
      pageLayout,
      permissionSets,
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
    const pageUserId = getUserIdFromPageGlobals();
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

    if (!response) {
      return {
        id: userId,
        name: userInfo && (userInfo.name || userInfo.preferred_username) || "Unavailable",
        profileId: null,
        profileName: "Unavailable",
        roleId: null,
        roleName: "Unavailable",
        source: "Current user id; SOQL user lookup unavailable"
      };
    }

    if (!record) {
      return {
        id: userId,
        name: userInfo && (userInfo.name || userInfo.preferred_username) || "Unavailable",
        profileId: null,
        profileName: "Unavailable",
        roleId: null,
        roleName: "Unavailable",
        source: "Current user id; SOQL user lookup returned no rows"
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

  async function getPermissionSets(apiVersion, user) {
    if (!user || !user.id || !isSalesforceId(user.id)) {
      return [];
    }

    const soql = [
      "SELECT Id, PermissionSetId, PermissionSet.Name, PermissionSet.Label,",
      "PermissionSet.NamespacePrefix, PermissionSet.IsOwnedByProfile",
      "FROM PermissionSetAssignment",
      `WHERE AssigneeId = '${soqlString(user.id)}'`,
      "AND PermissionSet.IsOwnedByProfile = false",
      "ORDER BY PermissionSet.Label"
    ].join(" ");
    const records = await attempt("Permission set assignments", () => queryAll(apiVersion, soql));

    if (!Array.isArray(records)) {
      return [];
    }

    return records.map((record) => {
      const permissionSet = record.PermissionSet || {};
      return {
        assignmentId: record.Id || null,
        id: record.PermissionSetId || null,
        label: permissionSet.Label || permissionSet.Name || record.PermissionSetId || "Permission Set",
        name: permissionSet.Name || null,
        namespacePrefix: permissionSet.NamespacePrefix || null,
        source: "REST SOQL PermissionSetAssignment query"
      };
    });
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

  async function resolveCurrentApp(apiVersion, parsedPage) {
    const appKey = parsedPage.appKey || appKeyFromNavigationLinks();
    const domName = appNameFromDom();

    if (domName) {
      return {
        id: null,
        name: domName,
        developerName: null,
        apiName: null,
        durableId: appKey || null,
        source: "Lightning header"
      };
    }

    if (appKey) {
      const conditions = [
        `DurableId = '${soqlString(appKey)}'`,
        `DeveloperName = '${soqlString(appKey)}'`
      ];
      if (appKey.startsWith("standard__")) {
        conditions.push(`DeveloperName = '${soqlString(appKey.replace(/^standard__/, ""))}'`);
      }
      if (isSalesforceId(appKey)) {
        conditions.push(`Id = '${soqlString(appKey)}'`);
      }

      const soql = [
        "SELECT Id, DurableId, DeveloperName, Label",
        "FROM AppDefinition",
        `WHERE ${conditions.join(" OR ")}`,
        "LIMIT 1"
      ].join(" ");
      const response = await attempt("Tooling AppDefinition", () => toolingQuery(apiVersion, soql));
      const record = response && response.records && response.records[0];
      if (record) {
        return {
          id: record.Id || null,
          name: record.Label || record.DeveloperName || record.DurableId,
          developerName: record.DeveloperName || null,
          apiName: record.DurableId || record.DeveloperName || appKey || null,
          durableId: record.DurableId || null,
          source: "Tooling API AppDefinition"
        };
      }
    }

    return {
      id: null,
      name: appKey || "Unavailable",
      developerName: null,
      apiName: appKey || null,
      durableId: appKey || null,
      source: appKey ? "Lightning URL app key" : "No current app marker found"
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

  async function resolveLightningRecordPage(apiVersion, parsedPage, user, recordType, app) {
    if (!parsedPage.objectApiName || parsedPage.pageType !== "record") {
      return {
        id: null,
        name: "Not on a Lightning record page",
        apiName: null,
        source: "URL context"
      };
    }

    const appAssignment = await resolveAppLightningRecordPage(apiVersion, parsedPage, user, recordType, app);
    if (appAssignment) {
      return appAssignment;
    }

    const profileAssignment = await resolveProfileLightningRecordPage(apiVersion, parsedPage, user, recordType);
    if (profileAssignment) {
      return profileAssignment;
    }

    const candidates = await getObjectFlexiPages(apiVersion, parsedPage.objectApiName);
    if (candidates.length === 1) {
      return {
        ...candidates[0],
        source: "Tooling API FlexiPage object lookup"
      };
    }

    if (candidates.length > 1) {
      const selected = chooseBestFlexiPageCandidate(candidates, parsedPage, recordType);
      return {
        ...selected,
        source: "Tooling API FlexiPage object lookup; assignment metadata was unavailable"
      };
    }

    return {
      id: null,
      name: "Unavailable",
      apiName: null,
      source: "No Lightning record page metadata was returned"
    };
  }

  async function resolveAppLightningRecordPage(apiVersion, parsedPage, user, recordType, app) {
    const appNames = unique([
      app && app.apiName,
      app && app.durableId,
      app && app.developerName,
      parsedPage.appKey
    ].filter(Boolean).flatMap((name) => [name, String(name).replace(/^standard__/, "")]));
    const safeAppNames = appNames.filter((name) => /^[A-Za-z][A-Za-z0-9_]*(__[A-Za-z][A-Za-z0-9_]*)?$/.test(name));

    if (!safeAppNames.length) {
      return null;
    }

    const soql = [
      "SELECT Id, DeveloperName",
      "FROM CustomApplication",
      `WHERE ${safeAppNames.map((name) => `DeveloperName = '${soqlString(name)}'`).join(" OR ")}`,
      "LIMIT 5"
    ].join(" ");
    const response = await attempt("Tooling CustomApplication lookup", () => toolingQuery(apiVersion, soql));
    const records = response && response.records || [];

    for (const record of records) {
      const application = await attempt(
        `Tooling CustomApplication metadata ${record.DeveloperName || record.Id}`,
        () => toolingObject(apiVersion, "CustomApplication", record.Id)
      );
      const override = findBestLightningRecordPageOverride(application && application.Metadata, parsedPage, user, recordType);
      if (override) {
        return resolveFlexiPageFromOverride(apiVersion, override, "CustomApplication profileActionOverrides metadata");
      }
    }

    return null;
  }

  async function resolveProfileLightningRecordPage(apiVersion, parsedPage, user, recordType) {
    if (!user || !user.profileId) {
      return null;
    }

    const profile = await attempt("Tooling Profile metadata", () => toolingObject(apiVersion, "Profile", user.profileId));
    const override = findBestLightningRecordPageOverride(profile && profile.Metadata, parsedPage, user, recordType);
    return override
      ? resolveFlexiPageFromOverride(apiVersion, override, "Profile profileActionOverrides metadata")
      : null;
  }

  async function resolveFlexiPageFromOverride(apiVersion, override, source) {
    const page = await getFlexiPageByName(apiVersion, override.content);
    if (page) {
      return {
        ...page,
        source
      };
    }

    return {
      id: null,
      name: override.content || "Assigned Lightning record page",
      apiName: override.content || null,
      developerName: override.content || null,
      source: `${source}; FlexiPage lookup unavailable`
    };
  }

  async function getFlexiPageByName(apiVersion, pageName) {
    if (!pageName) {
      return null;
    }

    const names = unique([
      pageName,
      String(pageName).split(".").pop(),
      String(pageName).replace(/^[A-Za-z0-9]+__/, "")
    ].filter(Boolean));
    const conditions = names.flatMap((name) => [
      `DeveloperName = '${soqlString(name)}'`,
      `MasterLabel = '${soqlString(name)}'`
    ]);

    if (isSalesforceId(pageName)) {
      conditions.push(`Id = '${soqlString(pageName)}'`);
    }

    const soql = [
      "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Type, EntityDefinitionId",
      "FROM FlexiPage",
      "WHERE Type = 'RecordPage'",
      `AND (${conditions.join(" OR ")})`,
      "LIMIT 5"
    ].join(" ");
    const response = await attempt("Tooling FlexiPage assigned page lookup", () => toolingQuery(apiVersion, soql));
    const record = response && response.records && response.records[0];
    return record ? shapeFlexiPage(record, "Tooling API FlexiPage lookup") : null;
  }

  async function getObjectFlexiPages(apiVersion, objectApiName) {
    let soql = [
      "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Type, EntityDefinitionId",
      "FROM FlexiPage",
      "WHERE Type = 'RecordPage'",
      `AND EntityDefinition.QualifiedApiName = '${soqlString(objectApiName)}'`,
      "ORDER BY MasterLabel"
    ].join(" ");
    let response = await attempt("Tooling FlexiPage object lookup", () => toolingQuery(apiVersion, soql));
    let records = response && response.records || [];

    if (!records.length) {
      soql = [
        "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Type, EntityDefinitionId",
        "FROM FlexiPage",
        "WHERE Type = 'RecordPage'",
        `AND EntityDefinitionId = '${soqlString(objectApiName)}'`,
        "ORDER BY MasterLabel"
      ].join(" ");
      response = await attempt("Tooling FlexiPage EntityDefinitionId lookup", () => toolingQuery(apiVersion, soql));
      records = response && response.records || [];
    }

    return records.map((record) => shapeFlexiPage(record, "Tooling API FlexiPage object lookup"));
  }

  function findBestLightningRecordPageOverride(metadata, parsedPage, user, recordType) {
    const overrides = [
      ...normalizeList(metadata && metadata.profileActionOverrides),
      ...normalizeList(metadata && metadata.actionOverrides)
    ];
    let best = null;

    for (const override of overrides) {
      if (!override || !override.content) {
        continue;
      }
      if (!matchesMetadataValue(override.actionName, "View") || !matchesMetadataValue(override.type, "Flexipage")) {
        continue;
      }
      if (!matchesMetadataValue(override.pageOrSobjectType, parsedPage.objectApiName)) {
        continue;
      }
      if (override.formFactor && !matchesMetadataValue(override.formFactor, "Large")) {
        continue;
      }

      const recordTypeScore = actionOverrideRecordTypeScore(override.recordType, parsedPage.objectApiName, recordType);
      const profileScore = actionOverrideProfileScore(override.profile, user);
      if (recordTypeScore === null || profileScore === null) {
        continue;
      }

      const score = recordTypeScore + profileScore + (override.profile ? 2 : 0);
      if (!best || score > best.score) {
        best = { score, override };
      }
    }

    return best && best.override || null;
  }

  function actionOverrideRecordTypeScore(overrideRecordType, objectApiName, recordType) {
    if (!overrideRecordType) {
      return 0;
    }

    const candidates = [
      recordType && recordType.developerName,
      recordType && recordType.name,
      recordType && recordType.developerName && `${objectApiName}.${recordType.developerName}`,
      recordType && recordType.developerName && `${objectApiName}.${recordType.developerName.replace(/^standard__/, "")}`
    ].filter(Boolean);

    return candidates.some((candidate) => matchesMetadataValue(overrideRecordType, candidate)) ? 8 : null;
  }

  function actionOverrideProfileScore(overrideProfile, user) {
    if (!overrideProfile) {
      return 0;
    }

    const candidates = [
      user && user.profileName,
      user && user.profileId
    ].filter(Boolean);

    return candidates.some((candidate) => matchesMetadataValue(overrideProfile, candidate)) ? 4 : null;
  }

  function shapeFlexiPage(record, source) {
    const developerName = record.DeveloperName || null;
    const apiName = developerName && record.NamespacePrefix
      ? `${record.NamespacePrefix}__${developerName}`
      : developerName;

    return {
      id: record.Id || null,
      name: record.MasterLabel || developerName || record.Id || "Lightning record page",
      apiName: apiName || null,
      developerName,
      namespacePrefix: record.NamespacePrefix || null,
      source
    };
  }

  function chooseBestFlexiPageCandidate(candidates, parsedPage, recordType) {
    const scored = candidates.map((candidate, index) => ({
      candidate,
      score: flexiPageCandidateScore(candidate, parsedPage, recordType),
      index
    }));
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored[0].candidate;
  }

  function flexiPageCandidateScore(candidate, parsedPage, recordType) {
    const haystack = [
      candidate.apiName,
      candidate.developerName,
      candidate.name
    ].filter(Boolean).join(" ").toLowerCase();
    let score = 0;

    if (parsedPage.objectApiName && haystack.includes(parsedPage.objectApiName.toLowerCase())) {
      score += 4;
    }
    if (recordType && recordType.developerName && haystack.includes(recordType.developerName.toLowerCase())) {
      score += 3;
    }
    if (recordType && recordType.name && haystack.includes(recordType.name.toLowerCase())) {
      score += 2;
    }
    if (haystack.includes("record")) {
      score += 1;
    }

    return score;
  }

  async function apiFetch(path) {
    const urls = salesforceApiUrls(path);
    const errors = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
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

        if (response.ok) {
          return body;
        }

        const message = `${displayApiUrl(url)} returned ${response.status}: ${salesforceErrorMessage(body)}`;
        errors.push(message);
        if (!shouldTryNextApiUrl(response.status)) {
          throw new Error(message);
        }
      } catch (error) {
        errors.push(`${displayApiUrl(url)}: ${error.message || String(error)}`);
      }
    }

    try {
      return await extensionApiFetch(path);
    } catch (error) {
      errors.push(`Extension API proxy: ${error.message || String(error)}`);
    }

    throw new Error(errors.join("; "));
  }

  async function query(apiVersion, soql) {
    return apiFetch(`/services/data/v${apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  }

  async function queryAll(apiVersion, soql) {
    let response = await query(apiVersion, soql);
    const records = [];

    while (response) {
      if (Array.isArray(response.records)) {
        records.push(...response.records);
      }
      if (response.done || !response.nextRecordsUrl) {
        break;
      }
      response = await apiFetch(response.nextRecordsUrl);
    }

    return records;
  }

  async function toolingQuery(apiVersion, soql) {
    return apiFetch(`/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  }

  async function toolingObject(apiVersion, type, id) {
    return apiFetch(`/services/data/v${apiVersion}/tooling/sobjects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
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

  function getUserIdFromPageGlobals() {
    const candidates = [];

    try {
      if (window.$A && typeof window.$A.get === "function") {
        candidates.push(window.$A.get("$SObjectType.CurrentUser.Id"));
      }
    } catch (_error) {
      // Ignore framework access errors from partially loaded Lightning pages.
    }

    try {
      candidates.push(window.UserContext && window.UserContext.userId);
      candidates.push(window.SfdcApp && window.SfdcApp.userId);
      candidates.push(window.sfdcPage && window.sfdcPage.userId);
    } catch (_error) {
      // Ignore page-global access errors.
    }

    return candidates.find((candidate) => isSalesforceId(candidate)) || null;
  }

  function appNameFromDom() {
    const selectors = [
      ".slds-context-bar__app-name .slds-truncate",
      ".slds-context-bar__app-name",
      "one-app-nav-bar .slds-context-bar__app-name .slds-truncate",
      "one-app-nav-bar .slds-context-bar__app-name",
      "one-appnav .slds-context-bar__app-name .slds-truncate",
      "one-appnav .slds-context-bar__app-name",
      ".slds-context-bar__primary .slds-context-bar__label-action .slds-truncate",
      ".slds-context-bar__primary .slds-context-bar__label-action",
      "one-app-nav-bar-item-root a[href*='/lightning/app/'] .slds-truncate",
      "one-app-nav-bar-item-root a[href*='/lightning/app/']",
      "one-app-nav-bar a[href*='/lightning/app/'] .slds-truncate",
      "one-app-nav-bar a[href*='/lightning/app/']",
      "a.slds-context-bar__label-action[href*='/lightning/app/']"
    ];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = appNameFromElement(element);
        if (text) {
          return text;
        }
      }
    }

    return appNameNearLauncher();
  }

  function appNameFromElement(element) {
    if (!element || !isVisibleElement(element)) {
      return null;
    }

    const values = [
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.textContent
    ];

    for (const value of values) {
      const text = cleanText(value);
      if (isLikelyAppName(text)) {
        return text;
      }
    }

    return null;
  }

  function appNameNearLauncher() {
    const launcher = document.querySelector([
      "button[title*='App Launcher']",
      "button[aria-label*='App Launcher']",
      ".slds-icon-waffle_container",
      ".slds-icon-waffle"
    ].join(","));

    if (!launcher || typeof launcher.getBoundingClientRect !== "function") {
      return null;
    }

    const launcherRect = launcher.getBoundingClientRect();
    const pointText = appNameFromPointsNearLauncher(launcherRect);
    if (pointText) {
      return pointText;
    }

    const textCandidates = visibleTextNodesNearRect(launcherRect)
      .filter((candidate) => {
        if (!candidate.text || !candidate.rect || candidate.rect.width <= 0 || candidate.rect.height <= 0) {
          return false;
        }
        const verticallyAligned = candidate.rect.bottom >= launcherRect.top - 12 && candidate.rect.top <= launcherRect.bottom + 12;
        const toTheRight = candidate.rect.left >= launcherRect.right - 8 && candidate.rect.left <= launcherRect.right + 180;
        const inHeader = candidate.rect.top <= 140;
        return verticallyAligned && toTheRight && inHeader;
      })
      .sort((left, right) => left.rect.left - right.rect.left);

    if (textCandidates.length) {
      return textCandidates[0].text;
    }

    const elementCandidates = [...document.querySelectorAll("a, button, span, div")]
      .map((element) => ({
        text: appNameFromElement(element),
        rect: element.getBoundingClientRect()
      }))
      .filter((candidate) => {
        if (!candidate.text || !candidate.rect || candidate.rect.width <= 0 || candidate.rect.height <= 0) {
          return false;
        }
        const verticallyAligned = candidate.rect.bottom >= launcherRect.top - 12 && candidate.rect.top <= launcherRect.bottom + 12;
        const toTheRight = candidate.rect.left >= launcherRect.right - 8 && candidate.rect.left <= launcherRect.right + 180;
        const inHeader = candidate.rect.top <= 140;
        return verticallyAligned && toTheRight && inHeader;
      })
      .sort((left, right) => left.rect.left - right.rect.left);

    return elementCandidates.length ? elementCandidates[0].text : null;
  }

  function appNameFromPointsNearLauncher(launcherRect) {
    const yValues = [
      launcherRect.top + launcherRect.height / 2,
      launcherRect.top + 4,
      launcherRect.bottom - 4
    ];

    for (const y of yValues) {
      for (let x = launcherRect.right + 8; x <= launcherRect.right + 180; x += 8) {
        const element = document.elementFromPoint(x, y);
        const text = appNameFromElementChain(element);
        if (text) {
          return text;
        }
      }
    }

    return null;
  }

  function appNameFromElementChain(element) {
    let current = element;
    while (current && current !== document.body) {
      const text = firstLikelyAppNameFromText(current.textContent);
      if (text) {
        return text;
      }
      current = current.parentElement;
    }
    return null;
  }

  function firstLikelyAppNameFromText(value) {
    const normalized = cleanText(value);
    if (!normalized) {
      return null;
    }

    const parts = normalized.split(/\s{2,}|\n|\t/).map((part) => cleanText(part));
    if (parts.length === 1) {
      const words = normalized.split(" ").map((part) => cleanText(part));
      parts.push(words[0], words.slice(0, 2).join(" "));
    }

    for (const part of parts) {
      if (isLikelyAppName(part)) {
        return part;
      }
    }
    return null;
  }

  function visibleTextNodesNearRect(referenceRect) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = cleanText(node.nodeValue);
        if (!isLikelyAppName(text)) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        return parent && isVisibleElement(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const results = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      const verticallyAligned = rect.bottom >= referenceRect.top - 12 && rect.top <= referenceRect.bottom + 12;
      const toTheRight = rect.left >= referenceRect.right - 8 && rect.left <= referenceRect.right + 220;
      const inHeader = rect.top <= 140;

      if (verticallyAligned && toTheRight && inHeader) {
        results.push({
          text: cleanText(node.nodeValue),
          rect
        });
      }
    }

    return results;
  }

  function isLikelyAppName(text) {
    if (!text) {
      return false;
    }

    const normalized = text.toLowerCase();
    const ignored = new Set([
      "app launcher",
      "home",
      "leads",
      "tasks",
      "files",
      "accounts",
      "contacts",
      "opportunities",
      "campaigns",
      "dashboards",
      "reports",
      "chatter"
    ]);

    return text.length <= 60 && !ignored.has(normalized);
  }

  function isVisibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function appKeyFromNavigationLinks() {
    const link = document.querySelector("a[href*='/lightning/app/']");
    if (!link) {
      return null;
    }

    try {
      const url = new URL(link.href, window.location.origin);
      const segments = url.pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
      const appIndex = segments.indexOf("app");
      return appIndex >= 0 ? segments[appIndex + 1] || null : null;
    } catch (_error) {
      return null;
    }
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

  function salesforceApiUrls(path) {
    if (/^https?:\/\//i.test(path)) {
      return [path];
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const currentOrigin = window.location.origin;
    const apiOrigin = salesforceApiOriginFromHost(window.location.host);
    return unique([apiOrigin, currentOrigin].filter(Boolean)).map((origin) => `${origin}${normalizedPath}`);
  }

  function salesforceApiOriginFromHost(host) {
    const normalizedHost = String(host || "").toLowerCase();
    if (normalizedHost.endsWith(".lightning.force.com")) {
      return `https://${host.replace(/\.lightning\.force\.com$/i, ".my.salesforce.com")}`;
    }
    if (
      normalizedHost.endsWith(".my.salesforce.com") ||
      normalizedHost.endsWith(".salesforce.com") ||
      normalizedHost.endsWith(".force.com")
    ) {
      return window.location.origin;
    }
    return null;
  }

  function shouldTryNextApiUrl(status) {
    return status === 401 || status === 403 || status === 404;
  }

  function displayApiUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_error) {
      return url;
    }
  }

  function extensionApiFetch(path) {
    return new Promise((resolve, reject) => {
      const requestId = `sf2p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handleResponse);
        reject(new Error("Timed out waiting for the extension API proxy."));
      }, 15000);

      function handleResponse(event) {
        if (event.source !== window) {
          return;
        }

        const detail = event.data || {};
        if (!detail || detail.source !== "sf2p" || detail.type !== "api-response" || detail.requestId !== requestId) {
          return;
        }

        clearTimeout(timeout);
        window.removeEventListener("message", handleResponse);
        const response = detail.response || {};
        if (response.ok) {
          resolve(response.body);
          return;
        }
        reject(new Error(response.error || "Extension API proxy failed."));
      }

      window.addEventListener("message", handleResponse);
      window.postMessage({
        source: "sf2p",
        type: "api-request",
        requestId,
        path
      }, window.location.origin);
    });
  }

  function normalizeList(value) {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  function matchesMetadataValue(value, expected) {
    return cleanText(value).toLowerCase() === cleanText(expected).toLowerCase();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
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
