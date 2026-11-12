/**
 * Paginated query utilities
 *
 * Convex has a 16MB read limit per function execution.
 * These utilities help avoid hitting that limit with bounded reads.
 *
 * IMPORTANT:
 * - Only ONE paginate() call is allowed per function
 * - paginatedCollect() performs a bounded take
 * - Use take() when you only need a fixed number of results
 */

/**
 * Default page size for pagination
 * Smaller values = more API calls but safer
 * Larger values = fewer API calls but higher memory usage
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Maximum items to collect to prevent runaway queries
 */
export const MAX_COLLECT_LIMIT = 10000;

/**
 * Collect up to a fixed maximum without reading the rest of the query
 * Replaces .collect() when a bounded result set is sufficient
 *
 * Prefer a direct .take(n) or .first() when the limit is local to one caller.
 *
 * @param query - The query builder (after .query().withIndex() etc.)
 * @param options - Pagination options
 * @returns All collected results
 *
 * @example
 * // Instead of:
 * const results = await ctx.db.query("table").withIndex(...).collect();
 *
 * // Use:
 * const results = await paginatedCollect(
 *   ctx.db.query("table").withIndex(...)
 * );
 */
export async function paginatedCollect<T>(
  query: {
    take: (limit: number) => Promise<T[]>;
  },
  options?: {
    maxItems?: number;
  },
): Promise<T[]> {
  const requestedMaxItems = options?.maxItems ?? MAX_COLLECT_LIMIT;
  const maxItems = Number.isFinite(requestedMaxItems)
    ? Math.min(MAX_COLLECT_LIMIT, Math.max(0, Math.floor(requestedMaxItems)))
    : MAX_COLLECT_LIMIT;

  return maxItems === 0 ? [] : await query.take(maxItems);
}

/**
 * Type-safe wrapper for paginated queries
 * Use this in functions that need to return paginated results
 */
export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Execute a paginated query and return results with cursor
 */
export async function paginatedQuery<T>(
  query: {
    paginate: (opts: { numItems: number; cursor: string | null }) => Promise<{
      page: T[];
      isDone: boolean;
      continueCursor: string;
    }>;
  },
  options: {
    pageSize?: number;
    cursor?: string | null;
  },
): Promise<PaginatedResult<T>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const cursor = options.cursor ?? null;

  const page = await query.paginate({
    numItems: pageSize,
    cursor: cursor as never,
  });

  return {
    items: page.page,
    cursor: page.isDone ? null : page.continueCursor,
    hasMore: !page.isDone,
  };
}
