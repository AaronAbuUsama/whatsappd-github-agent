export const rubricCriteria = [
  { id: "floorFirst", label: "Floor-first" },
  { id: "reversibility", label: "Reversibility" },
  { id: "blastRadius", label: "Blast radius" },
  { id: "integrity", label: "Correctness / integrity" },
  { id: "parallelizability", label: "Parallelizability" },
  { id: "existingFit", label: "Existing fit" },
];

export const flowOptions = [
  {
    id: "guided",
    title: "Guided setup → operate",
    strapline: "One next action at a time; independent facts remain the authority.",
    recommended: true,
    scores: {
      floorFirst: 5,
      reversibility: 5,
      blastRadius: 4,
      integrity: 5,
      parallelizability: 5,
      existingFit: 5,
    },
    usage:
      "After signup, resume at the first incomplete capability. Activation is explicit. Once active, the same facts render as a compact operate dashboard.",
    hides:
      "Lease acquisition, tenant-DB creation, setup-profile boot, bridge polling, config revision checks, and setup→operate restart.",
    interfaceSketch: `type HostedOnboarding = {
  snapshot(tenantId?: string): Promise<CoworkerSnapshot>;
  advance(input: OnboardingInput): Promise<CoworkerSnapshot>;
  retry(operationId: string): Promise<CoworkerSnapshot>;
}`,
  },
  {
    id: "board",
    title: "Parallel readiness board",
    strapline: "Model, GitHub, and runtime setup are cards that can progress independently.",
    recommended: false,
    scores: {
      floorFirst: 5,
      reversibility: 5,
      blastRadius: 4,
      integrity: 5,
      parallelizability: 5,
      existingFit: 4,
    },
    usage:
      "After naming a coworker, show a setup board. WhatsApp unlocks Managed Chats; all ready cards unlock a single Activate action.",
    hides:
      "A dependency graph and per-card retry semantics. The user sees more concurrency and more partial states.",
    interfaceSketch: `type ReadinessBoard = {
  facets: Record<Capability, FacetState>;
  blockers: ReadonlyArray<[Capability, Capability]>;
  activationReady: boolean;
}`,
  },
  {
    id: "operate-first",
    title: "Operate-first dashboard",
    strapline: "No onboarding route; incomplete operate cards expand in place.",
    recommended: false,
    scores: {
      floorFirst: 4,
      reversibility: 5,
      blastRadius: 4,
      integrity: 4,
      parallelizability: 4,
      existingFit: 5,
    },
    usage:
      "Signup lands directly on the permanent dashboard. Empty cards contain setup actions until they become status-and-repair cards.",
    hides:
      "The same capability ledger, but mixes first-run education, blocking dependencies, and daily operation on one surface.",
    interfaceSketch: `type CoworkerConsole = {
  capabilities: Record<Capability, CapabilityState>;
  nextAction?: ConsoleAction;
  readiness: "onboarding" | "healthy" | "degraded";
}`,
  },
];

export const persistence = {
  controlPlane: [
    "subscription_entitlement(status, polar_customer_id, polar_subscription_id, last_event_id)",
    "tenant(status, display_name, onboarding_projection, config_revision)",
    "agent_instance(desired_mode, observed_state, dokploy_application_id, runtime_base_url, applied_revision, last_error_code)",
    "tenant_lease(holder_id, fencing_token, expires_at)",
    "model_connection(status, verified_at, credential_version) — metadata only",
    "whatsapp_connection(status, account_jid, observed_at) — challenge material is never stored",
    "tenant_managed_chat(jid, display_name, kind, selected_at)",
    "github_installation(role, installation_id, status) + github_repository(selection, default)",
    "control_operation(id, kind, status, operation_identity, error_code, started_at, settled_at)",
  ],
  tenantDatabase: [
    "WhatsApp/Baileys authentication state (#167/#182)",
    "BYO model credential secret (#167/#182)",
  ],
  tenantLocal: [
    "application.sqlite — Conversation Archive, Managed Chat Inbox, Graph, GitHub operations",
    "flue.sqlite — runtime execution state",
  ],
  derivedOnly: [
    "nextAction — first incomplete prerequisite in the guided presentation",
    "readiness — healthy only when subscription, config revision, runtime, WhatsApp, chats, GitHub, and model are healthy",
    "onboarding route — a projection, never the authorization or activation authority",
  ],
};

