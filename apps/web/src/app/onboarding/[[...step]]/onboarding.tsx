"use client";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  FieldError,
  Fieldset,
  Input,
  Label,
  ProgressBar,
  Radio,
  RadioGroup,
  Skeleton,
  Spinner,
  TextField,
} from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import qrCode from "qrcode-terminal";
import { useEffect, useMemo, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { env } from "@ambient-agent/env/web";
import { client, orpc } from "@/utils/orpc";

const stages = [
  {
    id: "subscription",
    title: "Choose hosted access",
    description: "Activate the hosted plan before any tenant resources are allocated.",
  },
  {
    id: "coworker",
    title: "Name your coworker",
    description: "Create the one tenant-bound coworker this account will operate.",
  },
  {
    id: "preparing",
    title: "Prepare the private workspace",
    description: "Provision the tenant credential store and the setup-profile runtime.",
  },
  {
    id: "model",
    title: "Connect a model",
    description: "Authorize a tenant-owned model credential. The control plane stores metadata only.",
  },
  {
    id: "whatsapp",
    title: "Pair WhatsApp",
    description: "Read the short-lived pairing challenge from the authenticated tenant runtime.",
  },
  {
    id: "chats",
    title: "Choose Managed Chats",
    description: "Select real groups or direct chats synchronized by this WhatsApp account.",
  },
  {
    id: "github",
    title: "Connect GitHub",
    description: "Install each existing GitHub App role and choose its default repository.",
  },
  {
    id: "activation",
    title: "Activate Ambience",
    description: "Apply the current configuration revision and enter permanent Operate mode.",
  },
] as const;

type GitHubRole = "coder" | "reviewer" | "planner";
type GitHubRepository = {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly selected: boolean;
  readonly isDefault: boolean;
};

const apiUrl = (path: string) => new URL(path, env.NEXT_PUBLIC_SERVER_URL).toString();
const message = (cause: unknown) => (cause instanceof Error ? cause.message : "The request could not be completed.");

export default function Onboarding() {
  const router = useRouter();
  const pathname = usePathname();
  const snapshot = useQuery({ ...orpc.coworker.refresh.queryOptions(), refetchInterval: 3_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [displayName, setDisplayName] = useState("");
  const [modelChallenge, setModelChallenge] = useState<{
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  }>();
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof client.coworker.whatsapp.pairing>>>();
  const [pairingQr, setPairingQr] = useState<string>();
  const [chats, setChats] = useState<Awaited<ReturnType<typeof client.coworker.chats.list>>>([]);
  const [selectedChats, setSelectedChats] = useState<string[]>([]);
  const [repositories, setRepositories] = useState<Partial<Record<GitHubRole, readonly GitHubRepository[]>>>({});
  const [selectedRepositories, setSelectedRepositories] = useState<Partial<Record<GitHubRole, string[]>>>({});
  const [defaultRepositories, setDefaultRepositories] = useState<Partial<Record<GitHubRole, string>>>({});
  const operationIdentities = useRef<Partial<Record<"create" | "setup" | "model" | "activate", string>>>({});

  const identityFor = (kind: "create" | "setup" | "model" | "activate") => {
    operationIdentities.current[kind] ??= crypto.randomUUID();
    return operationIdentities.current[kind];
  };

  const activeStage = snapshot.data?.nextAction === "operate" ? undefined : snapshot.data?.nextAction;
  const stageIndex = Math.max(
    0,
    stages.findIndex((stage) => stage.id === activeStage),
  );
  const stage = stages[stageIndex] ?? stages[0];

  useEffect(() => {
    if (!snapshot.data) return;
    if (snapshot.data.nextAction === "operate") {
      router.replace("/dashboard");
      return;
    }
    const expectedPath = `/onboarding/${snapshot.data.nextAction}` as Route;
    if (pathname !== expectedPath) router.replace(expectedPath);
  }, [pathname, router, snapshot.data]);

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
    if (data.tenant) delete operationIdentities.current.create;
    if (data.capabilities.model.state === "healthy") {
      setModelChallenge(undefined);
      delete operationIdentities.current.model;
    }
    if (data.capabilities.whatsapp.state === "healthy") setPairing(undefined);
    for (const [key, kind] of [
      ["setup", "provision_setup"],
      ["activate", "activate"],
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

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    await snapshot.refetch();
  };

  const loadChats = async () =>
    await run(async () => {
      const available = await client.coworker.chats.list();
      setChats(available);
      const persisted = new Set(snapshot.data?.managedChats.map((chat) => chat.jid) ?? []);
      setSelectedChats(available.filter((chat) => persisted.has(chat.jid)).map((chat) => chat.jid));
    });

  const loadRepositories = async (role: GitHubRole) =>
    await run(async () => {
      const response = await fetch(
        apiUrl(`/api/github/repositories/${role}?tenantId=${encodeURIComponent(snapshot.data?.tenant?.id ?? "")}`),
        { credentials: "include" },
      );
      const body = (await response.json()) as readonly GitHubRepository[] | { error?: string };
      if (!response.ok || !Array.isArray(body)) {
        const apiError = Array.isArray(body) ? undefined : (body as { error?: string }).error;
        throw new Error(apiError ?? "GitHub repositories could not be loaded.");
      }
      setRepositories((current) => ({ ...current, [role]: body }));
      setSelectedRepositories((current) => ({
        ...current,
        [role]: body.filter((repository) => repository.selected).map((repository) => String(repository.id)),
      }));
      setDefaultRepositories((current) => ({
        ...current,
        [role]: String(body.find((repository) => repository.isDefault)?.id ?? ""),
      }));
    });

  const installGitHub = async (role: GitHubRole) =>
    await run(async () => {
      const response = await fetch(apiUrl(`/api/github/installations/${role}`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: snapshot.data?.tenant?.id }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "GitHub installation could not start.");
      const popup = window.open(body.url, `ambient-github-${role}`, "popup,width=980,height=760");
      if (!popup) throw new Error("Allow the GitHub installation window, then retry.");
      popup.opener = null;
    });

  const saveRepositories = async (role: GitHubRole) =>
    await run(async () => {
      const selected = (selectedRepositories[role] ?? []).map(Number);
      const defaultRepositoryId = Number(defaultRepositories[role]);
      if (!selected.includes(defaultRepositoryId)) throw new Error("Choose one selected repository as the default.");
      const response = await fetch(apiUrl(`/api/github/repositories/${role}`), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: snapshot.data?.tenant?.id, repositoryIds: selected, defaultRepositoryId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository selection could not be saved.");
      await refresh();
    });

  const stepSummary = useMemo(() => `Step ${stageIndex + 1} of ${stages.length}`, [stageIndex]);

  if (snapshot.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <Skeleton className="h-7 w-40 rounded-md" />
        <Skeleton className="mt-5 h-80 w-full rounded-2xl" />
      </div>
    );
  }

  if (snapshot.isError || !snapshot.data) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Onboarding could not be loaded</Alert.Title>
            <Alert.Description>{snapshot.error?.message ?? "The tenant snapshot is unavailable."}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button className="mt-4" onPress={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  const data = snapshot.data;
  const unsettledOperation = (kind: "provision_setup" | "activate") =>
    data.operations.find(
      (operation) => operation.kind === kind && ["pending", "running", "uncertain"].includes(operation.status),
    );
  const reconcile = async (operationId: string) =>
    await run(async () => {
      await client.coworker.operation({ operationId });
      await refresh();
    });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="mb-7 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-accent">Guided setup</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{stage.title}</h1>
          </div>
          <Chip color="accent" size="sm">
            {stepSummary}
          </Chip>
        </div>
        <ProgressBar aria-label={stepSummary} maxValue={stages.length} value={stageIndex + 1}>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <p className="text-sm text-muted sm:text-base">{stage.description}</p>
      </div>

      {error ? (
        <Alert className="mb-5" status="danger">
          <Alert.Content>
            <Alert.Title>Action needs attention</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card>
        {activeStage === "subscription" ? (
          <>
            <Card.Header>
              <Card.Title>Hosted plan</Card.Title>
              <Card.Description>Billing authority comes from the signed Polar webhook projection.</Card.Description>
            </Card.Header>
            <Card.Content className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
              <div>
                <p className="font-medium">Ambient Agent Pro</p>
                <p className="text-sm text-muted">One private coworker and its tenant runtime.</p>
              </div>
              <Chip color={data.entitlement.entitled ? "success" : "default"}>{data.entitlement.status}</Chip>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isPending={busy}
                onPress={() => run(async () => void (await authClient.checkout({ slug: "pro" })))}
              >
                Continue to checkout
              </Button>
              <Button variant="secondary" onPress={refresh}>
                Confirm payment
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "coworker" ? (
          <>
            <Card.Header>
              <Card.Title>Create your coworker</Card.Title>
              <Card.Description>Your model and WhatsApp credentials remain tenant-owned.</Card.Description>
            </Card.Header>
            <Card.Content>
              <TextField
                isInvalid={displayName.trim().length > 0 && displayName.trim().length < 2}
                value={displayName}
                onChange={setDisplayName}
              >
                <Label>Coworker name</Label>
                <Input autoComplete="off" placeholder="Eve" />
                <FieldError>Use between 2 and 48 characters.</FieldError>
              </TextField>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isDisabled={displayName.trim().length < 2}
                isPending={busy}
                onPress={() =>
                  run(async () => {
                    await client.coworker.create({ displayName, operationIdentity: identityFor("create") });
                    await refresh();
                  })
                }
              >
                Create coworker
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "preparing" ? (
          <>
            <Card.Header>
              <Card.Title>Private workspace</Card.Title>
              <Card.Description>{data.capabilities.workspace.detail}</Card.Description>
            </Card.Header>
            <Card.Content className="flex items-center gap-3">
              <Spinner size="sm" />
              <span className="text-sm text-muted">Provisioning is reconciled from its durable operation receipt.</span>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isDisabled={Boolean(unsettledOperation("provision_setup"))}
                isPending={busy}
                onPress={() =>
                  run(async () => {
                    await client.coworker.ensureSetup({ operationIdentity: identityFor("setup") });
                    await refresh();
                  })
                }
              >
                Retry setup
              </Button>
              {unsettledOperation("provision_setup") ? (
                <Button
                  variant="secondary"
                  isPending={busy}
                  onPress={() => reconcile(unsettledOperation("provision_setup")!.id)}
                >
                  Reconcile operation
                </Button>
              ) : null}
              <Button variant="secondary" onPress={refresh}>
                <RefreshCw className="size-4" />
                Refresh
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "model" ? (
          <>
            <Card.Header>
              <Card.Title>Tenant-owned model authorization</Card.Title>
              <Card.Description>{data.capabilities.model.detail}</Card.Description>
            </Card.Header>
            <Card.Content aria-live="polite">
              {modelChallenge ? (
                <Alert status="accent">
                  <Alert.Content>
                    <Alert.Title>Enter this one-time code</Alert.Title>
                    <Alert.Description>
                      <span className="font-mono text-lg font-semibold tracking-wider">{modelChallenge.userCode}</span>
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <p className="text-sm text-muted">
                  The one-time code is returned to this browser only and is never written to control-plane storage.
                </p>
              )}
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isPending={busy}
                onPress={() =>
                  run(async () =>
                    setModelChallenge(
                      await client.coworker.model.beginAuth({ operationIdentity: identityFor("model") }),
                    ),
                  )
                }
              >
                {modelChallenge ? "Start a new authorization" : "Connect model"}
              </Button>
              {modelChallenge ? (
                <Button
                  variant="secondary"
                  onPress={() => window.open(modelChallenge.verificationUrl, "_blank", "noopener,noreferrer")}
                >
                  Open verification <ExternalLink className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onPress={() =>
                  run(async () => {
                    await client.coworker.model.verify();
                    await refresh();
                  })
                }
              >
                Verify
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "whatsapp" ? (
          <>
            <Card.Header>
              <Card.Title>WhatsApp pairing</Card.Title>
              <Card.Description>{data.capabilities.whatsapp.detail}</Card.Description>
            </Card.Header>
            <Card.Content aria-live="polite">
              {pairing?.status === "pairing" ? (
                pairing.method === "pairing_code" ? (
                  <Alert status="accent">
                    <Alert.Content>
                      <Alert.Title>Pairing code</Alert.Title>
                      <Alert.Description>
                        <span className="font-mono text-xl font-semibold tracking-widest">{pairing.code}</span>
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : pairingQr ? (
                  <div
                    className="w-fit max-w-full overflow-auto rounded-xl bg-black p-4 text-white"
                    aria-label="Short-lived WhatsApp pairing QR code"
                    role="img"
                  >
                    <pre aria-hidden="true" className="text-[8px] leading-[8px] tracking-normal">
                      {pairingQr}
                    </pre>
                  </div>
                ) : (
                  <Spinner />
                )
              ) : pairing?.status === "paired" ? (
                <Alert status="success">
                  <Alert.Content>
                    <Alert.Title>WhatsApp is paired</Alert.Title>
                    <Alert.Description>Waiting for the online ledger observation.</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <p className="text-sm text-muted">
                  Pairing material is requested over the authenticated runtime bridge and kept in browser memory only.
                </p>
              )}
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isPending={busy}
                onPress={() => run(async () => setPairing(await client.coworker.whatsapp.pairing()))}
              >
                {pairing ? "Refresh challenge" : "Show pairing challenge"}
              </Button>
              <Button variant="secondary" onPress={refresh}>
                Check connection
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "chats" ? (
          <>
            <Card.Header>
              <Card.Title>Managed Chats</Card.Title>
              <Card.Description>Only selected chats can admit ambient work.</Card.Description>
            </Card.Header>
            <Card.Content>
              {chats.length === 0 ? (
                <p className="text-sm text-muted">Load synchronized chats from the paired tenant runtime.</p>
              ) : (
                <Fieldset>
                  <Fieldset.Legend className="sr-only">Managed Chats</Fieldset.Legend>
                  <Fieldset.Group>
                    {chats.map((chat) => (
                      <Checkbox
                        key={chat.jid}
                        isSelected={selectedChats.includes(chat.jid)}
                        value={chat.jid}
                        onChange={(isSelected) =>
                          setSelectedChats((current) =>
                            isSelected ? [...current, chat.jid] : current.filter((jid) => jid !== chat.jid),
                          )
                        }
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <span className="font-medium">{chat.name || chat.jid}</span>
                          <span className="ml-2 text-xs text-muted">{chat.kind}</span>
                        </Checkbox.Content>
                      </Checkbox>
                    ))}
                  </Fieldset.Group>
                </Fieldset>
              )}
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button isPending={busy} variant="secondary" onPress={loadChats}>
                Load chats
              </Button>
              <Button
                isDisabled={selectedChats.length === 0}
                isPending={busy}
                onPress={() =>
                  run(async () => {
                    await client.coworker.chats.select({ jids: selectedChats });
                    await refresh();
                  })
                }
              >
                Save Managed Chats
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "github" ? (
          <>
            <Card.Header>
              <Card.Title>GitHub App roles</Card.Title>
              <Card.Description>
                The existing tenant-bound callback and repository registry handle each role.
              </Card.Description>
            </Card.Header>
            <Card.Content className="flex flex-col gap-4">
              {data.github.map((installation) => {
                const role = installation.role;
                const available = repositories[role];
                return (
                  <Card key={role} variant="secondary">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium capitalize">{role}</p>
                        <p className="text-sm text-muted">{installation.accountLogin ?? "Not connected"}</p>
                      </div>
                      <Chip
                        color={
                          installation.status === "installed"
                            ? "success"
                            : installation.status === "failed" || installation.status === "revoked"
                              ? "danger"
                              : "default"
                        }
                        size="sm"
                      >
                        {installation.status}
                      </Chip>
                    </div>
                    {available ? (
                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <Fieldset>
                          <Fieldset.Legend>Repositories</Fieldset.Legend>
                          <Fieldset.Group>
                            {available.map((repository) => (
                              <Checkbox
                                key={repository.id}
                                isSelected={(selectedRepositories[role] ?? []).includes(String(repository.id))}
                                value={String(repository.id)}
                                onChange={(isSelected) =>
                                  setSelectedRepositories((current) => ({
                                    ...current,
                                    [role]: isSelected
                                      ? [...(current[role] ?? []), String(repository.id)]
                                      : (current[role] ?? []).filter((id) => id !== String(repository.id)),
                                  }))
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
                          aria-label={`${role} default repository`}
                          value={defaultRepositories[role] ?? ""}
                          onChange={(value) => setDefaultRepositories((current) => ({ ...current, [role]: value }))}
                        >
                          <Label>Default repository</Label>
                          {available
                            .filter((repository) => (selectedRepositories[role] ?? []).includes(String(repository.id)))
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
                      </div>
                    ) : null}
                    <Card.Footer className="mt-3 flex flex-wrap gap-2 px-0 pb-0">
                      {installation.status === "installed" ? (
                        <>
                          <Button size="sm" variant="secondary" onPress={() => loadRepositories(role)}>
                            Choose repositories
                          </Button>
                          {available ? (
                            <Button size="sm" isPending={busy} onPress={() => saveRepositories(role)}>
                              Save {role}
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <Button size="sm" isPending={busy} onPress={() => installGitHub(role)}>
                          Connect {role}
                        </Button>
                      )}
                    </Card.Footer>
                  </Card>
                );
              })}
            </Card.Content>
            <Card.Footer>
              <Button variant="secondary" onPress={refresh}>
                Refresh GitHub status
              </Button>
            </Card.Footer>
          </>
        ) : null}

        {activeStage === "activation" ? (
          <>
            <Card.Header>
              <Card.Title>Revision {data.tenant?.configVersion}</Card.Title>
              <Card.Description>
                Activation verifies the runtime route and binds the operation to this exact revision.
              </Card.Description>
            </Card.Header>
            <Card.Content className="grid gap-2 sm:grid-cols-2">
              {Object.entries(data.capabilities).map(([name, capability]) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-separator px-3 py-2"
                  key={name}
                >
                  <span className="text-sm capitalize">{name}</span>
                  <Chip color={capability.state === "healthy" ? "success" : "warning"} size="sm">
                    {capability.state}
                  </Chip>
                </div>
              ))}
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button
                isDisabled={Boolean(unsettledOperation("activate")) || !data.configurationRevision}
                isPending={busy}
                onPress={() =>
                  run(async () => {
                    await client.coworker.activate({
                      expectedConfigVersion: data.tenant?.configVersion ?? 0,
                      expectedBasisFingerprint: data.configurationRevision?.basisFingerprint ?? "",
                      operationIdentity: identityFor("activate"),
                    });
                    await refresh();
                  })
                }
              >
                Activate Ambience
              </Button>
              {unsettledOperation("activate") ? (
                <Button
                  variant="secondary"
                  isPending={busy}
                  onPress={() => reconcile(unsettledOperation("activate")!.id)}
                >
                  Reconcile activation
                </Button>
              ) : null}
            </Card.Footer>
          </>
        ) : null}
      </Card>
    </div>
  );
}
