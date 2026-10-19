import test from "node:test";
import assert from "node:assert/strict";
import { caseHealth, parseHealthDate } from "../case-health.mjs";

const now = new Date("2026-10-19T10:00:00Z");
const row = (date, purpose) => ({
  source: `Test history row ${date}`,
  fields: [{ label: "Hearing Date", value: date }, { label: "Purpose of Hearing", value: purpose }]
});
const record = (fields = {}) => ({
  status: "Other",
  details: { importedAt: "2026-10-18T09:00:00Z", fields: { filingdate: "20-10-2014", casestage: "Amendment", nexthearingdate: "31st October 2026", ...fields } }
});

test("validates numeric, ISO and ordinal dates without guessing malformed dates", () => {
  for (const input of ["31-10-2026", "2026-10-31", "31st October 2026"]) assert.equal(parseHealthDate(input).toISOString().slice(0, 10), "2026-10-31");
  for (const input of ["31-02-2026", "2026-13-01", "", undefined, "tomorrow", "1st Unknown 2026"]) assert.equal(parseHealthDate(input), null);
});

test("computes exact age before anniversary, past-stage counts and gaps without counting future dates", () => {
  const health = caseHealth(record(), [
    row("31-10-2026", "Amendment"), row("01-06-2026", "EVIDENCE"), row("01-01-2026", "Evidence"),
    row("01-01-2026", "ISSUES"), row("bad", "Evidence"), row("01-09-2021", "ARGUMENTS")
  ], [], now);
  assert.equal(health.age.years, 11);
  assert.equal(health.age.months, 11);
  assert.equal(health.nextHearing, "2026-10-31");
  assert.equal(health.distinctPastDates, 3);
  assert.equal(health.datedPastEntries, 4);
  assert.equal(health.futureEntries, 1);
  assert.equal(health.stages.find((stage) => stage.purpose.toUpperCase() === "EVIDENCE").entries, 2);
  const evidence = health.stages.find((stage) => stage.purpose.toUpperCase() === "EVIDENCE");
  assert.equal(evidence.hearings[0].date, "2026-01-01");
  assert.equal(evidence.hearings[0].purpose, "Evidence");
  assert.equal("sources" in evidence, false);
  assert.equal(health.longestGap.from, "2021-09-01");
  assert.equal(health.longestGap.to, "2026-01-01");
  assert.ok(health.questions.some((question) => question.includes("interim application")));
  assert.ok(health.questions.some((question) => question.includes("amendment")));
  assert.equal(health.roadmap.length, 5);
  assert.equal(health.progress.milestones[0].title, "Case filing recorded");
  assert.equal(health.progress.milestones[0].date, "2014-10-20");
  assert.ok(health.progress.activity.every((item) => item.status === "Listed in history - completion unverified"));
  assert.ok(health.progress.activity.some((item) => item.title === "ARGUMENTS"));
  assert.ok(!health.progress.activity.some((item) => item.title === "Amendment"));
  assert.match(health.progress.current, /Current recorded stage: Amendment/);
  assert.ok(health.roadmap[0].actions.some((action) => action.includes("amendment application")));
  assert.match(health.roadmapNotice, /not a guaranteed route to victory/);
  assert.ok(health.warnings.some((warning) => warning.includes("unrecognized hearing dates")));
  assert.equal(health.snapshotAgeDays, 1);
  assert.ok(health.documentsNeeded.every((document) => !document.uploadedCategory));
});

test("missing snapshot and dates produce explicit unknowns rather than a health score", () => {
  const health = caseHealth(null, [], [], now);
  assert.equal(health.available, false);
  assert.equal(health.age, null);
  assert.equal(health.longestGap, null);
  assert.equal(health.snapshotAgeDays, null);
  assert.match(health.comparison, /No comparable-case benchmark/);
  assert.match(health.merits, /Not assessed/);
  assert.equal("score" in health, false);
  assert.deepEqual(health.roadmap, []);
  assert.deepEqual(health.progress.milestones, []);
  assert.deepEqual(health.progress.activity, []);
  assert.match(health.roadmapNotice, /Sync a case snapshot/);
});

