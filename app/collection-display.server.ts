const SETTINGS_NAMESPACE = "custom";
const SETTINGS_KEY = "preferred_variant_display";
const LEGACY_COLOR_KEY = "preferred_collection_colors";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type MatchBy = "color" | "sku";

export type CollectionDisplaySetting = {
  id: string;
  title: string;
  handle: string;
  matchBy: MatchBy;
  values: string[];
};

type CollectionNode = {
  id: string;
  title: string;
  handle: string;
  setting: { value: string } | null;
  legacyColors: { value: string } | null;
};

function parseValues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSetting(node: CollectionNode): CollectionDisplaySetting | null {
  if (node.setting?.value) {
    try {
      const parsed = JSON.parse(node.setting.value) as { matchBy?: unknown; values?: unknown };
      const values = parseValues(parsed.values);
      if (values.length) {
        return {
          id: node.id,
          title: node.title,
          handle: node.handle,
          matchBy: parsed.matchBy === "sku" ? "sku" : "color",
          values,
        };
      }
    } catch {
      // Fall through to the legacy color metafield.
    }
  }

  if (!node.legacyColors?.value) return null;
  try {
    const values = parseValues(JSON.parse(node.legacyColors.value));
    return values.length
      ? { id: node.id, title: node.title, handle: node.handle, matchBy: "color", values }
      : null;
  } catch {
    return null;
  }
}

export async function getCollectionDisplaySettings(admin: AdminClient) {
  const configured: CollectionDisplaySetting[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query CollectionDisplaySettings($after: String) {
          collections(first: 250, after: $after, sortKey: TITLE) {
            nodes {
              id
              title
              handle
              setting: metafield(namespace: "custom", key: "preferred_variant_display") { value }
              legacyColors: metafield(namespace: "custom", key: "preferred_collection_colors") { value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { variables: { after: cursor } },
    );
    const payload = await response.json() as {
      data?: { collections?: { nodes: CollectionNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: { message: string }[];
    };
    if (payload.errors?.length || !payload.data?.collections) {
      throw new Error(payload.errors?.map((error) => error.message).join(", ") || "Could not load collections");
    }
    configured.push(...payload.data.collections.nodes.flatMap((node) => {
      const setting = parseSetting(node);
      return setting ? [setting] : [];
    }));
    hasNextPage = payload.data.collections.pageInfo.hasNextPage;
    cursor = payload.data.collections.pageInfo.endCursor;
  }

  return configured;
}

async function runMutation(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown>,
  resultKey: "metafieldsSet" | "metafieldsDelete",
) {
  const response = await admin.graphql(query, { variables });
  const payload = await response.json() as {
    data?: Record<string, { userErrors?: { field?: string[]; message: string }[] }>;
    errors?: { message: string }[];
  };
  const errors = [
    ...(payload.errors?.map((error) => error.message) ?? []),
    ...(payload.data?.[resultKey]?.userErrors?.map((error) => error.message) ?? []),
  ];
  if (errors.length) throw new Error(errors.join(", "));
}

export async function saveCollectionDisplaySettings(
  admin: AdminClient,
  settings: CollectionDisplaySetting[],
  removedIds: string[],
) {
  const metafields = settings.flatMap((setting) => {
    const common = {
      ownerId: setting.id,
      namespace: SETTINGS_NAMESPACE,
    };
    const fields: Record<string, unknown>[] = [{
      ...common,
      key: SETTINGS_KEY,
      type: "json",
      value: JSON.stringify({ matchBy: setting.matchBy, values: setting.values }),
    }];
    if (setting.matchBy === "color") {
      fields.push({
        ...common,
        key: LEGACY_COLOR_KEY,
        type: "list.single_line_text_field",
        value: JSON.stringify(setting.values),
      });
    }
    return fields;
  });

  for (let index = 0; index < metafields.length; index += 25) {
    await runMutation(
      admin,
      `#graphql
        mutation SaveCollectionDisplaySettings($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id key }
            userErrors { field message code }
          }
        }`,
      { metafields: metafields.slice(index, index + 25) },
      "metafieldsSet",
    );
  }

  const skuIds = settings.filter((setting) => setting.matchBy === "sku").map((setting) => setting.id);
  const deleteIds = [...new Set([...removedIds, ...skuIds])];
  const identifiers = deleteIds.flatMap((ownerId) => [
    { ownerId, namespace: SETTINGS_NAMESPACE, key: LEGACY_COLOR_KEY },
    ...(removedIds.includes(ownerId)
      ? [{ ownerId, namespace: SETTINGS_NAMESPACE, key: SETTINGS_KEY }]
      : []),
  ]);

  for (let index = 0; index < identifiers.length; index += 25) {
    await runMutation(
      admin,
      `#graphql
        mutation DeleteCollectionDisplaySettings($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { ownerId namespace key }
            userErrors { field message }
          }
        }`,
      { metafields: identifiers.slice(index, index + 25) },
      "metafieldsDelete",
    );
  }
}
