import type { InputHTMLAttributes } from "react";

/**
 * A secret's value as the admin pages and the setup take it: masked, never
 * offered from or saved to the browser's or a password manager's store, so a
 * client secret is not filled in where another belongs.
 */
export function SecretInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete">,
) {
  return (
    <input
      {...props}
      type="password"
      autoComplete="new-password"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
    />
  );
}