export const runtimeBootProfiles = [
  {
    mode: "setup",
    description:
      "The same tenant image/applicationId mounts health, pairing, and chats around one WhatsApp account. Managed Chat ingress remains fail-closed; Speaker, GitHub, and model composition do not start.",
    required: ["tenant DB reference", "runtime bridge secret", "runtimeId"],
  },
  {
    mode: "operate",
    description:
      "The existing createAmbientAgentApp path starts only with a complete, validated ManagedConfig and credentials. The strict schema remains unchanged.",
    required: ["complete ManagedConfig", "tenant DB reference", "GitHub credentials", "runtime bridge secret"],
  },
];

const ticket = (label, url, status = "existing") => ({ label, url, status });

export const screens = [
  {
    id: "account",
    phase: "account",
    title: "Create your account",
    eyebrow: "Account · existing shell",
    route: "/login",
    summary: "Better Auth owns identity and session creation before any tenant state exists.",
    persistedState: ["Better Auth user", "Better Auth session"],
    operations: ["authClient.signUp.email", "authClient.signIn.email", "authClient.getSession"],
    bridge: ["none"],
    errors: [
      "Invalid credentials → inline form error; do not create tenant state.",
      "Duplicate email → switch to sign in.",
      "Network failure → resubmit the same credential request.",
    ],
    visible: ["Name, email, password", "Sign in ↔ sign up switch", "Session-safe redirect"],
    tickets: [
      ticket("#186 · imported SaaS shell", "https://github.com/AaronAbuUsama/ambient-agent/issues/186"),
      ticket("New · hosted auth + billing", "#build-auth-billing", "to-file-after-ratification"),
    ],
  },
  {
    id: "subscription",
    phase: "subscription",
    title: "Hire your coworker",
    eyebrow: "Step 1 · subscription",
    route: "/onboarding/subscription",
    summary: "An active Polar entitlement is the durable gate; checkout success alone is not.",
    persistedState: [
      "subscription_entitlement.status = inactive | active | past_due | canceled",
      "last_event_id makes Polar webhook handling replay-safe",
    ],
    operations: [
      "authClient.checkout({ slug: 'pro' })",
      "authClient.customer.state()",
      "POST /api/auth/polar/webhooks",
    ],
    bridge: ["none"],
    errors: [
      "Checkout canceled → remain inactive and offer Checkout again.",
      "Webhook delayed → show 'Confirming payment' and refresh entitlement; never provision from the success URL.",
      "Past due/canceled → desired runtime mode becomes stopped without deleting tenant credentials.",
    ],
    visible: ["Pro plan", "$20 / month", "Polar checkout", "Confirming-payment state", "Billing portal after activation"],
    tickets: [
      ticket("#186 · Polar shell", "https://github.com/AaronAbuUsama/ambient-agent/issues/186"),
      ticket("New · hosted auth + billing", "#build-auth-billing", "to-file-after-ratification"),
    ],
  },
  {
    id: "coworker",
    phase: "coworker",
    title: "Name your coworker",
    eyebrow: "Step 2 · tenant",
    route: "/onboarding/coworker",
    summary: "Create exactly one tenant draft and its first agent instance for the signed-in owner.",
    persistedState: [
      "tenant.status = onboarding",
      "tenant.display_name",
      "agent_instance.desired_mode = stopped",
      "onboarding_projection = preparing",
    ],
    operations: ["coworker.create({ displayName })", "coworker.snapshot()"],
    bridge: ["none"],
    errors: [
      "Duplicate submit → return the existing tenant using an operation identity.",
      "Invalid/reserved name → inline validation.",
      "Control DB unavailable → no tenant is claimed; retry the create operation.",
    ],
    visible: ["Coworker name", "One-line BYO WhatsApp/model explanation", "Continue"],
    tickets: [
      ticket("#187 · product state machine", "https://github.com/AaronAbuUsama/ambient-agent/issues/187"),
      ticket("New · control-plane schema", "#build-control-schema", "to-file-after-ratification"),
    ],
  },
  {
    id: "preparing",
    phase: "preparing",
    title: "Preparing a private workspace",
    eyebrow: "Step 3 · provision setup profile",
    route: "/onboarding/preparing",
    summary: "Allocate the tenant DB and start the same runtime image in fail-closed setup mode under the single-owner lease.",
    persistedState: [
      "agent_instance.desired_mode = setup",
      "agent_instance.observed_state = provisioning | starting | healthy | failed | uncertain",
      "tenant_lease(holder_id, fencing_token, expires_at)",
      "control_operation.kind = provision_setup",
    ],
    operations: ["coworker.ensureSetup()", "coworker.reconcileOperation(operationId)"],
    bridge: ["GET /health (unauthenticated, coarse liveness only)"],
    errors: [
      "Lease busy → show Reconnecting and retry after the recorded expiry.",
      "Turso or Dokploy failure → preserve the operation receipt and retry the same applicationId.",
      "Lost Dokploy response → uncertain; observe before repeating a mutation.",
      "Health timeout → reconcile service state; never create a second tenant process.",
    ],
    visible: ["Create private credential store", "Deploy tenant runtime", "Wait for setup health", "Retry without losing progress"],
    tickets: [
      ticket("#166 · Dokploy facts", "https://github.com/AaronAbuUsama/ambient-agent/issues/166"),
      ticket("#167 · Turso topology", "https://github.com/AaronAbuUsama/ambient-agent/issues/167"),
      ticket("#169 · provisioner + lease", "https://github.com/AaronAbuUsama/ambient-agent/issues/169"),
      ticket("New · tenant runtime setup profile", "#build-runtime-setup-profile", "to-file-after-ratification"),
    ],
  },
  {
    id: "model",
    phase: "model",
    title: "Connect a model",
    eyebrow: "Step 4 · BYO credential",
    route: "/onboarding/model",
    summary: "Validate a tenant-owned model credential without persisting the secret in the control-plane database.",
    persistedState: [
      "model_connection.status = missing | validating | ready | invalid | revoked",
      "credential_version + verified_at metadata in the control DB",
      "secret in the per-tenant Turso DB only",
    ],
    operations: ["coworker.model.beginAuth()", "coworker.model.completeAuth()", "coworker.model.verify()"],
    bridge: ["none — apps/api writes through the tenant credential-store adapter"],
    errors: [
      "Device code expired/denied → start a new authorization attempt.",
      "Credential invalid → replace secret, keep tenant/runtime allocation.",
      "Tenant DB unavailable → show retryable storage error; never fall back to a shared key.",
    ],
    visible: ["Open verification URL", "One-time device code", "Validating", "Connected as tenant-owned credential"],
    tickets: [
      ticket("#167 · per-tenant secret boundary", "https://github.com/AaronAbuUsama/ambient-agent/issues/167"),
      ticket("#182 · tenant libsql secret store", "https://github.com/AaronAbuUsama/ambient-agent/issues/182"),
      ticket("New · hosted model capture", "#build-model-capture", "to-file-after-ratification"),
    ],
  },
  {
    id: "whatsapp",
    phase: "whatsapp",
    title: "Give your coworker a WhatsApp line",
    eyebrow: "Step 5 · pair WhatsApp",
    route: "/onboarding/whatsapp",
    summary: "The browser receives sanitized pairing state through apps/api; challenge material never enters unauthenticated health or durable control state.",
    persistedState: [
      "whatsapp_connection.status = unpaired | pairing | paired | online | re_pair_required | failed",
      "account_jid + observed_at only",
      "Baileys auth state in the per-tenant Turso DB",
    ],
    operations: ["coworker.whatsapp.pairing()", "coworker.whatsapp.retrySetup()"],
    bridge: ["GET /pairing (HMAC x-ambient-agent-bridge)", "GET /health"],
    errors: [
      "Pairing challenge expired → poll for the replacement; never store or log it.",
      "Bridge 401 → rotate/reconcile the bridge secret; do not expose pairing through /health.",
      "440/logged_out → explicit re-pair required; preserve configuration and model/GitHub state.",
      "Runtime unavailable → reconcile the leased setup process.",
    ],
    visible: ["QR or pairing code", "Expiry countdown", "Linked/online state", "Re-pair action after explicit failure"],
    tickets: [
      ticket("#171 · bridge contract", "https://github.com/AaronAbuUsama/ambient-agent/issues/171"),
      ticket("#181 · pairing + health bridge", "https://github.com/AaronAbuUsama/ambient-agent/issues/181"),
      ticket("#182 · durable tenant credentials", "https://github.com/AaronAbuUsama/ambient-agent/issues/182"),
    ],
  },
  {
    id: "chats",
    phase: "chats",
    title: "Choose Managed Chats",
    eyebrow: "Step 6 · enumerate and tick",
    route: "/onboarding/chats",
    summary: "List real groups/DMs from the authenticated tenant process and require at least one explicit selection.",
    persistedState: [
      "tenant_managed_chat rows keyed by tenant + jid",
      "managed_chat_selection.status = pending | selected",
      "tenant.config_revision increments on replacement",
    ],
    operations: ["coworker.chats.list()", "coworker.chats.replace({ jids })"],
    bridge: ["GET /chats (HMAC x-ambient-agent-bridge)"],
    errors: [
      "Initial sync incomplete → show Still syncing and retry GET /chats.",
      "Zero selection → reject before config revision changes.",
      "WhatsApp auth lost → return to the re-pair subflow.",
      "MVP selection is onboarding-only; later edits stay blocked by #179.",
    ],
    visible: ["Searchable groups/DMs", "Kind + last activity", "Selection count", "At least one required"],
    tickets: [
      ticket("#170 · enumerate/tick decision", "https://github.com/AaronAbuUsama/ambient-agent/issues/170"),
      ticket("#180 · GET /chats", "https://github.com/AaronAbuUsama/ambient-agent/issues/180"),
      ticket("#179 · live changes deferred", "https://github.com/AaronAbuUsama/ambient-agent/issues/179"),
    ],
  },
  {
    id: "github",
    phase: "github",
    title: "Connect GitHub",
    eyebrow: "Step 7 · installation and repositories",
    route: "/onboarding/github",
    summary: "apps/api owns the GitHub App redirect/callback and repository registry; tenant containers never receive the browser callback.",
    persistedState: [
      "github_installation.status = pending | installed | revoked | failed",
      "installation_id per App role",
      "selected repositories + one default repository",
      "delivery_route.status = pending | ready | degraded",
    ],
    operations: [
      "coworker.github.beginInstall({ role })",
      "GET /github/callback",
      "coworker.github.repositories()",
      "coworker.github.selectRepositories()",
    ],
    bridge: [
      "none during install",
      "#168 decides later delivery: HMAC POST /deliveries for push, or a tenant drain for pull",
    ],
    errors: [
      "OAuth state mismatch → reject callback and restart install.",
      "Canceled install/zero repository grant → stay on GitHub step.",
      "Duplicate callback → idempotently return the stored installation.",
      "Revocation → operate dashboard becomes degraded until relinked.",
    ],
    visible: ["Connect GitHub", "App roles", "Repository checklist", "Default repository", "Delivery decision status"],
    tickets: [
      ticket("#168 · delivery mechanism", "https://github.com/AaronAbuUsama/ambient-agent/issues/168"),
      ticket("New · GitHub callback + router", "#build-github-router", "to-file-after-ratification"),
    ],
  },
  {
    id: "activation",
    phase: "activation",
    title: "Bring Ambience online",
    eyebrow: "Step 8 · review and activate",
    route: "/onboarding/activate",
    summary: "Validate all independent facts, render the first complete ManagedConfig, then restart the same leased applicationId into operate mode.",
    persistedState: [
      "tenant.config_revision + agent_instance.applied_revision",
      "agent_instance.desired_mode = operate",
      "control_operation.kind = activate",
      "tenant.status = active only after healthy observation",
    ],
    operations: ["coworker.activation.review()", "coworker.activate({ expectedRevision })"],
    bridge: ["GET /health after setup → operate restart"],
    errors: [
      "Missing/changed prerequisite → 409 stale snapshot; return to the named capability.",
      "Config render/write fails → setup remains the desired mode and no partial operate boot occurs.",
      "Lost Dokploy response → uncertain; reconcile applicationId + applied revision before retry.",
      "Operate health timeout → show activation blocked with Restart/Reconcile, not a second container.",
    ],
    visible: ["Model, WhatsApp, Managed Chats, GitHub, billing review", "Explicit Activate Ambience", "Revision-bound progress"],
    tickets: [
      ticket("#169 · lease + lifecycle", "https://github.com/AaronAbuUsama/ambient-agent/issues/169"),
      ticket("#181 · health observation", "https://github.com/AaronAbuUsama/ambient-agent/issues/181"),
      ticket("New · hosted onboarding orchestration", "#build-onboarding", "to-file-after-ratification"),
    ],
  },
  {
    id: "operate",
    phase: "ready",
    title: "Operate your coworker",
    eyebrow: "Ready · daily operation",
    route: "/dashboard",
    summary: "One dashboard projects current control facts plus live tenant health; each degraded card owns its repair action.",
    persistedState: [
      "tenant.status = active | suspended | archived",
      "agent_instance observed health + last observation timestamp",
      "capability status rows and latest durable operation receipts",
      "whatsapp_repair operation = idle | pairing | verifying | succeeded | failed | uncertain",
      "readiness = derived healthy | degraded | suspended",
    ],
    operations: [
      "coworker.dashboard()",
      "coworker.runtime.restart()",
      "coworker.whatsapp.beginRepair()",
      "coworker.model.replaceCredential()",
      "authClient.customer.portal()",
    ],
    bridge: ["GET /health", "GET /pairing only during pair/repair", "delivery route selected by #168"],
    errors: [
      "Runtime failed → idempotent restart/reconcile under #169 lease.",
      "WhatsApp logged out → explicit setup-profile re-pair, then return to operate with Managed Chats preserved.",
      "Model invalid or GitHub revoked → degrade only the named capability and show its repair action.",
      "Subscription inactive → suspend runtime without deleting tenant DB or local data.",
    ],
    visible: ["Runtime health", "WhatsApp", "Managed Chats summary", "GitHub", "Model", "Billing", "Repair/re-pair"],
    tickets: [
      ticket("#168 · routed delivery", "https://github.com/AaronAbuUsama/ambient-agent/issues/168"),
      ticket("#169 · runtime lifecycle", "https://github.com/AaronAbuUsama/ambient-agent/issues/169"),
      ticket("New · operate dashboard", "#build-operate-dashboard", "to-file-after-ratification"),
    ],
  },
];

