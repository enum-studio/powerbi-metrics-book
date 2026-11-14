import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { Container } from "./context.js";
import { LOG_LEVELS, type LogLevel } from "./log.js";
import { ipv6Groups } from "./services/auth/client-address.js";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** What both containers read before they can reach their own database. */
type SharedConfig = {
  public_base_url: URL;
  /** The container's own role, api_rw or worker_rw. Database URLs are kept as written: URL would re-encode them. */
  database_url: string;
  audit_database_url: string;
  cerbos_url: URL;
  git_sha: string;
  log_level: LogLevel;
  node_env: NodeEnv;
  allow_dev_sign_in: boolean;
  /** The public demo: one read-only viewer on the sample tenant. services/demo/locks.ts keeps it off a real deployment. */
  demo_mode: boolean;
  /** API_AGE_IDENTITY or WORKER_AGE_IDENTITY, whichever is this container's; null makes one in identity_dir. */
  age_identity: string | null;
  identity_dir: string;
};

export type ApiConfig = SharedConfig & {
  container: "api";
  migrator_database_url: string;
  auth_secret: string;
  port: number;
  /** The reverse proxy's address, or a CIDR range written by its network address: only a request from it may name the client in X-Forwarded-For. */
  trusted_proxy: string | null;
  /**
   * Which header names the client. x-forwarded-for, the default, counts only
   * from TRUSTED_PROXY. x-real-ip takes the one address in X-Real-IP and
   * needs no proxy range, but only if every request comes through an edge
   * that replaces a client-sent X-Real-IP. Railway's networking page
   * (https://docs.railway.com/networking/public-networking/specs-and-limits)
   * documents that its edge sets the header and does not say it replaces one
   * the client sent, so that is unconfirmed. Before relying on this mode,
   * send GET /api/v1/me with a spoofed X-Real-IP: client_address must show
   * your real address. Anything that reaches the api without the edge
   * defeats it: Railway's private network from other services, a TCP Proxy.
   * Never use it behind Caddy or Traefik as configured here, which pass a
   * client's X-Real-IP through. It cannot be set with TRUSTED_PROXY, and
   * source_cidrs is refused under it.
   */
  client_address_header: "x-forwarded-for" | "x-real-ip";
};
export type WorkerConfig = SharedConfig & { container: "worker" };
export type Config = ApiConfig | WorkerConfig;

/** The page where a person connects Power BI, as the sentences name it. */
export function connectionsPage(config: Config): string {
  return `${config.public_base_url.href.replace(/\/$/, "")}/settings/connections`;
}

export function connectAgain(config: Config): string {
  return `Connect Power BI again at ${connectionsPage(config)}, then run this again.`;
}

type Env = Record<string, string | undefined>;

/**
 * Reads the environment once, at start. A missing or malformed variable stops
 * start-up with an error that names it, rather than surfacing later as a
 * failed request. Each container reads only its own variables: the worker
 * never reads the migrator's URL, the auth secret or the api's age identity.
 */
export function loadConfig(env: Env, container: "api"): ApiConfig;
export function loadConfig(env: Env, container: "worker"): WorkerConfig;
export function loadConfig(env: Env, container: Container): Config;
export function loadConfig(env: Env, container: Container): Config {
  const shared: SharedConfig = {
    public_base_url: readUrl(env, "PUBLIC_BASE_URL", ["http:", "https:"]),
    database_url: readDatabaseUrl(env, "DATABASE_URL"),
    audit_database_url: readDatabaseUrl(env, "AUDIT_DATABASE_URL"),
    cerbos_url: readUrl(env, "CERBOS_URL", ["http:", "https:"]),
    git_sha: readGitSha(env),
    log_level: readOneOf(env, "LOG_LEVEL", LOG_LEVELS),
    node_env: readOneOf(env, "NODE_ENV", NODE_ENVS),
    allow_dev_sign_in: readFlag(env, "ALLOW_DEV_SIGN_IN"),
    demo_mode: readFlag(env, "DEMO_MODE"),
    age_identity: readAgeIdentity(
      env,
      container === "api" ? "API_AGE_IDENTITY" : "WORKER_AGE_IDENTITY",
    ),
    identity_dir: readIdentityDir(env),
  };
  if (shared.demo_mode && shared.allow_dev_sign_in)
    throw new Error("DEMO_MODE and ALLOW_DEV_SIGN_IN cannot both be 1");
  const config: Config =
    container === "worker"
      ? { ...shared, container }
      : {
          ...shared,
          container,
          migrator_database_url: readDatabaseUrl(env, "MIGRATOR_DATABASE_URL"),
          auth_secret: readAuthSecret(env),
          port: readPort(env),
          trusted_proxy: readTrustedProxy(env),
          client_address_header: readClientAddressHeader(env),
        };
  if (config.node_env === "production") refuseSampleValues(config);
  return config;
}

