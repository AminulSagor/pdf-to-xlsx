export type ExtractedRow = {
  source: string;
  page: number;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
};

export function parseInvoiceToBlock(text: string): {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
} {
  const lines = text
    .replaceAll("\r", "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let name: string | null = null;
  let phone: string | null = null;
  let address: string | null = null;

  const toIdx = lines.findIndex((l) => l.toLowerCase().startsWith("invoice to"));
  if (toIdx !== -1) {
    // name (next line or same line)
    if (toIdx + 1 < lines.length) {
      name = lines[toIdx + 1];
      const sameLine = /invoice to\s*[:\-]\s*(.+)$/i.exec(lines[toIdx]);
      if (sameLine && sameLine[1].trim()) name = sameLine[1].trim();
    }

    // phone (BD format) – next next line
    if (toIdx + 2 < lines.length) {
      const phoneLine = lines[toIdx + 2];
      const phoneReg = /(?:(?:\+?880)|0)1[3-9]\d{8}/;
      const m = phoneReg.exec(phoneLine);
      if (m) phone = m[0];
    }

    // address (3rd line after)
    if (toIdx + 3 < lines.length) {
      address = lines[toIdx + 3];
    }

    // cleanups
    if (name) name = name.replace(/^name\s*[:\-]\s*/i, "").trim();
    if (address) address = address.replace(/^address\s*[:\-]\s*/i, "").trim();
  }

  return { name, phone, address };
}

export function fallbackParse(text: string): {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
} {
  const lines = text
    .replaceAll("\r", "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const phoneReg = /(?:(?:\+?880)|0)1[3-9]\d{8}/;
  const phone = phoneReg.exec(text)?.[0] ?? null;

  // Name via label
  let name: string | null = null;
  const nameLabel = /\bName\s*[:\-]\s*(.+)$/i;
  for (const line of lines) {
    const m = nameLabel.exec(line);
    if (m) {
      name = m[1]?.trim() ?? null;
      break;
    }
  }

  // Heuristic name near phone
  if (!name && phone) {
    const idx = lines.findIndex((l) => l.includes(phone));
    const window = [
      ...(idx - 2 >= 0 ? [lines[idx - 2]] : []),
      ...(idx - 1 >= 0 ? [lines[idx - 1]] : []),
      ...(idx >= 0 ? [lines[idx]] : []),
      ...(idx + 1 < lines.length ? [lines[idx + 1]] : []),
      ...(idx + 2 < lines.length ? [lines[idx + 2]] : []),
    ];
    const candidate = window.find((l) => looksLikeName(l)) ?? "";
    name = candidate.length ? candidate : null;
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

  // Heuristic address
  if (!address) {
    const addrKeywords =
      /\b(Road|Rd\.?|Thana|PO|PS|Upazila|District|Zila|Area|City|House|Apartment|Flat|Block|Sector)\b/i;
    const postal = /\b\d{4}\b/;
    const likely = lines.filter((l) => addrKeywords.test(l) || postal.test(l));
    if (likely.length) address = likely.slice(0, 3).join(", ");
  }

  return { name, phone, address };
}

function looksLikeName(line: string): boolean {
  if (/\d/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  const re = /^[A-Za-z][A-Za-z.\'-]*$/;
  return words.every((w) => re.test(w));
}

function looksLikeNewField(line: string): boolean {
  return /\b(Name|Phone|Mobile|Tel|Email|Address|City|Country|Order|Invoice|Bill To|Ship To|Payment|Shipping)\b/i.test(
    line
  );
}

/** Convert rows to CSV string (simple + safe) */
export function toCsv(rows: ExtractedRow[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = ["Source", "Page", "Name", "Phone", "Address"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [esc(r.source), String(r.page), esc(r.name ?? ""), esc(r.phone ?? ""), esc(r.address ?? "")]
        .join(",")
    );
  }
  return lines.join("\n");
}
