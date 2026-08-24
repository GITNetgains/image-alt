const pausedProducts = new Map<string, number>();

const pauseKey = (shop: string, productId: string) => `${shop}:${productId}`;

export function pauseProductAltSync(shop: string, productId: string, durationMs = 120_000) {
  pausedProducts.set(pauseKey(shop, productId), Date.now() + durationMs);
}

export function shouldSkipProductAltSync(shop: string, productId: string) {
  const key = pauseKey(shop, productId);
  const pausedUntil = pausedProducts.get(key) ?? 0;
  if (pausedUntil <= Date.now()) {
    pausedProducts.delete(key);
    return false;
  }
  return true;
}
