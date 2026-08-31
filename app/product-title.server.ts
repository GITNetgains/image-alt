import readXlsxFile from "read-excel-file/node";
import { buildProductTitle } from "./product-title";

type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type ProductTitleRow = {
  identifier: string;
  matchBy: "handle" | "title";
  sourceValues: string[];
  newTitle: string;
  mediaAlts: { position: number; imageId?: string; alt: string }[];
};

export type ProductTitleResult = {
  scanned: number;
  updated: number;
  mediaUpdated: number;
  skipped: number;
  errors: string[];
  undo: ProductUndoRecord[];
};

export type ProductUndoRecord = {
  productId: string;
  title?: string;
  seoTitle?: string | null;
  media: { id: string; alt: string | null }[];
};

export type ProductRevertResult = {
  revertedProducts: number;
  revertedMedia: number;
  errors: string[];
};

type ProductImportOptions = {
  updateTitles?: boolean;
  updateMediaAlt?: boolean;
  altColumn?: string;
};

const normalizeHeader = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");

const cell = (row: unknown[], index: number) =>
  index < 0 ? "" : String(row[index] ?? "").trim();

export type WorkbookSheet = {
  name: string;
  headers: string[];
  rowCount: number;
  sampleValues: string[];
};

export async function scanProductTitleWorkbook(buffer: ArrayBuffer): Promise<WorkbookSheet[]> {
  const sheets = await readXlsxFile(Buffer.from(buffer));
  return sheets
    .filter((sheet) => sheet.data.length > 0)
    .map((sheet) => {
      const headerCells = sheet.data[0].map((header) => String(header ?? "").trim());
      const includedIndexes = headerCells.flatMap((header, index) => header ? [index] : []);
      const sampleRow = sheet.data.slice(1).find((row) => row.some((value) => value != null)) ?? [];
      return {
        name: sheet.sheet,
        headers: includedIndexes.map((index) => headerCells[index]),
        rowCount: Math.max(0, sheet.data.length - 1),
        sampleValues: includedIndexes.map((index) => String(sampleRow[index] ?? "").trim()),
      };
    });
}

