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

const isProductTitleColumn = (column: string) =>
  /^(product|product title|title)$/.test(normalizeTitlePart(column));

const isConditionalColumn = (column: string) =>
  /^(brand|category)$/.test(normalizeTitlePart(column));

export function buildProductTitle(columns: string[], values: string[]) {
  const productTitleIndex = columns.findIndex(isProductTitleColumn);
  const productTitle = productTitleIndex >= 0 ? values[productTitleIndex] ?? "" : "";

  return values
    .filter((value, index) => {
      if (!value.trim()) return false;
      if (!isConditionalColumn(columns[index] ?? "")) return true;
      return !titleContainsPart(productTitle, value);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
