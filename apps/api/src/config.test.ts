import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const AGE_IDENTITY = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
const PG = "secret@postgres:5432/powerbi_metrics_book";

const WORKER = {
  PUBLIC_BASE_URL: "https://metrics.example.com",
  DATABASE_URL: `postgresql://worker_rw:${PG}`,
  AUDIT_DATABASE_URL: `postgresql://audit_writer:${PG}`,
  CERBOS_URL: "http://cerbos:3592",
  GIT_SHA: "3b5aa24",
  LOG_LEVEL: "info",
  NODE_ENV: "production",
};

const API = {
  ...WORKER,
  DATABASE_URL: `postgresql://api_rw:${PG}`,
  MIGRATOR_DATABASE_URL: `postgresql://migrator:${PG}`,
  AUTH_SECRET: "a".repeat(32),
};

describe("loadConfig for the api", () => {
  it("reads a well-formed environment, with every default", () => {
    expect(loadConfig(API, "api")).toEqual({
      container: "api",
      public_base_url: new URL("https://metrics.example.com"),
      database_url: API.DATABASE_URL,
      audit_database_url: API.AUDIT_DATABASE_URL,
      cerbos_url: new URL("http://cerbos:3592"),
      git_sha: "3b5aa24",
      log_level: "info",
      node_env: "production",
      allow_dev_sign_in: false,
      demo_mode: false,
      age_identity: null,
      identity_dir: "/var/lib/pbmb/identity",
      migrator_database_url: API.MIGRATOR_DATABASE_URL,
      auth_secret: API.AUTH_SECRET,
      port: 3000,
      trusted_proxy: null,
      client_address_header: "x-forwarded-for",
    });
  });

  it("reads the optional values when they are set", () => {
    const config = loadConfig(
      {
        ...API,
        PORT: "8080",
        IDENTITY_DIR: "/srv/identity",
        API_AGE_IDENTITY: AGE_IDENTITY,
        ALLOW_DEV_SIGN_IN: "1",
        NODE_ENV: "development",
        TRUSTED_PROXY: "10.0.0.0/24",
      },
      "api",
    );
    expect(config).toMatchObject({
      trusted_proxy: "10.0.0.0/24",
      port: 8080,
      identity_dir: "/srv/identity",
      age_identity: AGE_IDENTITY,
      allow_dev_sign_in: true,
      node_env: "development",
    });
    const shut = loadConfig({ ...API, ALLOW_DEV_SIGN_IN: "0" }, "api");
    expect(shut.allow_dev_sign_in).toBe(false);
  });

  it("reads DEMO_MODE for both containers", () => {
    expect(loadConfig({ ...API, DEMO_MODE: "1" }, "api").demo_mode).toBe(true);
    expect(loadConfig({ ...API, DEMO_MODE: "1" }, "worker").demo_mode).toBe(
      true,
    );
  });

  it("refuses DEMO_MODE with ALLOW_DEV_SIGN_IN, so no visitor can sign in as the admin", () => {
    expect(() =>
      loadConfig({ ...API, DEMO_MODE: "1", ALLOW_DEV_SIGN_IN: "1" }, "api"),
    ).toThrow("DEMO_MODE and ALLOW_DEV_SIGN_IN cannot both be 1");
  });

  describe("GIT_SHA_FILE, the commit an image built with no GIT_SHA read from .git", () => {
    const fileHolding = (text: string) => {
      const file = join(mkdtempSync(join(tmpdir(), "git-sha-")), "git_sha");
      writeFileSync(file, text);
      return file;
    };

    it("is read when GIT_SHA is empty", () => {
      const config = loadConfig(
        { ...API, GIT_SHA: "", GIT_SHA_FILE: fileHolding("0f13642\n") },
        "api",
      );
      expect(config.git_sha).toBe("0f13642");
    });

    it("gives way to a GIT_SHA that is set", () => {
      const config = loadConfig(
        { ...API, GIT_SHA_FILE: fileHolding("0f13642\n") },
        "api",
      );
      expect(config.git_sha).toBe(API.GIT_SHA);
    });

    it("names GIT_SHA when the file is empty", () => {
      expect(() =>
        loadConfig(
          { ...API, GIT_SHA: "", GIT_SHA_FILE: fileHolding("") },
          "api",
        ),
      ).toThrow("GIT_SHA is not set");
    });

    it("names GIT_SHA_FILE when the file cannot be read", () => {
      expect(() =>
        loadConfig(
          { ...API, GIT_SHA: "", GIT_SHA_FILE: "/nonexistent/git_sha" },
          "api",
        ),
      ).toThrow("GIT_SHA_FILE /nonexistent/git_sha cannot be read");
    });

    it("refuses a file that holds no commit sha", () => {
      expect(() =>
        loadConfig(
          { ...API, GIT_SHA: "", GIT_SHA_FILE: fileHolding("main\n") },
          "api",
        ),
      ).toThrow("must be a commit sha");
    });
  });

  it("reads CLIENT_ADDRESS_HEADER=x-real-ip, and refuses it together with TRUSTED_PROXY", () => {
    expect(
      loadConfig({ ...API, CLIENT_ADDRESS_HEADER: "x-real-ip" }, "api"),
    ).toMatchObject({
      client_address_header: "x-real-ip",
      trusted_proxy: null,
    });
    expect(() =>
      loadConfig(
        {
          ...API,
          CLIENT_ADDRESS_HEADER: "x-real-ip",
          TRUSTED_PROXY: "10.0.0.2",
        },
        "api",
      ),
    ).toThrow(
      "CLIENT_ADDRESS_HEADER=x-real-ip cannot be set with TRUSTED_PROXY",
    );
  });

  it.each([
    "PUBLIC_BASE_URL",
    "DATABASE_URL",
    "MIGRATOR_DATABASE_URL",
    "AUDIT_DATABASE_URL",
    "AUTH_SECRET",
    "CERBOS_URL",
    "GIT_SHA",
    "LOG_LEVEL",
    "NODE_ENV",
  ])("names %s when it is missing or empty", (name) => {
    for (const value of [undefined, ""])
      expect(() => loadConfig({ ...API, [name]: value }, "api")).toThrow(
        `${name} is not set`,
      );
  });

  it.each([
    ["DATABASE_URL", "not a url", "is not a URL"],
    ["AUDIT_DATABASE_URL", "mysql://db/x", "must be a postgres:// or"],
    ["PUBLIC_BASE_URL", "ftp://metrics.example.com", "must be a http:// or"],
    ["CERBOS_URL", "cerbos:3592", "must be a http:// or https:// URL"],
    ["GIT_SHA", "main", "must be a commit sha"],
    ["LOG_LEVEL", "verbose", "must be one of debug, info, warn, error"],
    ["NODE_ENV", "staging", "must be one of development, test, production"],
    ["ALLOW_DEV_SIGN_IN", "true", "must be 1 or 0"],
    ["DEMO_MODE", "true", "must be 1 or 0"],
    ["AUTH_SECRET", "a".repeat(31), "must be at least 32 characters"],
    ["IDENTITY_DIR", "identity", "must be an absolute path"],
    ["PORT", "80a", "must be a whole number from 1 to 65535"],
    ["PORT", "70000", "must be a whole number from 1 to 65535"],
    ["TRUSTED_PROXY", "proxy.internal", "must be an IP address or a CIDR"],
    ["TRUSTED_PROXY", "10.0.0.0/33", "must be an IP address or a CIDR"],
    ["TRUSTED_PROXY", "fd00::/129", "must be an IP address or a CIDR"],
    [
      "CLIENT_ADDRESS_HEADER",
      "forwarded",
      "must be x-forwarded-for or x-real-ip",
    ],
  ])("names %s when it is %j", (name, value, message) => {
    expect(() => loadConfig({ ...API, [name]: value }, "api")).toThrow(
      `${name} ${message}`,
    );
  });

  // config_security_test.ts holds the values it refuses because they would
  // trust more than they name.
  it.each([
    "10.0.1.25",
    "10.0.1.25/32",
    "10.0.1.0/24",
    "10.40.0.0/23",
    "fd00::5",
    "fd00::5/128",
    "fd00::/64",
    "::ffff:10.0.1.0/120",
    "::ffff:0:0/97",
    "2001:db8::/32",
  ])("takes TRUSTED_PROXY %s", (value) => {
    expect(loadConfig({ ...API, TRUSTED_PROXY: value }, "api")).toMatchObject({
      trusted_proxy: value,
    });
  });

  it("never repeats a malformed age identity in its error", () => {
    expect(() =>
      loadConfig({ ...API, API_AGE_IDENTITY: "key-material" }, "api"),
    ).toThrow(
      /^API_AGE_IDENTITY must be an age identity, AGE-SECRET-KEY-1\.\.\.$/,
    );
  });
});

