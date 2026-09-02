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
 * Builds a title in the selected column order while retaining only the first
 * occurrence of each word across columns. Comparison is case- and
 * punctuation- and common singular/plural-insensitive, but the spelling and
 * capitalisation from the spreadsheet are preserved. Repeated words inside
 * one column are retained because they may be meaningful dimensions or model
 * names (for example, "3 x 3").
 *
 * Category descriptors are placed before an overlapping product noun so the
 * result reads naturally. For example, ["Sitka Gear", "Stratus Pant",
 * "Hunting Pants"] becomes "Sitka Gear Stratus Hunting Pant".
 */
export function buildProductTitle(columns: string[], values: string[]) {
  const seenWords = new Set<string>();
  const titleWords: string[] = [];

  for (const [columnIndex, value] of values.entries()) {
    const columnWords = new Set<string>();
    const uniqueWords: { display: string; key: string }[] = [];
    const sourceWords: { display: string; key: string }[] = [];

    for (const word of value.trim().split(/\s+/)) {
      const normalizedWord = comparisonKey(word);
      if (!normalizedWord) continue;
      sourceWords.push({ display: word, key: normalizedWord });

      if (seenWords.has(normalizedWord)) continue;

      columnWords.add(normalizedWord);
      uniqueWords.push({ display: word, key: normalizedWord });
    }

    const existingKeys = titleWords.map(comparisonKey);
    let categoryNounIndex = -1;
    if (isCategoryColumn(columns[columnIndex] ?? "")) {
      // Find the longest category suffix already present in the title. New
      // descriptors belong before that noun phrase: "Hunting Ground Blinds"
      // merges into an existing "Ground Blind" as "Hunting Ground Blind".
      for (let start = 0; start < sourceWords.length; start += 1) {
        const suffix = sourceWords.slice(start).map(({ key }) => key);
        if (!suffix.every((key) => seenWords.has(key))) continue;

        categoryNounIndex = existingKeys.findIndex((_, titleIndex) =>
          suffix.every((key, offset) => existingKeys[titleIndex + offset] === key),
        );
        if (categoryNounIndex >= 0) break;
      }
    }

    const shouldMergeBeforeNoun =
      isCategoryColumn(columns[columnIndex] ?? "") &&
      categoryNounIndex >= 0 &&
      uniqueWords.length > 0;

    if (shouldMergeBeforeNoun) {
      titleWords.splice(
        categoryNounIndex,
        0,
        ...uniqueWords.map(({ display }) => display),
      );
    } else {
      titleWords.push(...uniqueWords.map(({ display }) => display));
    }

    for (const word of columnWords) seenWords.add(word);
  }

  return titleWords.join(" ").trim();
}
