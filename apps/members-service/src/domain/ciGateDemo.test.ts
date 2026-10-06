import { describe, expect, it } from "vitest";

// TEMP (CMS-16): deliberately failing test to prove a red check blocks the merge.
describe("CI gate demo", () => {
  it("fails on purpose", () => {
    expect(1 + 1).toBe(3);
  });
});
