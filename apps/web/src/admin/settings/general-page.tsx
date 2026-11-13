import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sent, signInConfigQuery } from "../../access/api";
import { api, ApiError } from "../../api/client";
import { Button, INPUT, PageFrame, SectionBox } from "../layout/ui";
import type { FieldSpec } from "./fields";
import { Section } from "./section";

const FIELDS: FieldSpec[] = [
  { key: "branding.name", label: "Brand name", kind: "text" },
  { key: "branding.company", label: "Company name", kind: "text" },
];

export function GeneralPage() {
  const client = useQueryClient();
  return (
    <PageFrame title="General" lede="Your company's name and logo.">
      <Section
        title="Company"
        fields={FIELDS}
        onSaved={() =>
          client.invalidateQueries({ queryKey: signInConfigQuery.queryKey })
        }
      />
      <LogoPicker />
    </PageFrame>
  );
}

function LogoPicker() {
  const client = useQueryClient();
  const { data } = useQuery(signInConfigQuery);
  const [file, setFile] = useState<File | null>(null);
  const change = useMutation({
    mutationFn: async (upload: File | null) => {
      await sent(
        upload === null
          ? api.DELETE("/api/v1/admin/branding/logo")
          : api.PUT("/api/v1/admin/branding/logo", {
              body: upload,
              bodySerializer: (body) => body,
              headers: { "Content-Type": upload.type },
            }),
      );
    },
    onSuccess: async () => {
      setFile(null);
      await client.invalidateQueries({ queryKey: signInConfigQuery.queryKey });
    },
  });
  return (
    <SectionBox title="Logo">
      {data?.brand.logo_url && (
        <img
          src={data.brand.logo_url}
          alt={data.brand.name}
          className="h-10 max-w-full self-start object-contain"
        />
      )}
      <label className="text-ui text-ink">
        Logo file
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className={INPUT}
          disabled={change.isPending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={file === null || change.isPending}
          onClick={() => {
            change.mutate(file);
          }}
        >
          Upload
        </Button>
        {data?.brand.logo_url && (
          <Button
            disabled={change.isPending}
            onClick={() => {
              change.mutate(null);
            }}
          >
            Remove
          </Button>
        )}
      </div>
      {change.error && (
        <p role="alert" className="text-ui text-out">
          {change.error instanceof ApiError
            ? change.error.message
            : "The logo could not be changed. Try again."}
        </p>
      )}
    </SectionBox>
  );
}
