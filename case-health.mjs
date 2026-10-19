const DAY = 86400000;
const key = (value) => value.toLowerCase().replace(/[^a-z]/g, "");

export function parseHealthDate(value) {
  if (typeof value !== "string") return null;
  let match = value.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) match = [match[0], match[3], match[2], match[1]];
  else match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const written = value.trim().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/i);
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const month = written ? months.indexOf(written[2].toLowerCase()) + 1 : 0;
    if (!month) return null;
    match = [written[0], written[3], String(month), written[1]];
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? date : null;
}

function iso(date) {
  return date?.toISOString().slice(0, 10) || null;
}

function elapsed(start, end) {
  if (!start || end < start) return null;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return { years: Math.floor(months / 12), months: months % 12, days: Math.floor((end - start) / DAY) };
}

export function caseHealth(snapshot, timeline, documents, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fields = snapshot?.details?.fields || {};
  const filing = parseHealthDate(fields.filingdate);
  const disposal = parseHealthDate(fields.disposaldate || fields.decisiondate);
  const next = parseHealthDate(fields.nexthearingdate || snapshot?.nextHearing);
  const importedAt = snapshot?.details?.importedAt;
  const imported = typeof importedAt === "string" && Number.isFinite(Date.parse(importedAt)) ? new Date(importedAt) : null;
  const recordedStatus = fields.casestatus || snapshot?.status || "";
  const disposed = /disposed|decided/i.test(recordedStatus) || Boolean(disposal);
  const stage = fields.casestage || fields.stageofcase || null;
  const warnings = [];
  if (!snapshot) warnings.push("No case snapshot is synced. Import a case and sync it to assess recorded progress.");
  if (snapshot && !filing) warnings.push("Filing date is missing or unrecognized; case age cannot be calculated.");
  if (filing && filing > today) warnings.push("The recorded filing date is in the future; verify the source.");
  if (disposed && !disposal) warnings.push("Disposal is recorded but its date is unavailable; total duration cannot be calculated.");
  if (disposal && (!filing || disposal < filing || disposal > today)) warnings.push("The recorded disposal date cannot be used for duration; verify the source.");
  if (!imported) warnings.push("Snapshot import date is unavailable; freshness cannot be assessed.");
  if (!disposed && next && next < today) warnings.push("The recorded next-hearing date has passed. Refresh eCourts; this does not establish that the hearing was missed.");

  let invalidDates = 0;
  const rows = timeline.map((entry) => {
    const values = Object.fromEntries(entry.fields.map((field) => [key(field.label), field.value]));
    const date = parseHealthDate(values.hearingdate);
    if (!date) invalidDates += 1;
    return {
      date,
      purpose: (values.purposeofhearing || values.purpose || values.business || "Not recorded").trim().replace(/\s+/g, " "),
      court: values.judge || values.court || values.courtname || null,
      businessDate: iso(parseHealthDate(values.businessondate))
    };
  });
  if (invalidDates) warnings.push(`${invalidDates} history entries have missing or unrecognized hearing dates and are excluded from date calculations.`);
  const dated = rows.filter((row) => row.date && row.date <= today).sort((a, b) => a.date - b.date);
  const future = rows.filter((row) => row.date && row.date > today);
  const groups = new Map();
  for (const row of dated) {
    const normalized = row.purpose.toUpperCase();
    const group = groups.get(normalized) || { purpose: row.purpose, entries: 0, first: iso(row.date), last: iso(row.date), hearings: [] };
    group.entries += 1;
    group.last = iso(row.date);
    group.hearings.push({ date: iso(row.date), purpose: row.purpose, court: row.court, businessDate: row.businessDate });
    groups.set(normalized, group);
  }
  const stages = [...groups.values()].sort((a, b) => b.entries - a.entries || a.purpose.localeCompare(b.purpose));
  const dates = [...new Set(dated.map((row) => iso(row.date)))];
  let longestGap = null;
  for (let index = 1; index < dates.length; index += 1) {
    const days = Math.round((parseHealthDate(dates[index]) - parseHealthDate(dates[index - 1])) / DAY);
    if (!longestGap || days > longestGap.days) longestGap = { days, from: dates[index - 1], to: dates[index] };
  }
  const end = disposed ? disposal : today;
  const age = filing && end && end <= today ? elapsed(filing, end) : null;
  const questions = [];
  if (/amend/i.test(stage || "")) questions.push("Which amendment application is pending, when was it filed, and what is needed for its decision? Check the application, objections and latest order sheet.");
  if (stages.some((item) => /evidence/i.test(item.purpose))) questions.push("Which witnesses, cross-examinations and documents remain? Review the daily orders to explain repeated evidence listings; labels do not prove inactivity.");
  if (stages.some((item) => /arguments/i.test(item.purpose))) questions.push("Were the arguments for the suit or for an interim application? Do not infer that final arguments or the trial were completed from this label.");
  if (snapshot && !disposed) questions.push("After identifying pending applications, service issues and any stay orders, discuss a focused hearing schedule or an appropriate expedition request with your advocate. Consider mediation if suitable and voluntary.");
  if (longestGap) questions.push("Check daily orders covering the longest recorded interval for stays, transfers, service issues or adjournment reasons. Missing history can also create apparent gaps.");
  const categories = new Set(documents.map((document) => document.category));
  const documentsNeeded = [
    { category: "Order", label: "Latest and historical daily orders / order sheets" },
    { category: "Pleading", label: "Plaint, written statements and pending applications with objections" },
    { category: "Evidence", label: "Recorded evidence, exhibits and witness / cross-examination records" }
  ].map((item) => ({ ...item, uploadedCategory: categories.has(item.category) }));
  const milestones = [];
  const addMilestone = (title, value, date) => {
    if (typeof value !== "string" || !value.trim()) return;
    const parsed = parseHealthDate(date);
    if (parsed && parsed > today) return;
    milestones.push({ title, detail: value.trim(), date: iso(parsed), status: "Recorded milestone" });
  };
  if (filing && filing <= today) addMilestone("Case filing recorded", fields.filingnumber || "Filing date recorded in the case details.", fields.filingdate);
  addMilestone("Case registration recorded", fields.registrationnumber, fields.registrationdate);
  if (disposal && disposal <= today && (!filing || disposal >= filing)) addMilestone("Case disposal recorded", fields.casestatus || snapshot?.status || "Disposal date recorded; review the final order for its effect.", fields.disposaldate || fields.decisiondate);
  const stageMap = {
    summons: "service", service: "service", pleadings: "service", writtenstatement: "service",
    issues: "issues", framingofissues: "issues",
    evidence: "evidence", plaintiffsevidence: "evidence", defendantsevidence: "evidence",
    arguments: "arguments", finalarguments: "arguments",
    judgment: "disposal", forjudgment: "disposal"
  };
  const progressSteps = milestones.filter((item) => !/disposal/.test(item.title)).map((item, index) => ({
    id: `milestone-${index}`, label: item.title, state: "recorded", status: item.detail, date: item.date
  })).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  const runs = [];
  for (const entry of dated) {
    const previous = runs.at(-1);
    if (previous && key(previous.label) === key(entry.purpose)) {
      previous.last = iso(entry.date);
      previous.count += 1;
    } else {
      runs.push({ label: entry.purpose, first: iso(entry.date), last: iso(entry.date), count: 1 });
    }
  }
  for (const [index, run] of runs.entries()) {
    progressSteps.push({
      id: `history-${index}`, label: run.label, state: "history",
      status: `${run.count} past-dated ${run.count === 1 ? "listing" : "listings"}; completion unverified`,
      date: run.first === run.last ? run.first : `${run.first} to ${run.last}`
    });
  }
  if (snapshot && (stage || disposed)) progressSteps.push({
    id: "current", label: disposed ? "Disposal recorded" : stage,
    state: disposed ? "recorded" : "current",
    status: disposed ? "Not necessarily a judgment on merits; review the final order"
      : `Current recorded stage; completion unverified${next ? `; next hearing ${iso(next)}` : ""}`,
    date: disposed ? iso(disposal) : null
  });
  const observed = new Set(dated.map((entry) => stageMap[key(entry.purpose)]).filter(Boolean));
  if (stageMap[key(stage || "")]) observed.add(stageMap[key(stage)]);
  if (disposed) observed.add("disposal");
  const unconfirmedSteps = snapshot ? [
    ["service", "Service / pleadings"],
    ["issues", "Issues"],
    ["evidence", "Evidence"],
    ["arguments", "Arguments"],
    ["disposal", "Decision / disposal"]
  ].filter(([id]) => !observed.has(id)).map(([id, label]) => ({
    id: `unconfirmed-${id}`, label, state: "disabled",
    status: "Not established by this snapshot; completion not confirmed", date: null
  })) : [];
  const futureSteps = [];
  if (snapshot && !disposed) {
    const scheduled = [...future].sort((a, b) => a.date - b.date);
    for (const [index, entry] of scheduled.entries()) futureSteps.push({
      id: `scheduled-${index}`, label: entry.purpose, date: iso(entry.date),
      state: "scheduled", status: "Future listing recorded in the snapshot; not a completed hearing"
    });
    if (next && next >= today && !scheduled.some((entry) => iso(entry.date) === iso(next))) {
      futureSteps.unshift({
        id: "next-hearing", label: stage || "Next hearing", date: iso(next),
        state: "scheduled", status: "Next hearing date recorded; confirm its purpose and date with the latest order"
      });
    }
    const possible = [
      ["applications", "Resolve pending applications / amendment", "If pending: obtain the application order and identify any resulting pleadings or compliance."],
      ["issues", "Settle or revisit issues", "If required by the pleadings or an amendment: confirm the framed issues with your advocate."],
      ["evidence", "Complete remaining evidence / cross-examination", "If evidence remains or is reopened: confirm witnesses, exhibits and the evidence-closure order."],
      ["arguments", "Final arguments / written submissions", "If the case proceeds to final hearing: confirm trial readiness and the court's directions."],
      ["disposal", "Judgment / disposal", "If the suit proceeds to a decision: obtain the signed order; disposal is not necessarily a win on merits."]
    ];
    for (const [id, label, condition] of possible) futureSteps.push({
      id: `possible-${id}`, label, date: null, state: "disabled",
      status: `Possible later step - pending status unverified. ${condition}`
    });
  }
  const journeyEnd = disposed ? disposal : next;
  const validJourney = Boolean(filing && filing <= today && journeyEnd && journeyEnd > filing && (!disposed || journeyEnd <= today));
  const spanDays = validJourney ? Math.round((journeyEnd - filing) / DAY) : null;
  const elapsedDays = validJourney ? Math.min(spanDays, Math.round((today - filing) / DAY)) : null;
  const journey = {
    available: validJourney,
    start: iso(filing),
    end: iso(journeyEnd),
    asOf: iso(today),
    endLabel: disposed ? "Recorded disposal" : "Next hearing in snapshot",
    spanDays,
    elapsedDays,
    remainingDays: validJourney ? Math.max(0, Math.round((journeyEnd - today) / DAY)) : null,
    percent: validJourney ? elapsedDays * 100 / spanDays : null,
    notice: !validJourney
      ? "Cannot draw the elapsed-time bar: a valid filing date and a later next-hearing date (or valid recorded disposal date) are required."
      : !disposed && journeyEnd < today
        ? "The hearing endpoint has passed; refresh and sync the case. A full time bar does not mean the case is completed."
        : disposed
          ? "This bar spans filing to recorded disposal. It does not establish a win, finality or completed enforcement."
          : "Fill measures elapsed calendar time from filing to the recorded next hearing, NOT case completion. That hearing is not a predicted resolution date. The bar changes when the hearing endpoint changes."
  };
  const checklist = ["Filing / registration", "Service / pleadings", "Issues", "Evidence", "Arguments", "Decision / disposal"];
  const checklistKeys = ["filing", "service", "issues", "evidence", "arguments", "disposal"];
  const latestTrial = [...dated].reverse().find((entry) => stageMap[key(entry.purpose)]);
  const currentTrial = stageMap[key(stage || "")];
  const estimatedStage = disposed ? "disposal" : currentTrial || (latestTrial ? stageMap[key(latestTrial.purpose)] : milestones.some((item) => /filing|registration/.test(item.title)) ? "filing" : null);
  const stageIndex = checklistKeys.indexOf(estimatedStage);
  const estimate = {
    available: Boolean(snapshot && stageIndex >= 0),
    percent: snapshot && stageIndex >= 0 ? (disposed ? 100 : Math.round((stageIndex + 0.5) * 100 / checklist.length)) : null,
    basis: disposed ? "Disposal is recorded in the snapshot."
      : currentTrial ? `Uses current recorded stage: ${stage}.`
        : latestTrial ? `Current stage ${stage || "not stated"} has no fixed checklist position. Uses the most recent recognizable trial-purpose listing: ${latestTrial.purpose}, ${iso(latestTrial.date)}.`
          : "Only a filing/registration milestone can be positioned on the checklist.",
    stage: stageIndex >= 0 ? checklist[stageIndex] : null,
    checklist,
    formula: "Six equally weighted typical stages; the active stage is placed halfway through its segment: (stage index + 0.5) / 6. Recorded disposal maps to 100%. These weights and the halfway assumption are illustrative, not measured.",
    notice: "ROUGH ESTIMATE ONLY - not a comparison with real cases, verified completion, time remaining or chances of winning. Earlier stages are assumed for illustration, not established complete. Interim applications, reopened evidence, settlement and different procedures can make this estimate inaccurate; it can decrease if the case returns to an earlier stage. Recorded disposal does not establish finality or completed enforcement."
  };
  const progress = {
    estimate,
    journey,
    steps: progressSteps,
    unconfirmedSteps,
    futureSteps,
    futureNotice: !snapshot ? "Sync a case snapshot to see recorded future listings."
      : disposed ? "Disposal is recorded. No pending trial stages are inferred; review any enforcement or challenge steps separately with your advocate."
        : "Recorded future listings are separated from conditional preparation steps. Earlier appearances in the history do not establish that a stage is finished. Greyed-out steps may not apply or occur in this order; the signed orders are needed to establish what is actually pending.",
    stageNote: !snapshot ? "No case snapshot is available."
      : disposed ? "Disposal is recorded; this does not establish a win, finality, or completion of enforcement."
        : `Progress for ${snapshot.title || snapshot.cnr}: ${stage ? `current recorded stage ${stage}` : "current stage not stated"}. The bar uses this case's milestones and chronological hearing history, not a generic trial sequence.`,
    milestones,
    activity: [...stages].sort((a, b) => a.first.localeCompare(b.first)).map((item) => ({
      title: item.purpose,
      status: "Listed in history - completion unverified",
      detail: `${item.entries} past-dated listings from ${item.first} to ${item.last}. Check the daily orders for what actually occurred.`
    })),
    current: stage ? `Current recorded stage: ${stage}. The stage label does not confirm whether the underlying task is complete.` : "Current stage is not stated in the snapshot.",
    notice: "Recorded milestones are separate from completed trial work. Service, framing of issues, evidence closure, final arguments and judgment are not marked complete merely because a hearing purpose appears or a later stage is listed. Review the signed orders for confirmation. The separate rough checklist estimate is not verified completion."
  };
  const roadmap = [];
  if (snapshot && !disposed) {
    roadmap.push({
      title: "1. Confirm the immediate procedural blocker",
      basis: stage ? `The snapshot records the stage as ${stage}.` : "The snapshot does not identify the current stage.",
      actions: [
        "Obtain the latest signed daily order and the pending-application list. Ask your advocate to identify exactly what the court expects next and who must do it.",
        ...(/amend/i.test(stage || "") ? ["Review the amendment application, proposed changes and objections with your advocate. Confirm whether it is pending or already decided; a stage label alone does not establish that."] : []),
        "Confirm the next hearing and any filing or compliance dates from the actual order, not from an AI estimate."
      ],
      deliverable: "An advocate-reviewed next-hearing checklist with each task, responsible person and court-confirmed date."
    });
    roadmap.push({
      title: "2. Build an issue-by-issue evidence map",
      basis: `${documents.length} documents are uploaded; upload counts do not establish a complete or persuasive case file.`,
      actions: [
        "Collect the plaint, all written statements, framed issues, applications, orders, witness evidence and exhibit list from authorized sources.",
        "For each disputed issue, identify your position, the applicable burden of proof with your advocate, supporting document/page or witness, the opponent's response and any missing proof.",
        "Separate allegations from admissions and findings. Preserve originals and provenance; check relevance and admissibility with your advocate. Never fabricate, alter or conceal evidence."
      ],
      deliverable: "A strengths-and-gaps matrix tied to the actual issues and source pages, including adverse material that needs an honest response."
    });
    roadmap.push({
      title: "3. Prepare the remaining trial work",
      basis: stages.some((item) => /evidence/i.test(item.purpose)) ? "Evidence appears repeatedly in the recorded hearing purposes; this does not prove no evidence was taken." : "The timeline alone does not establish which trial tasks remain.",
      actions: [
        "Ask which witnesses, examinations, cross-examinations and exhibit formalities remain, and what each is intended to establish.",
        "Coordinate witness availability and required originals with your advocate before the hearing. Ask whether lawful summons or other court directions are needed.",
        "Have your advocate prepare issue-focused examination questions and address contradictions using the actual record, without coaching false testimony."
      ],
      deliverable: "A witness/document readiness list, with outstanding tasks and a practical sequence for completing evidence."
    });
    roadmap.push({
      title: "4. Address delay with a documented plan",
      basis: longestGap ? `The largest interval between recorded past hearing dates is ${longestGap.days} days. Missing records or legitimate procedural events may explain it.` : "The available history cannot establish the reasons for delay.",
      actions: [
        "Read the order sheets to distinguish service issues, stays, transfers, pending applications, genuine adjournment reasons and missing history; do not attribute blame from hearing labels.",
        "Complete your own outstanding compliance promptly. Ask your advocate whether a focused schedule, early-hearing request or another appropriate procedural step is available in this case.",
        "Discuss voluntary mediation or settlement if suitable, including costs, enforceability and the consequences of any proposed terms."
      ],
      deliverable: "An order-backed list of blockers and lawful options for resolving each; no assumed right to expedition or guaranteed completion date."
    });
    roadmap.push({
      title: "5. Prepare arguments and outcome follow-through",
      basis: "Winning prospects cannot be assessed from a timeline. Current law, pleadings, evidence and orders must be reviewed.",
      actions: [
        "After confirming the procedural stage, prepare an issue-wise argument outline with supporting evidence, opposing evidence and verified legal authorities for your advocate.",
        "Check the precise relief sought and whether the pleadings and proof support it. Discuss realistic outcomes and settlement alternatives rather than relying on a win score.",
        "When an order or judgment is received, obtain the signed copy and ask your advocate about compliance, enforcement and any review/appeal options and applicable deadlines."
      ],
      deliverable: "An advocate-reviewed argument pack and, when applicable, an order-specific follow-through plan."
    });
  }
  return {
    asOf: iso(today),
    available: Boolean(snapshot),
    heading: snapshot ? "Recorded progress review" : "Insufficient case data",
    filingDate: iso(filing), age, durationLabel: disposed ? "Filing to recorded disposal" : "Time since filing",
    stage, recordedStatus: fields.casestatus || (["Pending", "Disposed"].includes(snapshot?.status) ? snapshot.status : null),
    nextHearing: iso(next), importedAt: imported?.toISOString() || null,
    snapshotAgeDays: imported ? Math.max(0, Math.floor((today - new Date(iso(imported))) / DAY)) : null,
    historyEntries: timeline.length, datedPastEntries: dated.length, futureEntries: future.length,
    distinctPastDates: dates.length, stages, longestGap, warnings, questions, documentsNeeded,
    documentCount: documents.length,
    progress,
    roadmap,
    roadmapNotice: disposed
      ? "Disposal is recorded. A trial-progression roadmap is not appropriate; ask your advocate to review the final order and any compliance, enforcement or challenge options and deadlines."
      : snapshot
        ? "Preparation roadmap, not a guaranteed route to victory. It is generated from recorded stages and document availability, not a substantive review of your case. Steps may overlap or not apply; confirm the sequence with your advocate."
        : "Sync a case snapshot first. A case-specific progression roadmap cannot be prepared without recorded case information.",
    merits: "Not assessed. Uploaded document counts and hearing labels do not establish evidence strength, admissibility or chances of winning.",
    comparison: "No comparable-case benchmark is connected. The app cannot classify this case as faster/slower than similar cases, attribute fault, or decide whether delay was avoidable.",
    limitation: "Computed from the synced snapshot, not a live court check or AI legal opinion. History entries are not proven adjournments or completed hearings. Stage spans and gaps do not establish continuous inactivity. These review questions cannot establish how or when the case could have been resolved."
  };
}
