import type { LoaderFunctionArgs } from "react-router";
import { getCollectionOptionChoices } from "../collection-display.server";
import { authenticateAdmin } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticateAdmin(request);
  const collectionId = new URL(request.url).searchParams.get("collectionId");
  if (!collectionId || !collectionId.startsWith("gid://shopify/Collection/")) {
    throw new Response("Missing or invalid collectionId", { status: 400 });
  }
  return await getCollectionOptionChoices(admin, collectionId);
};
