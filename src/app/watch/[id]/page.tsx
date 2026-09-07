import WatchPageClient from './WatchPageClient';
import { SEED_REEL } from '@/lib/data/seedReel';
import { validateCatalogPayload } from '@/lib/catalog/validateCatalog';

/**
 * A static export cannot render an unknown dynamic path at request time.
 * Generate pages for the bundled reel and, when configured, every validated
 * catalog identifier present in the build-time Gist.
 */
export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  const ids = new Set(SEED_REEL.map((card) => card.tmdbId));
  const catalogUrl = process.env.NEXT_PUBLIC_GIST_CATALOG_URL?.trim();

  if (!catalogUrl) {
    return Array.from(ids, (id) => ({ id }));
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(catalogUrl);
  } catch (error) {
    console.warn(
      '[watch] NEXT_PUBLIC_GIST_CATALOG_URL is not a valid URL; exporting bundled watch pages only.',
      error
    );
    return Array.from(ids, (id) => ({ id }));
  }

  let response: Response;
  try {
    response = await fetch(parsedUrl, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    console.warn(
      '[watch] Could not fetch the build-time catalog; exporting bundled watch pages only.',
      error
    );
    return Array.from(ids, (id) => ({ id }));
  }

  if (!response.ok) {
    console.warn(
      `[watch] Build-time catalog request returned ${response.status} ${response.statusText}; exporting bundled watch pages only.`
    );
    return Array.from(ids, (id) => ({ id }));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(
      '[watch] Build-time catalog response was not valid JSON; exporting bundled watch pages only.',
      error
    );
    return Array.from(ids, (id) => ({ id }));
  }

  try {
    const catalog = validateCatalogPayload(payload);
    for (const entry of catalog.catalog) {
      ids.add(entry.id);
    }
  } catch (error) {
    console.warn(
      '[watch] Build-time catalog failed validation; exporting bundled watch pages only.',
      error
    );
  }

  return Array.from(ids, (id) => ({ id }));
}

/**
 * Static export has no runtime fallback for paths that were not generated.
 * Keeping this explicit prevents Next from implying server-side dynamic
 * rendering is available on the CDN.
 */
export const dynamicParams = false;

export default function WatchRoute() {
  return <WatchPageClient />;
}
