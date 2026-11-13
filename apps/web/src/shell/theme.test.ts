import { describe, expect, it } from "vitest";
import { restoreTheme, shownTheme, type ThemeHost, toggleTheme } from "./theme";

function host(options: { prefersDark?: boolean; refuse?: boolean } = {}) {
  const attributes = new Map<string, string>();
  const saved = new Map<string, string>();
  const refuse = () => {
    throw new DOMException("The site's data is blocked.", "SecurityError");
  };
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  const theme: ThemeHost = {
    root: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => void attributes.set(name, value),
    },
    prefersDark: () => options.prefersDark ?? false,
    storage: options.refuse === true ? refuse : () => storage,
  };
  return { theme, attributes, saved };
}

describe("the theme toggle", () => {
  it("follows the system until the person chooses", () => {
    expect(shownTheme(host({ prefersDark: true }).theme)).toBe("dark");
    expect(shownTheme(host({ prefersDark: false }).theme)).toBe("light");
  });

  it("switches to the other theme and keeps the choice for that person", () => {
    const { theme, attributes, saved } = host({ prefersDark: true });
    expect(toggleTheme(theme, "person-1")).toBe("light");
    expect(attributes.get("data-theme")).toBe("light");
    expect(toggleTheme(theme, "person-1")).toBe("dark");
    expect(saved).toEqual(new Map([["pbmb.theme.person-1", "dark"]]));
  });

  it("restores a person's own choice and no one else's", () => {
    const later = host();
    later.saved.set("pbmb.theme.person-1", "dark");
    restoreTheme(later.theme, "person-2");
    expect(later.attributes.has("data-theme")).toBe(false);
    restoreTheme(later.theme, "person-1");
    expect(later.attributes.get("data-theme")).toBe("dark");
  });

  it("still switches when the browser refuses storage, and keeps nothing", () => {
    const { theme, attributes } = host({ refuse: true });
    expect(() => {
      restoreTheme(theme, "person-1");
    }).not.toThrow();
    expect(toggleTheme(theme, "person-1")).toBe("dark");
    expect(attributes.get("data-theme")).toBe("dark");
  });

  it("switches without keeping anything for someone not signed in", () => {
    const { theme, attributes, saved } = host();
    expect(toggleTheme(theme, null)).toBe("dark");
    expect(attributes.get("data-theme")).toBe("dark");
    expect(saved.size).toBe(0);
  });

  it("does not hide an error that is not the browser refusing", () => {
    const { theme } = host();
    theme.storage = () => {
      throw new TypeError("a bug");
    };
    expect(() => toggleTheme(theme, "person-1")).toThrow("a bug");
  });
});
