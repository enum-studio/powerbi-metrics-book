import { createRoute } from "@tanstack/react-router";
import { ForgotPassword } from "../access/forgot-password";
import { rootRoute } from "./root";

export const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true, authPage: "Forgot password" },
  path: "/forgot-password",
  component: ForgotPassword,
});
