"use strict";

import { normalizeCnr } from "./case-details.mjs";

const STORAGE_KEY = "karnataka-civil-case-tracker.v1";
const officialCaseStatusUrl = "https://services.ecourts.gov.in/ecourtindia_v6/?p=casestatus/index";

const form = document.querySelector("#case-form");
const dialog = document.querySelector("#case-dialog");
const rows = document.querySelector("#case-rows");
const emptyState = document.querySelector("#empty-state");
const noResults = document.querySelector("#no-results");
const filterText = document.querySelector("#filter-text");
const filterStatus = document.querySelector("#filter-status");
const message = document.querySelector("#message");
const formError = document.querySelector("#form-error");
const recordId = document.querySelector("#record-id");
const lookupForm = document.querySelector("#lookup-form");
const lookupInput = document.querySelector("#lookup-cnr");
const lookupStart = document.querySelector("#lookup-start");
const lookupImport = document.querySelector("#lookup-import");
const lookupCancel = document.querySelector("#lookup-cancel");
const lookupMessage = document.querySelector("#lookup-message");
const detailsDialog = document.querySelector("#details-dialog");
let currentLookup = null;
let selectedDetails = null;
let storageLoadFailed = false;
let cases = readCases();

function readCases() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item.id !== "string" || typeof item.title !== "string")) {
      throw new Error("Saved case data has an unexpected format.");
    }
    return parsed;
  } catch (error) {
    storageLoadFailed = true;
    message.textContent = `Could not load saved cases: ${error.message}`;
    return [];
  }
}

function persistCases(nextCases) {
  try {
    if (storageLoadFailed) throw new Error("Existing saved data could not be loaded. Export or recover the browser data before saving new cases.");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextCases));
    cases = nextCases;
    message.textContent = "";
    return true;
  } catch (error) {
    message.textContent = `Could not save cases in this browser: ${error.message}`;
    return false;
  }
}

function makeCell(text, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text || "—";
  return cell;
}

function addText(element, text, className) {
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderCases() {
  rows.replaceChildren();
  const query = filterText.value.trim().toLocaleLowerCase();
  const statusFilter = filterStatus.value;
  const visible = cases.filter((item) => {
    const haystack = [item.title, item.cnr, item.caseType, item.petitioner, item.respondent, item.district, item.court]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return (!query || haystack.includes(query)) && (!statusFilter || item.status === statusFilter);
  });

  for (const item of visible) {
    const row = document.createElement("tr");
    const caseCell = document.createElement("td");
    const title = addText(document.createElement("span"), item.title, "case-title");
    const cnr = addText(document.createElement("span"), item.cnr ? `CNR ${item.cnr}` : "CNR not added", "case-cnr");
    caseCell.append(title, cnr);
    row.append(caseCell);

    const parties = document.createElement("td");
    const petitioner = addText(document.createElement("span"), item.petitioner ? `Plaintiff: ${item.petitioner}` : "Plaintiff not added", "party-name");
    const respondent = addText(document.createElement("span"), item.respondent ? `Defendant: ${item.respondent}` : "Defendant not added", "party-name");
    parties.append(petitioner, respondent);
    row.append(parties);

    const court = document.createElement("td");
    const courtName = addText(document.createElement("span"), item.court || "Court not added");
    const district = addText(document.createElement("span"), item.district || "District not added", "cell-subtle");
    court.append(courtName, district);
    row.append(court);

    const statusCell = document.createElement("td");
    const status = addText(document.createElement("span"), item.status || "Other", `status status-${(item.status || "Other").toLowerCase()}`);
    if (item.details && item.status === "Other") status.textContent = "Not stated";
    statusCell.append(status);
    const stage = item.details?.fields?.casestage || item.details?.fields?.stageofcase;
    if (stage) statusCell.append(addText(document.createElement("span"), stage, "cell-subtle"));
    row.append(statusCell);

    row.append(makeCell(formatDate(item.nextHearing)));
    const actions = document.createElement("td");
    const actionGroup = document.createElement("div");
    actionGroup.className = "row-actions";
    const official = document.createElement("a");
    official.className = "row-action";
    official.href = item.cnr ? "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index" : officialCaseStatusUrl;
    official.target = "_blank";
    official.rel = "noopener noreferrer";
    official.textContent = "eCourts ↗";
    official.setAttribute("aria-label", `Open official eCourts search for ${item.title}`);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "row-action";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(item));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "row-action delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteCase(item.id));
    if (item.details) {
      const details = document.createElement("button");
      details.type = "button";
      details.className = "row-action";
      details.textContent = "Details";
      details.addEventListener("click", () => showDetails(item));
      actionGroup.append(details);
    }
    if (item.cnr) {
      const workspace = document.createElement("a");
      workspace.className = "row-action";
      workspace.href = `/workspace.html?cnr=${encodeURIComponent(item.cnr)}`;
      workspace.textContent = "Workspace";
      actionGroup.append(workspace);
    }
    actionGroup.append(official, edit, remove);
    actions.append(actionGroup);
    row.append(actions);
    rows.append(row);
  }

  document.querySelector("#case-count").textContent = String(cases.length);
  document.querySelector("#table-summary").textContent = `Showing ${visible.length} of ${cases.length} ${cases.length === 1 ? "case" : "cases"}`;
  emptyState.hidden = cases.length > 0;
  noResults.hidden = cases.length === 0 || visible.length > 0;
}

