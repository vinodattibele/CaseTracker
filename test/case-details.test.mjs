import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCnr, parseCaseSnapshot } from "../case-details.mjs";

const cnr = "KAAB010001232025";

function snapshot() {
  return {
    text: `Case Details\nCase Type\nOriginal Suit\nRegistration Number\n123/2025\nCNR Number\n${cnr}\nCase Status\nPending\nPetitioner and Advocate\n1) Test Plaintiff\nAdvocate: Test Counsel\nRespondent and Advocate\n1) Test Defendant\nActs\nCivil Procedure Code\nNext Hearing Date\n31-12-2026`,
    tables: [
      { rows: [["Case Type", "Filing Number", "Registration Number"], ["Original Suit", "140/2025", "123/2025"]] },
      { rows: [["Case Status", "Pending"], ["Next Hearing Date", "31-12-2026"], ["Court Number and Judge", "1 - Civil Judge"], ["District", "Bengaluru Urban"]] },
      { rows: [["Act", "Section"], ["Civil Procedure Code", "9"]] },
      { rows: [["Hearing date", "Business"], ["10-10-2026", "Evidence"]] }
    ],
    links: [
      { text: "Order", url: "https://services.ecourts.gov.in/ecourtindia_v6/order.pdf?app_token=private&order=1" },
      { text: "Invalid", url: "javascript:alert(1)" },
      { text: "External", url: "https://example.com/order.pdf" }
    ]
  };
}

test("normalizes a 16-character Karnataka CNR and rejects invalid/non-Karnataka values", () => {
  assert.equal(cnr.length, 16);
  assert.equal(normalizeCnr(" kaab 01000123-2025 "), cnr);
  for (const value of [null, "", "KA123", "MHAU019999992015", "KAAB0100012320250", "KAAAabcdefgh1234", "<script>"]) {
    assert.throws(() => normalizeCnr(value));
  }
});

test("imports summary fields while retaining full tables, parties, advocates, acts and hearing history", () => {
  const input = snapshot();
  const result = parseCaseSnapshot(input, cnr);
  assert.equal(result.title, "Original Suit 123/2025");
  assert.equal(result.status, "Pending");
  assert.equal(result.court, "1 - Civil Judge");
  assert.equal(result.district, "Bengaluru Urban");
  assert.equal(result.petitioner, "1) Test Plaintiff\nAdvocate: Test Counsel");
  assert.equal(result.respondent, "1) Test Defendant");
  assert.equal(result.nextHearing, "2026-12-31");
  assert.deepEqual(result.details.tables, input.tables);
  assert.equal(result.details.text, input.text);
  assert.deepEqual(result.details.links, [{ text: "Order", url: "https://services.ecourts.gov.in/ecourtindia_v6/order.pdf?order=1" }]);
});

test("rejects wrong CNRs, search instructions, and non-case responses", () => {
  assert.throws(() => parseCaseSnapshot(snapshot(), "KAAB010001242025"), /requested CNR/);
  assert.throws(() => parseCaseSnapshot({ ...snapshot(), text: `${cnr}0` }, cnr), /requested CNR/);
  assert.throws(() => parseCaseSnapshot({ text: cnr, tables: [], links: [] }, cnr), /no recognizable case details/);
});

test("does not invent missing status, parties or dates", () => {
  const result = parseCaseSnapshot({
    text: `CNR Number: ${cnr}`,
    tables: [{ rows: [["Case Type", "Civil"], ["Next Hearing Date", "31-02-2026"]] }],
    links: []
  }, cnr);
  assert.equal(result.status, "Other");
  assert.equal(result.petitioner, "");
  assert.equal(result.nextHearing, "");
  assert.equal(result.details.nextHearingRaw, "31-02-2026");
});

test("recognizes disposal without marking unrelated order text as case disposal", () => {
  const input = snapshot();
  input.tables[1].rows[0][1] = "Disposed";
  input.tables.push({ rows: [["Nature of Disposal", "Contested"]] });
  input.text = input.text.replace("Case Status\nPending", "Case Status\nDisposed");
  assert.equal(parseCaseSnapshot(input, cnr).status, "Disposed");
  const pending = snapshot();
  pending.text += "\nAn earlier application was disposed.";
  assert.equal(parseCaseSnapshot(pending, cnr).status, "Pending");
});

test("handles written-out portal dates and transfer tables without corrupting the registration number or status", () => {
  const input = {
    text: `Case Details\nCase Type\tO.S. - ORIGINAL SUIT\nRegistration Number\t1089/2014\tRegistration Date\t21-10-2014\nCNR Number\t${cnr}\nCase Status\nFirst Hearing Date\t21st October 2014\nNext Hearing Date\t31st October 2026\nCase Stage\tAmendment\nPetitioner and Advocate\n1) Test Plaintiff\nRespondent and Advocate\n1) Test Defendant\nActs`,
    tables: [
      { rows: [["Case Type", "O.S. - ORIGINAL SUIT"], ["Registration Number", "1089/2014", "Registration Date", "21-10-2014"], ["CNR Number", cnr]] },
      { rows: [["First Hearing Date", "21st October 2014"], ["Next Hearing Date", "31st October 2026"], ["Case Stage", "Amendment"]] },
      { rows: [["Registration Number", "Transfer Date", "From Court Number and Judge", "To Court Number and Judge"], ["1089/2014", "05-06-2020", "First Court", "Second Court"]] }
    ],
    links: []
  };
  const result = parseCaseSnapshot(input, cnr);
  assert.equal(result.title, "O.S. - ORIGINAL SUIT 1089/2014");
  assert.equal(result.nextHearing, "2026-10-31");
  assert.equal(result.details.fields.casestage, "Amendment");
  assert.equal(result.details.fields.casestatus, undefined);
  assert.equal(result.status, "Other");
  assert.equal(result.details.tables[2].rows[1][1], "05-06-2020");
});
