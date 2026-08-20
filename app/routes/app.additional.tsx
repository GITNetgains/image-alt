import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  importCsvAltText,
  parseAltTextCsv,
  parseAltTextXlsx,
  syncAllFileImages,
  syncArticleImages,
} from "../image-alt.server";
import { authenticateAdmin } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticateAdmin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "csv-import") {
    const spreadsheet = formData.get("spreadsheet");
    if (!(spreadsheet instanceof File) || !spreadsheet.size) {
      return { scanned: 0, updated: 0, skipped: 0, errors: ["Please select a CSV or XLSX file"] };
    }
    try {
      const extension = spreadsheet.name.toLowerCase().split(".").pop();
      if (extension !== "csv" && extension !== "xlsx") {
        throw new Error("Only .csv and .xlsx files are supported");
      }
      const rows = extension === "xlsx"
        ? await parseAltTextXlsx(await spreadsheet.arrayBuffer())
        : parseAltTextCsv(await spreadsheet.text());
      return await importCsvAltText(admin, rows);
    } catch (error) {
      return { scanned: 0, updated: 0, skipped: 0, errors: [getErrorMessage(error, "CSV import failed")] };
    }
  }

  const [filesResult, articlesResult] = await Promise.allSettled([
    syncAllFileImages(admin),
    syncArticleImages(admin),
  ]);
  const files =
    filesResult.status === "fulfilled"
      ? filesResult.value
      : { scanned: 0, updated: 0, skipped: 0, errors: [`Files scan: ${getErrorMessage(filesResult.reason, "Sync failed")}`] };
  const articles =
    articlesResult.status === "fulfilled"
      ? articlesResult.value
      : { scanned: 0, updated: 0, skipped: 0, errors: [`Blog scan: ${getErrorMessage(articlesResult.reason, "Temporarily unavailable")}`] };

  return {
    scanned: files.scanned + articles.scanned,
    updated: files.updated + articles.updated,
    skipped: files.skipped + articles.skipped,
    errors: [...files.errors, ...articles.errors],
  };
};

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function ImageAltPage() {
  const syncFetcher = useFetcher<typeof action>();
  const importFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const spreadsheetInput = useRef<HTMLInputElement>(null);
  const [spreadsheetName, setSpreadsheetName] = useState("");

  useEffect(() => {
    if (!syncFetcher.data) return;
    shopify.toast.show(
      syncFetcher.data.errors.length
        ? `Updated ${syncFetcher.data.updated} images with ${syncFetcher.data.errors.length} errors`
        : `Updated ${syncFetcher.data.updated} image alt texts`,
    );
  }, [syncFetcher.data, shopify]);

  useEffect(() => {
    if (!importFetcher.data) return;
    shopify.toast.show(
      importFetcher.data.errors.length
        ? `Imported ${importFetcher.data.updated} images with ${importFetcher.data.errors.length} errors`
        : `Imported alt text for ${importFetcher.data.updated} images`,
    );
  }, [importFetcher.data, shopify]);

  return (
    <s-page heading="Alt Text Manager" inlineSize="base">
      <s-banner heading="Your image SEO assistant" tone="info">
        Automatically keep image accessibility text complete without changing
        descriptions that merchants have already written.
      </s-banner>

      <s-section heading="Automation overview">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
          gap="base"
        >
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-badge tone="success" icon="check-circle">Active</s-badge>
              <s-text type="strong">Product automation</s-text>
              <s-paragraph color="subdued">
                New product images receive alt text from their filename.
              </s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-badge tone="success" icon="lock">Protected</s-badge>
              <s-text type="strong">Existing alt text</s-text>
              <s-paragraph color="subdued">
                Automatic sync only updates images where alt text is blank.
              </s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-badge tone="info" icon="upload">CSV + XLSX</s-badge>
              <s-text type="strong">Bulk import</s-text>
              <s-paragraph color="subdued">
                Apply custom descriptions by matching Shopify filenames.
              </s-paragraph>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Fill missing alt text">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Scan Files and blog images after an upload. Shopify does not provide
            upload webhooks for these areas, so this scan runs on demand.
          </s-paragraph>
          <syncFetcher.Form method="post">
            <input type="hidden" name="intent" value="auto-sync" />
            <s-button
              type="submit"
              variant="primary"
              icon="refresh"
              loading={syncFetcher.state !== "idle"}
            >
              Scan blank alt text
            </s-button>
          </syncFetcher.Form>
          {syncFetcher.data && <ResultSummary result={syncFetcher.data} />}
        </s-stack>
      </s-section>

      <s-section heading="Import custom alt text">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Upload a CSV or Excel file. Use image_name and alt_text as the first
            row. The filename extension is optional.
          </s-paragraph>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="info" tone="info"></s-icon>
                <s-text type="strong">Spreadsheet format</s-text>
              </s-stack>
              <s-grid gridTemplateColumns="1fr 1fr" gap="small">
                <s-box padding="small" background="base" borderRadius="base">
                  <s-text type="strong">image_name</s-text>
                  <s-paragraph color="subdued">Image-Alt-logo-1200.png</s-paragraph>
                </s-box>
                <s-box padding="small" background="base" borderRadius="base">
                  <s-text type="strong">alt_text</s-text>
                  <s-paragraph color="subdued">Image Alt company logo</s-paragraph>
                </s-box>
              </s-grid>
            </s-stack>
          </s-box>
          <importFetcher.Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="csv-import" />
            <s-stack direction="block" gap="base">
              <s-box
                padding="large"
                background="subdued"
                border="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base" alignItems="center">
                  <s-icon type="upload" tone="info" size="base"></s-icon>
                  <s-stack direction="block" gap="small" alignItems="center">
                    <s-text type="strong">Upload your spreadsheet</s-text>
                    <s-paragraph color="subdued">
                      Select a CSV or XLSX file containing image names and alt text.
                    </s-paragraph>
                  </s-stack>
                  <input
                    ref={spreadsheetInput}
                    type="file"
                    name="spreadsheet"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={importFetcher.state !== "idle"}
                    onChange={(event) =>
                      setSpreadsheetName(event.currentTarget.files?.[0]?.name ?? "")
                    }
                    required
                    style={{ display: "none" }}
                  />
                  <s-button
                    type="button"
                    variant="secondary"
                    icon="plus"
                    disabled={importFetcher.state !== "idle"}
                    onClick={() => spreadsheetInput.current?.click()}
                  >
                    Select spreadsheet
                  </s-button>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone="info">CSV</s-badge>
                    <s-badge tone="info">XLSX</s-badge>
                    <s-text color="subdued">Maximum one file per import</s-text>
                  </s-stack>
                  {spreadsheetName && (
                    <s-box padding="small" background="base" borderRadius="base">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-icon type="file" tone="success"></s-icon>
                        <s-text type="strong">{spreadsheetName}</s-text>
                        <s-badge tone="success">Ready</s-badge>
                      </s-stack>
                    </s-box>
                  )}
                </s-stack>
              </s-box>
              <s-button
                type="submit"
                variant="primary"
                icon="upload"
                loading={importFetcher.state !== "idle"}
                disabled={!spreadsheetName}
              >
                Import alt text
              </s-button>
            </s-stack>
          </importFetcher.Form>
          {importFetcher.data && <ResultSummary result={importFetcher.data} />}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>Upload images to Shopify.</s-list-item>
          <s-list-item>Run a blank-alt scan or upload a spreadsheet.</s-list-item>
          <s-list-item>Review the result summary and unmatched names.</s-list-item>
        </s-ordered-list>
      </s-section>
      <s-section slot="aside" heading="Safe by default">
        <s-paragraph color="subdued">
          Automatic scans never overwrite existing alt text. Spreadsheet imports
          only change filenames explicitly included in your file.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function ResultSummary({
  result,
}: {
  result: { scanned: number; updated: number; skipped: number; errors: string[] };
}) {
  return (
    <s-banner
      heading={`Updated ${result.updated} of ${result.scanned} rows`}
      tone={result.errors.length ? "warning" : "success"}
    >
      <s-paragraph>
        Skipped: {result.skipped} · Errors: {result.errors.length}
      </s-paragraph>
      {result.errors.length > 0 && (
        <s-unordered-list>
          {result.errors.slice(0, 10).map((error, index) => (
            <s-list-item key={`${index}-${error}`}>{error}</s-list-item>
          ))}
        </s-unordered-list>
      )}
    </s-banner>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
