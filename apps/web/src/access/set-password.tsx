import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { INPUT, Label, LINK } from "../admin/layout/ui";
import { ApiError } from "../api/client";
import { meQuery } from "../api/me";
import { authCall } from "./api";
import { AccessCard, Button, AuthPanel, Problem } from "./parts";
import { readFragmentToken } from "./fragment-token";
import { authRefusal } from "./refusals";

export function SetPassword({ kind }: { kind?: string }) {
  const token = readFragmentToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const set = useMutation({
    mutationFn: async () => {
      await authCall(
        kind === "invite" ? "/invites/accept" : "/reset-password",
        {
          method: "POST",
          body:
            kind === "invite"
              ? { token, password }
              : { token, newPassword: password },
        },
      );
      await client.invalidateQueries({ queryKey: meQuery.queryKey });
      await navigate({
        href: kind === "invite" ? "/" : "/sign-in?password=set",
      });
    },
  });
  const invalid = (kind !== "invite" && kind !== "reset") || !token;
  const expired =
    invalid ||
    (set.error instanceof ApiError &&
      set.error.status === 400 &&
      set.error.kind === "INVALID_TOKEN");
  return (
    <AccessCard>
      <h1 className="text-title font-semibold text-ink">Set password</h1>
      <AuthPanel>
        {invalid && (
          <Problem>
            This link is invalid or has expired. Ask for a new password link.
          </Problem>
        )}
        {set.error !== null && <Problem>{authRefusal(set.error)}</Problem>}
        {!expired && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setMismatch(password !== confirm);
              if (password === confirm) set.mutate();
            }}
          >
            <Label htmlFor="password">New password</Label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              aria-describedby="password-hint"
              className={INPUT}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <p id="password-hint" className="text-meta text-ink-3">
              At least 12 characters.
            </p>
            <Label htmlFor="confirm">Confirm password</Label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              className={INPUT}
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
              }}
            />
            {mismatch && (
              <Problem>
                The passwords do not match. Enter the same password in both
                fields.
              </Problem>
            )}
            <Button kind="primary" type="submit" disabled={set.isPending}>
              Set password
            </Button>
          </form>
        )}
        <a href="/forgot-password" className={LINK}>
          Ask for a new password link
        </a>
      </AuthPanel>
    </AccessCard>
  );
}
