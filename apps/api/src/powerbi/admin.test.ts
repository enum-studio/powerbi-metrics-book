import { describe, expect, it } from "vitest";
import { accessList } from "./admin.js";

const USER = "a0000000-0000-4000-8000-0000000000aa";

describe("accessList", () => {
  it("keeps the right under any key ending in UserAccessRight, as Microsoft's own samples name it", () => {
    const listed = (key: string) =>
      accessList.parse([
        { graphId: USER, principalType: "User", [key]: "Viewer" },
      ])[0]?.access_right;
    for (const key of [
      "groupUserAccessRight",
      "datasetUserAccessRight",
      "appUserAccessRight",
      "datamartUserAccessRight",
    ])
      expect(listed(key), key).toBe("Viewer");
  });

  it("gives an entry naming no right a null right, and drops the whole organization", () => {
    expect(
      accessList.parse([
        {
          graphId: USER,
          principalType: "User",
          emailAddress: "x@sample.example",
        },
        { graphId: "", principalType: "None", groupUserAccessRight: "Viewer" },
      ]),
    ).toEqual([
      {
        principal_type: "user",
        principal_object_id: USER,
        email: "x@sample.example",
        access_right: null,
      },
    ]);
  });
});
