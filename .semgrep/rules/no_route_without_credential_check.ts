// Stands in for a route module such as apps/api/src/routes/v1/read.ts. The
// rule's `paths:` block (apps/api/src/routes/**) is not applied by
// `semgrep --test`, so the fixture lives beside the rule.

// ruleid: no-route-without-credential-check
routes.get("/things", doc, async (c) => c.json({}));

// ruleid: no-route-without-credential-check
routes.post("/things", doc, validator("json"), async (c) => c.json({}));

// ruleid: no-route-without-credential-check
routes.delete("/things/:id", async (c) => c.json({}));

// ok: no-route-without-credential-check
routes.get("/things", doc, credential, async (c) => c.json({}));

// ok: no-route-without-credential-check
routes.patch("/things/:id", doc, credential, validator("json"), async (c) =>
  c.json({}),
);

// The setup routes build their own credential middleware per step.
// ok: no-route-without-credential-check
routes.post("/setup/steps/search", doc, credential("search"), async (c) =>
  c.json({}),
);

// ok: no-route-without-credential-check
routes.get("/oauth/consent", doc, browserOnly, async (c) => c.json({}));

// ok: no-route-without-credential-check
routes.get(
  "/powerbi/connect",
  doc,
  sessionOnly,
  validator("query"),
  async (c) => c.redirect("/"),
);

// In the public-paths list: "/api/setup/session". The setup link's token in
// the body is its credential.
// ok: no-route-without-credential-check
routes.post(`${SETUP_PATH}/session`, doc, limited, async (c) => c.body(""));

// In the public-paths list (http/public-paths.ts): "GET /api/v1/results/:id/csv".
// The signed link is its credential.
// ok: no-route-without-credential-check
routes.get("/results/:id/csv", doc, validator("query"), async (c) =>
  c.body(""),
);

// The same path with another method is not the public one.
// ruleid: no-route-without-credential-check
routes.post("/results/:id/csv", doc, async (c) => c.body(""));

// In the public-paths list: "GET /api/auth/config".
// ok: no-route-without-credential-check
routes.get("/api/auth/config", doc, async (c) => c.json({}));

// In the public-paths list: "GET /api/branding/logo".
// ok: no-route-without-credential-check
routes.get("/api/branding/logo", doc, async (c) => c.body(null));

// ruleid: no-route-without-credential-check
routes.put("/api/branding/logo", doc, async (c) => c.body(null));

// Not a route: a map's get has one argument.
// ok: no-route-without-credential-check
cache.get("key");