test("disposal stops duration at the disposal date; future/invalid dates are not used", () => {
  const health = caseHealth(record({ filingdate: "01-01-2020", disposaldate: "01-01-2022" }), [], [{ category: "Order" }], now);
  assert.equal(health.age.years, 2);
  assert.equal(health.age.months, 0);
  assert.equal(health.durationLabel, "Filing to recorded disposal");
  assert.deepEqual(health.roadmap, []);
  assert.match(health.roadmapNotice, /Disposal is recorded/);
  assert.ok(health.progress.milestones.some((item) => item.title === "Case disposal recorded"));
  assert.equal(health.documentsNeeded.find((document) => document.category === "Order").uploadedCategory, true);
  assert.equal(caseHealth(record({ filingdate: "01-01-2030" }), [], [], now).age, null);
  assert.equal(caseHealth(record({ disposaldate: "01-01-2010" }), [], [], now).age, null);
  assert.equal(caseHealth({ ...record(), status: "Disposed" }, [], [], now).age, null);
  const stale = caseHealth(record({ nexthearingdate: "01-01-2026" }), [], [], now);
  assert.ok(stale.warnings.some((warning) => warning.includes("does not establish that the hearing was missed")));
});

test("progress records registration without treating a scheduled trial stage as completed", () => {
  const health = caseHealth(record({ registrationnumber: "123/2014", registrationdate: "21-10-2014" }), [row("01-01-2026", "EVIDENCE")], [], now);
  const registration = health.progress.milestones.find((item) => item.title === "Case registration recorded");
  assert.equal(registration.detail, "123/2014");
  assert.equal(registration.date, "2014-10-21");
  assert.equal(health.progress.activity[0].status, "Listed in history - completion unverified");
  assert.match(health.progress.notice, /not verified completion/);
  const future = caseHealth(record({ registrationnumber: "123/2030", registrationdate: "01-01-2030" }), [], [], now);
  assert.ok(!future.progress.milestones.some((item) => item.title === "Case registration recorded"));
});

test("rough checklist estimate uses latest recognizable stage rather than highest past stage or elapsed time", () => {
  const history = [row("01-01-2021", "Arguments"), row("01-01-2026", "Evidence")];
  const estimate = caseHealth(record(), history, [], now).progress.estimate;
  assert.equal(estimate.percent, 58);
  assert.equal(estimate.stage, "Evidence");
  assert.match(estimate.basis, /2026-01-01/);
  assert.match(estimate.notice, /not a comparison with real cases/);
  assert.match(estimate.formula, /halfway/);
  assert.equal(caseHealth(record({ casestage: "Issues" }), history, [], now).progress.estimate.percent, 42);
  assert.equal(caseHealth({ ...record(), status: "Disposed" }, history, [], now).progress.estimate.percent, 100);
  assert.equal(caseHealth(null, [], [], now).progress.estimate.percent, null);
  assert.equal(caseHealth({ details: { fields: { casestage: "Unknown" } } }, [], [], now).progress.estimate.available, false);
});

test("age changes on anniversary and sparse or duplicate history does not fabricate intervals", () => {
  const health = caseHealth(record(), [row("01-01-2026", "Evidence"), row("01-01-2026", "Evidence")], [], new Date("2026-10-20T23:59:00Z"));
  assert.equal(health.age.years, 12);
  assert.equal(health.age.months, 0);
  assert.equal(health.longestGap, null);
  assert.equal(health.distinctPastDates, 1);
});

test("stage progress marks current stage without inventing completion of earlier trial work", () => {
  const health = caseHealth(record({ casestage: "EVIDENCE" }), [], [], now);
  assert.equal(health.progress.steps.length, 2);
  assert.equal(health.progress.steps.find((step) => step.label === "EVIDENCE").state, "current");
  assert.equal(health.progress.steps[0].state, "recorded");
  assert.equal(health.progress.unconfirmedSteps.find((step) => step.id === "unconfirmed-issues").state, "disabled");
  assert.equal(caseHealth(record(), [], [], now).progress.steps.at(-1).label, "Amendment");
  assert.match(caseHealth(record(), [], [], now).progress.stageNote, /not a generic trial sequence/);
  assert.deepEqual(caseHealth(null, [], [], now).progress.steps, []);
  assert.deepEqual(caseHealth(null, [], [], now).progress.unconfirmedSteps, []);
  const disposed = caseHealth({ ...record(), status: "Disposed" }, [], [], now);
  assert.equal(disposed.progress.steps.at(-1).label, "Disposal recorded");
  assert.equal(disposed.progress.steps.at(-1).state, "recorded");
  assert.match(disposed.progress.stageNote, /does not establish a win/);
});

