import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getCollectionDisplaySettings,
  saveCollectionDisplaySettings,
} from "../collection-display.server";
import type { CollectionDisplaySetting, CollectionOptionChoices } from "../collection-display.server";
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
        typeof candidate.optionName !== "string" || !candidate.optionName.trim() || !values.length
      ) {
        throw new Error("Every collection needs an option and at least one preferred value");
      }
      return {
        id: candidate.id,
        title: candidate.title,
        handle: candidate.handle,
        optionName: candidate.optionName.trim(),
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

function CollectionSettingCard({
  setting,
  onUpdate,
  onRemove,
}: {
  setting: CollectionDisplaySetting;
  onUpdate: (patch: Partial<CollectionDisplaySetting>) => void;
  onRemove: () => void;
}) {
  const optionsFetcher = useFetcher<CollectionOptionChoices>();

  useEffect(() => {
    if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
      optionsFetcher.load(`/app/collection-display/options?collectionId=${encodeURIComponent(setting.id)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setting.id]);

  const optionNames = optionsFetcher.data?.optionNames ?? [];
  const isLoading = optionsFetcher.state !== "idle";

  useEffect(() => {
    if (optionNames.length && !optionNames.includes(setting.optionName)) {
      onUpdate({ optionName: optionNames[0], values: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionNames.join("|")]);

  const availableValues = (optionsFetcher.data?.valuesByOption[setting.optionName] ?? [])
    .filter((value) => !setting.values.includes(value));

  const removeValue = (value: string) => {
    onUpdate({ values: setting.values.filter((item) => item !== value) });
  };

  const moveValue = (index: number, direction: -1 | 1) => {
    const next = [...setting.values];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onUpdate({ values: next });
  };

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack direction="block" gap="small">
            <s-text type="strong">{setting.title}</s-text>
            <s-text color="subdued">/{setting.handle}</s-text>
          </s-stack>
          <s-button type="button" variant="tertiary" tone="critical" onClick={onRemove}>
            Remove
          </s-button>
        </s-grid>

        <s-grid gridTemplateColumns="minmax(180px, 0.35fr) minmax(260px, 1fr)" gap="base" alignItems="start">
          <s-select
            label="Option"
            disabled={isLoading || !optionNames.length}
            value={setting.optionName}
            onChange={(event) => onUpdate({ optionName: event.currentTarget.value, values: [] })}
          >
            {optionNames.length ? (
              optionNames.map((name) => <s-option key={name} value={name}>{name}</s-option>)
            ) : (
              <s-option value={setting.optionName}>{isLoading ? "Loading…" : setting.optionName}</s-option>
            )}
          </s-select>

          <s-stack direction="block" gap="small">
            <s-select
              label="Add a preferred value"
              disabled={isLoading || !availableValues.length}
              value=""
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value) onUpdate({ values: [...setting.values, value] });
              }}
            >
              <s-option value="">
                {isLoading ? "Loading values…" : (availableValues.length ? "Choose a value" : "No more values")}
              </s-option>
              {availableValues.map((value) => (
                <s-option key={value} value={value}>{value}</s-option>
              ))}
            </s-select>

            {setting.values.length > 0 && (
              <s-stack direction="block" gap="small-200">
                {setting.values.map((value, index) => (
                  <s-box key={value} padding="small-300" background="subdued" borderRadius="base">
                    <s-grid gridTemplateColumns="auto 1fr auto auto auto" gap="small" alignItems="center">
                      <s-badge>{index + 1}</s-badge>
                      <s-text>{value}</s-text>
                      <s-button
                        type="button"
                        variant="tertiary"
                        icon="chevron-up"
                        accessibilityLabel={`Move ${value} up`}
                        disabled={index === 0}
                        onClick={() => moveValue(index, -1)}
                      ></s-button>
                      <s-button
                        type="button"
                        variant="tertiary"
                        icon="chevron-down"
                        accessibilityLabel={`Move ${value} down`}
                        disabled={index === setting.values.length - 1}
                        onClick={() => moveValue(index, 1)}
                      ></s-button>
                      <s-button
                        type="button"
                        variant="tertiary"
                        tone="critical"
                        icon="x"
                        accessibilityLabel={`Remove ${value}`}
                        onClick={() => removeValue(value)}
                      ></s-button>
                    </s-grid>
                  </s-box>
                ))}
              </s-stack>
            )}
            <s-text color="subdued">First value has highest priority.</s-text>
          </s-stack>
        </s-grid>
      </s-stack>
    </s-box>
  );
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
      optionName: "Color",
      values: [],
    })));
  };

  const updateSetting = (id: string, patch: Partial<CollectionDisplaySetting>) => {
    setSettings((current) => current.map((setting) => setting.id === id ? { ...setting, ...patch } : setting));
  };

  const removeSetting = (id: string) => {
    setSettings((current) => current.filter((item) => item.id !== id));
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
        Add any number of collections, pick which option to match (e.g. Color), then choose preferred values in
        priority order from the store&apos;s actual product data — nothing to type by hand. The first matching
        variant is shown; products without a match keep their normal featured image.
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
            <CollectionSettingCard
              key={setting.id}
              setting={setting}
              onUpdate={(patch) => updateSetting(setting.id, patch)}
              onRemove={() => removeSetting(setting.id)}
            />
          ))}

          {hasEmptyValues && (
            <s-banner heading="Preferred value required" tone="warning">
              Add at least one value to every selected collection before saving.
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
        <s-paragraph color="subdued">
          Values are pulled live from the products already in each collection. Saving also updates the existing
          preferred_collection_colors metafield used by your tested theme code.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
