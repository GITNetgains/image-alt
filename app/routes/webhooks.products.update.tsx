import type { ActionFunctionArgs } from "react-router";
import { syncProductImages } from "../image-alt.server";
import { shouldSkipProductAltSync } from "../product-alt-sync-pause.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (!admin) return new Response();

  const productId = `gid://shopify/Product/${payload.id}`;
  if (shouldSkipProductAltSync(shop, productId)) {
    console.log("Skipping product image alt sync during revert", { productId });
    return new Response();
  }
  const result = await syncProductImages(admin, productId);
  if (result.errors.length) {
    console.error("Product image alt sync errors", {
      productId,
      errors: result.errors,
    });
  }
  return new Response();
};
