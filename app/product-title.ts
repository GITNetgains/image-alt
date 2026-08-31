const normalizeTitlePart = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const titleContainsPart = (title: string, part: string) => {
  const normalizedTitle = normalizeTitlePart(title);
  const normalizedPart = normalizeTitlePart(part);
  if (!normalizedTitle || !normalizedPart) return false;

  return ` ${normalizedTitle} `.includes(` ${normalizedPart} `);
};

const titleContainsCategory = (title: string, category: string) => {
  if (titleContainsPart(title, category)) return true;

  const normalizedTitle = ` ${normalizeTitlePart(title)} `;
  const categoryWords = normalizeTitlePart(category).split(" ").filter(Boolean);

  // A category can be broader than the wording already present in the product title.
  // Example: "HUNTING GROUND BLIND" must not be appended to a title containing
  // "GROUND BLIND". Match a consecutive two-or-more-word category phrase as well.
  for (let phraseLength = categoryWords.length - 1; phraseLength >= 2; phraseLength -= 1) {
    for (let start = 0; start + phraseLength <= categoryWords.length; start += 1) {
      const phrase = categoryWords.slice(start, start + phraseLength).join(" ");
      if (normalizedTitle.includes(` ${phrase} `)) return true;
    }
  }

  return false;
};

const isProductTitleColumn = (column: string) =>
  /^(product|product title|title)$/.test(normalizeTitlePart(column));

const conditionalColumnType = (column: string) => {
  const normalizedColumn = normalizeTitlePart(column);
  if (/^(brand|brand name)$/.test(normalizedColumn)) return "brand";
  if (/^(category|product category)$/.test(normalizedColumn)) return "category";
  return null;
};

export function buildProductTitle(columns: string[], values: string[]) {
  const productTitleIndex = columns.findIndex(isProductTitleColumn);
  const productTitle = productTitleIndex >= 0 ? values[productTitleIndex] ?? "" : "";

  return values
    .filter((value, index) => {
      if (!value.trim()) return false;
      const columnType = conditionalColumnType(columns[index] ?? "");
      if (columnType === "brand") return !titleContainsPart(productTitle, value);
      if (columnType === "category") return !titleContainsCategory(productTitle, value);
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
