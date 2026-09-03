const normalizeTitleWord = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

const comparisonKey = (value: string) => {
  const word = normalizeTitleWord(value);
  if (word.length <= 3) return word;

  // Treat common English singular/plural forms as the same SEO keyword.
  // This intentionally affects comparison only; the first spelling is kept.
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:sses|ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
};

const isCategoryColumn = (column: string) =>
  /^(?:category|product category)$/.test(
    column.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " "),
  );

/**
 * Builds a title in the selected column order, separated by " - ", while
 * retaining only the first occurrence of each word across columns. Category
 * columns are excluded from the generated title. Comparison is case- and
 * punctuation- and common singular/plural-insensitive, but the spelling and
 * capitalisation from the spreadsheet are preserved. Repeated words inside
 * one column are retained because they may be meaningful dimensions or model
 * names (for example, "3 x 3").
 *
 * For example, ["Sitka Gear", "Stratus Pant", "Hunting Pants"] from Brand,
 * Product, and Category columns becomes "Sitka Gear - Stratus Pant".
 */
export function buildProductTitle(columns: string[], values: string[]) {
  const seenWords = new Set<string>();
  const titleParts: string[] = [];

  for (const [columnIndex, value] of values.entries()) {
    if (isCategoryColumn(columns[columnIndex] ?? "")) continue;

    const columnWords = new Set<string>();
    const uniqueWords: string[] = [];

    for (const word of value.trim().split(/\s+/)) {
      const normalizedWord = comparisonKey(word);
      if (!normalizedWord) continue;

      if (seenWords.has(normalizedWord)) continue;

      columnWords.add(normalizedWord);
      uniqueWords.push(word);
    }

    if (uniqueWords.length) titleParts.push(uniqueWords.join(" "));

    for (const word of columnWords) seenWords.add(word);
  }

  return titleParts.join(" - ").trim();
}
