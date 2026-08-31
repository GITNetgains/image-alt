import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  parseProductTitleXlsx,
  revertProductUpdates,
  scanProductTitleWorkbook,
  updateProductTitles,
} from "../product-title.server";
import type { ProductUndoRecord } from "../product-title.server";
import { buildProductTitle } from "../product-title";
import { pauseProductAltSync } from "../product-alt-sync-pause.server";
import { authenticateAdmin } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticateAdmin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "revert") {
    try {
      const parsed = JSON.parse(String(formData.get("records") ?? "[]"));
      if (!Array.isArray(parsed)) throw new Error("Invalid revert data");
      const records = parsed as ProductUndoRecord[];
      const result = await revertProductUpdates(
        admin,
        records,
        (productId) => pauseProductAltSync(session.shop, productId),
      );
      const offset = Number(formData.get("offset") ?? 0);
      return {
        mode: "revert" as const,
        ...result,
        nextOffset: offset + records.length,
        errors: result.errors,
      };
    } catch (error) {
      return {
        mode: "revert" as const,
        revertedProducts: 0,
        revertedMedia: 0,
        nextOffset: Number(formData.get("offset") ?? 0),
        errors: [error instanceof Error ? error.message : "Revert failed"],
      };
    }
  }
  const spreadsheet = formData.get("spreadsheet");
  if (!(spreadsheet instanceof File) || !spreadsheet.size) {
    return { mode: "update" as const, scanned: 0, updated: 0, mediaUpdated: 0, skipped: 0, total: 0, nextOffset: 0, done: true, errors: ["Please select an XLSX file"] };
  }
  if (!spreadsheet.name.toLowerCase().endsWith(".xlsx")) {
    return { mode: "update" as const, scanned: 0, updated: 0, mediaUpdated: 0, skipped: 0, total: 0, nextOffset: 0, done: true, errors: ["Only .xlsx files are supported"] };
  }
  try {
    if (formData.get("intent") === "scan") {
      const sheets = await scanProductTitleWorkbook(await spreadsheet.arrayBuffer());
      return { mode: "scan" as const, sheets, errors: sheets.length ? [] : ["No worksheets found"] };
    }
    const rawColumns = JSON.parse(String(formData.get("titleColumns") ?? "[]"));
    if (!Array.isArray(rawColumns) || !rawColumns.every((column) => typeof column === "string")) {
      throw new Error("Invalid title column selection");
    }
    const sheetName = String(formData.get("sheetName") ?? "");
    const identifierColumn = String(formData.get("identifierColumn") ?? "");
    const updateTitles = formData.get("updateTitles") === "true";
    const updateMediaAlt = formData.get("updateMediaAlt") === "true";
    if (!updateTitles && !updateMediaAlt) throw new Error("Select at least one update type");
    const rows = await parseProductTitleXlsx(
      await spreadsheet.arrayBuffer(),
      rawColumns,
      sheetName,
      identifierColumn,
      {
        updateTitles,
        updateMediaAlt,
        altColumn: String(formData.get("altColumn") ?? ""),
      },
    );
    const requestedOffset = Number(formData.get("offset") ?? 0);
    const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const batchSize = 10;
    const batch = rows.slice(offset, offset + batchSize);
    console.log("[product-sheet] update batch", {
      sheetName,
      identifierColumn,
      altColumn: String(formData.get("altColumn") ?? ""),
      updateTitles,
      updateMediaAlt,
      parsedProducts: rows.length,
      offset,
      batchProducts: batch.length,
      products: batch.map((row) => ({
        identifier: row.identifier,
        images: row.mediaAlts.map((media) => ({
          position: media.position,
          imageId: media.imageId ?? null,
        })),
        imageAltCount: row.mediaAlts.length,
      })),
    });
    const result = await updateProductTitles(admin, batch);
    const nextOffset = offset + batch.length;
    return { mode: "update" as const, ...result, total: rows.length, nextOffset, done: nextOffset >= rows.length };
  } catch (error) {
    return {
      scanned: 0,
      updated: 0,
      mediaUpdated: 0,
      skipped: 0,
      total: 0,
      nextOffset: 0,
      done: true,
      mode: "update" as const,
      errors: [error instanceof Error ? error.message : "Product title import failed"],
    };
  }
};

