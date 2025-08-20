"use client";

import { useState } from "react";
import type { ExtractedRow } from "@/lib/parsers";
import * as XLSX from "xlsx";

export default function HomePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<ExtractedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setRows([]);
    setError(null);
  };

  const extract = async () => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f, f.name));
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { rows: ExtractedRow[] };
      setRows(data.rows ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Download as real Excel (.xlsx)
  const downloadXlsx = () => {
    if (!rows.length) return;

    // Flatten to simple objects -> worksheet
    const sheetData = rows.map((r) => ({
      Source: r.source,
      Page: r.page,
      Name: r.name ?? "",
      Phone: r.phone ?? "",
      Address: r.address ?? "",
    }));

    // Workbook + sheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetData);

    // Optional: nicer column widths
    ws["!cols"] = [
      { wch: 24 }, // Source
      { wch: 6 },  // Page
      { wch: 28 }, // Name
      { wch: 16 }, // Phone
      { wch: 60 }, // Address
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Extracted");
    // ISO-ish filename safe for all OS
    const fname = `extracted_${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
    XLSX.writeFile(wb, fname, { compression: true });
  };

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Top banner */}
      <div className="bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600">
        <div className="mx-auto max-w-4xl px-6 py-10">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">
            PDF → Excel (XLSX) Extractor
          </h1>
          <p className="mt-2 text-sm/6 text-indigo-100">
            Upload one or more PDFs, extract contact blocks, and download as XLSX.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-6 py-8 space-y-6">
        {/* Controls Card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Choose Files</span>
              <input
                type="file"
                multiple
                accept="application/pdf"
                onChange={onPick}
                className="block text-sm file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 focus:outline-none"
              />
            </label>

            <div className="flex-1" />

            <button
              onClick={extract}
              disabled={!files.length || busy}
              className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition
                         hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600
                         disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Extracting…" : "Extract"}
            </button>

            <button
              onClick={downloadXlsx}
              disabled={!rows.length || busy}
              className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition
                         hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600
                         disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download XLSX
            </button>

            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
              {files.length} file(s) • {rows.length} row(s)
            </span>
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
        </div>

        {/* Table Card */}
        {!rows.length ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
            Pick PDFs and click <b className="text-slate-700">Extract</b>.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-slate-100/95 backdrop-blur supports-[backdrop-filter]:bg-slate-100/70">
                  <tr className="text-left text-slate-700">
                    <th className="p-3 font-semibold">Source</th>
                    <th className="p-3 font-semibold">Page</th>
                    <th className="p-3 font-semibold">Name</th>
                    <th className="p-3 font-semibold">Phone</th>
                    <th className="p-3 font-semibold">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={i}
                      className="border-t border-slate-200 odd:bg-white even:bg-slate-50 hover:bg-indigo-50/60"
                    >
                      <td className="p-3 text-slate-900">{r.source}</td>
                      <td className="p-3 text-slate-900">{r.page}</td>
                      <td className="p-3 text-slate-900">{r.name ?? ""}</td>
                      <td className="p-3 text-slate-900">{r.phone ?? ""}</td>
                      <td className="p-3 text-slate-900 w-[520px]">{r.address ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Tip: keep primary actions in indigo, export in emerald, and errors in rose to preserve
          semantic color memory.
        </p>
      </div>
    </main>
  );
}
