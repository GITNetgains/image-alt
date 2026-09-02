const normalizeTitleWord = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

/**
 * Builds a title in the selected column order while retaining only the first
 * occurrence of each word across columns. Comparison is case- and
 * punctuation-insensitive, but the spelling and capitalisation from the
 * spreadsheet are preserved. Repeated words inside one column are retained
 * because they may be meaningful dimensions or model names (for example,
 * "3 x 3").
 *
 * Example: ["Nike", "Nike Air Max Shoes", "Running Shoes"]
 * becomes "Nike Air Max Shoes Running".
 */
export function buildProductTitle(_columns: string[], values: string[]) {
  const seenWords = new Set<string>();
  const titleWords: string[] = [];

  for (const value of values) {
    const columnWords = new Set<string>();

    for (const word of value.trim().split(/\s+/)) {
      const normalizedWord = normalizeTitleWord(word);
      if (!normalizedWord || seenWords.has(normalizedWord)) continue;

      columnWords.add(normalizedWord);
      titleWords.push(word);
    }

    for (const word of columnWords) seenWords.add(word);
  }

  return titleWords.join(" ").trim();
}