export default function ProductTitlesPage() {
  const scanFetcher = useFetcher<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const revertFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const selectedFile = useRef<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [sheetName, setSheetName] = useState("");
  const [identifierColumn, setIdentifierColumn] = useState("");
  const [titleColumns, setTitleColumns] = useState<string[]>([]);
  const [updateTitles, setUpdateTitles] = useState(true);
  const [updateMediaAlt, setUpdateMediaAlt] = useState(true);
  const [altColumn, setAltColumn] = useState("");
  const [progress, setProgress] = useState({ processed: 0, updated: 0, mediaUpdated: 0, skipped: 0, errors: [] as string[] });
  const [undoRecords, setUndoRecords] = useState<ProductUndoRecord[]>([]);
  const [revertProgress, setRevertProgress] = useState({
    processed: 0,
    products: 0,
    media: 0,
    errors: [] as string[],
  });

  const submitBatch = (offset: number) => {
    if (!selectedFile.current) return;
    const formData = new FormData();
    formData.set("spreadsheet", selectedFile.current);
    formData.set("offset", String(offset));
    formData.set("titleColumns", JSON.stringify(titleColumns));
    formData.set("sheetName", sheetName);
    formData.set("identifierColumn", identifierColumn);
    formData.set("updateTitles", String(updateTitles));
    formData.set("updateMediaAlt", String(updateMediaAlt));
    formData.set("altColumn", altColumn);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  const submitRevertBatch = (offset: number) => {
    const records = undoRecords.slice(offset, offset + 10);
    if (!records.length) return;
    const formData = new FormData();
    formData.set("intent", "revert");
    formData.set("offset", String(offset));
    formData.set("records", JSON.stringify(records));
    revertFetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    const data = fetcher.data;
    if (!data || data.mode !== "update") return;
    const undo = "undo" in data ? data.undo : [];
    setUndoRecords((current) => [...current, ...undo]);
    setProgress((current) => ({
      processed: data.nextOffset,
      updated: current.updated + data.updated,
      mediaUpdated: current.mediaUpdated + data.mediaUpdated,
      skipped: current.skipped + data.skipped,
      errors: [...current.errors, ...data.errors],
    }));
    if (!data.done && selectedFile.current) {
      submitBatch(data.nextOffset);
      return;
    }
    shopify.toast.show("Selected product updates finished");
    // fetcher is stable for the lifetime of the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const data = revertFetcher.data;
    if (!data || data.mode !== "revert") return;
    setRevertProgress((current) => ({
      processed: data.nextOffset,
      products: current.products + data.revertedProducts,
      media: current.media + data.revertedMedia,
      errors: [...current.errors, ...data.errors],
    }));
    if (data.nextOffset < undoRecords.length) {
      submitRevertBatch(data.nextOffset);
      return;
    }
    setUndoRecords([]);
    shopify.toast.show(
      data.errors.length ? "Revert finished with errors" : "Last upload reverted",
    );
    // The fetcher and undo snapshot remain stable during a revert run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revertFetcher.data, shopify]);

  const scannedSheets = scanFetcher.data?.mode === "scan" ? scanFetcher.data.sheets : [];
  const selectedSheet = scannedSheets.find((sheet) => sheet.name === sheetName);
  const availableHeaders = selectedSheet?.headers ?? [];

  const selectSheet = (name: string) => {
    const sheet = scannedSheets.find((item) => item.name === name);
    const headers = sheet?.headers ?? [];
    setSheetName(name);
    setIdentifierColumn(
      headers.find((header) => /product\s*url/i.test(header))
      ?? headers.find((header) => /handle/i.test(header))
      ?? headers.find((header) => /^product$/i.test(header.trim()))
      ?? headers[0]
      ?? "",
    );
    setAltColumn(headers.find((header) => /proposed\s*alt|alt\s*text/i.test(header)) ?? headers[0] ?? "");
    const preferred = ["Brand", "Product", "Category"].flatMap((wanted) => {
      const match = headers.find((header) => header.trim().toLowerCase() === wanted.toLowerCase());
      return match ? [match] : [];
    });
    setTitleColumns(preferred.length ? preferred : headers.slice(0, 1));
  };

  useEffect(() => {
    if (scanFetcher.data?.mode !== "scan" || !scanFetcher.data.sheets.length) return;
    const firstSheet = scanFetcher.data.sheets.find((sheet) =>
      sheet.name.toLowerCase() === "products") ?? scanFetcher.data.sheets[0];
    selectSheet(firstSheet.name);
    // The scan response is the only trigger; selectSheet reads that response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.data]);

  const sampleTitle = buildProductTitle(
    titleColumns,
    titleColumns.map((column) => selectedSheet?.sampleValues[availableHeaders.indexOf(column)] ?? ""),
  );

  const moveTitleColumn = (index: number, direction: -1 | 1) => {
    setTitleColumns((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };

  return (
    <s-page heading="Product bulk updater" inlineSize="base">
      <s-banner heading="Dynamic Excel mapping" tone="info">
        Upload any XLSX workbook first. The app scans its worksheets and column headers, then lets
        you select the exact columns used for titles and image ALT text.
      </s-banner>

      <s-section heading="1. Upload workbook">
        <s-stack direction="block" gap="base">
          <s-drop-zone
            label="Excel workbook"
            accessibilityLabel="Upload and scan an Excel workbook"
            name="spreadsheet"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            disabled={scanFetcher.state !== "idle" || fetcher.state !== "idle"}
            onChange={(event) => {
              const file = event.currentTarget.files[0] ?? null;
              selectedFile.current = file;
              setFileName(file?.name ?? "");
              setConfirmed(false);
              if (!file) return;
              const formData = new FormData();
              formData.set("intent", "scan");
              formData.set("spreadsheet", file);
              scanFetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
            }}
          >
            <s-stack direction="block" gap="small" alignItems="center">
              <s-icon type="upload" tone="info"></s-icon>
              <s-text type="strong">
                {scanFetcher.state !== "idle" ? "Scanning workbook…" : "Drop XLSX here or choose a file"}
              </s-text>
              <s-paragraph color="subdued">Worksheet names and headers are detected automatically.</s-paragraph>
              {fileName && <s-badge tone="success" icon="check-circle">{fileName}</s-badge>}
            </s-stack>
          </s-drop-zone>
          {scanFetcher.data?.errors.length ? (
            <s-banner heading="Workbook scan failed" tone="critical">
              <s-paragraph>{scanFetcher.data.errors.join(", ")}</s-paragraph>
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      {scannedSheets.length > 0 && (
      <s-section heading="2. Map workbook data">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-text color="subdued">Worksheets found</s-text>
                <s-heading>{scannedSheets.length}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-text color="subdued">Rows in selected sheet</s-text>
                <s-heading>{selectedSheet?.rowCount ?? 0}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-text color="subdued">Columns detected</s-text>
                <s-heading>{availableHeaders.length}</s-heading>
              </s-stack>
            </s-box>
          </s-grid>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
            <s-select
              label="Worksheet"
              name="sheetName"
              value={sheetName}
              onChange={(event) => selectSheet(event.currentTarget.value)}
            >
              {scannedSheets.map((sheet) => (
                <s-option key={sheet.name} value={sheet.name}>{sheet.name}</s-option>
              ))}
            </s-select>
            <s-select
              label="Product matching column"
              details="Choose Product name, Product URL, or Shopify handle. Product names are matched exactly."
              name="identifierColumn"
              value={identifierColumn}
              onChange={(event) => setIdentifierColumn(event.currentTarget.value)}
            >
              {availableHeaders.map((header) => (
                <s-option key={header} value={header}>{header}</s-option>
              ))}
            </s-select>
          </s-grid>
        </s-stack>
      </s-section>
      )}

      {availableHeaders.length > 0 && (
      <s-section heading="3. Choose update types">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Update Product Title and SEO Meta Title"
            checked={updateTitles}
            onChange={(event) => setUpdateTitles(event.currentTarget.checked)}
          ></s-switch>
          <s-switch
            label="Update product image ALT text"
            checked={updateMediaAlt}
            onChange={(event) => setUpdateMediaAlt(event.currentTarget.checked)}
          ></s-switch>
        </s-stack>
      </s-section>
      )}

      {availableHeaders.length > 0 && updateTitles && (
      <s-section heading="4. Build the title format">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Add columns in the exact sequence required for the new Product Title. The same
            generated value is also used as the SEO Meta Title.
          </s-paragraph>
          {titleColumns.map((column, index) => (
            <s-box key={`${index}-${column}`} padding="base" background="subdued" borderRadius="base">
            <s-grid gridTemplateColumns="auto minmax(180px, 1fr) auto" gap="base" alignItems="center">
              <s-badge tone="info">Part {index + 1}</s-badge>
              <s-select
                label={`Title column ${index + 1}`}
                labelAccessibilityVisibility="exclusive"
                name={`titleColumn${index}`}
                value={column}
                disabled={fetcher.state !== "idle"}
                onChange={(event) => setTitleColumns((current) =>
                  current.map((value, itemIndex) => itemIndex === index ? event.currentTarget.value : value),
                )}
              >
                {availableHeaders.map((option) => (
                  <s-option key={option} value={option}>{option}</s-option>
                ))}
              </s-select>
              <s-button-group gap="base">
                <s-button type="button" variant="tertiary" disabled={index === 0 || fetcher.state !== "idle"} onClick={() => moveTitleColumn(index, -1)}>Up</s-button>
                <s-button type="button" variant="tertiary" disabled={index === titleColumns.length - 1 || fetcher.state !== "idle"} onClick={() => moveTitleColumn(index, 1)}>Down</s-button>
                <s-button type="button" variant="tertiary" tone="critical" disabled={titleColumns.length === 1 || fetcher.state !== "idle"} onClick={() => setTitleColumns((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</s-button>
              </s-button-group>
            </s-grid>
            </s-box>
          ))}
          <s-button
            type="button"
            icon="plus"
            disabled={fetcher.state !== "idle"}
            onClick={() => setTitleColumns((current) => [...current, availableHeaders[0]])}
          >
            Add column
          </s-button>
          <s-box padding="base" background="subdued" border="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">Live title preview</s-text>
              <s-stack direction="inline" gap="small">
                {titleColumns.map((column, index) => <s-chip key={`${column}-${index}`} accessibilityLabel={`Title part ${index + 1}`}>{column}</s-chip>)}
              </s-stack>
              <s-paragraph>{sampleTitle || "No sample value available in the first data row."}</s-paragraph>
              <s-text color="subdued">SEO Meta Title will use this same generated value.</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>
      )}

      {availableHeaders.length > 0 && updateMediaAlt && (
      <s-section heading="5. Map product image ALT text">
        <s-stack direction="block" gap="base">
          <s-banner heading="Product-wise image mapping" tone="info">
            Every row with a non-empty selected ALT value is eligible. ALT values map by Img #,
            and Shopify images that already have ALT text are always protected.
          </s-banner>
          <s-grid gridTemplateColumns="minmax(240px, 1fr)" gap="base">
            <s-select
              label="ALT text column"
              details="Example: PROPOSED ALT."
              name="altColumn"
              value={altColumn}
              onChange={(event) => setAltColumn(event.currentTarget.value)}
            >
              {availableHeaders.map((header) => <s-option key={header} value={header}>{header}</s-option>)}
            </s-select>
          </s-grid>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">Sample mapping</s-text>
              <s-paragraph>
                {selectedSheet?.sampleValues[availableHeaders.indexOf(identifierColumn)] || "Product URL"}
                {" → "}
                Image 1: {selectedSheet?.sampleValues[availableHeaders.indexOf(altColumn)] || "No sample ALT"}
              </s-paragraph>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>
      )}

      {availableHeaders.length > 0 && (
      <s-section heading="6. Confirm and update">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Rows are grouped using the selected matching column. Selected title and media updates
            run in timeout-safe batches.
          </s-paragraph>
          <s-stack direction="block" gap="base">
              <s-checkbox
                label={updateTitles && updateMediaAlt
                  ? "I confirm that titles and SEO titles may be overwritten; only blank image ALTs are filled."
                  : updateMediaAlt
                    ? "I confirm that only blank product image ALT text will be filled."
                    : "I confirm that Product Titles and SEO Meta Titles may be overwritten."}
                details={updateMediaAlt
                  ? "Rows with blank ALT values and images with existing ALT text are skipped."
                  : "Images, ALT text, descriptions, prices, and variants are not changed."}
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              ></s-checkbox>
              <s-button
                type="button"
                variant="primary"
                loading={fetcher.state !== "idle"}
                disabled={!fileName || !confirmed || (!updateTitles && !updateMediaAlt)}
                onClick={() => {
                  setProgress({ processed: 0, updated: 0, mediaUpdated: 0, skipped: 0, errors: [] });
                  setUndoRecords([]);
                  setRevertProgress({ processed: 0, products: 0, media: 0, errors: [] });
                  submitBatch(0);
                }}
              >
                Update selected fields
              </s-button>
          </s-stack>
          {fetcher.data?.mode === "update" && (
            <s-banner
              heading={fetcher.data.done
                ? `Processed ${progress.processed} of ${fetcher.data.total} products`
                : `Processing ${progress.processed} of ${fetcher.data.total} products`}
              tone={progress.errors.length ? "warning" : fetcher.data.done ? "success" : "info"}
            >
              <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
                <s-box padding="small"><s-text color="subdued">Processed</s-text><s-heading>{progress.processed}</s-heading></s-box>
                <s-box padding="small"><s-text color="subdued">Titles</s-text><s-heading>{progress.updated}</s-heading></s-box>
                <s-box padding="small"><s-text color="subdued">Image ALTs</s-text><s-heading>{progress.mediaUpdated}</s-heading></s-box>
                <s-box padding="small"><s-text color="subdued">Skipped</s-text><s-heading>{progress.skipped}</s-heading></s-box>
              </s-grid>
              {progress.errors.length > 0 && (
                <s-unordered-list>
                  {progress.errors.slice(0, 20).map((error, index) => (
                    <s-list-item key={`${index}-${error}`}>{error}</s-list-item>
                  ))}
                </s-unordered-list>
              )}
            </s-banner>
          )}
          {fetcher.data?.mode === "update" && fetcher.data.done && undoRecords.length > 0 && (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text type="strong">Undo this upload</s-text>
                <s-paragraph color="subdued">
                  Restore the product titles, SEO titles, and image ALT text saved immediately
                  before this upload. This option remains available until another upload starts
                  or this page is reloaded.
                </s-paragraph>
                <s-button
                  type="button"
                  tone="critical"
                  loading={revertFetcher.state !== "idle"}
                  disabled={fetcher.state !== "idle" || revertFetcher.state !== "idle"}
                  onClick={() => {
                    setRevertProgress({ processed: 0, products: 0, media: 0, errors: [] });
                    submitRevertBatch(0);
                  }}
                >
                  Revert last upload
                </s-button>
              </s-stack>
            </s-box>
          )}
          {(revertFetcher.state !== "idle" || revertProgress.processed > 0) && (
            <s-banner
              heading={`Reverted ${revertProgress.processed} of ${undoRecords.length || revertProgress.processed} products`}
              tone={revertProgress.errors.length ? "warning" : "success"}
            >
              <s-paragraph>
                Titles: {revertProgress.products} · Image ALTs: {revertProgress.media}
              </s-paragraph>
              {revertProgress.errors.length > 0 && (
                <s-unordered-list>
                  {revertProgress.errors.slice(0, 20).map((error, index) => (
                    <s-list-item key={`${index}-${error}`}>{error}</s-list-item>
                  ))}
                </s-unordered-list>
              )}
            </s-banner>
          )}
        </s-stack>
      </s-section>
      )}

      <s-section slot="aside" heading="Safe workflow">
        <s-ordered-list>
          <s-list-item>Upload and scan the workbook.</s-list-item>
          <s-list-item>Select the worksheet and product identifier.</s-list-item>
          <s-list-item>Choose title and/or product image ALT updates.</s-list-item>
          <s-list-item>Map columns and review live previews.</s-list-item>
          <s-list-item>Confirm and run timeout-safe batches.</s-list-item>
        </s-ordered-list>
      </s-section>
      <s-section slot="aside" heading="Never changed">
        <s-unordered-list>
          <s-list-item>Product image files</s-list-item>
          <s-list-item>Descriptions and variants</s-list-item>
          <s-list-item>Prices and inventory</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
