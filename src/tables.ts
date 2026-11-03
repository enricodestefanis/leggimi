// A table as tab-separated text: rows on lines, cells split by tabs, which
// Excel and Google Sheets paste straight into cells. Shared by the copy button
// on the table and the full-window preview, where it copies what is shown:
// the rows a filter left (the others are hidden), in the order shown.
export function tableToTsv(table: HTMLTableElement): string {
  return [...table.querySelectorAll("tr")]
    .filter((tr) => !tr.hidden)
    .map((tr) =>
      [...tr.querySelectorAll("th, td")].map((c) => (c.textContent ?? "").trim().replace(/\s+/g, " ")).join("\t"),
    )
    .join("\n");
}
