import { describe, expect, it } from "vitest";
import { pageId } from "./page";

describe("pageId", () => {
  it("replaces a member id with :id, like the server's http.route", () => {
    expect(pageId("/members/3f2c8a1e-5b7d-4c1e-9a0b-1234567890ab")).toBe("/members/:id");
  });

  it("leaves paths without an id unchanged", () => {
    expect(pageId("/members")).toBe("/members");
    expect(pageId("/members/new")).toBe("/members/new");
    expect(pageId("/")).toBe("/");
  });

  it("replaces every id, whatever its case", () => {
    expect(
      pageId("/events/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE/attendance/3f2c8a1e-5b7d-4c1e-9a0b-1234567890ab")
    ).toBe("/events/:id/attendance/:id");
  });

  it("drops the query string and fragment, which can carry anything", () => {
    expect(pageId("/members/new?rum-test-error=1")).toBe("/members/new");
    expect(pageId("/members?q=jane#top")).toBe("/members");
    expect(pageId("")).toBe("/");
  });
});
