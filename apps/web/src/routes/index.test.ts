import { expect, it } from "vitest";
import { indexRoute } from "./index";

const validate = (search: Record<string, unknown>) => {
  const check = indexRoute.options.validateSearch;
  if (typeof check !== "function") throw new Error("no validateSearch");
  return check(search);
};

it("drops an empty trust list from a crafted address, so Home never sends an empty filter", () => {
  expect(validate({ trust: [] })).toMatchObject({ trust: undefined });
  expect(validate({ trust: [1, null] })).toMatchObject({ trust: undefined });
  expect(validate({ trust: ["draft", 2] })).toMatchObject({ trust: ["draft"] });
});
