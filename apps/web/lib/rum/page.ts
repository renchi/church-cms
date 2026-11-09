// The page id every browser signal is grouped by (CMS-30, study-guide §14).
//
// Faro sends the page URL with each error, log and Web Vitals measurement. Grouping
// by the raw URL gives one "page" per member: /members/3f2c…, /members/9a1b…, and
// so on, so "LCP by page" becomes thousands of rows. The server side solved the same
// problem with `http.route` (CMS-24): report the route template, not the path. This
// is the browser's version of it: every UUID segment becomes `:id`.
//
//   /members/3f2c8a1e-…  →  /members/:id
//   /members/new         →  /members/new   (no UUID, unchanged)
//
// Faro calls it on every route change (`pageTracking.generatePageId` in app/Rum.tsx),
// so client-side navigations are covered as well as full page loads.
//
// Only the path: the query string and fragment are dropped, because they can carry
// anything (a search box, a token), and a page id must be safe to group by.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function pageId(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || "/";
  return path.replace(UUID, ":id");
}
