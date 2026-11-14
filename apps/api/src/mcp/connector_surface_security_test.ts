import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./tools/index.js";

/**
 * The connector never changes the book (AGENTS.md, rule 7). Proved two
 * ways: every registered tool is one the spec names, and every module under
 * src/mcp reaches in the rest of the api only the declarations listed below.
 *
 * Proved over the TypeScript program, not the text: each import and
 * re-export is followed with the type checker to the declaration it names,
 * through index files, `export *` and a sibling module's re-exports. A
 * namespace import, `export *` and a bare import of a module outside
 * src/mcp take the whole module, which ALLOWED never lists. Packages and
 * type-only imports are free. A computed import(), require() or eval, or a
 * raw query through the context's db or pool, sits outside the program's
 * imports, so the connector is asserted to hold none of those.
 */

/** The tools of the spec, "The connector (MCP) and the API", and the requests of docs/specs/2026-11-11-requests-and-usage-report.md. */
const SPEC_TOOLS = [
  "search", "list_metrics", "get_metric", "list_variants", "get_variant",
  "list_categories", "list_terms", "get_term", "get_conventions",
  "list_workspaces", "list_apps", "list_datasets", "get_dataset", "list_relationships",
  "list_columns", "list_measures", "execute_dax", "read_query_result",
  "get_result_csv_link", "search_query_log", "get_query", "post_thread",
  "reply_in_thread", "get_thread", "list_threads", "accept_reply",
  "set_upvote", "whoami", "record_request", "list_requests", "get_request", "get_usage_report",
]; // prettier-ignore

/**
 * What the connector may reach in the rest of src: the file that declares
 * it and the name it is declared under. A new tool group adds its service
 * reads here, in a change that gets the security review.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "config.ts": ["connectionsPage"],
  "services/text.ts": ["excerpt"],
  "errors.ts": ["ServiceError"],
  "version.ts": ["VERSION"],
  "http/error-log.ts": ["logError"],
  "services/auth/principal.ts": ["requirePrincipal"],
  "services/auth/sign-in-config.ts": ["onTheMock"],
  "services/conventions/service.ts": ["getConventionsForAgents"],
  "services/connection/store.ts": ["connectionState"],
  "services/audit/connector.ts": ["recordConnectorReached"],
  "db/schema/book.ts": ["COMPARISONS", "TRUST_STATES"],
  "db/schema/queries.ts": ["QUERY_STATUSES"],
  "db/schema/search.ts": ["SEARCH_KINDS"],
  "services/search/query.ts": ["search"],
  "db/schema/threads.ts": [
    "THREAD_ELEMENT_KINDS",
    "THREAD_KINDS",
    "THREAD_STATUSES",
  ],
  "services/book/metrics.ts": ["getMetric", "listMetrics", "summarizeBook"],
  "services/book/variants.ts": ["getVariant", "listVariants"],
  "services/book/categories.ts": ["categoryTree"],
  "services/book/terms.ts": ["getTerm", "listTerms"],
  "services/mirror/read.ts": [
    "getDataset",
    "listApps",
    "listColumns",
    "listDatasets",
    "listMeasures",
    "listRelationships",
    "listWorkspaces",
  ],
  "services/queries/execute.ts": ["executeDax"],
  "services/queries/log.ts": ["getQuery", "searchQueryLog"],
  "services/queries/store.ts": ["readResult", "resultCsvLink"],
  "services/threads/threads.ts": [
    "acceptReply",
    "getThread",
    "listThreads",
    "postThread",
    "reply",
    "setUpvote",
  ],
  "db/schema/usage.ts": ["GAP_KINDS", "REQUEST_OUTCOMES"],
  "services/usage/report.ts": ["usageReport"],
  "services/usage/requests.ts": ["getRequest", "listRequests", "recordRequest"],
};

/**
 * Declarations that give a connector more than it needs: the whole result
 * store and the CSV signer (the tools use readResult and resultCsvLink, which
 * bind them to the caller) and the audit writer (recordConnectorReached
 * writes the one event a tool may). ALLOWED never lists them.
 */
const FORBIDDEN: Record<string, readonly string[]> = {
  "services/queries/store.ts": ["createResultStore"],
  "services/queries/links.ts": ["csvLink"],
  "services/audit/write.ts": ["writeAudit"],
};

/**
 * The reads of the book and conventions services, each asking Cerbos
 * itself. Whatever else those folders declare changes the book, records a
 * change, drafts, or reads past Cerbos, so ALLOWED may take nothing else
 * from services/book or services/conventions.
 */
const BOOK_READS: Record<string, readonly string[]> = {
  "services/book/metrics.ts": ["getMetric", "listMetrics", "summarizeBook"],
  "services/book/variants.ts": ["getVariant", "listVariants"],
  "services/book/categories.ts": ["categoryTree"],
  "services/book/terms.ts": ["getTerm", "listTerms"],
  "services/book/docs.ts": ["getDocs"],
  "services/conventions/service.ts": ["getConventionsForAgents"],
};
const BOOK_FOLDERS = /^services\/(book|conventions)\//;

