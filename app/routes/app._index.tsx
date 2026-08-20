import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Dashboard() {
  return (
    <s-page heading="Image Alt dashboard" inlineSize="base">
      <s-button slot="primary-action" href="/app/additional" variant="primary">
        Manage alt text
      </s-button>

      <s-banner heading="Image alt automation is active" tone="success">
        Product images with blank alt text are automatically updated from their
        filenames. Alt text already written by a merchant stays protected.
      </s-banner>

      <s-section heading="Overview">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))"
          gap="base"
        >
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="product" tone="success"></s-icon>
                <s-badge tone="success">Active</s-badge>
              </s-stack>
              <s-text type="strong">Product images</s-text>
              <s-paragraph color="subdued">
                Automatic filename-based alt text for new product images.
              </s-paragraph>
            </s-stack>
          </s-box>

          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="file" tone="info"></s-icon>
                <s-badge tone="info">On demand</s-badge>
              </s-stack>
              <s-text type="strong">Files and blogs</s-text>
              <s-paragraph color="subdued">
                Scan blank alt text after uploading Files or blog images.
              </s-paragraph>
            </s-stack>
          </s-box>

          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="upload" tone="info"></s-icon>
                <s-badge tone="info">CSV + XLSX</s-badge>
              </s-stack>
              <s-text type="strong">Bulk import</s-text>
              <s-paragraph color="subdued">
                Match filenames and apply custom alt text from a spreadsheet.
              </s-paragraph>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Quick actions">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
          gap="base"
        >
          <s-clickable
            href="/app/additional"
            padding="base"
            background="subdued"
            borderRadius="base"
            accessibilityLabel="Scan images with blank alt text"
          >
            <s-stack direction="block" gap="small">
              <s-text type="strong">Scan blank alt text</s-text>
              <s-paragraph color="subdued">
                Fill missing descriptions without overwriting existing values.
              </s-paragraph>
              <s-text tone="info">Open automation →</s-text>
            </s-stack>
          </s-clickable>

          <s-clickable
            href="/app/additional"
            padding="base"
            background="subdued"
            borderRadius="base"
            accessibilityLabel="Import alt text spreadsheet"
          >
            <s-stack direction="block" gap="small">
              <s-text type="strong">Import spreadsheet</s-text>
              <s-paragraph color="subdued">
                Upload CSV or XLSX using image_name and alt_text columns.
              </s-paragraph>
              <s-text tone="info">Start an import →</s-text>
            </s-stack>
          </s-clickable>
        </s-grid>
      </s-section>

      <s-section heading="Recommended workflow">
        <s-grid gridTemplateColumns="auto 1fr" gap="base" alignItems="start">
          <s-badge tone="success" size="large">1</s-badge>
          <s-box paddingBlockEnd="base">
            <s-text type="strong">Upload images</s-text>
            <s-paragraph color="subdued">
              Add images to Products, Content → Files, or blog posts.
            </s-paragraph>
          </s-box>
          <s-badge tone="info" size="large">2</s-badge>
          <s-box paddingBlockEnd="base">
            <s-text type="strong">Run the appropriate workflow</s-text>
            <s-paragraph color="subdued">
              Product images run automatically. Use Scan or Import for other images.
            </s-paragraph>
          </s-box>
          <s-badge tone="info" size="large">3</s-badge>
          <s-box>
            <s-text type="strong">Review results</s-text>
            <s-paragraph color="subdued">
              Check updated, skipped, and unmatched image counts after each run.
            </s-paragraph>
          </s-box>
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Protection rules">
        <s-unordered-list>
          <s-list-item>Automatic scans only fill blank alt text.</s-list-item>
          <s-list-item>Existing merchant-written text is preserved.</s-list-item>
          <s-list-item>Imports change only filenames listed in the sheet.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Spreadsheet format">
        <s-stack direction="block" gap="small">
          <s-paragraph color="subdued">The first row must contain:</s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-chip accessibilityLabel="Image name column">image_name</s-chip>
            <s-chip accessibilityLabel="Alt text column">alt_text</s-chip>
          </s-stack>
          <s-link href="/app/additional">Go to spreadsheet import</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
