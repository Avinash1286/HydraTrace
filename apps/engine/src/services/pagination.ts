export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAGE_OFFSET = 100_000;

export interface PageMetadata {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasPrevious: boolean;
  hasMore: boolean;
  truncated: boolean;
}

export function paginate<T>(
  values: readonly T[],
  offset: number,
  limit: number,
): { items: readonly T[]; page: PageMetadata } {
  const items = values.slice(offset, offset + limit);
  return {
    items,
    page: pageMetadata(values.length, offset, limit, items.length),
  };
}

export function pageMetadata(
  total: number,
  offset: number,
  limit: number,
  returned: number,
): PageMetadata {
  const hasPrevious = offset > 0 && total > 0;
  const hasMore = offset + returned < total;
  return {
    total,
    offset,
    limit,
    returned,
    hasPrevious,
    hasMore,
    truncated: hasPrevious || hasMore,
  };
}
