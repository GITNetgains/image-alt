import readXlsxFile from "read-excel-file/node";

type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type SyncResult = { scanned: number; updated: number; skipped: number; errors: string[] };
type ImageRecord = { id: string; alt: string | null; url: string | null };

export type CsvAltRow = { imageName: string; altText: string };

async function graphqlWithRetry(
  admin: AdminGraphqlClient,
  query: string,
  options?: { variables?: Record<string, unknown> },
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await admin.graphql(query, options);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

export function filenameToAlt(url: string | null): string | null {
  if (!url) return null;
  try {
    const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    const cleaned = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned ? cleaned.slice(0, 512) : null;
  } catch {
    return null;
  }
}

function filenameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || null;
  } catch {
    return null;
  }
}

export function parseAltTextCsv(csv: string): CsvAltRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted && character === '"' && csv[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  return spreadsheetRowsToAltRows(records);
}

export async function parseAltTextXlsx(buffer: ArrayBuffer): Promise<CsvAltRow[]> {
  const sheets = await readXlsxFile(Buffer.from(buffer));
  const rows = sheets[0]?.data ?? [];
  return spreadsheetRowsToAltRows(
    rows.map((row) => row.map((cell) => (cell == null ? "" : String(cell)))),
  );
}

function spreadsheetRowsToAltRows(records: string[][]): CsvAltRow[] {
  if (!records.length) throw new Error("Spreadsheet is empty");

  const headers = records[0].map((value) =>
    value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_"),
  );
  const imageIndex = headers.findIndex((value) =>
    ["image_name", "file_name", "filename"].includes(value),
  );
  const altIndex = headers.findIndex((value) => ["alt_text", "alt"].includes(value));
  if (imageIndex < 0 || altIndex < 0) {
    throw new Error('Spreadsheet headers must be "image_name" and "alt_text"');
  }

  return records.slice(1).flatMap((values) => {
    const imageName = values[imageIndex]?.trim();
    const altText = values[altIndex]?.trim();
    return imageName && altText ? [{ imageName, altText: altText.slice(0, 512) }] : [];
  });
}

