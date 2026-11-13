import { describe, expect, it } from "vitest";
import { embeddingFor } from "./vector.js";

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, at) => sum + value * (b[at] ?? 0), 0);
const similarity = (a: string, b: string) =>
  cosine(embeddingFor(a, 256), embeddingFor(b, 256));

describe("embeddingFor", () => {
  it("puts texts of the same meaning close and unrelated texts near zero", () => {
    const same = similarity("total revenue", "sum of sales amount");
    const other = similarity("total revenue", "number of page views");

    expect(same).toBeGreaterThan(0.9);
    expect(Math.abs(other)).toBeLessThan(0.3);
    expect(same - other).toBeGreaterThan(0.6);
  });

  it.each([
    ["Net sales", "net turnover"],
    ["Order count", "purchases"],
    ["clients", "Customer"],
    ["Sessions", "visits"],
    ["gross profit", "Gross margin"],
    ["refunds", "returns"],
    ["Ad spend", "ad cost"],
  ])("matches %s to %s", (a, b) => {
    expect(similarity(a, b)).toBeGreaterThan(0.9);
  });

  it("matches a measure by some of its words more than by none", () => {
    const some = similarity("revenue last year", "Revenue PY year");
    const none = similarity("gross margin", "Return rate");

    expect(some).toBeGreaterThan(0.6);
    expect(Math.abs(none)).toBeLessThan(0.3);
  });

  it("answers the same vector for the same text, and for the same words in other case, plural or punctuation", () => {
    expect(embeddingFor("Net sales", 64)).toEqual(
      embeddingFor("Net sales", 64),
    );
    expect(embeddingFor("net sales", 64)).toEqual(
      embeddingFor("  NET-Sales!! ", 64),
    );
  });

  it("respects the dimensions asked", () => {
    for (const dimensions of [1, 8, 1536, 3072]) {
      expect(embeddingFor("gross margin", dimensions)).toHaveLength(dimensions);
    }
  });

  it("answers a vector of unit length", () => {
    for (const text of ["gross margin", "orders by channel", "x"]) {
      for (const dimensions of [1, 2, 64]) {
        const vector = embeddingFor(text, dimensions);
        expect(Math.hypot(...vector)).toBeCloseTo(1, 6);
      }
    }
  });

  it("answers a valid unit vector for an empty or stop-word-only text", () => {
    for (const text of ["", "   ", "the of and", "!!!"]) {
      const vector = embeddingFor(text, 32);
      expect(vector).toHaveLength(32);
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 6);
    }
    expect(embeddingFor("", 32)).toEqual(embeddingFor("", 32));
  });
});