export async function parseProductTitleXlsx(
  buffer: ArrayBuffer,
  selectedColumns: string[] = ["Brand", "Product", "Category"],
  sheetName = "Products",
  identifierColumn = "Product URL",
  options: ProductImportOptions = {},
): Promise<ProductTitleRow[]> {
  const sheets = await readXlsxFile(Buffer.from(buffer));
  const sheet = sheets.find((item) => item.sheet.trim().toLowerCase() === sheetName.trim().toLowerCase());
  if (!sheet?.data.length) throw new Error(`Worksheet not found: ${sheetName}`);

  const headers = sheet.data[0].map(normalizeHeader);
  const identifierIndex = headers.indexOf(normalizeHeader(identifierColumn));
  if (identifierIndex < 0) throw new Error(`Identifier column not found: ${identifierColumn}`);
  const updateTitles = options.updateTitles ?? true;
  const updateMediaAlt = options.updateMediaAlt ?? false;
  if (updateTitles && !selectedColumns.length) throw new Error("Select at least one title column");

  const selectedIndexes = selectedColumns.map((column) => headers.indexOf(normalizeHeader(column)));
  const missingColumns = selectedColumns.filter((_, index) => selectedIndexes[index] < 0);
  if (missingColumns.length) {
    throw new Error(`Columns not found in Products tab: ${missingColumns.join(", ")}`);
  }
  const altIndex = updateMediaAlt ? headers.indexOf(normalizeHeader(options.altColumn)) : -1;
  const imageNumberIndex = headers.findIndex((header) => header === "img #" || header === "image #");
  const imageIdIndex = headers.findIndex((header) => header === "image id");
  if (updateMediaAlt && altIndex < 0) {
    throw new Error("Select a valid ALT text column");
  }

  const matchBy = /product\s*url|handle/i.test(identifierColumn) ? "handle" : "title";
  const byProduct = new Map<string, ProductTitleRow>();
  let previousProductIdentifier = "";
  for (const row of sheet.data.slice(1)) {
    const rowAlt = updateMediaAlt ? cell(row, altIndex) : "";
    const identifier = cell(row, identifierIndex);
    let productIdentifier = identifier;
    if (matchBy === "handle") {
      if (identifier) {
        try {
          const parts = new URL(identifier).pathname.split("/").filter(Boolean);
          const productPosition = parts.lastIndexOf("products");
          productIdentifier = productPosition >= 0 ? parts[productPosition + 1] ?? "" : "";
        } catch {
          productIdentifier = identifier.trim().replace(/^\/+|\/+$/g, "");
        }
      }
    }
    if (!productIdentifier && rowAlt) productIdentifier = previousProductIdentifier;
    if (!productIdentifier) continue;
    previousProductIdentifier = productIdentifier;

    const sourceValues = selectedIndexes.map((index) => cell(row, index));
    const newTitle = updateTitles
      ? buildProductTitle(selectedColumns, sourceValues)
      : "";
    const mapKey = `${matchBy}:${productIdentifier.toLocaleLowerCase()}`;
    const existing = byProduct.get(mapKey);
    const product = existing ?? {
      identifier: productIdentifier,
      matchBy,
      sourceValues,
      newTitle: newTitle.slice(0, 255),
      mediaAlts: [],
    };
    if (updateMediaAlt) {
      if (rowAlt) {
        const sheetPosition = Number(cell(row, imageNumberIndex));
        const position = Number.isInteger(sheetPosition) && sheetPosition > 0
          ? sheetPosition
          : product.mediaAlts.length + 1;
        const imageId = cell(row, imageIdIndex);
        product.mediaAlts.push({
          position,
          ...(imageId ? { imageId } : {}),
          alt: rowAlt.slice(0, 512),
        });
      }
    }
    const hasTitleUpdate = updateTitles && Boolean(product.newTitle);
    const hasMediaUpdate = updateMediaAlt && product.mediaAlts.length > 0;
    if (hasTitleUpdate || hasMediaUpdate) {
      byProduct.set(mapKey, product);
    }
  }

  if (!byProduct.size) throw new Error("No valid product rows were found in the Products tab");
  const products = [...byProduct.values()];
  console.log("[product-sheet] parsed workbook", {
    sheetName,
    sourceRows: Math.max(0, sheet.data.length - 1),
    parsedProducts: products.length,
    products: products.map((product) => ({
      identifier: product.identifier,
      images: product.mediaAlts.map((media) => ({
        position: media.position,
        imageId: media.imageId ?? null,
      })),
      imageAltCount: product.mediaAlts.length,
    })),
  });
  return products;
}

const escapeSearchValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const normalizedProductValue = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

