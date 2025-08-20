import { NextResponse } from "next/server";
import { parseInvoiceToBlock, fallbackParse, type ExtractedRow } from "@/lib/parsers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];
    if (!files.length) {
      return NextResponse.json({ rows: [] as ExtractedRow[] }, { status: 200 });
    }

    // Use the real parser entry to avoid ENOENT self-test
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");

    const rows: ExtractedRow[] = [];

    for (const f of files) {
      const ab = await f.arrayBuffer();
      const buf = Buffer.from(ab);

      // Build per-page text:
      // - keep word spaces
      // - insert '\n' at end-of-line
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

      // Pages are separated by form feed
      const pages: string[] = (data.text ?? "").split("\f");

      pages.forEach((rawPageText, pageIndex) => {
        // ---- Bangla-safe cleanup ----
        let pageText = rawPageText.normalize("NFC");
        // collapse spaces between consecutive Bengali block chars
        pageText = pageText.replace(/([\u0980-\u09FF])\s+(?=[\u0980-\u09FF])/g, "$1");
        // collapse spaces around zero-width joiners
        pageText = pageText.replace(/([\u0980-\u09FF])\s+(?=[\u200C\u200D])/g, "$1");
        pageText = pageText.replace(/([\u200C\u200D])\s+(?=[\u0980-\u09FF])/g, "$1");
        // tidy whitespace
        pageText = pageText.replace(/[ \t]+/g, " ");
        pageText = pageText.replace(/[ \t]*\n[ \t]*/g, "\n");
        pageText = pageText.replace(/\n{2,}/g, "\n");

        // Split page into Invoice blocks (handles "Invoice To:", "Invoice   To -", etc.)
        const blocks = pageText
          .split(/Invoice\s*To\s*[:\-]?/i)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => "Invoice To: " + s);

        const work = blocks.length ? blocks : [pageText];

        for (const block of work) {
          const primary = parseInvoiceToBlock(block);
          const parsed =
            primary.name || primary.phone || primary.address
              ? primary
              : fallbackParse(block);

          if (parsed.name || parsed.phone || parsed.address) {
            rows.push({
              source: f.name,
              page: pageIndex + 1,
              name: parsed.name ?? undefined,
              phone: parsed.phone ?? undefined,
              address: parsed.address ?? undefined,
            });
          }
        }
      });
    }

    return NextResponse.json({ rows }, { status: 200 });
  } catch (e: any) {
    console.error("extract error", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
