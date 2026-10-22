// A table as tab-separated text: rows on lines, cells split by tabs, which
// Excel and Google Sheets paste straight into cells. Shared by the copy button
// on the table and the full-window preview.
export function tableToTsv(table: HTMLTableElement): string {
  return [...table.querySelectorAll("tr")]
    .map((tr) =>
      [...tr.querySelectorAll("th, td")].map((c) => (c.textContent ?? "").trim().replace(/\s+/g, " ")).join("\t"),
    )
    .join("\n");
}