test("case progress preserves returning purposes and excludes future history from past activity", () => {
  const health = caseHealth(record(), [
    row("01-01-2021", "Evidence"), row("01-02-2021", "EVIDENCE"), row("01-01-2022", "Arguments"),
    row("01-01-2023", "Evidence"), row("31-10-2026", "Amendment")
  ], [], now);
  const history = health.progress.steps.filter((step) => step.state === "history");
  assert.deepEqual(history.map((step) => step.label), ["Evidence", "Arguments", "Evidence"]);
  assert.equal(history[0].date, "2021-01-01 to 2021-02-01");
  assert.match(history[0].status, /2 past-dated listings/);
  assert.equal(health.progress.steps.at(-1).label, "Amendment");
  assert.equal(health.progress.steps.at(-1).state, "current");
  assert.ok(!health.progress.unconfirmedSteps.some((step) => /evidence|arguments/.test(step.id)));
  assert.ok(health.progress.unconfirmedSteps.some((step) => step.id === "unconfirmed-disposal"));
  assert.equal(health.progress.futureSteps[0].label, "Amendment");
  assert.equal(health.progress.futureSteps[0].date, "2026-10-31");
  assert.equal(health.progress.futureSteps[0].state, "scheduled");
  assert.equal(health.progress.futureSteps.filter((step) => step.state === "scheduled").length, 1);
  assert.ok(health.progress.futureSteps.some((step) => step.id === "possible-evidence" && step.state === "disabled"));
  assert.ok(health.progress.futureSteps.some((step) => step.id === "possible-arguments" && step.state === "disabled"));
});

test("future stages handle missing snapshots, disposal, next dates and expired dates honestly", () => {
  assert.deepEqual(caseHealth(null, [], [], now).progress.futureSteps, []);
  const disposed = caseHealth({ ...record(), status: "Disposed" }, [], [], now);
  assert.deepEqual(disposed.progress.futureSteps, []);
  assert.match(disposed.progress.futureNotice, /No pending trial stages are inferred/);
  const next = caseHealth(record(), [], [], now).progress.futureSteps;
  assert.equal(next[0].id, "next-hearing");
  assert.equal(next[0].date, "2026-10-31");
  const expired = caseHealth(record({ nexthearingdate: "01-01-2020" }), [], [], now).progress.futureSteps;
  assert.ok(expired.every((step) => step.state === "disabled" && step.date === null));
});

test("elapsed journey measures filing-to-hearing time, not completion, with exact clamped bounds", () => {
  const health = caseHealth(record({ filingdate: "01-10-2026", nexthearingdate: "31-10-2026" }), [], [], now);
  const journey = health.progress.journey;
  assert.equal(journey.spanDays, 30);
  assert.equal(journey.elapsedDays, 18);
  assert.equal(journey.remainingDays, 12);
  assert.equal(journey.percent, 60);
  assert.match(journey.notice, /NOT case completion/);
  const expired = caseHealth(record({ nexthearingdate: "01-01-2020" }), [], [], now).progress.journey;
  assert.equal(expired.percent, 100);
  assert.equal(expired.remainingDays, 0);
  assert.match(expired.notice, /endpoint has passed/);
  const disposed = caseHealth(record({ disposaldate: "01-01-2020" }), [], [], now).progress.journey;
  assert.equal(disposed.percent, 100);
  assert.equal(disposed.endLabel, "Recorded disposal");
  for (const input of [null, record({ filingdate: "bad" }), record({ filingdate: "01-01-2030" }), record({ nexthearingdate: "20-10-2014" }), record({ nexthearingdate: "" }), record({ disposaldate: "01-01-2030" })]) {
    const result = caseHealth(input, [], [], now).progress.journey;
    assert.equal(result.available, false);
    assert.equal(result.percent, null);
  }
});
