import type { SignInConfig } from "../access/api";

export function configWith(brand: SignInConfig["brand"]): SignInConfig {
  return {
    providers: [],
    passkeys: false,
    email_password: false,
    dev_sign_in: false,
    sample_data: false,
    demo: false,
    setup_pending: false,
    invite_only: false,
    brand,
  };
}
