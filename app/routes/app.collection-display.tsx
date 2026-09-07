import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getCollectionDisplaySettings,
  saveCollectionDisplaySettings,
} from "../collection-display.server";
import type { CollectionDisplaySetting, MatchBy } from "../collection-display.server";
import { authenticateAdmin } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticateAdmin(request);
  return { settings: await getCollectionDisplaySettings(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticateAdmin(request);
  try {
    const formData = await request.formData();
    const parsedSettings = JSON.parse(String(formData.get("settings") ?? "[]"));
    const parsedRemovedIds = JSON.parse(String(formData.get("removedIds") ?? "[]"));
    if (!Array.isArray(parsedSettings) || !Array.isArray(parsedRemovedIds)) {
      throw new Error("Invalid collection settings");
    }

    const settings: CollectionDisplaySetting[] = parsedSettings.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Invalid collection setting");
      const candidate = item as Record<string, unknown>;
      const values = Array.isArray(candidate.values)
        ? candidate.values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
        : [];
      if (
        typeof candidate.id !== "string" || !candidate.id.startsWith("gid://shopify/Collection/") ||
        typeof candidate.title !== "string" || typeof candidate.handle !== "string" ||
        (candidate.matchBy !== "color" && candidate.matchBy !== "sku") || !values.length
      ) {
        throw new Error("Every collection needs at least one valid Color or SKU value");
      }
      return {
        id: candidate.id,
        title: candidate.title,
        handle: candidate.handle,
        matchBy: candidate.matchBy,
        values,
      };
    });
    const removedIds = parsedRemovedIds.filter(
      (id): id is string => typeof id === "string" && id.startsWith("gid://shopify/Collection/"),
    );
    await saveCollectionDisplaySettings(admin, settings, removedIds);
    return { ok: true as const, saved: settings.length, error: "" };
  } catch (error) {
    return { ok: false as const, saved: 0, error: error instanceof Error ? error.message : "Settings could not be saved" };
  }
};

type PickedCollection = { id: string; title: string; handle?: string };

function normalizeLines(value: string) {
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

export default function CollectionDisplayPage() {
  const { settings: initialSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [settings, setSettings] = useState<CollectionDisplaySetting[]>(initialSettings);
  const initialIds = useMemo(() => initialSettings.map((setting) => setting.id), [initialSettings]);

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.ok
      ? `Saved display order for ${fetcher.data.saved} collections`
      : fetcher.data.error);
  }, [fetcher.data, shopify]);

  const chooseCollections = async () => {
    const picked = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: settings.map((setting) => ({ id: setting.id })),
    }) as PickedCollection[] | undefined;
    if (!picked) return;
    setSettings((current) => picked.map((collection) => current.find((item) => item.id === collection.id) ?? ({
      id: collection.id,
      title: collection.title,
      handle: collection.handle ?? "",
      matchBy: "color" as const,
      values: [],
    })));
  };

  const updateSetting = (id: string, patch: Partial<CollectionDisplaySetting>) => {
    setSettings((current) => current.map((setting) => setting.id === id ? { ...setting, ...patch } : setting));
  };

  const save = () => {
    const formData = new FormData();
    formData.set("settings", JSON.stringify(settings));
    formData.set("removedIds", JSON.stringify(initialIds.filter((id) => !settings.some((setting) => setting.id === id))));
    fetcher.submit(formData, { method: "post" });
  };

  const hasEmptyValues = settings.some((setting) => !setting.values.length);

  return (
    <s-page heading="Collection display settings" inlineSize="base">
      <s-button slot="primary-action" variant="primary" onClick={save} loading={fetcher.state !== "idle"} disabled={hasEmptyValues}>
        Save settings
      </s-button>

      <s-banner heading="Set the first variant shown on collection cards" tone="info">
        Add any number of collections, choose Color or SKU, then enter preferred values in priority order. The first matching variant is shown; products without a match keep their normal featured image.
      </s-banner>

      <s-section heading="Collections">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button type="button" variant="secondary" icon="plus" onClick={chooseCollections}>
              Choose collections
            </s-button>
            <s-badge tone={settings.length ? "info" : "neutral"}>{settings.length} selected</s-badge>
          </s-stack>

          {!settings.length && (
            <s-box padding="large" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small" alignItems="center">
                <s-icon type="collection" tone="info"></s-icon>
                <s-text type="strong">No collections configured</s-text>
                <s-paragraph color="subdued">Choose collections to create their preferred variant order.</s-paragraph>
              </s-stack>
            </s-box>
          )}

          {settings.map((setting) => (
            <s-box key={setting.id} padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                  <s-stack direction="block" gap="small">
                    <s-text type="strong">{setting.title}</s-text>
                    <s-text color="subdued">/{setting.handle}</s-text>
                  </s-stack>
                  <s-button
                    type="button"
                    variant="tertiary"
                    tone="critical"
                    onClick={() => setSettings((current) => current.filter((item) => item.id !== setting.id))}
                  >
                    Remove
                  </s-button>
                </s-grid>
                <s-grid gridTemplateColumns="minmax(180px, 0.35fr) minmax(260px, 1fr)" gap="base" alignItems="start">
                  <s-select
                    label="Match variant by"
                    name={`match-${setting.id}`}
                    value={setting.matchBy}
                    onChange={(event) => updateSetting(setting.id, { matchBy: event.currentTarget.value as MatchBy })}
                  >
                    <s-option value="color">Color</s-option>
                    <s-option value="sku">SKU</s-option>
                  </s-select>
                  <s-text-area
                    label={setting.matchBy === "color" ? "Preferred colors" : "Preferred SKUs"}
                    details="Enter one value per line, in priority order. The first line has highest priority."
                    name={`values-${setting.id}`}
                    rows={3}
                    value={setting.values.join("\n")}
                    placeholder={setting.matchBy === "color" ? "Elevated II\nCover" : "SKU-PRIMARY\nSKU-FALLBACK"}
                    onChange={(event) => updateSetting(setting.id, { values: normalizeLines(event.currentTarget.value) })}
                  ></s-text-area>
                </s-grid>
              </s-stack>
            </s-box>
          ))}

          {hasEmptyValues && (
            <s-banner heading="Preferred value required" tone="warning">
              Add at least one Color or SKU value to every selected collection before saving.
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Priority example">
        <s-ordered-list>
          <s-list-item>Elevated II</s-list-item>
          <s-list-item>Cover</s-list-item>
        </s-ordered-list>
        <s-paragraph color="subdued">Elevated II is tried first, then Cover, then the product&apos;s normal featured image.</s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Theme compatibility">
        <s-paragraph color="subdued">Color mode also updates the existing preferred_collection_colors metafield used by your tested theme code. SKU mode is stored separately for theme code that supports SKU matching.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
