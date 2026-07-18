"use client";

import { Avatar, Button, buttonVariants, Dropdown, Label, Skeleton } from "@heroui/react";
import { LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

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

export default function UserMenu() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <Skeleton className="h-10 w-full rounded-lg" />;
  }

  if (!session) {
    return (
      <Link className={buttonVariants({ className: "w-full max-md:hidden" })} href="/login">
        Sign In
      </Link>
    );
  }

  return (
    <Dropdown>
      <Button
        className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 max-md:justify-center max-md:px-1"
        variant="ghost"
      >
        <Avatar size="sm">
          <Avatar.Fallback>{initials(session.user.name)}</Avatar.Fallback>
        </Avatar>
        <span className="flex min-w-0 flex-col items-start max-md:hidden">
          <span className="w-full truncate text-start text-sm font-medium">
            {session.user.name}
          </span>
          <span className="w-full truncate text-start text-xs font-normal text-muted">
            {session.user.email}
          </span>
        </span>
      </Button>
      <Dropdown.Popover className="min-w-52" placement="top start">
        <Dropdown.Menu>
          <Dropdown.Item
            id="sign-out"
            textValue="Sign out"
            variant="danger"
            onAction={() => {
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    router.push("/");
                  },
                },
              });
            }}
          >
            <LogOut className="size-4" />
            <Label>Sign out</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