export async function importCsvAltText(
  admin: AdminGraphqlClient,
  rows: CsvAltRow[],
): Promise<SyncResult> {
  const result: SyncResult = { scanned: rows.length, updated: 0, skipped: 0, errors: [] };
  const images: ImageRecord[] = [];
  let after: string | null = null;

  do {
    const response = await graphqlWithRetry(
      admin,
      `#graphql
        query StoreImagesForCsvImport($after: String) {
          files(first: 100, after: $after) {
            nodes { id alt ... on MediaImage { image { url } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { variables: { after } },
    );
    const json = await response.json();
    const connection = json.data?.files;
    images.push(
      ...(connection?.nodes ?? [])
        .filter((node: { image?: { url?: string } }) => Boolean(node.image?.url))
        .map((node: { id: string; alt: string | null; image: { url: string } }) => ({
          id: node.id,
          alt: node.alt,
          url: node.image.url,
        })),
    );
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  const byFilename = new Map<string, ImageRecord[]>();
  for (const image of images) {
    const filename = filenameFromUrl(image.url)?.toLowerCase();
    if (!filename) continue;
    const stem = filename.replace(/\.[^.]+$/, "");
    for (const key of new Set([filename, stem])) {
      byFilename.set(key, [...(byFilename.get(key) ?? []), image]);
    }
  }

  const updates = new Map<string, { id: string; alt: string }>();
  for (const row of rows) {
    const key = row.imageName.toLowerCase();
    const matches = byFilename.get(key) ?? [];
    if (!matches.length) {
      result.skipped += 1;
      result.errors.push(`Image not found: ${row.imageName}`);
      continue;
    }
    for (const image of matches) updates.set(image.id, { id: image.id, alt: row.altText });
  }

  const files = [...updates.values()];
  for (let index = 0; index < files.length; index += 100) {
    const response = await graphqlWithRetry(
      admin,
      `#graphql
        mutation ImportFileAltText($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            files { id }
            userErrors { field message }
          }
        }`,
      { variables: { files: files.slice(index, index + 100) } },
    );
    const json = await response.json();
    result.updated += json.data?.fileUpdate?.files?.length ?? 0;
    result.errors.push(
      ...(json.data?.fileUpdate?.userErrors ?? []).map(
        (error: { message: string }) => error.message,
      ),
    );
  }

  result.skipped += Math.max(0, rows.length - result.updated - result.skipped);
  return result;
}

async function updateFiles(admin: AdminGraphqlClient, images: ImageRecord[]) {
  const files = images
    .filter((image) => !image.alt?.trim())
    .map((image) => ({ id: image.id, alt: filenameToAlt(image.url) }))
    .filter((file): file is { id: string; alt: string } => Boolean(file.alt));
  if (!files.length) return { updated: 0, errors: [] as string[] };

  const response = await graphqlWithRetry(
    admin,
    `#graphql
      mutation SetFileAltText($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
    { variables: { files } },
  );
  const json = await response.json();
  const payload = json.data?.fileUpdate;
  return {
    updated: payload?.files?.length ?? 0,
    errors: (payload?.userErrors ?? []).map((error: { message: string }) => error.message),
  };
}

export async function syncProductImages(admin: AdminGraphqlClient, productId: string): Promise<SyncResult> {
  const response = await graphqlWithRetry(
    admin,
    `#graphql
      query ProductImagesForAltText($id: ID!) {
        product(id: $id) {
          media(first: 250) {
            nodes { id alt ... on MediaImage { image { url } } }
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const json = await response.json();
  const images: ImageRecord[] = (json.data?.product?.media?.nodes ?? [])
    .filter((node: { image?: { url?: string } }) => Boolean(node.image?.url))
    .map((node: { id: string; alt: string | null; image: { url: string } }) => ({ id: node.id, alt: node.alt, url: node.image.url }));
  const update = await updateFiles(admin, images);
  return { scanned: images.length, updated: update.updated, skipped: images.length - update.updated, errors: update.errors };
}

export async function syncAllFileImages(admin: AdminGraphqlClient): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, updated: 0, skipped: 0, errors: [] };
  let after: string | null = null;
  do {
    const response = await graphqlWithRetry(
      admin,
      `#graphql
        query StoreFilesForAltText($after: String) {
          files(first: 100, after: $after) {
            nodes { id alt ... on MediaImage { image { url } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { variables: { after } },
    );
    const json = await response.json();
    const connection = json.data?.files;
    const images: ImageRecord[] = (connection?.nodes ?? [])
      .filter((node: { image?: { url?: string } }) => Boolean(node.image?.url))
      .map((node: { id: string; alt: string | null; image: { url: string } }) => ({ id: node.id, alt: node.alt, url: node.image.url }));
    result.scanned += images.length;
    const update = await updateFiles(admin, images);
    result.updated += update.updated;
    result.errors.push(...update.errors);
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  result.skipped = result.scanned - result.updated;
  return result;
}

export async function syncArticleImages(admin: AdminGraphqlClient): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, updated: 0, skipped: 0, errors: [] };
  let after: string | null = null;
  do {
    const response = await graphqlWithRetry(
      admin,
      `#graphql
        query ArticleImagesForAltText($after: String) {
          articles(first: 100, after: $after) {
            nodes { id image { url altText } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { variables: { after } },
    );
    const json = await response.json();
    const connection = json.data?.articles;
    for (const article of connection?.nodes ?? []) {
      if (!article.image?.url) continue;
      result.scanned += 1;
      const altText = filenameToAlt(article.image.url);
      if (article.image.altText?.trim() || !altText) { result.skipped += 1; continue; }
      const updateResponse = await graphqlWithRetry(
        admin,
        `#graphql
          mutation SetArticleImageAltText($id: ID!, $article: ArticleUpdateInput!) {
            articleUpdate(id: $id, article: $article) {
              article { id }
              userErrors { field message }
            }
          }`,
        { variables: { id: article.id, article: { image: { url: article.image.url, altText } } } },
      );
      const updateJson = await updateResponse.json();
      const errors = updateJson.data?.articleUpdate?.userErrors ?? [];
      if (errors.length) result.errors.push(...errors.map((error: { message: string }) => error.message));
      else result.updated += 1;
    }
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return result;
}
