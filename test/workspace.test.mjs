import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore, hearingTimeline } from "../workspace-store.mjs";
import { LocalAI, retrieveSources } from "../local-ai.mjs";
import { createAppServer } from "../server.mjs";
import { chromium } from "playwright";

const cnr = "KAAB010001232025";
const otherCnr = "KAAB010001242025";
const snapshot = {
  cnr, title: "Test Original Suit 123/2025",
  details: {
    text: "Test court hearing scheduled for amendment on 31 October 2026.",
    importedAt: "2026-10-19T09:00:00.000Z",
    tables: [{ rows: [["Judge", "Business on Date", "Hearing Date", "Purpose of Hearing"], ["Civil Judge", "04-08-2026", "31-10-2026", "Amendment"]] }]
  }
};
const upload = (name = "payment.txt", text = "The plaintiff alleges payment of INR 5000 on 12 June 2025.\fThe defendant disputes payment and asks for bank records.") => ({
  name, content: Buffer.from(text).toString("base64"), category: "Evidence"
});

async function storeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "case-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new WorkspaceStore(root);
}

function makePdf() {
  const streams = ["BT /F1 12 Tf 50 700 Td (Payment on page one) Tj ET", "BT /F1 12 Tf 50 700 Td (Dispute on page two) Tj ET"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

test("local storage isolates cases, preserves originals/pages and survives a new store instance", async (t) => {
  const store = await storeFixture(t);
  const document = await store.upload(cnr, upload());
  assert.equal(document.pages.length, 2);
  assert.equal(document.pages[1].number, 2);
  assert.equal((await store.workspace(otherCnr)).documents.length, 0);
  await assert.rejects(store.document(otherCnr, document.id), /not found/);
  assert.equal((await new WorkspaceStore(store.root).workspace(cnr)).documents.length, 1);
  assert.equal((await stat(join(store.directory(cnr), `${document.id}.json`))).mode & 0o777, 0o600);
  const saved = await store.document(cnr, document.id);
  assert.equal(Buffer.from(saved.content, "base64").toString(), Buffer.from(upload().content, "base64").toString());
  await store.saveSnapshot(cnr, snapshot);
  assert.equal((await store.workspace(cnr)).timeline[0].fields[3].value, "Amendment");
  await store.deleteDocument(cnr, document.id);
  assert.equal((await store.workspace(cnr)).documents.length, 0);
});

test("rejects invalid names, formats, empty text, invalid base64 and CNR traversal", async (t) => {
  const store = await storeFixture(t);
  for (const input of [upload("../file.txt"), upload("file.docx"), upload("file.txt", ""), { ...upload(), content: "?" }, upload("not-real.pdf"), upload("binary.txt", "\0test")]) {
    await assert.rejects(store.upload(cnr, input));
  }
  assert.throws(() => store.directory("../../private"), /Karnataka CNR/);
  await assert.rejects(store.saveSnapshot(cnr, { ...snapshot, cnr: otherCnr }), /matching case/);
  await assert.rejects(store.document(cnr, "../../private"), /identifier/);
});

test("extracts actual PDF text with original physical page numbers", async (t) => {
  const store = await storeFixture(t);
  const pdf = await store.upload(cnr, { name: "two-pages.pdf", content: makePdf().toString("base64"), category: "Order" });
  assert.equal(pdf.pages.length, 2);
  assert.match(pdf.pages[0].text, /Payment on page one/);
  assert.match(pdf.pages[1].text, /Dispute on page two/);
});

test("retrieval is bounded, page-addressable and reports no matches", async () => {
  const documents = [{ id: "test", name: "payment.txt", pages: [{ number: 7, text: "  Plaintiff alleges payment. " }] }];
  const sources = retrieveSources(documents, snapshot, "payment", "question");
  assert.equal(sources[0].page, 7);
  assert.equal(sources[0].id, "S1");
  assert.equal(sources[0].documentId, "test");
  assert.equal(documents[0].pages[0].text.slice(sources[0].offset, sources[0].offset + sources[0].excerpt.length), sources[0].excerpt);
  assert.equal(retrieveSources(documents, null, "zebras", "question").length, 0);
  assert.ok(retrieveSources(documents, null, "summarize", "summary").length > 0);
  assert.equal(hearingTimeline(snapshot).length, 1);
  assert.equal(hearingTimeline({
    details: {
      tables: [
        { rows: [["First Hearing Date", "21st October 2014"], ["Next Hearing Date", "31st October 2026"], ["Case Stage", "Amendment"]] },
        ...snapshot.details.tables
      ]
    }
  }).length, 1);
});

test("local AI calls loopback only and validates citation IDs, failures and missing sources", async () => {
  let output = { answer: "Payment is alleged, not proven [S1].", citations: ["S1"], limitations: ["Original records need review."] };
  const calls = [];
  const ai = new LocalAI(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ message: { content: JSON.stringify(output) } });
  });
  const input = { question: "What payment is alleged?", mode: "question", documents: [{ id: "test", name: "claim.txt", pages: [{ number: 2, text: "Plaintiff alleges payment." }] }], snapshot: null };
  const result = await ai.answer(input);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(result.sources[0].page, 2);
  assert.match(result.disclaimer, /human verification/);
  for (const invalid of [
    { answer: "No citation", citations: [], limitations: [] },
    { answer: "Invented [S99]", citations: ["S99"], limitations: [] },
    { answer: "Mismatched [S1]", citations: ["S2"], limitations: [] }
  ]) {
    output = invalid;
    await assert.rejects(ai.answer(input), /invalid citations/);
  }
  await assert.rejects(ai.answer({ ...input, documents: [] }), /No matching source/);
  await assert.rejects(new LocalAI(async () => { throw new Error("offline"); }).answer(input), /Local AI is unavailable/);
  await assert.rejects(new LocalAI(async () => new Response(null, { status: 404 })).answer(input), /Ollama returned 404/);
});

