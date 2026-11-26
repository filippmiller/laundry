/**
 * Generations for a paged list that can be replaced while a request is still in flight.
 *
 * The dispute list is filtered in the URL, so the operator switches the filter — or presses
 * Back — while the previous page is still loading. The late answer then overwrote the rows,
 * the count and the cursor of the newer filter: the list showed «Открытые» but held the
 * resolved disputes of the «Все» filter, together with the cursor of the second «Все» page.
 *
 * A generation makes every write conditional. A fresh load — a new filter, a new endpoint or a
 * refresh — opens a new generation and closes every request that was running before it,
 * including a pending load-more. An append belongs to the generation it was started in, so it
 * dies together with that generation and can never append rows of another filter.
 *
 * The rules live in plain TypeScript without React: the panels are components and this
 * repository has no DOM test harness, so the behaviour is unit-tested here directly.
 */

export type RequestToken = {
  /** `fresh` replaces the whole list, `append` adds one page to it. */
  kind: "fresh" | "append";
  /** The generation the request belongs to. */
  generation: number;
  /** The number of the request inside its generation. */
  sequence: number;
};

export type RequestGeneration = {
  /** Opens a new generation and returns the token of the fresh request. */
  beginFresh: () => RequestToken;
  /** Returns the token of an append request inside the current generation. */
  beginAppend: () => RequestToken;
  /** True while the token may still write to the state. */
  isCurrent: (token: RequestToken) => boolean;
  /** Closes every issued token without starting a request. */
  invalidate: () => void;
};

export function createRequestGeneration(): RequestGeneration {
  let generation = 0;
  let sequence = 0;
  return {
    beginFresh: () => {
      generation += 1;
      sequence = 0;
      return { kind: "fresh", generation, sequence };
    },
    beginAppend: () => {
      sequence += 1;
      return { kind: "append", generation, sequence };
    },
    isCurrent: token => {
      if (token.generation !== generation) return false;
      // A fresh request owns the whole generation; an append owns only the last page it
      // fetched, so a second load-more supersedes the first one.
      return token.kind === "fresh" || token.sequence === sequence;
    },
    invalidate: () => {
      generation += 1;
      sequence = 0;
    },
  };
}

/** One page of a cursor-paged list as the server sends it. */
export type ListPage<T extends { id: string }> = {
  items?: T[] | null;
  nextCursor?: string | null;
  totalCount?: number | null;
};

/** Everything the panels show about the list. */
export type ListSnapshot<T extends { id: string }> = {
  items: T[] | null;
  totalCount: number | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};

export function initialListSnapshot<T extends { id: string }>(): ListSnapshot<T> {
  return {
    items: null,
    totalCount: null,
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
  };
}

/**
 * Appends the rows that are not in the list yet: the same dispute can be on two pages when
 * the list changes while the operator is reading it.
 */
export function mergeById<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const seen = new Set(previous.map(item => item.id));
  return [...previous, ...next.filter(item => !seen.has(item.id))];
}

/**
 * A fresh load starts from the first page.
 *
 * The rows, the count and the cursor of the previous filter go away: the cursor is opaque and
 * belongs to one filter only, so it must never be sent to the server for another filter.
 */
export function startFreshLoad<T extends { id: string }>(previous: ListSnapshot<T>): ListSnapshot<T> {
  return {
    ...previous,
    items: null,
    totalCount: null,
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
  };
}

/** A load-more keeps the rows and the count of the page it extends. */
export function startAppendLoad<T extends { id: string }>(previous: ListSnapshot<T>): ListSnapshot<T> {
  return { ...previous, loadingMore: true, error: null };
}

/**
 * Applies a page that arrived.
 *
 * A page of a closed generation changes nothing at all — not the rows, not the count, not the
 * cursor and not the loading flags of the request that replaced it.
 */
export function applyLoadedPage<T extends { id: string }>(
  previous: ListSnapshot<T>,
  token: RequestToken,
  generation: RequestGeneration,
  page: ListPage<T>,
): ListSnapshot<T> {
  if (!generation.isCurrent(token)) return previous;
  const rows = page.items ?? [];
  return {
    items: token.kind === "append" ? mergeById(previous.items ?? [], rows) : rows,
    totalCount: page.totalCount ?? null,
    nextCursor: page.nextCursor ?? null,
    loading: false,
    loadingMore: false,
    error: null,
  };
}

/**
 * Applies an error that arrived.
 *
 * A stale error changes nothing: it must not put a message on the screen and it must not
 * switch off the loading flag of the request that is still running.
 */
export function applyLoadError<T extends { id: string }>(
  previous: ListSnapshot<T>,
  token: RequestToken,
  generation: RequestGeneration,
  message: string,
): ListSnapshot<T> {
  if (!generation.isCurrent(token)) return previous;
  return {
    ...previous,
    items: token.kind === "append" ? previous.items : null,
    loading: false,
    loadingMore: false,
    error: message,
  };
}
