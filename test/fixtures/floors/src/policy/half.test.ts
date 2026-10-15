import { expect, it } from "vitest";
import { half } from "./half.ts";

it("leaves most lines uncovered", () => {
  expect(half(1)).toBe(1);
});
