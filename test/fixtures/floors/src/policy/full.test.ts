import { expect, it } from "vitest";
import { full } from "./full.ts";

it("covers every line", () => {
  expect(full(1)).toBe(3);
});