function formatDate(value) {
  if (!value) return "Not set";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function openForm(item) {
  form.reset();
  form.elements.namedItem("cnr").readOnly = Boolean(item?.details);
  formError.textContent = "";
  recordId.value = item?.id || "";
  document.querySelector("#dialog-title").textContent = item ? "Edit case" : "Add a case";
  for (const [key, value] of Object.entries(item || {})) {
    const input = form.elements.namedItem(key);
    if (input && typeof value === "string") {
      if (input instanceof HTMLSelectElement && value && ![...input.options].some((option) => option.value === value)) {
        input.add(new Option(value, value));
      }
      input.value = value;
    }
  }
  dialog.showModal();
  form.elements.namedItem("title").focus();
}

function deleteCase(id) {
  const target = cases.find((item) => item.id === id);
  if (!target || !window.confirm(`Delete "${target.title}" from this browser?`)) return;
  if (persistCases(cases.filter((item) => item.id !== id))) renderCases();
}

function downloadCsv() {
  const columns = [
    ["title", "Case title / number"], ["cnr", "CNR"], ["caseType", "Case type"],
    ["petitioner", "Plaintiff"], ["respondent", "Defendant"], ["district", "District"],
    ["court", "Court"], ["status", "Status"], ["nextHearing", "Next hearing"], ["notes", "Notes"]
  ];
  const quote = (value) => {
    const text = String(value || "");
    const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const csv = [columns.map(([, label]) => quote(label)).join(","), ...cases.map((item) => columns.map(([key]) => quote(item[key])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "karnataka-civil-cases.csv";
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector("#add-button").addEventListener("click", () => openForm());
document.querySelectorAll("[data-open-form]").forEach((button) => button.addEventListener("click", () => openForm()));
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#export-button").addEventListener("click", downloadCsv);
filterText.addEventListener("input", renderCases);
filterStatus.addEventListener("change", renderCases);

function showDetails(item) {
  selectedDetails = item;
  document.querySelector("#details-title").textContent = item.title;
  document.querySelector("#details-meta").textContent = `CNR ${item.cnr} · Imported ${new Date(item.details.importedAt).toLocaleString("en-IN")}`;
  document.querySelector("#details-text").textContent = item.details.text;
  const links = document.querySelector("#details-links");
  links.replaceChildren();
  for (const link of item.details.links) {
    const url = new URL(link.url);
    if (url.protocol !== "https:" || url.hostname !== "services.ecourts.gov.in") continue;
    const anchor = document.createElement("a");
    anchor.textContent = link.text || "Official document link";
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    links.append(anchor);
  }
  detailsDialog.showModal();
}

document.querySelector("#close-details").addEventListener("click", () => detailsDialog.close());
document.querySelector("#details-download").addEventListener("click", () => {
  if (!selectedDetails) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(selectedDetails, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${selectedDetails.cnr}-case-details.json`;
  link.click();
  URL.revokeObjectURL(url);
});

function lookupFeedback(text, isError = false) {
  lookupMessage.textContent = text;
  lookupMessage.dataset.error = String(isError);
}

function setLookup(session) {
  currentLookup = session;
  lookupStart.disabled = Boolean(session);
  lookupInput.disabled = Boolean(session);
  document.querySelector("#lookup-active").hidden = !session;
  if (session) {
    lookupInput.value = session.cnr;
    document.querySelector("#lookup-instructions").textContent = `Lookup for ${session.cnr} is open. Complete CAPTCHA and click Search in Chrome, then import here. The window expires at ${new Date(session.expiresAt).toLocaleTimeString()}.`;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    throw new Error("Cannot reach the lookup server. Run npm start in the RND folder, then reload http://localhost:8000.");
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The browser-assisted lookup needs the Node server. Stop the old static server and run npm start in the RND folder.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Lookup request failed (${response.status}).`);
  return body;
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const cnr = normalizeCnr(lookupInput.value);
    lookupStart.disabled = true;
    lookupFeedback("Opening the official eCourts page in a separate Chrome window...");
    setLookup(await api("/api/lookup", { method: "POST", body: JSON.stringify({ cnr }) }));
    lookupFeedback("Complete the CAPTCHA and click Search on eCourts. Then click Import result here.");
  } catch (error) {
    lookupFeedback(error.message, true);
  } finally {
    lookupStart.disabled = Boolean(currentLookup);
  }
});

lookupImport.addEventListener("click", async () => {
  if (!currentLookup) return;
  lookupImport.disabled = true;
  lookupCancel.disabled = true;
  try {
    lookupFeedback("Reading the displayed case result...");
    const { record } = await api(`/api/lookup/${currentLookup.id}/import`, { method: "POST", body: "{}" });
    if (record.cnr !== currentLookup.cnr || !record.details?.text) throw new Error("The server returned an unexpected case result.");
    const existing = cases.find((item) => item.cnr?.toUpperCase() === record.cnr);
    const imported = { ...existing, ...record, id: existing?.id || crypto.randomUUID(), notes: existing?.notes || "" };
    const nextCases = existing ? cases.map((item) => item.id === existing.id ? imported : item) : [imported, ...cases];
    if (!persistCases(nextCases)) throw new Error(message.textContent);
    filterText.value = "";
    filterStatus.value = "";
    renderCases();
    await api(`/api/lookup/${currentLookup.id}`, { method: "DELETE" });
    setLookup(null);
    lookupFeedback(`Imported ${record.cnr}. Use Details to view or download the full displayed result.`);
    showDetails(imported);
  } catch (error) {
    lookupFeedback(error.message, true);
  } finally {
    lookupImport.disabled = false;
    lookupCancel.disabled = false;
  }
});

lookupCancel.addEventListener("click", async () => {
  if (!currentLookup) return;
  lookupCancel.disabled = true;
  lookupImport.disabled = true;
  try {
    await api(`/api/lookup/${currentLookup.id}`, { method: "DELETE" });
    setLookup(null);
    lookupFeedback("Lookup cancelled. No case was imported.");
  } catch (error) {
    lookupFeedback(error.message, true);
  } finally {
    lookupCancel.disabled = false;
    lookupImport.disabled = false;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const existingId = recordId.value;
  const item = {
    ...cases.find((saved) => saved.id === existingId),
    id: existingId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    title: String(data.get("title") || "").trim(),
    cnr: String(data.get("cnr") || "").replace(/[\s-]/g, "").toUpperCase(),
    caseType: String(data.get("caseType") || "").trim(),
    petitioner: String(data.get("petitioner") || "").trim(),
    respondent: String(data.get("respondent") || "").trim(),
    district: String(data.get("district") || ""),
    court: String(data.get("court") || "").trim(),
    status: String(data.get("status") || "Pending"),
    nextHearing: String(data.get("nextHearing") || ""),
    notes: String(data.get("notes") || "").trim()
  };
  if (!item.title) {
    formError.textContent = "Enter the case title or case number.";
    return;
  }
  const duplicate = item.cnr && cases.some((saved) => saved.cnr.toLowerCase() === item.cnr.toLowerCase() && saved.id !== existingId);
  if (duplicate) {
    formError.textContent = "A case with this CNR is already saved.";
    return;
  }
  const nextCases = existingId ? cases.map((saved) => saved.id === existingId ? item : saved) : [item, ...cases];
  if (persistCases(nextCases)) {
    dialog.close();
    renderCases();
  } else {
    formError.textContent = message.textContent;
  }
});

renderCases();
api("/api/health").then((health) => {
  if (health.lookup && !currentLookup) setLookup(health.lookup);
}).catch((error) => lookupFeedback(error.message, true));
