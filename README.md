# Karnataka Civil Case Tracker

A local web app for looking up Karnataka cases by CNR, with human CAPTCHA verification on the official eCourts website.

## Requirements and setup

- Node.js 20 or later and npm.
- Google Chrome installed on the same computer as the server.
- An internet connection to eCourts.

From this folder:

```sh
npm install
npm start
```

Open <http://localhost:8000>. Stop any old `python3 -m http.server 8000` process first; a static file server cannot run browser lookups. Use `PORT=8001 npm start` if another application owns port 8000. Keep using the same localhost port/browser to retain access to your existing saved records.

## Fetch by CNR

1. Enter the 16-character Karnataka CNR and select **Open official lookup**.
2. A separate, visible Chrome window opens on the official eCourts CNR search, with the CNR prefilled.
3. **You** enter the CAPTCHA on that website and click its **Search** button. The app does not solve or bypass CAPTCHA.
4. Open the full result and expand any available history/order sections you want included.
5. Return to the tracker and click **Import result**. The app verifies that the displayed result contains the requested CNR, then saves the result in the table.
6. Select **Details** to read the full captured result or download its JSON snapshot.

Import captures displayed case details and tables, including parties, advocates, acts, status, hearing history and order listings when present in the visible result. Hidden sections and linked PDF contents are not downloaded. Only fields actually returned by eCourts are populated; missing information is not invented. Unrecognized dates remain available in the full snapshot rather than being guessed. This does not independently classify every CNR as a civil case; check the official case type.

One lookup can run at a time. A browser session expires after 15 minutes. Reloading the tracker recovers an active session. Cancel closes only the Chrome window launched by this app, not your personal browser. Importing the same CNR updates its record while preserving your notes.

## Storage and privacy

Case records and full snapshots are saved in this browser's local storage, not in a server-side database. Lookup sessions and their cookies exist only in the separate browser's temporary context. The local Node server is bound to `127.0.0.1`; it rejects non-local Host headers and cross-origin requests. Do not expose it on a public interface.

### Local case workspace

Click **Workspace** on a case row. On first open, the case snapshot is copied from the browser tracker to the local workspace. **Sync tracker snapshot** updates this copy after you refresh the official case data. This does not fetch new data from eCourts itself.

- Upload text-based PDFs or UTF-8 TXT files up to **10 MB** (PDFs up to 500 pages and 2 million extracted characters). PDF citations refer to physical page numbers, not printed page labels. TXT pages use form-feed separators.
- Read extracted text and download originals. Scan/image-only files require OCR outside this app; image-only pages are explicitly flagged and not analyzed. Text extraction may lose layout; compare against originals.
- The published hearing timeline is built from the imported eCourts tables, in their original order. It is not a full procedural or filing register.
- **Case health** automatically shows filing age (or duration to recorded disposal), snapshot freshness, recorded stage, next hearing, past-stage listing counts and the largest interval between distinct past hearing dates. Future listings are counted separately; missing/unrecognized dates are excluded with explicit warnings. Expand stage groups for actual hearing dates, purposes, court/judge details and business dates when recorded, rather than internal table/row identifiers. Age uses UTC calendar dates, not an estimated statutory deadline. These deterministic observations do not require the AI model.
- The health panel includes advocate-review questions about amendment/evidence/arguments where those labels appear, and a document-category checklist. Uploaded categories do not establish document completeness or evidence strength. No peer-case benchmark or legal merits score is supplied: the app cannot determine relative speed, fault, avoidable delay, win probability, or how the case could definitely have been resolved. Hearing listings are not proof of adjournments or completed work. Refresh and sync the snapshot for up-to-date source data.
- **Move the case forward: preparation roadmap** provides stage-aware tips and concrete deliverables: identify procedural blockers, map issues to evidence, prepare remaining trial work, investigate delay from orders, and prepare arguments/outcome follow-through. It is a deterministic preparation checklist, not a merits-based strategy or promise of winning. It names its basis and flags missing documents; no deadline, legal entitlement or chance of success is invented. Missing snapshots and recorded disposal suppress the trial roadmap and show appropriate guidance instead. Review applicability, sequencing and procedural options with your advocate.
- The roadmap's **Progress so far** section separates recorded filing/registration/disposal milestones from past-dated hearing-stage listings. Evidence, arguments and other scheduled purposes remain **completion unverified** until established from actual orders; later stages and file uploads do not automatically mark earlier work complete. Future-dated listings are not presented as past progress, and no completion percentage is invented.
- The roadmap's **This case's progress** bar uses only the open case's recorded filing/registration milestones, chronological past hearing-purpose runs, and current recorded stage, including Amendment or ADR. Consecutive identical purposes are grouped with dates/counts; returning stages appear again. Future listings are not presented as past activity. Green means recorded milestone, blue historical activity with unverified completion, and amber current recorded stage. Separate greyed-out, noninteractive **Other stages - completion not confirmed** show common trial stages absent from the snapshot, with `aria-disabled` labels. These are not proven pending tasks or a predicted future sequence; recorded historical stages can remain incomplete too. No percentage, win estimate or inference of completed trial work is supplied.
- **Future stages and pending work to confirm** separately shows dated future hearing listings in purple, plus disabled conditional steps for applications/amendment, issues, remaining evidence, final arguments and disposal. Conditional steps remain visible even if those purposes occurred earlier; neither their pending status nor sequence is established from history alone. Missing snapshots and recorded disposal do not generate future trial steps; expired next-hearing dates are not shown as upcoming.
- **Estimated case completion - rough checklist estimate** replaces the elapsed-time bar. At the user's request it uses six typical stages (filing/registration, service/pleadings, issues, evidence, arguments, decision/disposal), equally weighted, with the active stage placed halfway through its segment: `(zero-based stage index + 0.5) / 6`, rounded to a whole percentage. Recorded disposal maps to 100%, not finality or completed enforcement. The current recognized stage takes priority; for Amendment/ADR or unknown current stages, the latest past-dated recognizable trial-purpose listing is used, not the highest historical stage. Filing is a fallback only when recorded. The basis, formula and assumptions are displayed. This is an illustrative heuristic, **not real-case comparison, verified completion, remaining duration or winning probability**. It can decrease after returning to an earlier stage. Without stage/milestone evidence no percentage is shown. The existing internal elapsed-journey calculation is not used by the displayed completion bar.
- The completion bar includes original, local SVG artwork: a lawyer in black court attire carrying a law book runs from the left to the current estimate once, then keeps running in place. An Indian justice figure with scales and a Constitution book stands at the right end. The artwork is decorative, not a success prediction; the accessible native percentage bar and estimate warnings remain unchanged. Reduced-motion preferences disable all running/travel animations and place the lawyer directly at the estimate. No animation is shown when an estimate is unavailable.
- Uploads and extracted text persist in this project's **`data/<CNR>/`** folder, excluded from Git. The folder is owner-access restricted, but files are **not encrypted at rest**. Use disk encryption and encrypted backups; do not commit, cloud-sync or share sensitive case folders unintentionally. Deleting a document removes its original and extracted text; downloaded copies/backups remain.
- Deleting a tracker row does **not** delete its separate workspace or uploaded documents. Remove documents explicitly in the workspace.

