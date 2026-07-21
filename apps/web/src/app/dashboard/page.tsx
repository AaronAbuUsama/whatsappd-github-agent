import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { authClient } from "@/lib/auth-client";

import Dashboard from "./dashboard";

export default async function DashboardPage() {
  const session = await authClient.getSession({
    fetchOptions: {
      headers: await headers(),
      throw: true,
    },
  });

  if (!session?.user) {
    redirect("/login");
  }

  const { data: customerState } = await authClient.customer.state({
    fetchOptions: {
      headers: await headers(),
    },
  });

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
      <div className="mb-8">
        <p className="text-sm font-medium text-accent">Hosted coworker</p>
        <h1 className="text-3xl font-bold tracking-tight">Operate</h1>
        <p className="mt-1 text-muted">Health, repair, and billing for {session.user.name}</p>
      </div>
      <Dashboard session={session} customerState={customerState} />
    </div>
  );
}
