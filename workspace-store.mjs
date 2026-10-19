import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDocumentProxy, extractText } from "unpdf";
import { normalizeCnr } from "./case-details.mjs";
import { caseHealth } from "./case-health.mjs";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 2_000_000;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class WorkspaceStore {
  constructor(root = new URL("./data/", import.meta.url)) {
    this.root = root;
  }

  directory(cnr) {
    const root = this.root instanceof URL ? fileURLToPath(this.root) : this.root;
    return join(root, normalizeCnr(cnr));
  }

  async read(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
  }

  async documents(cnr) {
    const directory = this.directory(cnr);
    let files;
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const documents = await Promise.all(files.filter((file) => validId.test(file.replace(/\.json$/, "")) && file.endsWith(".json")).map((file) => this.read(join(directory, file))));
    return documents.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async workspace(cnr) {
    const [snapshot, documents] = await Promise.all([
      this.read(join(this.directory(cnr), "case.json")),
      this.documents(cnr)
    ]);
    const timeline = snapshot ? hearingTimeline(snapshot) : [];
    return {
      cnr: normalizeCnr(cnr),
      snapshot,
      documents: documents.map(({ content, pages, ...metadata }) => ({ ...metadata, pageCount: pages.length })),
      timeline,
      health: caseHealth(snapshot, timeline, documents)
    };
  }

  async saveSnapshot(cnr, record) {
    if (!record || normalizeCnr(record.cnr) !== normalizeCnr(cnr) || typeof record.title !== "string") {
      throw new Error("A matching case record is required.");
    }
    if (JSON.stringify(record).length > MAX_TEXT_LENGTH) throw new Error("Case snapshot is too large.");
    if (record.details && (typeof record.details.text !== "string" || !Array.isArray(record.details.tables)
      || record.details.tables.some((table) => !Array.isArray(table.rows) || table.rows.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== "string"))))) {
      throw new Error("Invalid case snapshot tables or text.");
    }
    const directory = this.directory(cnr);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.save(join(directory, "case.json"), record);
  }

  async upload(cnr, input) {
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 180 || /[/\\\x00-\x1f]/.test(input.name)) {
      throw new Error("Provide a file name without directory separators or control characters.");
    }
    const extension = input.name.split(".").pop().toLowerCase();
    if (!["pdf", "txt"].includes(extension)) throw new Error("Only text-based PDF and UTF-8 TXT files are supported.");
    if (typeof input.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
      throw new Error("Document content must be valid base64.");
    }
    const bytes = Buffer.from(input.content, "base64");
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Upload a nonempty file of at most 10 MB.");
    let pages;
    if (extension === "pdf") {
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("This file is not a valid PDF.");
      let pdf;
      try {
        pdf = await getDocumentProxy(new Uint8Array(bytes));
        if (pdf.numPages > 500) throw new Error("PDFs are limited to 500 pages; split this document.");
        const extracted = await extractText(pdf, { mergePages: false });
        pages = extracted.text.map((text, index) => ({ number: index + 1, text }));
      } catch (error) {
        throw new Error(`Cannot extract this PDF. It may be encrypted, damaged, or unsupported. ${error.message}`);
      } finally {
        if (pdf) await pdf.destroy();
      }
    } else {
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("TXT documents must use UTF-8 encoding.");
      }
      if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error("The TXT file contains binary data.");
      pages = text.split("\f").map((text, index) => ({ number: index + 1, text }));
    }
    if (!pages.some((page) => page.text.trim())) throw new Error("No readable text was found. Scanned/image PDFs require OCR first; OCR is not included yet.");
    if (pages.reduce((length, page) => length + page.text.length, 0) > MAX_TEXT_LENGTH) throw new Error("Extracted text exceeds 2 million characters. Split the document.");
    const document = {
      id: randomUUID(),
      name: input.name.trim(),
      category: ["Pleading", "Evidence", "Order", "Correspondence", "Other"].includes(input.category) ? input.category : "Other",
      mime: extension === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
      bytes: bytes.length,
      content: input.content,
      pages,
      emptyPages: pages.filter((page) => !page.text.trim()).map((page) => page.number),
      createdAt: new Date().toISOString()
    };
    const directory = this.directory(cnr);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.save(join(directory, `${document.id}.json`), document);
    const { content, ...result } = document;
    return result;
  }

  async document(cnr, id) {
    if (!validId.test(id)) throw new Error("Invalid document identifier.");
    const document = await this.read(join(this.directory(cnr), `${id}.json`));
    if (!document) throw new Error("Document not found in this case.");
    return document;
  }

  async deleteDocument(cnr, id) {
    await this.document(cnr, id);
    await unlink(join(this.directory(cnr), `${id}.json`));
  }
}

export function hearingTimeline(record) {
  const entries = [];
  for (const table of record.details?.tables || []) {
    const header = table.rows[0] || [];
    const labels = header.map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ""));
    if (!labels.includes("hearingdate") || !labels.some((label) => ["businessondate", "purposeofhearing", "purpose", "judge", "business"].includes(label))) continue;
    for (const row of table.rows.slice(1)) {
      if (!row.some((cell) => cell.trim())) continue;
      entries.push({
        fields: header.map((label, column) => ({ label: label || `Column ${column + 1}`, value: row[column] || "" }))
      });
    }
  }
  return entries;
}