export const transitions = [
  { from: "account", event: "session.created", to: "subscription", guard: "authenticated user" },
  { from: "subscription", event: "subscription.active", to: "coworker", guard: "verified Polar webhook projection" },
  { from: "coworker", event: "tenant.created", to: "preparing", guard: "one tenant draft for owner" },
  { from: "preparing", event: "setup.healthy", to: "model", guard: "lease held + same applicationId observed" },
  { from: "model", event: "model.ready", to: "whatsapp", guard: "tenant-secret validation receipt" },
  { from: "whatsapp", event: "whatsapp.online", to: "chats", guard: "authenticated tenant account" },
  { from: "chats", event: "managedChats.selected", to: "github", guard: "at least one JID" },
  { from: "github", event: "repositories.selected", to: "activation", guard: "all App roles + default repository" },
  {
    from: "activation",
    event: "operate.healthy",
    to: "operate",
    guard: "active entitlement + current config revision + single leased applicationId",
  },
  { from: "operate", event: "subscription.inactive", to: "operate", guard: "render suspended; desired mode stopped; data retained" },
  { from: "operate", event: "capability.degraded", to: "operate", guard: "render named repair card; do not rewind onboarding" },
  {
    from: "operate",
    event: "whatsapp.repair.started",
    to: "operate",
    guard: "persist repair operation; temporarily use setup profile on the same applicationId; preserve Managed Chats",
  },
  {
    from: "operate",
    event: "whatsapp.repair.completed",
    to: "operate",
    guard: "authenticated tenant account observed; clear repair operation; resume operate profile without replaying onboarding",
  },
];

export const decision = {
  question: "Which presentation should become the hosted MVP contract?",
  recommendation: "guided",
  narrowChoice:
    "Ratify Guided setup → operate, with one explicit Activate Ambience action. The capability ledger and same-container setup profile remain identical whichever presentation is chosen.",
};
