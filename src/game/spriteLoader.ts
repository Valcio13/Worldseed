const cache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadSprite(source: string): Promise<HTMLImageElement | null> {
  const cached = cache.get(source);
  if (cached) return cached;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof window === 'undefined' || typeof window.Image === 'undefined') {
      resolve(null);
      return;
    }
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
  cache.set(source, promise);
  return promise;
}

export async function loadSprites(
  paths: Record<string, string>,
): Promise<Map<string, HTMLImageElement>> {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, source]) => {
      const image = await loadSprite(source);
      return image ? ([key, image] as const) : null;
    }),
  );
  return new Map(
    entries.filter((entry): entry is readonly [string, HTMLImageElement] => entry !== null),
  );
}
