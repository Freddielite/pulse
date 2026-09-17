import { useEffect, useState } from "react";

// For lists the backend already bounds to a fixed max (incidents at 50,
// CSP violations and CT certificates at 200, and so on) but that are
// still routinely long enough that rendering all of them at once makes
// a monitor's detail page an endless scroll. This slices client-side
// rather than adding real offset-based pagination to each endpoint -
// the data's already been fetched and is already capped, so there's
// nothing to save by re-fetching in pages, just a rendering choice.
//
// Resets to the first page whenever the underlying list changes size
// (a fresh fetch after switching monitors, a new item arriving) rather
// than preserving whatever page you'd scrolled to for a completely
// different dataset - that only matters when the length actually
// changes, not on every render of the same list.
export function usePagedList(items, pageSize = 10) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const list = items || [];

  useEffect(() => {
    setVisibleCount(pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  return {
    visible: list.slice(0, visibleCount),
    hasMore: list.length > visibleCount,
    remaining: list.length - visibleCount,
    showMore: () => setVisibleCount((c) => c + pageSize),
    total: list.length,
  };
}
