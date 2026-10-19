import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";
import { BrowserLookup } from "../browser-lookup.mjs";
import { createAppServer } from "../server.mjs";

const cnr = "KAAB010001232025";

test("browser-assisted lookup: verify on portal, import, persist, refresh and cancel", { timeout: 90000 }, async (t) => {
  const fixture = await readFile(new URL("./portal.html", import.meta.url), "utf8");
  const launched = [];
  const lookup = new BrowserLookup(async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    launched.push(browser);
    return {
      async newContext(options) {
        const context = await browser.newContext(options);
        await context.route("**/*", (route) => {
          if (route.request().url().startsWith("https://services.ecourts.gov.in/")) {
            return route.fulfill({ contentType: "text/html", body: fixture });
          }
          return route.abort();
        });
        return context;
      },
      close: () => browser.close(),
      on: (event, listener) => browser.on(event, listener)
    };
  });
  const server = createAppServer(lookup);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => {
    await lookup.close();
    for (const instance of launched) await instance.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator("#lookup-cnr").fill("bad");
  await page.locator("#lookup-start").click();
  await page.locator('#lookup-message[data-error="true"]').waitFor();
  assert.equal(lookup.session, null);

  await page.locator("#lookup-cnr").fill(cnr);
  await page.locator("#lookup-start").click();
  await page.locator("#lookup-active").waitFor();
  assert.equal(await lookup.session.page.locator("#cino").inputValue(), cnr);
  await assert.rejects(lookup.start(cnr), /already open/);
  await page.locator("#lookup-import").click();
  await page.locator('#lookup-message[data-error="true"]').waitFor();
  assert.equal(await page.locator("#case-count").innerText(), "0");

  const portal = lookup.session.page;
  await portal.locator("#test-verification").fill("wrong");
  await portal.locator("#search").click();
  assert.equal(await portal.locator("#error").innerText(), "Test verification failed");
  await portal.locator("#test-verification").fill("human-test");
  await portal.locator("#search").click();
  await page.locator("#lookup-import").click();
  await page.locator("#details-dialog[open]").waitFor();
  assert.equal(await page.locator("#case-count").innerText(), "1");
  assert.match(await page.locator("#case-rows").innerText(), /Original Suit 123\/2025/);
  const detailsText = await page.locator("#details-text").innerText();
  for (const expected of [cnr, "Test Counsel", "Civil Procedure Code", "Evidence", "Test order"]) assert.ok(detailsText.includes(expected));
  assert.ok(!detailsText.includes("Hidden information"));
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#details-download").click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(saved.cnr, cnr);
  assert.equal(saved.details.tables.length, 4);
  assert.ok(!JSON.stringify(saved).includes("app_token"));
  await page.locator("#close-details").click();
  await page.reload();
  assert.equal(await page.locator("#case-count").innerText(), "1");
  await page.locator("#filter-text").fill("no match");
  await page.locator("#no-results").waitFor();
  await page.locator("#filter-text").fill("");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="notes"]').fill("Keep my notes");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await page.locator("#case-dialog").waitFor({ state: "hidden" });
  await page.locator("#lookup-cnr").fill(cnr);
  await page.locator("#lookup-start").click();
  await page.locator("#lookup-active").waitFor();
  await page.reload();
  await page.locator("#lookup-active").waitFor();
  await lookup.session.page.locator("#test-verification").fill("human-test");
  await lookup.session.page.locator("#search").click();
  await page.locator("#lookup-import").click();
  await page.locator("#details-dialog[open]").waitFor();
  assert.equal(await page.locator("#case-count").innerText(), "1");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("karnataka-civil-case-tracker.v1"))[0].notes), "Keep my notes");
  await page.locator("#close-details").click();

  await page.locator("#lookup-start").click();
  await page.locator("#lookup-active").waitFor();
  await page.locator("#lookup-cancel").click();
  await page.locator("#lookup-active").waitFor({ state: "hidden" });
  assert.equal(lookup.session, null);
  assert.deepEqual(errors, []);

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth && getComputedStyle(element).display !== "none").map((element) => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width }))
  }));
  assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
});

test("local API rejects cross-origin/nonlocal requests and invalid input; serves only public assets", { timeout: 15000 }, async (t) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/lookup`, { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ cnr }) })).status, 403);
  const nonlocalStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/health`, { headers: { Host: "example.com" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
  assert.equal(nonlocalStatus, 403);
  for (const body of ['{"cnr":"bad"}', "null", "{bad"]) {
    const response = await fetch(`${url}/api/lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal((await fetch(`${url}/api/lookup`, { method: "POST" })).status, 415);
  for (const path of ["/server.mjs", "/package.json", "/node_modules/playwright/package.json"]) {
    assert.equal((await fetch(url + path)).status, 404);
  }
});
