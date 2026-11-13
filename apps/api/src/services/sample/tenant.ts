// Invented values of the mock's sample tenant
// (packages/powerbi-mock/src/sample/tenant.ts); scripts/dev-stack.test.mjs compares them.
export const SAMPLE = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  app: {
    client_id: "c1000000-0000-4000-8000-000000000002",
    secret: "sample-app-secret",
  },
  scanner: {
    client_id: "c1000000-0000-4000-8000-000000000001",
    secret: "sample-scanner-secret",
  },
  embedding_key: "sample-embedding-key",
  people: {
    "admin@sample.example": "a0000000-0000-4000-8000-000000000001",
    "analyst@sample.example": "a0000000-0000-4000-8000-000000000002",
    "viewer@sample.example": "a0000000-0000-4000-8000-000000000003",
    "leader@sample.example": "a0000000-0000-4000-8000-000000000004",
    "outsider@sample.example": "a0000000-0000-4000-8000-000000000005",
    "revoked@sample.example": "a0000000-0000-4000-8000-000000000006",
    "app-reader@sample.example": "a0000000-0000-4000-8000-000000000007",
    "sales-viewer@sample.example": "a0000000-0000-4000-8000-000000000008",
  },
};
