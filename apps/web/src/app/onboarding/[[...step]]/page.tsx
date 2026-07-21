import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { authClient } from "@/lib/auth-client";

import Onboarding from "./onboarding";

export default async function OnboardingPage() {
  const session = await authClient.getSession({
    fetchOptions: { headers: await headers(), throw: true },
  });
  if (!session?.user) redirect("/login");

  return <Onboarding />;
}
