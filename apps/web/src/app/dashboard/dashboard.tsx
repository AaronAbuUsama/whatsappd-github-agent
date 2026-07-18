"use client";
import { Avatar, Button, Card, Chip, Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, ServerCog } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

function initials(name: string) {
  return (
    name
      .split(" ")
      .map((word) => word[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export default function Dashboard({
  customerState,
  session,
}: {
  customerState: ReturnType<typeof authClient.customer.state>;
  session: typeof authClient.$Infer.Session;
}) {
  const privateData = useQuery(orpc.privateData.queryOptions());

  const hasProSubscription = (customerState?.activeSubscriptions?.length ?? 0) > 0;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <Card.Header>
          <Card.Title>Account</Card.Title>
          <Card.Description>Your current session</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-row items-center gap-3">
          <Avatar>
            <Avatar.Fallback>{initials(session.user.name)}</Avatar.Fallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium">{session.user.name}</p>
            <p className="truncate text-sm text-muted">{session.user.email}</p>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
            <CreditCard className="size-4" />
          </div>
          <Chip color={hasProSubscription ? "accent" : "default"} size="sm">
            {hasProSubscription ? "Pro" : "Free"}
          </Chip>
        </div>
        <Card.Header>
          <Card.Title>Subscription</Card.Title>
          <Card.Description>
            {hasProSubscription
              ? "You are on the Pro plan. Manage billing in the customer portal."
              : "You are on the Free plan. Upgrade to unlock Pro features."}
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          {hasProSubscription ? (
            <Button variant="secondary" onPress={async () => await authClient.customer.portal()}>
              Manage Subscription
            </Button>
          ) : (
            <Button onPress={async () => await authClient.checkout({ slug: "pro" })}>
              Upgrade to Pro
            </Button>
          )}
        </Card.Footer>
      </Card>

      <Card className="md:col-span-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
          <ServerCog className="size-4" />
        </div>
        <Card.Header>
          <Card.Title>Private API</Card.Title>
          <Card.Description>Authenticated response from the oRPC endpoint</Card.Description>
        </Card.Header>
        <Card.Content>
          {privateData.isLoading ? (
            <Skeleton className="h-5 w-48 rounded-md" />
          ) : (
            <code className="inline-block w-fit rounded-md bg-default-soft px-2 py-1 font-mono text-sm">
              {privateData.data?.message ?? "No response"}
            </code>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
