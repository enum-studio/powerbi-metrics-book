import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Breakable } from "./breakable";

describe("Breakable", () => {
  it("lets a name break after each underscore and dot, and nowhere else", () => {
    expect(
      renderToStaticMarkup(<Breakable text="fct_order.split ratio" />),
    ).toBe("fct_<wbr/>order.<wbr/>split ratio");
  });

  it("leaves a name with neither as it is", () => {
    expect(renderToStaticMarkup(<Breakable text="Orders" />)).toBe("Orders");
  });
});