export async function updateProductTitles(
  admin: AdminGraphqlClient,
  rows: ProductTitleRow[],
): Promise<ProductTitleResult> {
  const result: ProductTitleResult = { scanned: rows.length, updated: 0, mediaUpdated: 0, skipped: 0, errors: [], undo: [] };

  type ProductNode = {
    id: string;
    handle: string;
    title: string;
    seo: { title: string | null };
    media: {
      nodes: {
        id: string;
        mediaContentType: string;
        alt: string | null;
        image?: { id: string } | null;
      }[];
    };
  };
  const titleRows = rows.filter((row) => row.matchBy === "title");
  let products: ProductNode[] = [];
  if (titleRows.length) {
    const lookupResponse = await admin.graphql(
      `#graphql
        query ProductsForTitleUpdate($query: String!, $first: Int!) {
          products(first: $first, query: $query) {
            nodes {
              id
              handle
              title
              seo { title }
              media(first: 250) {
                nodes {
                  id
                  alt
                  mediaContentType
                  ... on MediaImage { image { id } }
                }
              }
            }
          }
        }`,
      {
        variables: {
          first: Math.min(250, Math.max(50, titleRows.length * 3)),
          query: titleRows.flatMap((row) => {
            const values = row.newTitle
              ? new Set([row.identifier, row.newTitle])
              : new Set([row.identifier]);
            return [...values].map((value) => `title:"${escapeSearchValue(value)}"`);
          }).join(" OR "),
        },
      },
    );
    const lookupJson = await lookupResponse.json();
    if (lookupJson.errors?.length) {
      throw new Error(lookupJson.errors.map((error: { message: string }) => error.message).join(", "));
    }
    products = lookupJson.data?.products?.nodes ?? [];
  }

  const productsByHandle = new Map<string, ProductNode>();
  for (const row of rows.filter((item) => item.matchBy === "handle")) {
    const mediaFirst = Math.min(
      250,
      Math.max(1, ...row.mediaAlts.map((media) => media.position)),
    );
    console.log("[product-sheet] direct lookup start", {
      identifier: row.identifier,
      mediaFirst,
    });
    try {
      const response = await admin.graphql(
        `#graphql
          query ProductByHandle($query: String!, $mediaFirst: Int!) {
            products(first: 2, query: $query) {
              nodes {
                id
                handle
                title
                seo { title }
                media(first: $mediaFirst) {
                  nodes {
                    id
                    alt
                    mediaContentType
                  }
                }
              }
            }
          }`,
        { variables: { query: `handle:${row.identifier}`, mediaFirst } },
      );
      const json = await response.json();
      if (json.errors?.length) {
        result.errors.push(
          `${row.identifier} lookup: ${json.errors.map((error: { message: string }) => error.message).join(", ")}`,
        );
        console.error("[product-sheet] direct lookup GraphQL errors", {
          identifier: row.identifier,
          errors: json.errors,
        });
        continue;
      }
      const candidates: ProductNode[] = json.data?.products?.nodes ?? [];
      const product = candidates.find(
        (candidate) => normalizedProductValue(candidate.handle) === normalizedProductValue(row.identifier),
      ) ?? null;
      console.log("[product-sheet] direct lookup result", {
        identifier: row.identifier,
        found: Boolean(product),
        returnedHandle: product?.handle ?? null,
        availableImages: product?.media.nodes.length ?? 0,
      });
      if (product) productsByHandle.set(normalizedProductValue(row.identifier), product);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Product lookup failed";
      result.errors.push(
        `${row.identifier} lookup: ${message}`,
      );
      console.error("[product-sheet] direct lookup failed", {
        identifier: row.identifier,
        error: message,
      });
    }
  }

  for (const row of rows) {
    const expected = new Set([
      normalizedProductValue(row.identifier),
      ...(row.matchBy === "title" && row.newTitle
        ? [normalizedProductValue(row.newTitle)]
        : []),
    ]);
    const directProduct = row.matchBy === "handle"
      ? productsByHandle.get(normalizedProductValue(row.identifier))
      : undefined;
    const matches = directProduct
      ? [directProduct]
      : products.filter((product) =>
          expected.has(normalizedProductValue(product.title)),
        );
    const product = matches[0];
    console.log("[product-sheet] product lookup", {
      identifier: row.identifier,
      matchBy: row.matchBy,
      matches: matches.length,
      requestedImagePositions: row.mediaAlts.map((media) => media.position),
      availableImages: product?.media.nodes.filter(
        (media) => media.mediaContentType === "IMAGE",
      ).length ?? 0,
    });
    if (!product) {
      result.skipped += 1;
      result.errors.push(`Product not found: ${row.identifier}`);
      continue;
    }
    if (matches.length > 1) {
      result.skipped += 1;
      result.errors.push(`Multiple products matched exactly: ${row.identifier}`);
      continue;
    }

    let mediaUpdateSucceeded = true;
    const undo: ProductUndoRecord = { productId: product.id, media: [] };
    if (row.mediaAlts.length) {
      const images = product.media.nodes.filter((media) => media.mediaContentType === "IMAGE");
      const mediaUpdates = row.mediaAlts.flatMap(({ position, alt }) => {
        const image = images[position - 1];
        if (!image) {
          mediaUpdateSucceeded = false;
          result.skipped += 1;
          result.errors.push(`${row.identifier}: image ${position} does not exist; ALT skipped`);
          return [];
        }
        if (image.alt?.trim()) {
          result.skipped += 1;
          console.log("[product-sheet] existing image ALT protected", {
            identifier: row.identifier,
            position,
            mediaId: image.id,
          });
          return [];
        }
        return [{
          id: image.id,
          alt,
          position,
          matchedBy: "position",
        }];
      });
      const media = mediaUpdates.map(({ id, alt }) => ({ id, alt }));
      if (media.length) {
        console.log("[product-sheet] updating image ALT", {
          identifier: row.identifier,
          productId: product.id,
          updates: mediaUpdates.map((item) => ({
            position: item.position,
            matchedBy: item.matchedBy,
            mediaId: item.id,
            altLength: item.alt.length,
          })),
        });
        const mediaResponse = await admin.graphql(
          `#graphql
            mutation UpdateProductImageAlt($files: [FileUpdateInput!]!) {
              fileUpdate(files: $files) {
                files { id alt }
                userErrors { field message }
              }
            }`,
          { variables: { files: media } },
        );
        const mediaJson = await mediaResponse.json();
        const mediaErrors = [
          ...(mediaJson.errors ?? []).map((error: { message: string }) => error.message),
          ...(mediaJson.data?.fileUpdate?.userErrors ?? []).map((error: { message: string }) => error.message),
        ];
        const updatedMedia: { id: string; alt: string | null }[] = mediaJson.data?.fileUpdate?.files ?? [];
        console.log("[product-sheet] image ALT response", {
          identifier: row.identifier,
          requested: media.length,
          returned: updatedMedia.length,
          updatedMediaIds: updatedMedia.map((item) => item.id),
          errors: mediaErrors,
        });
        const allVerified = media.every((item) =>
          updatedMedia.some((updated) => updated.id === item.id && updated.alt === item.alt),
        );
        mediaUpdateSucceeded = mediaUpdateSucceeded && !mediaErrors.length && allVerified;
        if (mediaUpdateSucceeded) {
          result.mediaUpdated += media.length;
          undo.media.push(...mediaUpdates.map((item) => ({
            id: item.id,
            alt: images.find((image) => image.id === item.id)?.alt ?? null,
          })));
        } else {
          result.skipped += media.length;
          result.errors.push(
            `${row.identifier}: image ALT update failed${mediaErrors.length ? `: ${mediaErrors.join(", ")}` : " verification"}`,
          );
        }
      }
    }

    // Update the title after media ALT text. This prevents any legacy product-update webhook
    // delivery from racing ahead of the spreadsheet ALT write.
    if (row.newTitle) {
      const updateResponse = await admin.graphql(
        `#graphql
          mutation UpdateProductAndSeoTitle($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              product { id title seo { title } }
              userErrors { field message }
            }
          }`,
        { variables: { product: { id: product.id, title: row.newTitle, seo: { title: row.newTitle } } } },
      );
      const updateJson = await updateResponse.json();
      const errors = [
        ...(updateJson.errors ?? []).map((error: { message: string }) => error.message),
        ...(updateJson.data?.productUpdate?.userErrors ?? []).map((error: { message: string }) => error.message),
      ];
      if (errors.length) result.errors.push(`${row.identifier} title: ${errors.join(", ")}`);
      else {
        result.updated += 1;
        undo.title = product.title;
        undo.seoTitle = product.seo.title;
      }
    }
    if (undo.title !== undefined || undo.media.length) result.undo.push(undo);
  }

  return result;
}

