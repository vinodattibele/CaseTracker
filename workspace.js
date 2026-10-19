import { normalizeCnr } from "./case-details.mjs";

const $ = (selector) => document.querySelector(selector);
const dialog = $("#document-dialog");
let cnr;
let workspace;
let lastAnswer;

function status(selector, text, error = false) {
  $(selector).textContent = text;
  $(selector).dataset.error = String(error);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  } catch {
    throw new Error("Cannot reach the local workspace server. Run npm start and reload this page.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

const path = (suffix = "") => `/api/cases/${cnr}${suffix}`;

function textElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

async function loadWorkspace() {
  workspace = await api(path());
  $("#workspace-title").textContent = workspace.snapshot?.title || "Case workspace";
  $("#workspace-cnr").textContent = `CNR ${cnr} | Files and extracted text stored on this computer`;
  $("#snapshot-info").textContent = workspace.snapshot?.details
    ? `Snapshot imported ${new Date(workspace.snapshot.details.importedAt).toLocaleString()}.`
    : "No eCourts snapshot synced. Import a case through the tracker, then click Sync tracker snapshot.";
  renderDocuments();
  renderTimeline();
  renderHealth();
}

function renderHealth() {
  const health = workspace.health;
  $("#health-summary").textContent = `${health.heading}. ${health.comparison}`;
  const metrics = $("#health-metrics");
  metrics.replaceChildren();
  const age = health.age ? `${health.age.years} years, ${health.age.months} months (${health.age.days.toLocaleString()} days)` : "Cannot calculate from available dates";
  for (const [label, value] of [
    [health.durationLabel, age],
    ["Recorded stage", health.stage || "Not stated"],
    ["Next hearing in snapshot", health.nextHearing || "Not stated"],
    ["History coverage", `${health.historyEntries} entries; ${health.distinctPastDates} distinct past dates; ${health.futureEntries} future listings`]
  ]) {
    const card = textElement("div", "");
    card.className = "health-metric";
    card.append(textElement("span", label), textElement("strong", value));
    metrics.append(card);
  }
  $("#health-freshness").textContent = `Assessed as of ${health.asOf}. ${health.importedAt ? `Snapshot imported ${new Date(health.importedAt).toLocaleString()} (${health.snapshotAgeDays} calendar days ago).` : "Snapshot freshness unknown."} Refresh through the tracker and sync to update.`;
  $("#health-warnings").replaceChildren(...health.warnings.map((warning) => textElement("li", warning)));
  const stages = $("#health-stages");
  stages.replaceChildren();
  if (!health.stages.length) stages.append(textElement("p", "No past, dated hearing-stage entries available."));
  for (const stage of health.stages) {
    const details = textElement("details", "");
    details.className = "health-stage";
    details.append(textElement("summary", `${stage.purpose}: ${stage.entries} entries | ${stage.first} to ${stage.last}`));
    details.append(textElement("p", "Scheduled purpose labels on past dates; not proof the listed work was completed or that the entire interval was spent at this stage."));
    const list = textElement("ul", "");
    list.append(...stage.hearings.map((hearing) => textElement("li", [
      `${hearing.date}: ${hearing.purpose}`,
      hearing.court,
      hearing.businessDate ? `Business recorded on ${hearing.businessDate}` : null
    ].filter(Boolean).join(" | "))));
    details.append(list);
    stages.append(details);
  }
  $("#health-gap").textContent = health.longestGap
    ? `Largest gap between distinct recorded past hearing dates: ${health.longestGap.days} days (${health.longestGap.from} to ${health.longestGap.to}). Not necessarily inactivity; review orders and missing history.`
    : "At least two distinct past hearing dates are needed to calculate recorded intervals.";
  $("#health-questions").replaceChildren(...health.questions.map((question) => textElement("li", question)));
  $("#health-documents").replaceChildren(...health.documentsNeeded.map((document) => textElement("li", `${document.label}: ${document.uploadedCategory ? "files in this category uploaded; completeness and contents not verified" : "no files uploaded in this category"}.`)));
  $("#health-merits").textContent = `Legal merits: ${health.merits}`;
  $("#health-limitations").textContent = health.limitation;
  $("#roadmap-notice").textContent = health.roadmapNotice;
  const estimate = health.progress.estimate;
  const journeyBar = $("#case-journey-bar");
  journeyBar.hidden = !estimate.available;
  const completionScene = $("#completion-scene");
  completionScene.hidden = !estimate.available;
  $("#completion-animation-caption").hidden = !estimate.available;
  completionScene.style.setProperty("--completion", `${estimate.available ? estimate.percent : 0}%`);
  $("#journey-notice").textContent = estimate.notice;
  $("#completion-formula").textContent = estimate.formula;
  $("#completion-checklist").replaceChildren(...estimate.checklist.map((label) => textElement("li", label)));
  $("#journey-dates").replaceChildren();
  if (estimate.available) {
    journeyBar.value = estimate.percent;
    $("#journey-summary").textContent = `Approximately ${estimate.percent}% on the illustrative checklist (${estimate.stage}). Not verified case completion.`;
    journeyBar.setAttribute("aria-valuetext", `${estimate.percent}% rough checklist estimate; not verified case completion`);
    $("#journey-dates").append(textElement("span", estimate.basis));
  } else {
    $("#journey-summary").textContent = "Insufficient recognizable stage information to calculate even a rough checklist estimate.";
    journeyBar.value = 0;
    journeyBar.removeAttribute("aria-valuetext");
  }
  $("#stage-progress-note").textContent = health.progress.stageNote;
  renderStageSteps("#case-stage-progress", health.progress.steps, "No recorded progress is available for this case.");
  renderStageSteps("#case-unconfirmed-progress", health.progress.unconfirmedSteps, "No additional common stages to show. Completion of listed activities still requires order verification.");
  $("#case-future-note").textContent = health.progress.futureNotice;
  renderStageSteps("#case-future-progress", health.progress.futureSteps, "No future trial steps can be inferred from the available snapshot.");
  $("#progress-notice").textContent = health.progress.notice;
  $("#progress-current").textContent = health.progress.current;
  for (const [selector, items] of [
    ["#progress-milestones", health.progress.milestones],
    ["#progress-activity", health.progress.activity]
  ]) {
    const container = $(selector);
    container.replaceChildren();
    if (!items.length) container.append(textElement("p", "No corresponding progress information is available in the synced snapshot."));
    for (const item of items) {
      const article = textElement("article", "");
      article.className = "roadmap-step";
      article.append(textElement("h4", item.title), textElement("p", `${item.status}${item.date ? ` | ${item.date}` : ""}`), textElement("p", item.detail));
      container.append(article);
    }
  }
  const roadmap = $("#case-roadmap");
  roadmap.replaceChildren();
  for (const step of health.roadmap) {
    const article = textElement("article", "");
    article.className = "roadmap-step";
    article.append(textElement("h3", step.title), textElement("p", `Why this step: ${step.basis}`));
    const actions = textElement("ul", "");
    actions.append(...step.actions.map((action) => textElement("li", action)));
    article.append(actions, textElement("p", `Prepare: ${step.deliverable}`));
    roadmap.append(article);
  }
}

function renderStageSteps(selector, steps, emptyMessage) {
  const stageProgress = $(selector);
  stageProgress.replaceChildren();
  if (!steps.length) stageProgress.append(textElement("li", emptyMessage));
  for (const [index, step] of steps.entries()) {
    const item = textElement("li", "");
    item.className = `stage-step stage-${step.state}`;
    if (step.state === "current") item.setAttribute("aria-current", "step");
    if (step.state === "disabled") item.setAttribute("aria-disabled", "true");
    const marker = textElement("span", String(index + 1));
    marker.className = "stage-marker";
    marker.setAttribute("aria-hidden", "true");
    item.append(marker, textElement("strong", step.label), textElement("span", step.status));
    if (step.date) item.append(textElement("p", step.date));
    stageProgress.append(item);
  }
}

function renderDocuments() {
  const container = $("#document-list");
  container.replaceChildren();
  if (!workspace.documents.length) container.append(textElement("p", "No documents uploaded. Add pleadings, orders or evidence you are entitled to access."));
  for (const document of workspace.documents) {
    const card = textElement("article", "");
    card.className = "document-card";
    card.append(textElement("h3", document.name), textElement("p", `${document.category} | ${document.pageCount} pages | ${(document.bytes / 1024).toFixed(1)} KB`));
    if (document.emptyPages.length) card.append(textElement("p", `No extracted text on pages ${document.emptyPages.join(", ")}. Image/scanned portions are not analyzed.`));
    const actions = textElement("div", "");
    actions.className = "document-actions";
    const view = textElement("button", "Read extracted text");
    view.type = "button";
    view.className = "button button-quiet";
    view.addEventListener("click", () => openDocument(document.id));
    const download = textElement("a", "Download original");
    download.href = path(`/documents/${document.id}/download`);
    const remove = textElement("button", "Delete");
    remove.type = "button";
    remove.className = "row-action delete";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete "${document.name}" and its extracted text from this case?`)) return;
      remove.disabled = true;
      try {
        await api(path(`/documents/${document.id}`), { method: "DELETE" });
        lastAnswer = null;
        $("#answer-section").hidden = true;
        await loadWorkspace();
      } catch (error) {
        status("#workspace-error", error.message, true);
        remove.disabled = false;
      }
    });
    actions.append(view, download, remove);
    card.append(actions);
    container.append(card);
  }
}

function renderTimeline() {
  const container = $("#timeline");
  container.replaceChildren();
  if (!workspace.timeline.length) container.append(textElement("p", "No recognizable hearing-history table is present in this snapshot."));
  for (const entry of workspace.timeline) {
    const article = textElement("article", "");
    article.className = "timeline-entry";
    const list = textElement("dl", "");
    for (const field of entry.fields) list.append(textElement("dt", field.label), textElement("dd", field.value || "Not recorded"));
    article.append(list);
    container.append(article);
  }
}

async function syncSnapshot() {
  const records = JSON.parse(localStorage.getItem("karnataka-civil-case-tracker.v1") || "[]");
  const record = records.find((item) => item.cnr?.replace(/[\s-]/g, "").toUpperCase() === cnr);
  if (!record) throw new Error("This case is not in this browser's tracker. Import or add it in the tracker first.");
  await api(path("/snapshot"), { method: "PUT", body: JSON.stringify(record) });
}

async function openDocument(id, pageNumber) {
  try {
    const document = await api(path(`/documents/${id}`));
    $("#document-title").textContent = document.name;
    $("#document-warning").textContent = "Extracted text is not a certified copy. Compare against the original, especially tables, handwriting and scanned sections.";
    const container = $("#document-pages");
    container.replaceChildren();
    for (const page of document.pages) {
      const section = textElement("section", "");
      section.className = "document-page";
      section.id = `page-${page.number}`;
      section.append(textElement("h3", `Page ${page.number}`), textElement("pre", page.text || "No readable text on this page."));
      container.append(section);
    }
    dialog.showModal();
    if (pageNumber) $(`#page-${pageNumber}`)?.scrollIntoView({ block: "start" });
  } catch (error) {
    status("#workspace-error", error.message, true);
  }
}

$("#close-document").addEventListener("click", () => dialog.close());
$("#sync-case").addEventListener("click", async () => {
  try {
    await syncSnapshot();
    await loadWorkspace();
    status("#workspace-error", "Tracker snapshot synced locally.");
  } catch (error) {
    status("#workspace-error", error.message, true);
  }
});

$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#document-file").files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return status("#upload-status", "Maximum file size is 10 MB.", true);
  $("#upload-button").disabled = true;
  $("#answer-section").hidden = true;
  lastAnswer = null;
  status("#upload-status", "Extracting and storing this document locally...");
  try {
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
    const result = await api(path("/documents"), {
      method: "POST",
      body: JSON.stringify({ name: file.name, category: $("#document-category").value, content })
    });
    await loadWorkspace();
    $("#upload-form").reset();
    status("#upload-status", `Saved ${result.name}. ${result.pages.length} pages indexed locally.`);
  } catch (error) {
    status("#upload-status", error.message, true);
  } finally {
    $("#upload-button").disabled = false;
  }
});

