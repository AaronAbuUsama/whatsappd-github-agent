import { buttonVariants, Card } from "@heroui/react";
import { CircleCheck } from "lucide-react";
import Link from "next/link";

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout_id: string }>;
}) {
  const params = await searchParams;
  const checkout_id = params.checkout_id;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success-soft-foreground">
          <CircleCheck className="size-6" />
        </div>
        <Card.Header className="items-center">
          <Card.Title className="text-xl">Payment successful</Card.Title>
          <Card.Description>Thanks for upgrading — your subscription is active.</Card.Description>
        </Card.Header>
        {checkout_id && (
          <Card.Content>
            <code className="rounded-md bg-default-soft px-2 py-1 font-mono text-xs">
              {checkout_id}
            </code>
          </Card.Content>
        )}
        <Card.Footer>
          <Link className={buttonVariants()} href="/dashboard">
            Go to Dashboard
          </Link>
        </Card.Footer>
      </Card>
    </div>
  );
}
