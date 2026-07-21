"use client";
import { buttonVariants, Card, Chip, Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, CreditCard, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { orpc } from "@/utils/orpc";

const stack = ["Next.js", "React 19", "Hono", "oRPC", "Better Auth", "Polar", "HeroUI"];

export default function Home() {
  const healthCheck = useQuery(orpc.healthCheck.queryOptions());
  const isConnected = Boolean(healthCheck.data);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <section className="flex flex-col items-start gap-4">
        <Chip color="accent" size="sm">
          Powered by HeroUI v3
        </Chip>
        <h1 className="text-4xl font-bold tracking-tight text-balance md:text-5xl">
          A modern full-stack
          <span className="text-accent"> starter</span>
        </h1>
        <p className="max-w-xl text-lg text-muted">
          Type-safe APIs, authentication, and billing — wired together and ready to build on.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {stack.map((item) => (
            <Chip key={item} size="sm" variant="soft">
              {item}
            </Chip>
          ))}
        </div>
        <Link className={buttonVariants({ className: "mt-4" })} href="/dashboard">
          Open Dashboard
          <ArrowRight className="size-4" />
        </Link>
      </section>

      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <div className="flex items-center justify-between">
            <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
              <Activity className="size-4" />
            </div>
            {healthCheck.isLoading ? (
              <Skeleton className="h-6 w-24 rounded-full" />
            ) : (
              <Chip color={isConnected ? "success" : "danger"} size="sm">
                <span className="relative flex size-2">
                  {isConnected && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                  )}
                  <span className="relative inline-flex size-2 rounded-full bg-current" />
                </span>
                {isConnected ? "Connected" : "Disconnected"}
              </Chip>
            )}
          </div>
          <Card.Header>
            <Card.Title>API Status</Card.Title>
            <Card.Description>
              Live health check against the Hono server via oRPC.
            </Card.Description>
          </Card.Header>
        </Card>

        <Card>
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
            <ShieldCheck className="size-4" />
          </div>
          <Card.Header>
            <Card.Title>Authentication</Card.Title>
            <Card.Description>
              Email and password auth with sessions, powered by Better Auth.
            </Card.Description>
          </Card.Header>
        </Card>

        <Card>
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
            <CreditCard className="size-4" />
          </div>
          <Card.Header>
            <Card.Title>Billing</Card.Title>
            <Card.Description>
              Subscriptions and checkout handled end-to-end by Polar.
            </Card.Description>
          </Card.Header>
        </Card>
      </section>
    </div>
  );
}