### Local AI setup and limits

Install [Ollama](https://ollama.com/) and a local model:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 ollama serve
# In a separate terminal:
ollama pull qwen2.5:3b
```

The default model download is roughly 2 GB. Set `OLLAMA_MODEL` when starting the tracker to use another installed local model. Model downloads require internet, but document analysis goes only to `http://127.0.0.1:11434`. The app does not use cloud AI APIs or fetch legal research online. Keep Ollama cloud features disabled and do not expose its port publicly.

The workspace supports source-grounded questions, summaries, and **drafts for advocate review**. It selects up to eight 1,600-character, keyword-ranked excerpts from that case only and asks the local model for page-cited output. Summary mode can use excerpts even without keyword matches. This is a bounded prototype, not exhaustive/semantic search over every document. It does not automatically read linked order PDFs: download documents you are entitled to use and upload them.

Citation identifiers are validated against selected excerpts before an answer is displayed, and you can inspect the quoted text and open its page. **This checks source identifiers, not whether every claim is supported or legally correct.** The local model may hallucinate, miss contradictions or omit relevant material. It has no verified current-law database, legal-deadline calculator, filing capability or authority to represent you. Do not treat it as a licensed lawyer or use unreviewed output in court. Upload statutes, orders or judgments you want analyzed; current law and citations still require professional verification.

Missing model/runtime, unreadable files, no matching source text, or invalid model citations produce explicit errors rather than simulated AI answers. Questions and answers are not retained on the server by this app; download the JSON answer with sources if you want to save it. The app logs request error messages, not document text or prompts.

This version manages **your own cases**, not a statewide bulk database. No paid API has been purchased or integrated. A future paid CNR provider can supplement the existing human-CAPTCHA workflow, but no provider guarantees all private evidence documents. Complete files still depend on documents obtained through your advocate, authorized access, or permitted court-copy/inspection processes.

**Export CSV** downloads table summaries. **Download full snapshot (JSON)** includes the full captured text, tables and available official links. Exports are unencrypted and may contain personal information. Document links may require a fresh official session; authentication tokens are not retained in exported links.

This app is not affiliated with eCourts and cannot guarantee statewide coverage, availability or freshness. It reads the official `#history_cnr` result after your search; if the portal changes its markup, lookup/import may require an update. Always check the official record for current information. A valid CNR and human CAPTCHA are required to validate live retrieval.

## Tests

```sh
npm test
```

Tests cover CNR validation, snapshot parsing, local API boundaries and the browser-assisted flow against a local fixture. No test solves a live CAPTCHA or treats fixture data as a real court record.

Workspace tests use temporary local storage, synthetic documents and a mocked local-model response. They cover PDF/TXT extraction, case isolation, persistence/deletion, source selection/citation checks, missing model failures, document UI and API protections. They do not establish correctness of legal advice.
