import type { CinemaCard, CatalogGist } from '@/types/schema';

const CATALOG_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Validate and normalize the untrusted JSON received from the catalog Gist.
 * The ingestion workflow is trusted to produce this shape, but the browser
 * must not let malformed remote data reach rendering or playback code.
 */
export function validateCatalogPayload(value: unknown): CatalogGist {
  if (!isRecord(value)) {
    throw new Error('[CatalogValidation] Catalog payload must be an object.');
  }

  if (value.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `[CatalogValidation] Unsupported schema version: ${String(
        value.schemaVersion
      )}. Expected ${CATALOG_SCHEMA_VERSION}.`
    );
  }

  if (
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt))
  ) {
    throw new Error('[CatalogValidation] generatedAt must be a valid ISO date.');
  }

  if (!Array.isArray(value.catalog) || value.catalog.length === 0) {
    throw new Error('[CatalogValidation] catalog must contain at least one item.');
  }

  if (
    typeof value.totalItems !== 'number' ||
    !Number.isSafeInteger(value.totalItems) ||
    value.totalItems !== value.catalog.length
  ) {
    throw new Error(
      '[CatalogValidation] totalItems must equal the number of catalog entries.'
    );
  }

  const seenIds = new Set<string>();
  const catalog: CinemaCard[] = [];
  for (const [index, entry] of value.catalog.entries()) {
    if (!isCinemaCard(entry)) {
      throw new Error(
        `[CatalogValidation] catalog[${index}] does not match the CinemaCard schema.`
      );
    }
    if (seenIds.has(entry.id)) {
      throw new Error(
        `[CatalogValidation] catalog contains duplicate id "${entry.id}".`
      );
    }
    seenIds.add(entry.id);
    catalog.push(entry);
  }

  return {
    generatedAt: value.generatedAt,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    totalItems: catalog.length,
    catalog,
  };
}

function isCinemaCard(value: unknown): value is CinemaCard {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    typeof value.description === 'string' &&
    isHttpUrl(value.posterUrl) &&
    isHttpUrl(value.streamUrl) &&
    (value.streamType === 'mp4' || value.streamType === 'hls') &&
    (value.duration === undefined ||
      (typeof value.duration === 'number' &&
        Number.isFinite(value.duration) &&
        value.duration >= 0)) &&
    isRecord(value.metadata) &&
    (value.metadata.year === undefined ||
      (typeof value.metadata.year === 'string' && value.metadata.year.length <= 16)) &&
    (value.metadata.director === undefined ||
      typeof value.metadata.director === 'string')
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