async function checkModel() {
  try {
    const result = await api("/api/ai/status");
    if (!result.installed) throw new Error(`Ollama is running, but ${result.model} is not installed. Run: ollama pull ${result.model}`);
    status("#ai-status", `${result.model} ready on this computer. Cloud AI is not used.`);
  } catch (error) {
    status("#ai-status", error.message, true);
  }
}
$("#check-model").addEventListener("click", checkModel);

$("#assistant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#ask-button").disabled = true;
  $("#answer-section").hidden = true;
  lastAnswer = null;
  status("#assistant-status", "Analyzing local excerpts. This may take up to three minutes...");
  try {
    const result = await api(path("/assist"), {
      method: "POST",
      body: JSON.stringify({ question: $("#assistant-question").value, mode: $("#assistant-mode").value })
    });
    lastAnswer = result;
    $("#answer-heading").textContent = result.mode === "draft" ? "DRAFT FOR ADVOCATE REVIEW" : "AI-generated assistance - verify against sources";
    $("#assistant-answer").textContent = result.answer;
    $("#answer-disclaimer").textContent = `${result.disclaimer} ${result.retrieval}`;
    $("#answer-limitations").replaceChildren(...result.limitations.map((limitation) => textElement("li", limitation)));
    const sources = $("#answer-sources");
    sources.replaceChildren();
    for (const source of result.sources) {
      const card = textElement("article", "");
      card.className = "source-card";
      card.append(textElement("strong", `[${source.id}] ${source.name} | ${source.page ? `page ${source.page}` : "snapshot text"} | characters ${source.offset + 1}-${source.offset + source.excerpt.length}`));
      if (source.documentId) {
        const view = textElement("button", "Open source page");
        view.className = "row-action";
        view.type = "button";
        view.addEventListener("click", () => openDocument(source.documentId, source.page));
        card.append(view);
      }
      card.append(textElement("pre", source.excerpt));
      sources.append(card);
    }
    $("#answer-section").hidden = false;
    status("#assistant-status", `Generated locally with ${result.model}. Citation identifiers checked; human review is still required.`);
  } catch (error) {
    status("#assistant-status", error.message, true);
  } finally {
    $("#ask-button").disabled = false;
  }
});

$("#download-answer").addEventListener("click", () => {
  if (!lastAnswer) return;
  const blob = new Blob([JSON.stringify(lastAnswer, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = textElement("a", "");
  anchor.href = url;
  anchor.download = `${cnr}-local-ai-answer.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

try {
  cnr = normalizeCnr(new URLSearchParams(location.search).get("cnr"));
  await loadWorkspace();
  if (!workspace.snapshot) {
    const records = JSON.parse(localStorage.getItem("karnataka-civil-case-tracker.v1") || "[]");
    if (records.some((record) => record.cnr?.toUpperCase() === cnr)) {
      await syncSnapshot();
      await loadWorkspace();
    }
  }
  await checkModel();
} catch (error) {
  status("#workspace-error", error.message, true);
  document.querySelectorAll("form button, #sync-case").forEach((button) => { button.disabled = true; });
}
