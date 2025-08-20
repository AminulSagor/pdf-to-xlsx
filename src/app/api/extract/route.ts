// src/app/api/extract/route.ts
import { NextResponse } from "next/server";
import { Buffer } from "buffer";
import {
  parseInvoiceToBlock,
  fallbackParse,
  type ExtractedRow,
} from "@/lib/parsers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bangla/Latin tidy for output fields (keep natural word spaces)
const tidyBn = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFC")
    // remove zero-width & NBSP junk
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00A0]/g, "")
    // tighten only around dependent marks (kar/nukta/hasanta)
    .replace(/([\u0980-\u09FF])\s+(?=[\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD])/g, "$1")
    .replace(/(?<=[\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD])\s+(?=[\u0980-\u09FF])/g, "")
    // collapse gaps inside digits (Latin or Bangla)
    .replace(/([0-9\u09E6-\u09EF])\s+(?=[0-9\u09E6-\u09EF])/g, "$1")
    // normalize punctuation spacing
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*:\s*/g, ":")
    // Bengali danda/visarga spacing
    .replace(/\s*।\s*/g, "। ")
    .replace(/\s*ঃ\s*/g, "ঃ")
    // collapse repeated spaces but keep single spaces between words
    .replace(/[ \t]{2,}/g, " ")
    .trim();

// normalize a captured currency amount -> "৳970" / "Tk970" / "BDT970" -> "৳970"
const tidyValue = (s?: string | null) => {
  if (!s) return undefined;
  const raw = s.replace(/[,\s]/g, ""); // remove commas/spaces
  // prefer Bangla symbol if present, else keep prefix (Tk/BDT)
  const m = /^(৳|Tk|BDT)?(\d+(?:\.\d{1,2})?)$/i.exec(raw);
  if (!m) return undefined;
  const [, sym = "৳", num] = m;
  return `${sym}${num}`;
};

// extract total from a block (preferred) or page text (fallback)
// extract total from a block (preferred) or page text (fallback)
const extractTotal = (text: string): string | undefined => {
  // Collect all possible totals in this block
  const all = Array.from(
    text.matchAll(
      /Total\s*[:\-]?\s*((?:৳|Tk|BDT)?\s*[\d,]+(?:\.\d{1,2})?)/gi
    )
  );

  if (all.length) {
    // pick the last one
    const rawVal = all[all.length - 1][1];
    const withSym = /^(?:৳|Tk|BDT)/i.test(rawVal) ? rawVal : `৳${rawVal}`;
    return tidyValue(withSym);
  }

  // Fallback: last currency-like token anywhere in block
  const currencyMatches = Array.from(
    text.matchAll(/(?:৳|Tk|BDT)\s*[\d,]+(?:\.\d{1,2})?/gi)
  );
  if (currencyMatches.length) {
    return tidyValue(currencyMatches[currencyMatches.length - 1][0]);
  }

  return undefined;
};

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];

    if (!files.length) {
      return NextResponse.json({ rows: [] as ExtractedRow[] }, { status: 200 });
    }

    // Use real entry to avoid ENOENT self-test on some setups
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");

    const rows: ExtractedRow[] = [];

    for (const f of files) {
      const ab = await f.arrayBuffer();
      const buf = Buffer.from(ab);

      // Keep spaces between words; add '\n' at EOL so we can split reliably later
      const data = await pdfParse(buf, {
        pagerender: (pageData: any) =>
          pageData.getTextContent().then((tc: any) =>
            tc.items
              .map((i: any) => {
                const s = (i?.str ?? "") as string;
                const eol = i?.hasEOL ? "\n" : " ";
                return s + eol;
              })
              .join("")
          ),
      });

      // pdf-parse separates pages with form feed
      const pages: string[] = (data.text ?? "").split("\f");

      pages.forEach((rawPageText, pageIndex) => {
        // ---------- Normalization / cleanup ----------
        let pageText = rawPageText.normalize("NFC");

        // collapse only OCR-style spaced Latin runs (keeps real word gaps)
        pageText = pageText.replace(/((?:[A-Za-z]\s+){2,}[A-Za-z])/g, (run) =>
          run.replace(/\s+/g, "")
        );
        // collapse gaps inside numbers
        pageText = pageText.replace(/(\d)\s+(?=\d)/g, "$1");
        // punctuation spacing
        pageText = pageText.replace(/([A-Za-z0-9])\s+(?=[,.:;])/g, "$1");
        pageText = pageText.replace(/\s+(?=\))/g, "");
        pageText = pageText.replace(/(?<=\()\s+/g, "");
        // zero-width joiners near Bangla
        pageText = pageText.replace(/([\u0980-\u09FF])\s+(?=[\u200C\u200D])/g, "$1");
        pageText = pageText.replace(/([\u200C\u200D])\s+(?=[\u0980-\u09FF])/g, "$1");
        // General whitespace tidy
        pageText = pageText.replace(/[ \t]+/g, " ");
        pageText = pageText.replace(/[ \t]*\n[ \t]*/g, "\n");
        pageText = pageText.replace(/\n{2,}/g, "\n");

        // ---------- Split into "Invoice To" blocks ----------
        const splitRe = /Invoice\s*To\s*[:\-]?|InvoiceTo\s*[:\-]?/i;

        const parts = pageText
          .split(splitRe)
          .map((s) => s.trim())
          .filter(Boolean);

        const blocks = parts.map((s) => "Invoice To: " + s);
        const work = blocks.length ? blocks : [pageText];

        for (const block of work) {
          const primary = parseInvoiceToBlock(block);
          const parsed =
            primary.name || primary.phone || primary.address
              ? primary
              : fallbackParse(block);

          // clean & normalize outputs
          const name = tidyBn(parsed.name);
          const phone = (parsed.phone ?? "").trim();
          const address = tidyBn(parsed.address);
          const value = extractTotal(block) ?? extractTotal(pageText); // prefer per-block, fallback per-page

          // drop junk row where name is just "Invoice"
          const isInvoiceName = /^(\d+\s*)?invoice$/i.test(name);

          if (!isInvoiceName && (name || phone || address || value)) {
            rows.push({
              source: f.name,
              page: pageIndex + 1,
              name: name || undefined,
              phone: phone || undefined,
              address: address || undefined,
              value: value || undefined, // <-- NEW
            });
          }
        }
      });
    }

    return NextResponse.json({ rows }, { status: 200 });
  } catch (e: any) {
    console.error("extract error", e);
    return NextResponse.json(
      { error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
