"use client";

import {
  Alert,
  Avatar,
  Button,
  Card,
  Checkbox,
  Chip,
  Fieldset,
  Label,
  Radio,
  RadioGroup,
  Separator,
  Skeleton,
  Spinner,
} from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import qrCode from "qrcode-terminal";
import { useEffect, useRef, useState } from "react";

import { env } from "@ambient-agent/env/web";
import { authClient } from "@/lib/auth-client";
import { client, orpc } from "@/utils/orpc";

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

const apiUrl = (path: string) => new URL(path, env.NEXT_PUBLIC_SERVER_URL).toString();
const message = (cause: unknown) => (cause instanceof Error ? cause.message : "The request could not be completed.");
const capabilityColor = (state: string) =>
  state === "healthy"
    ? "success"
    : state === "repairing"
      ? "accent"
      : state === "pending"
        ? "default"
        : state === "uncertain"
          ? "warning"
          : "danger";

type GitHubRole = "coder" | "reviewer" | "planner";
type GitHubRepository = {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly selected: boolean;
  readonly isDefault: boolean;
};
type GitHubConfigurationApplication = {
  readonly currentConfigVersion: number;
  readonly appliedConfigVersion: number;
  readonly remoteConfigState: "idle" | "pending" | "confirmed" | "blocked_unknown";
  readonly updated: boolean;
};