describe("loadConfig for the worker", () => {
  it("reads only its own variables: no migrator URL, auth secret, port or api age identity", () => {
    const config = loadConfig(
      {
        ...WORKER,
        MIGRATOR_DATABASE_URL: "not a url",
        AUTH_SECRET: "short",
        PORT: "not a port",
        API_AGE_IDENTITY: AGE_IDENTITY,
      },
      "worker",
    );
    expect(config.container).toBe("worker");
    expect(config).not.toHaveProperty("migrator_database_url");
    expect(config).not.toHaveProperty("auth_secret");
    expect(config).not.toHaveProperty("port");
    expect(config.age_identity).toBeNull();
    const own = { ...WORKER, WORKER_AGE_IDENTITY: AGE_IDENTITY };
    expect(loadConfig(own, "worker").age_identity).toBe(AGE_IDENTITY);
  });
});

describe("loadConfig and the sample deployment's public values", () => {
  const SAMPLE_PG = "SampleOnlyApiPassword1@postgres:5432/powerbi_metrics_book";
  const SAMPLE_AUTH = `SampleOnly${"a".repeat(30)}`;

  it.each([
    ["AUTH_SECRET", { AUTH_SECRET: SAMPLE_AUTH }],
    ["DATABASE_URL", { DATABASE_URL: `postgresql://api_rw:${SAMPLE_PG}` }],
    [
      "MIGRATOR_DATABASE_URL",
      { MIGRATOR_DATABASE_URL: `postgresql://migrator:${SAMPLE_PG}` },
    ],
    [
      "AUDIT_DATABASE_URL",
      { AUDIT_DATABASE_URL: `postgresql://audit_writer:${SAMPLE_PG}` },
    ],
  ])(
    "refuses production when %s is a sample value, naming it and not the value",
    (name, change) => {
      let refusal = "";
      try {
        loadConfig({ ...API, ...change }, "api");
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toContain(
        `${name} holds a value from the sample deployment`,
      );
      expect(refusal).not.toContain("SampleOnly");
    },
  );

  it("refuses production in the worker for its own database URLs", () => {
    expect(() =>
      loadConfig(
        { ...WORKER, DATABASE_URL: `postgresql://worker_rw:${SAMPLE_PG}` },
        "worker",
      ),
    ).toThrow("DATABASE_URL holds a value from the sample deployment");
  });

  it.each(["development", "test"])(
    "allows them when NODE_ENV is %s",
    (node) => {
      const env = {
        ...API,
        NODE_ENV: node,
        AUTH_SECRET: SAMPLE_AUTH,
        DATABASE_URL: `postgresql://api_rw:${SAMPLE_PG}`,
      };
      expect(loadConfig(env, "api").node_env).toBe(node);
    },
  );
});