test("workspace API and browser support upload, timeline, cited answers, source inspection and deletion", { timeout: 60000 }, async (t) => {
  const store = await storeFixture(t);
  const ai = new LocalAI(async (url, options) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen2.5:3b" }] });
    assert.match(JSON.parse(options.body).messages[1].content, /UNTRUSTED SOURCE EXCERPTS/);
    return Response.json({ message: { content: JSON.stringify({ answer: "This is an allegation of payment [S1].", citations: ["S1"], limitations: ["Check the originals with your advocate."] }) } });
  });
  const server = createAppServer(undefined, { store, ai });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const browserSnapshot = structuredClone(snapshot);
  browserSnapshot.details.tables[0].rows.push(["Civil Judge", "01-12-2019", "01-01-2020", "Evidence"]);
  await page.evaluate((record) => localStorage.setItem("karnataka-civil-case-tracker.v1", JSON.stringify([record])), browserSnapshot);
  await page.goto(`${url}/workspace.html?cnr=${cnr}`);
  await page.getByRole("heading", { name: snapshot.title }).waitFor();
  await page.getByRole("heading", { name: "Case health", exact: true }).waitFor();
  assert.match(await page.locator("#health-summary").innerText(), /No comparable-case benchmark/);
  assert.match(await page.locator("#health-documents").innerText(), /no files uploaded in this category/);
  assert.match(await page.locator("#health-merits").innerText(), /Not assessed/);
  await page.getByRole("heading", { name: "Move the case forward: preparation roadmap" }).waitFor();
  assert.equal(await page.locator("#case-roadmap .roadmap-step").count(), 5);
  assert.match(await page.locator("#roadmap-notice").innerText(), /not a guaranteed route to victory/);
  assert.match(await page.locator("#case-roadmap").innerText(), /issue-by-issue evidence map/);
  assert.equal(await page.locator('[aria-labelledby="roadmap-title"] #progress-title').count(), 1);
  assert.match(await page.locator("#progress-activity").innerText(), /completion unverified/);
  assert.match(await page.locator("#progress-current").innerText(), /Current stage is not stated/);
  assert.equal(await page.locator("#case-stage-progress li").count(), 1);
  assert.equal(await page.locator('#case-stage-progress [aria-current="step"]').count(), 0);
  assert.match(await page.locator("#case-stage-progress").innerText(), /Evidence/);
  assert.match(await page.locator("#case-stage-progress").innerText(), /2020-01-01/);
  assert.equal(await page.locator('#case-unconfirmed-progress [aria-disabled="true"]').count(), 4);
  assert.match(await page.locator("#case-unconfirmed-progress").innerText(), /Decision \/ disposal/);
  assert.equal(await page.locator('#case-future-progress [aria-disabled="true"]').count(), 5);
  assert.match(await page.locator("#case-future-progress").innerText(), /Final arguments \/ written submissions/);
  assert.match(await page.locator("#case-future-progress").innerText(), /pending status unverified/);
  assert.equal(await page.locator("#case-journey-bar").isVisible(), true);
  assert.equal(await page.locator("#case-journey-bar").evaluate((element) => element.value), 58);
  assert.match(await page.locator("#journey-notice").innerText(), /ROUGH ESTIMATE ONLY/);
  assert.equal(await page.locator("#completion-scene").isVisible(), true);
  assert.match(await page.locator("#completion-animation-caption").innerText(), /keeps running in place/);
  const travel = await page.locator("#completion-lawyer").evaluate((lawyer) => {
    const animation = lawyer.getAnimations().find((item) => item.animationName === "lawyer-arrive");
    animation.pause();
    const track = lawyer.parentElement.getBoundingClientRect();
    const position = (time) => {
      animation.currentTime = time;
      const bounds = lawyer.getBoundingClientRect();
      return (bounds.x + bounds.width / 2 - track.x) / track.width;
    };
    const positions = [0, 1200, 2400, 4800].map(position);
    animation.currentTime = 0;
    animation.play();
    return positions;
  });
  assert.ok(Math.abs(travel[0]) < .01);
  assert.ok(travel[1] > 0 && travel[1] < .58);
  assert.ok(Math.abs(travel[2] - .58) < .01);
  assert.equal(travel[2], travel[3]);
  assert.equal(await page.locator(".lawyer-leg-front").evaluate((leg) =>
    leg.getAnimations().some((animation) => animation.effect.getTiming().iterations === Infinity && animation.playState === "running")
  ), true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#completion-lawyer").evaluate((lawyer) => lawyer.getAnimations().length), 0);
  assert.equal(await page.locator(".lawyer-leg-front").evaluate((leg) => leg.getAnimations().length), 0);
  for (const percent of [0, 58, 100]) {
    const layout = await page.locator("#completion-scene").evaluate((scene, percent) => {
      scene.style.setProperty("--completion", `${percent}%`);
      const track = scene.querySelector(".completion-track").getBoundingClientRect();
      const lawyer = scene.querySelector(".completion-lawyer").getBoundingClientRect();
      const goal = scene.querySelector(".justice-goal").getBoundingClientRect();
      const bounds = scene.getBoundingClientRect();
      return {
        position: (lawyer.x + lawyer.width / 2 - track.x) / track.width,
        contained: lawyer.x >= bounds.x && goal.right <= bounds.right,
        separate: lawyer.right <= goal.x
      };
    }, percent);
    assert.ok(Math.abs(layout.position - percent / 100) < .01);
    assert.equal(layout.contained, true);
    assert.equal(layout.separate, true);
  }
  await page.locator("#completion-scene").evaluate((scene) => scene.style.setProperty("--completion", "58%"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate((record) => {
    record.details.fields = { filingdate: "20-10-2014", nexthearingdate: "31-10-2099" };
    localStorage.setItem("karnataka-civil-case-tracker.v1", JSON.stringify([record]));
  }, browserSnapshot);
  await page.locator("#sync-case").click();
  await page.locator("#case-journey-bar").waitFor();
  const fill = await page.locator("#case-journey-bar").evaluate((element) => element.value);
  assert.ok(fill > 0 && fill < 100);
  assert.match(await page.locator("#journey-summary").innerText(), /Not verified case completion/);
  assert.match(await page.locator("#timeline").innerText(), /Amendment/);
  assert.doesNotMatch(await page.locator("#timeline").innerText(), /snapshot, table|row \d/i);
  await page.locator("#health-stages summary").first().click();
  assert.match(await page.locator("#health-stages").innerText(), /Civil Judge/);
  assert.match(await page.locator("#health-stages").innerText(), /2020-01-01/);
  assert.doesNotMatch(await page.locator("#health-stages").innerText(), /snapshot, table|row \d/i);
  await page.locator("#document-file").setInputFiles({ name: "claim.txt", mimeType: "text/plain", buffer: Buffer.from("The plaintiff alleges payment of INR 5000.") });
  await page.locator("#upload-button").click();
  await page.locator("#document-list h3").waitFor();
  assert.equal(await page.locator("#document-list h3").innerText(), "claim.txt");
  assert.match(await page.locator("#health-documents").innerText(), /completeness and contents not verified/);
  await page.locator("#assistant-question").fill("What payment is alleged?");
  await page.locator("#ask-button").click();
  await page.locator("#answer-section").waitFor();
  assert.match(await page.locator("#assistant-answer").innerText(), /\[S1\]/);
  await page.getByRole("button", { name: "Open source page" }).click();
  await page.locator("#document-dialog[open]").waitFor();
  assert.match(await page.locator("#document-pages").innerText(), /5000/);
  await page.locator("#close-document").click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download original" }).click();
  const download = await downloadEvent;
  assert.equal(await readFile(await download.path(), "utf8"), "The plaintiff alleges payment of INR 5000.");
  await page.reload();
  await page.locator("#document-list h3").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator(".justice-goal").isVisible(), true);
  const mobileScene = await page.locator("#completion-scene").evaluate((scene) => {
    const goal = scene.querySelector(".justice-goal").getBoundingClientRect();
    return goal.right <= scene.getBoundingClientRect().right;
  });
  assert.equal(mobileScene, true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#document-list").textContent.includes("No documents uploaded"));
  assert.equal((await store.workspace(cnr)).documents.length, 0);
  assert.deepEqual(errors, []);
  const blocked = await fetch(`${url}/api/cases/${cnr}/documents`, { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify(upload()) });
  assert.equal(blocked.status, 403);
  assert.equal((await fetch(`${url}/data/${cnr}/case.json`)).status, 404);
  const emptyPage = await browser.newPage();
  await emptyPage.goto(`${url}/workspace.html?cnr=KABR210000832014`);
  await emptyPage.waitForFunction(() => document.querySelector("#journey-summary").textContent.includes("Insufficient"));
  assert.equal(await emptyPage.locator("#completion-scene").isVisible(), false);
  assert.equal(await emptyPage.locator("#case-journey-bar").isVisible(), false);
  await emptyPage.close();
});
