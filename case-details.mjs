export function normalizeCnr(value) {
  if (typeof value !== "string") throw new Error("Enter a CNR number.");
  const cnr = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^KA[A-Z0-9]{2}\d{12}$/.test(cnr)) {
    throw new Error("Enter a Karnataka CNR: KA, two court-code characters, and twelve digits (16 characters total).");
  }
  return cnr;
}

// Runs inside the official page, retaining only displayed result data, not its HTML or cookies.
export function extractVisibleResult() {
  const root = document.querySelector("#history_cnr");
  if (!root || !root.getClientRects().length || !root.innerText.trim()) {
    throw new Error("No case result is visible yet. Complete the CAPTCHA and click Search on eCourts, then try Import result again.");
  }
  const visible = (element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  return {
    text: root.innerText.trim(),
    tables: [...root.querySelectorAll("table")].filter(visible).map((table) => ({
      rows: [...table.rows].filter(visible).map((row) => [...row.cells].map((cell) => cell.innerText.trim()))
    })),
    links: [...root.querySelectorAll("a[href]")].filter(visible).map((link) => ({
      text: link.innerText.trim(),
      url: link.href
    }))
  };
}

function cleanLabel(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isoDate(value) {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const written = value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/i);
  let normalized = value;
  if (written) {
    const month = months.indexOf(written[2].toLowerCase()) + 1;
    if (!month) return "";
    normalized = `${written[1]}-${month}-${written[3]}`;
  }
  const match = normalized.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === iso) return iso;
  }
  return "";
}

export function parseCaseSnapshot(snapshot, expectedCnr) {
  const cnr = normalizeCnr(expectedCnr);
  const text = snapshot.text.trim();
  const cnrPattern = new RegExp(`\\b${cnr.split("").join("[\\s-]*")}\\b`, "i");
  if (!cnrPattern.test(text)) {
    throw new Error("The displayed result does not contain the requested CNR. Complete the search for that CNR before importing.");
  }

  const fields = new Map();
  const remember = (key, value) => {
    if (value.trim() && !fields.has(key)) fields.set(key, value.trim());
  };
  const labels = new Set([
    "casetype", "filingnumber", "filingdate", "registrationnumber", "registrationdate", "cnrnumber",
    "firsthearingdate", "nexthearingdate", "casestatus", "casestage", "stageofcase",
    "disposaldate", "decisiondate", "natureofdisposal", "court", "courtname",
    "courtnumberandjudge", "courtnumberandjudgename", "courtnumberandpresidingofficer",
    "district", "districtname", "petitionerandadvocate", "respondentandadvocate",
    "plaintiffandadvocate", "defendantandadvocate"
  ]);
  for (const table of snapshot.tables) {
    for (let index = 0; index < table.rows.length; index += 1) {
      const row = table.rows[index];
      const nextRow = table.rows[index + 1];
      const headerRow = row.length > 1 && row.every((cell) => labels.has(cleanLabel(cell)));
      if (headerRow && nextRow?.length === row.length) {
        row.forEach((cell, column) => remember(cleanLabel(cell), nextRow[column]));
        index += 1;
        continue;
      }
      for (let column = 0; column < row.length - 1; column += 1) {
        const label = cleanLabel(row[column]);
        if (labels.has(label) && !labels.has(cleanLabel(row[column + 1]))) {
          remember(label, row[column + 1].replace(/^:\s*/, ""));
          column += 1;
        }
      }
    }
  }

  // Some eCourts result sections are headings followed by text, rather than key/value rows.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([^:\t]+)(?::\s*|\t+)(.+)$/);
    if (match && labels.has(cleanLabel(match[1]))) remember(cleanLabel(match[1]), match[2].split("\t")[0]);
    const label = cleanLabel(lines[index]);
    if (labels.has(label) && !fields.has(label)) {
      const values = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (labels.has(cleanLabel(lines[next].split(/[:\t]/)[0])) || /^(acts|case history|history of case hearing|orders|business|transfer details|ia status)$/i.test(lines[next])) break;
        values.push(lines[next]);
        if (!/andadvocate$/.test(label)) break;
      }
      if (values.length) remember(label, values.join("\n"));
    }
  }
  const field = (...keys) => keys.map((key) => fields.get(key)).find(Boolean) || "";
  const registration = field("registrationnumber");
  const caseType = field("casetype");
  if (!registration && !field("filingnumber") && !caseType) {
    throw new Error("The CNR was found, but no recognizable case details were returned. Open the full case details on eCourts before importing.");
  }
  const sourceStatus = field("casestatus");
  const disposed = /disposed|disposal|decided/i.test(sourceStatus) || Boolean(field("disposaldate", "decisiondate", "natureofdisposal"));
  const pending = /pending/i.test(sourceStatus);
  const nextHearingRaw = field("nexthearingdate");
  return {
    cnr,
    title: [caseType, registration].filter(Boolean).join(" ") || `CNR ${cnr}`,
    caseType,
    petitioner: field("petitionerandadvocate", "plaintiffandadvocate"),
    respondent: field("respondentandadvocate", "defendantandadvocate"),
    court: field("courtname", "courtnumberandjudge", "courtnumberandjudgename", "courtnumberandpresidingofficer", "court"),
    district: field("district", "districtname"),
    status: disposed ? "Disposed" : pending ? "Pending" : "Other",
    nextHearing: isoDate(nextHearingRaw),
    details: {
      importedAt: new Date().toISOString(),
      source: "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index",
      fields: Object.fromEntries(fields),
      nextHearingRaw,
      text,
      tables: snapshot.tables,
      links: snapshot.links.flatMap((link) => {
        try {
          const url = new URL(link.url);
          if (url.protocol !== "https:" || url.hostname !== "services.ecourts.gov.in") return [];
          url.searchParams.delete("app_token");
          return [{ text: link.text, url: url.href }];
        } catch {
          return [];
        }
      })
    }
  };
}