/** The fixed public values of examples/sample start with this; they are in the repository, so they protect nothing. */
const SAMPLE_PREFIX = "SampleOnly";

/** In production a secret or password that starts with `SampleOnly` stops start-up. The error names the variable, never the value. */
function refuseSampleValues(config: Config): void {
  const password = (url: string) => decodeURIComponent(new URL(url).password);
  const values: [string, string][] = [
    ["DATABASE_URL", password(config.database_url)],
    ["AUDIT_DATABASE_URL", password(config.audit_database_url)],
  ];
  if (config.container === "api")
    values.push(
      ["MIGRATOR_DATABASE_URL", password(config.migrator_database_url)],
      ["AUTH_SECRET", config.auth_secret],
    );
  for (const [name, value] of values)
    if (value.startsWith(SAMPLE_PREFIX))
      throw new Error(
        `${name} holds a value from the sample deployment, which is public. Set your own secret and passwords (pbmb init writes them) before running with NODE_ENV=production`,
      );
}

/** A Postgres URL, returned as written: pg parses it, and URL would re-encode it. */
export function readDatabaseUrl(env: Env, name: string): string {
  readUrl(env, name, ["postgres:", "postgresql:"]);
  return required(env, name);
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
}

function readUrl(env: Env, name: string, protocols: readonly string[]): URL {
  const value = required(env, name);
  if (!URL.canParse(value)) throw new Error(`${name} is not a URL`);
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) {
    throw new Error(
      `${name} must be a ${protocols.map((protocol) => `${protocol}//`).join(" or ")} URL`,
    );
  }
  return url;
}

function readOneOf<T extends string>(
  env: Env,
  name: string,
  values: readonly T[],
): T {
  const value = required(env, name);
  const found = values.find((candidate) => candidate === value);
  if (found === undefined)
    throw new Error(`${name} must be one of ${values.join(", ")}`);
  return found;
}

function readGitShaFile(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (cause) {
    throw new Error(`GIT_SHA_FILE ${file} cannot be read`, { cause });
  }
}

function readGitSha(env: Env): string {
  // An image built with no GIT_SHA keeps the commit its build read from .git
  // in this file. The image's ENV leaves GIT_SHA set but empty in that case.
  const file = env.GIT_SHA_FILE;
  const value = required(
    file !== undefined && (env.GIT_SHA ?? "") === ""
      ? { GIT_SHA: readGitShaFile(file) }
      : env,
    "GIT_SHA",
  );
  if (!/^[0-9a-f]{7,40}$/.test(value))
    throw new Error(
      "GIT_SHA must be a commit sha, 7 to 40 lowercase hex digits",
    );
  return value;
}

/**
 * A lock that opens only on an exact "1"; unset is "0". Any other spelling
 * ("true", "yes") stops start-up rather than being guessed at, so a typo never
 * leaves a lock open, or shut, without anyone noticing.
 */