/** Anything that could reach code or the database past the imports read here. */
const ESCAPES =
  /\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\b|\.(query|insert|update|delete|execute|transaction)\s*\(|\bsql\s*`/;

const API = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(API, "src");
const MCP = join(SRC, "mcp");
const inSrc = (path: string) => join(SRC, path);

const connectorModules = readdirSync(MCP, { recursive: true, encoding: "utf8" })
  .filter((path) => /(?<!\.test|_security_test)\.ts$/.test(path))
  .map((path) => join(MCP, path));

const tsconfig: unknown = ts.readConfigFile(
  join(API, "tsconfig.json"),
  (path) => ts.sys.readFile(path),
).config;
const program = ts.createProgram(
  [...connectorModules, ...Object.keys(BOOK_READS).map(inSrc)],
  ts.parseJsonConfigFileContent(tsconfig, ts.sys, API).options,
);
const checker = program.getTypeChecker();

/** `<file relative to src>#<name>` of what `symbol` resolves to, through every alias. */
function declared(symbol: ts.Symbol | undefined): string {
  if (symbol === undefined) return "unresolved";
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const [declaration] = target.declarations ?? [];
  if (declaration === undefined) return `unresolved#${target.name}`;
  return `${relative(SRC, declaration.getSourceFile().fileName)}#${target.name}`;
}

/** The whole module a specifier names, as `<file>#*`. */
function whole(specifier: ts.Expression): string {
  const [declaration] =
    checker.getSymbolAtLocation(specifier)?.declarations ?? [];
  if (declaration === undefined) return "unresolved#*";
  return `${relative(SRC, declaration.getSourceFile().fileName)}#*`;
}

/** Every declaration `file` takes from another module, by its own imports and re-exports. */
function reached(file: string): string[] {
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`${file} is not in the program`);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const { importClause: clause, moduleSpecifier } = statement;
      if (clause === undefined) return [whole(moduleSpecifier)];
      if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings))
        return [whole(moduleSpecifier)];
      return [
        ...(clause.name === undefined ? [] : [clause.name]),
        ...(bindings?.elements ?? [])
          .filter((element) => !element.isTypeOnly)
          .map((element) => element.name),
      ].map((name) => declared(checker.getSymbolAtLocation(name)));
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      !statement.isTypeOnly
    ) {
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause))
        return [whole(statement.moduleSpecifier)];
      return clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) =>
          declared(checker.getExportSpecifierLocalTargetSymbol(element)),
        );
    }
    return [];
  });
}

/** Inside src/mcp, which this test reads too, or an installed package. */
const free = (key: string) =>
  key.startsWith("mcp/") || key.includes("node_modules/");

const allowed = (key: string) => {
  const [file = "", name = ""] = key.split("#");
  return ALLOWED[file]?.includes(name) === true;
};

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

describe("the connector's tools", () => {
  it("are all on the spec's list, each once", () => {
    const names = TOOLS.map(({ name }) => name);
    expect(SPEC_TOOLS).toHaveLength(32);
    expect(TOOLS).toHaveLength(32);
    expect(TOOLS.filter((tool) => tool.requires === undefined)).toHaveLength(
      26,
    );
    expect(
      TOOLS.filter((tool) => tool.requires === "questions.enabled")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "accept_reply",
      "get_thread",
      "list_threads",
      "post_thread",
      "reply_in_thread",
      "set_upvote",
    ]);
    expect(names.filter((name) => !SPEC_TOOLS.includes(name))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...SPEC_TOOLS].sort());
  });
});

describe("the connector's modules", () => {
  it("are all read: the server, the registry and every tool module", () => {
    const read = connectorModules.map((file) => relative(MCP, file));
    const expected = [
      ...[
        "server.ts",
        "registry.ts",
        "anchors.ts",
        "tools/index.ts",
        "tools/inputs.ts",
      ],
      ...["find", "read", "query", "talk", "whoami"].map(
        (group) => `tools/${group}.ts`,
      ),
    ];
    expect(read).toEqual(expect.arrayContaining(expected));
  });

  it("reach in the rest of the api only the declarations listed", () => {
    const unlisted = connectorModules.flatMap((file) =>
      reached(file)
        .filter((key) => !free(key) && !allowed(key))
        .map((key) => `${relative(SRC, file)} reaches ${key}`),
    );
    expect(unlisted).toEqual([]);
  });

  it("are allowed only the reads of the book and conventions services", () => {
    const writes = Object.entries(ALLOWED)
      .filter(([file]) => BOOK_FOLDERS.test(file))
      .flatMap(([file, names]) =>
        names
          .filter((name) => !(BOOK_READS[file] ?? []).includes(name))
          .map((name) => `${file}#${name}`),
      );
    expect(writes).toEqual([]);
  });

  it("are never allowed the result store, the CSV signer or the audit writer", () => {
    const taken = Object.entries(FORBIDDEN).flatMap(([file, names]) =>
      names
        .filter((name) => ALLOWED[file]?.includes(name) === true)
        .map((name) => `${file}#${name}`),
    );
    expect(taken).toEqual([]);
  });

  it("hold no dynamic import, eval or raw database call", () => {
    const escaping = connectorModules
      .filter((file) => ESCAPES.test(code(file)))
      .map((file) => relative(SRC, file));
    expect(escaping).toEqual([]);
  });
});

describe("the lists and the analysis", () => {
  it("name declarations that exist, so neither list is stale", () => {
    const missing = Object.entries({ ...ALLOWED, ...BOOK_READS }).flatMap(
      ([file, names]) => {
        const source = program.getSourceFile(inSrc(file));
        const module =
          source === undefined
            ? undefined
            : checker.getSymbolAtLocation(source);
        const exported = new Set(
          (module === undefined ? [] : checker.getExportsOfModule(module)).map(
            (symbol) => declared(symbol),
          ),
        );
        return names
          .map((name) => `${file}#${name}`)
          .filter((key) => !exported.has(key));
      },
    );
    expect(missing).toEqual([]);
  });

  it("finds a write through a module that makes one, so the checks above are not vacuous", () => {
    expect(reached(inSrc("services/conventions/service.ts"))).toContain(
      "services/conventions/store.ts#setConventions",
    );
  });
});
