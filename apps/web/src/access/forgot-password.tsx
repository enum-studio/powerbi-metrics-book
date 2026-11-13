import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { INPUT, Label, LINK } from "../admin/layout/ui";
import { authCall } from "./api";
import { AccessCard, Button, AuthPanel, Problem } from "./parts";
import { authRefusal } from "./refusals";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const send = useMutation({
    mutationFn: () =>
      authCall("/email/forgot-password", { method: "POST", body: { email } }),
  });
  return (
    <AccessCard>
      <h1 className="text-title font-semibold text-ink">Forgot password</h1>
      <AuthPanel>
        {send.isSuccess ? (
          <p role="status" className="text-ui text-ink">
            If that email has an account, a link to set a new password is on its
            way.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              send.mutate();
            }}
          >
            <Label htmlFor="email">Email</Label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={INPUT}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <Button kind="primary" type="submit" disabled={send.isPending}>
              Send password link
            </Button>
            {send.error !== null && (
              <Problem>{authRefusal(send.error)}</Problem>
            )}
          </form>
        )}
        <a href="/sign-in" className={LINK}>
          Back to sign-in
        </a>
      </AuthPanel>
    </AccessCard>
  );
}