export async function revertProductUpdates(
  admin: AdminGraphqlClient,
  records: ProductUndoRecord[],
  beforeProductRevert?: (productId: string) => void,
): Promise<ProductRevertResult> {
  const result: ProductRevertResult = { revertedProducts: 0, revertedMedia: 0, errors: [] };

  for (const record of records) {
    beforeProductRevert?.(record.productId);
    if (record.title !== undefined) {
      const response = await admin.graphql(
        `#graphql
          mutation RevertProductTitle($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              product { id title seo { title } }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            product: {
              id: record.productId,
              title: record.title,
              seo: { title: record.seoTitle },
            },
          },
        },
      );
      const json = await response.json();
      const errors = [
        ...(json.errors ?? []).map((error: { message: string }) => error.message),
        ...(json.data?.productUpdate?.userErrors ?? []).map((error: { message: string }) => error.message),
      ];
      if (errors.length) result.errors.push(`${record.productId} title: ${errors.join(", ")}`);
      else result.revertedProducts += 1;
    }

    if (record.media.length) {
      const response = await admin.graphql(
        `#graphql
          mutation RevertProductImageAlt($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
              files { id alt }
              userErrors { field message }
            }
          }`,
        { variables: { files: record.media } },
      );
      const json = await response.json();
      const errors = [
        ...(json.errors ?? []).map((error: { message: string }) => error.message),
        ...(json.data?.fileUpdate?.userErrors ?? []).map((error: { message: string }) => error.message),
      ];
      if (errors.length) result.errors.push(`${record.productId} image ALT: ${errors.join(", ")}`);
      else result.revertedMedia += json.data?.fileUpdate?.files?.length ?? 0;
    }
  }

  return result;
}