function readFlag(env: Env, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 1 or 0`);
}

/** The error never repeats the value: it is a private key. */
function readAgeIdentity(env: Env, name: string): string | null {
  const value = env[name];
  if (value === undefined || value === "") return null;
  if (!value.startsWith("AGE-SECRET-KEY-1"))
    throw new Error(`${name} must be an age identity, AGE-SECRET-KEY-1...`);
  return value;
}

function readIdentityDir(env: Env): string {
  const value = env.IDENTITY_DIR;
  if (value === undefined || value === "") return "/var/lib/pbmb/identity";
  if (!isAbsolute(value))
    throw new Error("IDENTITY_DIR must be an absolute path");
  return value;
}

/** Better Auth signs sessions with it and only warns below 32 characters; here a short one stops start-up. */
function readAuthSecret(env: Env): string {
  const value = required(env, "AUTH_SECRET");
  if (value.length < 32)
    throw new Error("AUTH_SECRET must be at least 32 characters");
  return value;
}

function readPort(env: Env): number {
  const value = env.PORT;
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535)
    throw new Error("PORT must be a whole number from 1 to 65535");
  return port;
}

function readClientAddressHeader(env: Env): ApiConfig["client_address_header"] {
  const value = env.CLIENT_ADDRESS_HEADER;
  if (value === undefined || value === "") return "x-forwarded-for";
  if (value !== "x-forwarded-for" && value !== "x-real-ip")
    throw new Error(
      "CLIENT_ADDRESS_HEADER must be x-forwarded-for or x-real-ip",
    );
  if (value === "x-real-ip" && (env.TRUSTED_PROXY ?? "") !== "")
    throw new Error(
      "CLIENT_ADDRESS_HEADER=x-real-ip cannot be set with TRUSTED_PROXY: x-real-ip ignores X-Forwarded-For, so TRUSTED_PROXY would do nothing, and setting both hides which header the api counts. Set one.",
    );
  return value;
}

/** ::ffff:0:0/96, where IPv6 writes every IPv4 address. */
const IPV4_MAPPED = 0xffffn << 32n;

/**
 * An IPv4 or IPv6 address, or a CIDR range of either written by its network
 * address, that trusts no more than it names. Node's BlockList trusts all of
 * 10.0.1.0/24 for 10.0.1.25/24, and that is how `docker network inspect`
 * prints one container's address, so a range written by an address inside it
 * stops start-up rather than quietly trusting every container on the network.
 * BlockList also matches an IPv4 connection against an IPv6 range that holds
 * its mapped form, so an IPv6 range that holds all of ::ffff:0:0/96, such as
 * ::/64, would trust every IPv4 client as /0 would.
 */
function readTrustedProxy(env: Env): string | null {
  const value = env.TRUSTED_PROXY;
  if (value === undefined || value === "") return null;
  const [address = "", prefix, extra] = value.split("/");
  const family = isIP(address);
  const bits = family === 4 ? 32 : 128;
  // A zero-length prefix would trust every address to name its own client.
  const prefixOk =
    prefix === undefined ||
    (/^\d+$/.test(prefix) && Number(prefix) >= 1 && Number(prefix) <= bits);
  if (family === 0 || !prefixOk || extra !== undefined)
    throw new Error(
      "TRUSTED_PROXY must be an IP address or a CIDR range other than /0, such as 10.0.0.2 or 10.0.0.0/24",
    );
  if (prefix === undefined) return value;
  const length = Number(prefix);
  const number = addressNumber(address, bits);
  const hostBits = BigInt(bits - length);
  const networkNumber = (number >> hostBits) << hostBits;
  if (networkNumber !== number) {
    const network = `${addressText(networkNumber, bits)}/${String(length)}`;
    throw new Error(
      `TRUSTED_PROXY ${value} names a range by an address inside it, and would trust all of ${network}. To trust that one address, drop the suffix: ${address}. To trust the range, write it as ${network}.`,
    );
  }
  if (
    bits === 128 &&
    length <= 96 &&
    (IPV4_MAPPED >> hostBits) << hostBits === networkNumber
  )
    throw new Error(
      `TRUSTED_PROXY ${value} holds all of ::ffff:0:0/96, the IPv6 form of every IPv4 address, so it would trust every client to name its own address, as /0 would. Set the proxy's own address or range.`,
    );
  return value;
}

/** An address as one number: 32 bits for IPv4, 128 for IPv6. */
function addressNumber(address: string, bits: 32 | 128): bigint {
  const [parts, width] =
    bits === 32
      ? [address.split(".").map((part) => BigInt(part)), 8n]
      : [ipv6Groups(address).map((group) => BigInt(`0x${group}`)), 16n];
  return parts.reduce((number, part) => (number << width) | part, 0n);
}

/**
 * A number as an address again. An IPv4-mapped address keeps its dotted
 * IPv4 part, and URL shortens other IPv6 as RFC 5952 does, the longest run
 * of zero groups to ::.
 */
function addressText(number: bigint, bits: 32 | 128): string {
  if (bits === 128 && number >> 32n === 0xffffn)
    return `::ffff:${addressText(number & 0xffffffffn, 32)}`;
  const width = bits === 32 ? 8 : 16;
  const parts = Array.from(
    { length: bits / width },
    (_, index) =>
      (number >> BigInt(bits - width * (index + 1))) &
      ((1n << BigInt(width)) - 1n),
  );
  if (bits === 32) return parts.map((part) => String(part)).join(".");
  const groups = parts.map((part) => part.toString(16)).join(":");
  return new URL(`http://[${groups}]`).hostname.slice(1, -1);
}
