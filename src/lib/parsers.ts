// src/lib/parsers.ts

export type ExtractedRow = {
  source: string;
  page: number;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  value?: string | null; // <-- NEW
};

/* -------------------------- helpers -------------------------- */

/** Keep only digits and an optional leading + */
const onlyDigitsPlus = (s: string) => s.replace(/[^\d+]/g, "");

/** Normalize BD phone (tolerant to spaces/dashes/commas) -> returns compact form */
const bdPhone = (s: string): string | null => {
  const only = onlyDigitsPlus(s);
  const m = /(?:(?:\+?880)|0)1[3-9]\d{8}/.exec(only);
  return m ? m[0] : null;
};

/** Fuzzy phone matcher that gives you the match span in the original text */
function findFuzzyPhoneSpan(
  s: string
): { normalized: string; index: number; length: number } | null {
  // Allow arbitrary whitespace/punctuation between digits
  const re =
    /(?:(?:\+?\s*8\s*8\s*0)|0)\s*1\s*[3-9]\s*\d\s*\d\s*\d\s*\d\s*\d\s*\d\s*\d\s*\d/;
  const m = re.exec(s);
  if (!m) return null;
  const normalized = bdPhone(m[0]);
  if (!normalized) return null;
  return { normalized, index: m.index, length: m[0].length };
}

/** Field markers that appear after the address in these invoices */
const FIELD_MARKERS =
  /(Order\s*ID|Date\s*Added|Payment\s*Method|Shipping\s*Method|City\s*Courier|Product|Quantity|Unit\s*Price|Sub\s*Total|Total|Authorized\s*Signature|BD\s*Apple)/i;

/** Looks like a personal name (Latin or Bangla), no digits */
function looksLikeName(line: string): boolean {
  if (!line) return false;
  if (/\d/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 6) return false;
  const re = /^[A-Za-z\u0980-\u09FF][A-Za-z\u0980-\u09FF.\-'\u200C\u200D]*$/u;
  return words.every((w) => re.test(w));
}

/** Detect start of a new labeled field */
function looksLikeNewField(line: string): boolean {
  return /\b(Name|Phone|Mobile|Tel|Email|Address|City|Country|Order|Invoice|Bill To|Ship To|Payment|Shipping)\b/i.test(
    line
  );
}

/* ---------------------- main parse functions ---------------------- */

export function parseInvoiceToBlock(text: string): {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
} {
  // Work on a single cleaned string to tolerate missing newlines
  const cleaned = text.replace(/\r/g, "");

  // 1) Slice everything after "Invoice To:"
  const toMatch = /invoice\s*to\s*[:\-]?\s*/i.exec(cleaned);
  if (!toMatch) return {}; // let fallback handle it

  const afterTo = cleaned.slice(toMatch.index + toMatch[0].length).trim();

  // 2) Cut at the first field marker so product/order text doesn't leak into address
  const cut = FIELD_MARKERS.exec(afterTo);
  const head = (cut ? afterTo.slice(0, cut.index) : afterTo).trim();

  // 3) Find phone span inside head (fuzzy), then derive name/address by slicing
  const span = findFuzzyPhoneSpan(head);

  let name: string | null = null;
  let phone: string | null = null;
  let address: string | null = null;

  if (span) {
    phone = span.normalized;

    const before = head.slice(0, span.index).trim();
    const after = head.slice(span.index + span.length).trim();

    // name: prefer the "first line" from the 'before' part, else heuristics
    const nameLine = before.split(/\n/)[0]?.trim() ?? "";
    name = nameLine || (looksLikeName(before) ? before : null);

    // address: what remains after phone, scrub leading punctuation/labels
    address = after
      .replace(/^(,|:|-)\s*/g, "")
      .replace(/^address\s*[:\-]\s*/i, "")
      .trim();
  } else {
    // No phone found; try to split head into name + address by lines
    const [first, ...rest] = head.split(/\n/).map((s) => s.trim()).filter(Boolean);
    name = first || null;
    address = rest.join(", ").trim() || null;
  }

  if (name) name = name.replace(/^name\s*[:\-]\s*/i, "").trim();
  if (address) address = address.replace(/\s{2,}/g, " ").trim();

  return { name, phone, address };
}

export function fallbackParse(text: string): {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
} {
  const cleaned = text.replace(/\r/g, "");
  const lines = cleaned
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const phone = bdPhone(cleaned);

  // Name via explicit label
  let name: string | null = null;
  const nameLabel = /\bName\s*[:\-]\s*(.+)$/i;
  for (const line of lines) {
    const m = nameLabel.exec(line);
    if (m) {
      const v = (m[1] ?? "").trim();
      if (v) {
        name = v;
        break;
      }
    }
  }

  // Heuristic name: first nice-looking line above phone
  if (!name && phone) {
    const span = findFuzzyPhoneSpan(cleaned);
    if (span) {
      const before = cleaned.slice(0, span.index);
      const cand =
        before
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .reverse()
          .find((l) => looksLikeName(l)) || "";
      name = cand || null;
    }
  }

  // Address via label (collect following lines until a likely new field)
  let address: string | null = null;
  const addrLabel = /\bAddress\b\s*[:\-]\s*(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = addrLabel.exec(lines[i]);
    if (m) {
      const buf: string[] = [m[1] ?? ""];
      for (let j = i + 1; j < lines.length; j++) {
        if (looksLikeNewField(lines[j])) break;
        buf.push(lines[j]);
      }
      address = buf.join(", ").trim();
      break;
    }
  }

  // Heuristic address: text after phone until the next field marker
  if (!address && phone) {
    const span = findFuzzyPhoneSpan(cleaned);
    if (span) {
      const after = cleaned.slice(span.index + span.length);
      const cut = FIELD_MARKERS.exec(after);
      const chunk = (cut ? after.slice(0, cut.index) : after).trim();
      const linesAfter = chunk.split("\n").map((s) => s.trim()).filter(Boolean);
      if (linesAfter.length) {
        address = linesAfter
          .slice(0, 3)
          .join(", ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
    }
  }

  return { name: name ?? null, phone: phone ?? null, address: address ?? null };
}

/** Convert rows to CSV string (simple + safe) */
export function toCsv(rows: ExtractedRow[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = ["Source", "Page", "Name", "Phone", "Address", "Value"]; // <-- add Value
  const out = [header.join(",")];
  for (const r of rows) {
    out.push(
      [
        esc(r.source),
        String(r.page),
        esc(r.name ?? ""),
        esc(r.phone ?? ""),
        esc(r.address ?? ""),
        esc(r.value ?? ""), // <-- include Value
      ].join(",")
    );
  }
  return out.join("\n");
}
