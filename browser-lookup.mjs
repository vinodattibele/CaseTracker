import { chromium } from "playwright";
import { extractVisibleResult, normalizeCnr, parseCaseSnapshot } from "./case-details.mjs";

const OFFICIAL_URL = "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index";
const SESSION_DURATION = 15 * 60 * 1000;

export class BrowserLookup {
  session = null;
  starting = false;

  constructor(launchBrowser = () => chromium.launch({ headless: false, channel: "chrome" })) {
    this.launchBrowser = launchBrowser;
  }

  async start(value) {
    const cnr = normalizeCnr(value);
    if (this.session || this.starting) {
      throw new Error("A lookup is already open. Import its result or cancel it before starting another.");
    }
    this.starting = true;
    let browser;
    try {
      browser = await this.launchBrowser();
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(OFFICIAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator("#cino").fill(cnr, { timeout: 30000 });
      await page.bringToFront();
      const session = { id: crypto.randomUUID(), cnr, browser, page, expiresAt: Date.now() + SESSION_DURATION };
      session.timer = setTimeout(() => {
        this.close().catch((error) => console.error("Failed to close expired eCourts lookup:", error));
      }, SESSION_DURATION);
      session.timer.unref();
      this.session = session;
      browser.on("disconnected", () => {
        clearTimeout(session.timer);
        if (this.session === session) this.session = null;
      });
      return { id: session.id, cnr, expiresAt: session.expiresAt };
    } catch (error) {
      if (browser) await browser.close();
      throw new Error(`Could not open the official lookup browser. Ensure Google Chrome is installed and eCourts is reachable. ${error.message}`);
    } finally {
      this.starting = false;
    }
  }

  async import(id) {
    const session = this.getSession(id);
    if (session.page.isClosed()) throw new Error("The lookup browser was closed. Start a new CNR lookup.");
    const url = new URL(session.page.url());
    if (url.origin !== "https://services.ecourts.gov.in") {
      throw new Error("Return to the official eCourts case result before importing.");
    }
    const snapshot = await session.page.evaluate(extractVisibleResult);
    return parseCaseSnapshot(snapshot, session.cnr);
  }

  getSession(id) {
    if (!this.session || this.session.id !== id || Date.now() >= this.session.expiresAt) {
      throw new Error("This lookup has expired or its browser was closed. Cancel it here and start a new lookup.");
    }
    return this.session;
  }

  async close(id) {
    if (id) this.getSession(id);
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.timer);
    await session.browser.close();
  }
}