export default function Dashboard({
  customerState,
  session,
}: {
  customerState: ReturnType<typeof authClient.customer.state>;
  session: typeof authClient.$Infer.Session;
}) {
  const router = useRouter();
  const snapshot = useQuery({ ...orpc.coworker.refresh.queryOptions(), refetchInterval: 5_000 });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [modelChallenge, setModelChallenge] = useState<{
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  }>();
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof client.coworker.whatsapp.pairing>>>();
  const [pairingQr, setPairingQr] = useState<string>();
  const [repositories, setRepositories] = useState<readonly GitHubRepository[]>();
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [defaultRepository, setDefaultRepository] = useState("");
  const [repositoryRole, setRepositoryRole] = useState<GitHubRole>();
  const [githubApplication, setGitHubApplication] = useState<GitHubConfigurationApplication>();
  const operationIdentities = useRef<Partial<Record<"restart" | "repair" | "model", string>>>({});

  const identityFor = (kind: "restart" | "repair" | "model") => {
    operationIdentities.current[kind] ??= crypto.randomUUID();
    return operationIdentities.current[kind];
  };

  useEffect(() => {
    if (snapshot.data && snapshot.data.nextAction !== "operate") {
      router.replace(`/onboarding/${snapshot.data.nextAction}` as Route);
    }
  }, [router, snapshot.data]);

  useEffect(() => {
    if (pairing?.status !== "pairing" || pairing.method !== "qr" || !pairing.qr) {
      setPairingQr(undefined);
      return;
    }
    qrCode.generate(pairing.qr, { small: true }, setPairingQr);
  }, [pairing]);

  useEffect(() => {
    if (!modelChallenge) return;
    const timeout = window.setTimeout(
      () => setModelChallenge(undefined),
      Math.max(0, modelChallenge.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [modelChallenge]);

  useEffect(() => {
    if (pairing?.status !== "pairing") return;
    const timeout = window.setTimeout(() => setPairing(undefined), Math.max(0, pairing.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [pairing]);

  useEffect(() => {
    const data = snapshot.data;
    if (!data) return;
    if (data.capabilities.model.state === "healthy") {
      setModelChallenge(undefined);
      delete operationIdentities.current.model;
    }
    if (data.capabilities.whatsapp.state === "healthy") setPairing(undefined);
    if (data.capabilities.github.state === "healthy") setGitHubApplication(undefined);
    for (const [key, kind] of [
      ["restart", "restart"],
      ["repair", "repair"],
    ] as const) {
      const identity = operationIdentities.current[key];
      if (
        identity &&
        data.operations.some(
          (operation) =>
            operation.kind === kind &&
            operation.operationIdentity === identity &&
            ["succeeded", "failed"].includes(operation.status),
        )
      ) {
        delete operationIdentities.current[key];
      }
    }
  }, [snapshot.data]);

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name);
    setError(undefined);
    try {
      await operation();
      await snapshot.refetch();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const reconnectGitHub = async (role: "coder" | "reviewer" | "planner") => {
    const response = await fetch(apiUrl(`/api/github/installations/${role}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: snapshot.data?.tenant?.id }),
    });
    const body = (await response.json()) as { url?: string; error?: string };
    if (!response.ok || !body.url) throw new Error(body.error ?? "GitHub repair could not start.");
    const popup = window.open(body.url, `ambient-github-${role}`, "popup,width=980,height=760");
    if (!popup) throw new Error("Allow the GitHub installation window, then retry.");
    popup.opener = null;
  };

  const loadRepositories = async (role: GitHubRole) => {
    const response = await fetch(
      apiUrl(`/api/github/repositories/${role}?tenantId=${encodeURIComponent(snapshot.data?.tenant?.id ?? "")}`),
      { credentials: "include" },
    );
    const body = (await response.json()) as readonly GitHubRepository[] | { error?: string };
    if (!response.ok || !Array.isArray(body)) {
      const apiError = Array.isArray(body) ? undefined : (body as { error?: string }).error;
      throw new Error(apiError ?? "GitHub repositories could not be loaded.");
    }
    setRepositoryRole(role);
    setRepositories(body);
    setSelectedRepositories(
      body.filter((repository) => repository.selected).map((repository) => String(repository.id)),
    );
    setDefaultRepository(String(body.find((repository) => repository.isDefault)?.id ?? ""));
  };

  const saveRepositories = async () => {
    if (!repositoryRole) return;
    const selected = selectedRepositories.map(Number);
    const defaultRepositoryId = Number(defaultRepository);
    if (!selected.includes(defaultRepositoryId)) throw new Error("Choose one selected repository as the default.");
    const response = await fetch(apiUrl(`/api/github/repositories/${repositoryRole}`), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: snapshot.data?.tenant?.id,
        repositoryIds: selected,
        defaultRepositoryId,
      }),
    });
    const body = (await response.json()) as GitHubConfigurationApplication | { error?: string };
    if (!response.ok) {
      throw new Error("error" in body ? body.error : "Repository selection could not be saved.");
    }
    if (
      !("currentConfigVersion" in body) ||
      typeof body.currentConfigVersion !== "number" ||
      !("appliedConfigVersion" in body) ||
      typeof body.appliedConfigVersion !== "number" ||
      !("remoteConfigState" in body) ||
      !["idle", "pending", "confirmed", "blocked_unknown"].includes(body.remoteConfigState)
    ) {
      throw new Error("Repository selection was saved without a configuration receipt.");
    }
    setGitHubApplication(body as GitHubConfigurationApplication);
    setRepositories(undefined);
    setRepositoryRole(undefined);
  };

  if (snapshot.isLoading || (snapshot.data && snapshot.data.nextAction !== "operate")) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl md:col-span-2" />
      </div>
    );
  }

  if (snapshot.isError || !snapshot.data?.tenant) {
    return (
      <Alert status="danger">
        <Alert.Content>
          <Alert.Title>Operate dashboard unavailable</Alert.Title>
          <Alert.Description>{snapshot.error?.message ?? "No tenant snapshot was returned."}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const data = snapshot.data;
  const tenant = data.tenant;
  if (!tenant) return null;
  const hasProSubscription = (customerState?.activeSubscriptions?.length ?? 0) > 0;
  const githubRepairRole = data.github.find(
    (role) =>
      role.status === "failed" ||
      role.status === "revoked" ||
      role.status === "missing" ||
      role.selectedRepositories === 0 ||
      !role.hasDefaultRepository,
  );
  const lifecycleOperation = data.operations.find(
    (operation) =>
      ["provision_setup", "activate", "restart", "repair"].includes(operation.kind) &&
      ["pending", "running", "uncertain"].includes(operation.status),
  );
  const repairOperation = data.operations.find(
    (operation) => operation.kind === "repair" && ["pending", "running"].includes(operation.status),
  );

  return (
    <div className="flex flex-col gap-5">
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {modelChallenge ? "A model authorization challenge is ready." : ""}
        {pairing ? "A WhatsApp repair challenge is ready." : ""}
      </div>
      {data.readiness === "suspended" ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>Coworker suspended</Alert.Title>
            <Alert.Description>
              Billing stopped the runtime without deleting tenant credentials, Managed Chats, or configuration.
            </Alert.Description>
          </Alert.Content>
          <Button variant="secondary" onPress={async () => await authClient.customer.portal()}>
            Restore billing
          </Button>
        </Alert>
      ) : null}

      {error ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Repair needs attention</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {githubApplication &&
      (githubApplication.remoteConfigState === "blocked_unknown" ||
        githubApplication.currentConfigVersion !== githubApplication.appliedConfigVersion) ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>
              {githubApplication.remoteConfigState === "blocked_unknown"
                ? "GitHub configuration outcome uncertain"
                : "GitHub configuration applying"}
            </Alert.Title>
            <Alert.Description>
              Revision {githubApplication.currentConfigVersion} is saved. The runtime currently reports revision{" "}
              {githubApplication.appliedConfigVersion};{" "}
              {githubApplication.remoteConfigState === "blocked_unknown"
                ? "refresh observations before retrying this repair."
                : "this dashboard will refresh as reconciliation completes."}
            </Alert.Description>
          </Alert.Content>
          {githubApplication.remoteConfigState === "blocked_unknown" ? (
            <Button variant="secondary" onPress={() => snapshot.refetch()}>
              Refresh observations
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar>
                <Avatar.Fallback>{initials(tenant.displayName)}</Avatar.Fallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{tenant.displayName}</p>
                <p className="text-sm text-muted">
                  Revision {tenant.configVersion} · {tenant.status}
                </p>
              </div>
            </div>
            <Chip
              color={data.readiness === "healthy" ? "success" : data.readiness === "suspended" ? "warning" : "danger"}
            >
              {data.readiness}
            </Chip>
          </div>
          <Card.Header>
            <Card.Title>Operate</Card.Title>
            <Card.Description>
              Capability health and repair actions remain here after activation; degradation never rewinds setup.
            </Card.Description>
          </Card.Header>
          <Card.Footer>
            <Button variant="secondary" onPress={() => snapshot.refetch()}>
              <RefreshCw className="size-4" />
              Refresh observations
            </Button>
          </Card.Footer>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <CreditCard className="size-5 text-muted" />
            <Chip color={hasProSubscription ? "accent" : "default"} size="sm">
              {hasProSubscription ? "Pro" : data.entitlement.status}
            </Chip>
          </div>
          <Card.Header>
            <Card.Title>Billing</Card.Title>
            <Card.Description>Manage the subscription without changing tenant identity.</Card.Description>
          </Card.Header>
          <Card.Footer>
            <Button variant="secondary" onPress={async () => await authClient.customer.portal()}>
              Manage billing
            </Button>
          </Card.Footer>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(data.capabilities)
          .filter(([name]) => name !== "subscription")
          .map(([name, capability]) => (
            <Card key={name}>
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold capitalize">{name}</p>
                <Chip color={capabilityColor(capability.state)} size="sm">
                  {capability.state}
                </Chip>
              </div>
              <Card.Content>
                <p className="text-sm text-muted">{capability.detail}</p>
                {capability.observedAtMs ? (
                  <p className="mt-2 text-xs text-muted">
                    Observed {new Date(capability.observedAtMs).toLocaleString()}
                  </p>
                ) : null}
              </Card.Content>
              <Card.Footer className="flex flex-wrap gap-2">
                {name === "workspace" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={!data.entitlement.entitled || Boolean(lifecycleOperation)}
                    isPending={busy === "restart"}
                    onPress={() =>
                      run(
                        "restart",
                        async () =>
                          void (await client.coworker.runtime.restart({ operationIdentity: identityFor("restart") })),
                      )
                    }
                  >
                    {tenant.desiredState === "stopped" ? "Resume runtime" : "Restart runtime"}
                  </Button>
                ) : null}
                {name === "model" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={!data.entitlement.entitled || capability.state === "repairing"}
                    isPending={busy === "model"}
                    onPress={() =>
                      run("model", async () =>
                        setModelChallenge(
                          await client.coworker.model.beginAuth({ operationIdentity: identityFor("model") }),
                        ),
                      )
                    }
                  >
                    {capability.state === "uncertain" ? "Retry credential" : "Replace credential"}
                  </Button>
                ) : null}
                {name === "whatsapp" ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={!data.entitlement.entitled || Boolean(lifecycleOperation)}
                      isPending={busy === "whatsapp-repair"}
                      onPress={() =>
                        run(
                          "whatsapp-repair",
                          async () =>
                            void (await client.coworker.whatsapp.beginRepair({
                              operationIdentity: identityFor("repair"),
                            })),
                        )
                      }
                    >
                      Begin re-pair
                    </Button>
                    {repairOperation ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        isPending={busy === "whatsapp-pairing"}
                        onPress={() =>
                          run("whatsapp-pairing", async () => setPairing(await client.coworker.whatsapp.pairing()))
                        }
                      >
                        Show challenge
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {name === "github" && githubRepairRole ? (
                  githubRepairRole.status === "installed" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      isPending={busy === "github"}
                      onPress={() => run("github", async () => loadRepositories(githubRepairRole.role))}
                    >
                      Choose {githubRepairRole.role} repositories
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      isPending={busy === "github"}
                      onPress={() => run("github", async () => reconnectGitHub(githubRepairRole.role))}
                    >
                      Reconnect {githubRepairRole.role}
                    </Button>
                  )
                ) : null}
              </Card.Footer>
            </Card>
          ))}
      </div>

      {repositories && repositoryRole ? (
        <Card>
          <Card.Header>
            <Card.Title>Repair {repositoryRole} repositories</Card.Title>
            <Card.Description>
              Choose the repositories admitted for this installed GitHub App role and one default.
            </Card.Description>
          </Card.Header>
          <Card.Content className="grid gap-4 md:grid-cols-2">
            <Fieldset>
              <Fieldset.Legend>Repositories</Fieldset.Legend>
              <Fieldset.Group>
                {repositories.map((repository) => (
                  <Checkbox
                    key={repository.id}
                    isSelected={selectedRepositories.includes(String(repository.id))}
                    value={String(repository.id)}
                    onChange={(isSelected) =>
                      setSelectedRepositories((current) =>
                        isSelected
                          ? [...current, String(repository.id)]
                          : current.filter((id) => id !== String(repository.id)),
                      )
                    }
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      {repository.owner}/{repository.name}
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </Fieldset.Group>
            </Fieldset>
            <RadioGroup
              aria-label={`${repositoryRole} default repository`}
              value={defaultRepository}
              onChange={setDefaultRepository}
            >
              <Label>Default repository</Label>
              {repositories
                .filter((repository) => selectedRepositories.includes(String(repository.id)))
                .map((repository) => (
                  <Radio key={repository.id} value={String(repository.id)}>
                    <Radio.Content>
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      {repository.owner}/{repository.name}
                    </Radio.Content>
                  </Radio>
                ))}
            </RadioGroup>
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button isPending={busy === "github-save"} onPress={() => run("github-save", saveRepositories)}>
              Save repositories
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                setRepositories(undefined);
                setRepositoryRole(undefined);
              }}
            >
              Cancel
            </Button>
          </Card.Footer>
        </Card>
      ) : null}

      {modelChallenge ? (
        <Card>
          <Card.Header>
            <Card.Title>Model replacement</Card.Title>
            <Card.Description>This one-time code remains in browser memory only.</Card.Description>
          </Card.Header>
          <Card.Content>
            <span className="font-mono text-xl font-semibold tracking-widest">{modelChallenge.userCode}</span>
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-3">
            <Button onPress={() => window.open(modelChallenge.verificationUrl, "_blank", "noopener,noreferrer")}>
              Open verification <ExternalLink className="size-4" />
            </Button>
            <Button
              variant="secondary"
              onPress={() => run("model-verify", async () => void (await client.coworker.model.verify()))}
            >
              Verify
            </Button>
          </Card.Footer>
        </Card>
      ) : null}

      {pairing ? (
        <Card>
          <Card.Header>
            <Card.Title>WhatsApp re-pair</Card.Title>
            <Card.Description>
              Managed Chats remain stored while the same setup profile is paired again.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            {pairing.status === "pairing" ? (
              pairing.method === "pairing_code" ? (
                <span className="font-mono text-xl font-semibold tracking-widest">{pairing.code}</span>
              ) : pairingQr ? (
                <div
                  className="w-fit max-w-full overflow-auto rounded-xl bg-black p-4 text-white"
                  aria-label="Short-lived WhatsApp repair QR code"
                  role="img"
                >
                  <pre aria-hidden="true" className="text-[8px] leading-[8px] tracking-normal">
                    {pairingQr}
                  </pre>
                </div>
              ) : (
                <Spinner />
              )
            ) : (
              <Alert status={pairing.status === "paired" ? "success" : "warning"}>
                <Alert.Content>
                  <Alert.Title>{pairing.status === "paired" ? "Paired" : "Pairing is not active yet"}</Alert.Title>
                </Alert.Content>
              </Alert>
            )}
          </Card.Content>
        </Card>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title>Recent operations</Card.Title>
          <Card.Description>Durable receipts for restart, repair, provisioning, and activation.</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          {data.operations.length === 0 ? (
            <p className="text-sm text-muted">No operations recorded.</p>
          ) : (
            data.operations.slice(0, 6).map((operation, index) => (
              <div key={operation.id}>
                {index > 0 ? <Separator className="mb-3" /> : null}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{operation.kind.replaceAll("_", " ")}</p>
                    <p className="text-xs text-muted">{new Date(operation.startedAtMs).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {["pending", "running", "uncertain"].includes(operation.status) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        isPending={busy === `operation-${operation.id}`}
                        onPress={() =>
                          run(
                            `operation-${operation.id}`,
                            async () => void (await client.coworker.operation({ operationId: operation.id })),
                          )
                        }
                      >
                        Reconcile
                      </Button>
                    ) : null}
                    <Chip
                      color={capabilityColor(operation.status === "succeeded" ? "healthy" : operation.status)}
                      size="sm"
                    >
                      {operation.status}
                    </Chip>
                  </div>
                </div>
              </div>
            ))
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Signed-in account</Card.Title>
        </Card.Header>
        <Card.Content className="flex items-center gap-3">
          <Avatar>
            <Avatar.Fallback>{initials(session.user.name)}</Avatar.Fallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium">{session.user.name}</p>
            <p className="truncate text-sm text-muted">{session.user.email}</p>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
