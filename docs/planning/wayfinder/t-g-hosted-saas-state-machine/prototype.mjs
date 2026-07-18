import { decision, flowOptions, rubricCriteria, screens } from "./model.mjs";

const byId = new Map(screens.map((screen) => [screen.id, screen]));
const setupScreens = screens.filter((screen) => !["account", "operate"].includes(screen.id));
let currentId = location.hash.replace("#", "") || "subscription";
let simulatedState = "idle";

if (!document.documentElement.dataset.theme) {
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const icon = (name) => {
  const icons = {
    account: "◎",
    subscription: "◈",
    coworker: "✦",
    preparing: "◌",
    model: "◇",
    whatsapp: "◫",
    chats: "☷",
    github: "⌘",
    activation: "↗",
    operate: "●",
  };
  return icons[name] ?? "•";
};

const ticketLinks = (tickets) =>
  tickets
    .map((item) => {
      if (item.url.startsWith("#")) return `<span class="ticket future">${escapeHtml(item.label)}</span>`;
      return `<a class="ticket" href="${escapeHtml(item.url)}">${escapeHtml(item.label)}</a>`;
    })
    .join("");

const detailList = (title, items, kind = "plain") => `
  <section class="contract-block">
    <h3>${escapeHtml(title)}</h3>
    <ul class="contract-list ${kind}">
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  </section>`;

const qrPlaceholder = () => `
  <div class="qr" role="img" aria-label="Illustrative QR placeholder; not a real pairing challenge">
    ${Array.from({ length: 81 }, (_, index) => `<i class="${(index * 7 + index % 5) % 3 === 0 ? "on" : ""}"></i>`).join("")}
  </div>`;

const renderMock = (screen) => {
  const mocks = {
    account: `
      <div class="mock-card auth-card">
        <span class="mock-kicker">Start with Ambient Agent</span>
        <h2>Create your account</h2>
        <label>Name<input value="Aaron" aria-label="Name" /></label>
        <label>Email<input value="aaron@example.com" aria-label="Email" /></label>
        <label>Password<input value="••••••••••••" aria-label="Password" /></label>
        <button class="primary wide" data-simulate>Create account</button>
      </div>`,
    subscription: `
      <div class="mock-card plan-card">
        <div class="plan-heading"><span class="brand-mark">✦</span><span class="status neutral">MVP plan</span></div>
        <div><span class="mock-kicker">Ambient Agent Pro</span><h2>$20 <small>/ month</small></h2></div>
        <ul class="checks"><li>One hosted coworker</li><li>Your WhatsApp number</li><li>Your model credential</li><li>Your GitHub repositories</li></ul>
        <button class="primary" data-simulate>Continue to Polar</button>
        <p class="fineprint">Provisioning starts only after the signed webhook says active.</p>
      </div>`,
    coworker: `
      <div class="mock-card focus-card">
        <span class="mock-kicker">Coworker identity</span>
        <h2>What should your team call them?</h2>
        <label>Display name<input value="Ambience" aria-label="Coworker display name" /></label>
        <p class="field-help">You can change the display name later. The tenant identity stays stable.</p>
        <button class="primary" data-simulate>Create Ambience</button>
      </div>`,
    preparing: `
      <div class="mock-card progress-card">
        <div class="spinner" aria-hidden="true"></div>
        <span class="mock-kicker">Private workspace</span>
        <h2>${simulatedState === "done" ? "Setup runtime is healthy" : "Preparing Ambience…"}</h2>
        <ol class="provision-list">
          <li class="done"><b>1</b><span>Create isolated tenant database<small>Turso Cloud · scoped token</small></span></li>
          <li class="done"><b>2</b><span>Acquire single-owner lease<small>Fenced operation · same applicationId</small></span></li>
          <li class="${simulatedState === "done" ? "done" : "active"}"><b>3</b><span>Start setup profile<small>Fail-closed · pairing bridge only</small></span></li>
        </ol>
        <button class="secondary" data-simulate>Simulate completion</button>
      </div>`,
    model: `
      <div class="mock-card oauth-card">
        <div class="provider-row"><span class="provider-icon">AI</span><div><span class="mock-kicker">Tenant-owned credential</span><h2>Connect your model</h2></div></div>
        <p>Open the verification page, then enter this one-time code.</p>
        <div class="device-code">FK9P-WQ2M <button aria-label="Copy device code">Copy</button></div>
        <button class="primary" data-simulate>${simulatedState === "done" ? "Connected ✓" : "Open verification page ↗"}</button>
        <p class="fineprint">The secret is written to this tenant’s Turso database—not the control plane.</p>
      </div>`,
    whatsapp: `
      <div class="mock-card pairing-card">
        <div class="pair-copy"><span class="mock-kicker">WhatsApp · Linked devices</span><h2>Scan to link Ambience</h2><ol><li>Open WhatsApp on the dedicated phone</li><li>Choose Linked devices</li><li>Scan this rotating code</li></ol><span class="status warning">Refreshes in 43s</span></div>
        ${qrPlaceholder()}
      </div>`,
    chats: `
      <div class="mock-card chats-card">
        <div class="row between"><div><span class="mock-kicker">Explicit participation boundary</span><h2>Choose Managed Chats</h2></div><span class="status success">2 selected</span></div>
        <label class="search"><span>⌕</span><input placeholder="Search groups and chats" aria-label="Search chats" /></label>
        <div class="chat-list">
          <label><input type="checkbox" checked /><span class="avatar lavender">CE</span><span>Capxul Engineering<small>Group · active 2m ago</small></span></label>
          <label><input type="checkbox" checked /><span class="avatar mint">TS</span><span>TST<small>Group · active 18m ago</small></span></label>
          <label><input type="checkbox" /><span class="avatar peach">AA</span><span>Aaron AbuUsama<small>Direct · active yesterday</small></span></label>
        </div>
      </div>`,
    github: `
      <div class="mock-card github-card">
        <div class="row between"><div><span class="mock-kicker">GitHub App installation</span><h2>Connect repositories</h2></div><span class="github-logo">⌘</span></div>
        <div class="install-row"><span><b>Ambient Agent Apps</b><small>Coder · Reviewer · Planner</small></span><button class="secondary" data-simulate>${simulatedState === "done" ? "Installed ✓" : "Install ↗"}</button></div>
        <p class="label-text">Repository access</p>
        <label class="repo"><input type="radio" name="default" checked /><span>AaronAbuUsama/ambient-agent<small>Default repository</small></span><input type="checkbox" checked aria-label="Allow ambient-agent" /></label>
        <label class="repo"><input type="radio" name="default" /><span>AaronAbuUsama/capxul<small>Additional repository</small></span><input type="checkbox" checked aria-label="Allow capxul" /></label>
      </div>`,
    activation: `
      <div class="mock-card review-card">
        <span class="mock-kicker">Revision 4 · all gates ready</span>
        <h2>Bring Ambience online</h2>
        <div class="review-grid"><span>Model <b>Ready</b></span><span>WhatsApp <b>Online</b></span><span>Managed Chats <b>2 selected</b></span><span>GitHub <b>2 repositories</b></span><span>Billing <b>Active</b></span><span>Runtime <b>Setup healthy</b></span></div>
        <button class="primary wide" data-activate>Activate Ambience</button>
        <p class="fineprint">Writes one complete config, then restarts the same leased tenant application.</p>
      </div>`,
    operate: `
      <div class="operate-grid">
        <div class="health-banner"><span class="health-dot"></span><div><span class="mock-kicker">Ambience</span><h2>${simulatedState === "repairing" ? "Repairing WhatsApp in place" : "Healthy and listening"}</h2></div><span class="status ${simulatedState === "repairing" ? "warning" : "success"}">${simulatedState === "repairing" ? "Degraded" : "Online"}</span></div>
        ${[
          ["Runtime", "Healthy", "Revision 4 · observed now"],
          ["WhatsApp", simulatedState === "repairing" ? "Pairing" : "Online", simulatedState === "repairing" ? "Managed Chats preserved · finish re-pair" : "+233 ••• •• 47 · re-pair"],
          ["Managed Chats", "2 chats", "Changes after MVP · #179"],
          ["GitHub", "Connected", "2 repositories · delivery pending #168"],
          ["Model", "Ready", "Tenant credential · rotate"],
          ["Billing", "Pro", "Active · manage subscription"],
        ]
          .map(([label, value, note]) => `<div class="status-card"><span class="card-icon">${icon(label.toLowerCase())}</span><span><small>${label}</small><b>${value}</b><em>${note}</em></span><button ${label === "WhatsApp" ? "data-repair" : ""} aria-label="${label === "WhatsApp" ? (simulatedState === "repairing" ? "Finish WhatsApp re-pair" : "Repair WhatsApp") : `Open ${label}`}">${label === "WhatsApp" && simulatedState === "repairing" ? "✓" : "→"}</button></div>`)
          .join("")}
      </div>`,
  };
  return mocks[screen.id] ?? "";
};

const renderNavigation = () => {
  document.querySelector("#step-nav").innerHTML = setupScreens
    .map(
      (screen, index) => `
      <button class="step-link ${screen.id === currentId ? "active" : ""}" data-screen="${screen.id}" aria-current="${screen.id === currentId ? "step" : "false"}">
        <span class="step-index">${index + 1}</span>
        <span><b>${escapeHtml(screen.title)}</b><small>${escapeHtml(screen.phase)}</small></span>
      </button>`,
    )
    .join("");
};

const renderScreen = (screen) => {
  const currentIndex = setupScreens.findIndex((item) => item.id === screen.id);
  const total = setupScreens.length;
  document.querySelector("#app").innerHTML = `
    <header class="page-header">
      <div><span class="eyebrow">${escapeHtml(screen.eyebrow)}</span><h1>${escapeHtml(screen.title)}</h1><p>${escapeHtml(screen.summary)}</p></div>
      <span class="route-pill">${escapeHtml(screen.route)}</span>
    </header>
    <div class="screen-layout">
      <section class="wireframe" aria-label="Interactive wireframe">
        <div class="wireframe-top"><span>Hosted product prototype</span><span class="state-chip"><i></i>${simulatedState === "done" ? "simulated ready" : "wireframe state"}</span></div>
        <div class="mock-wrap">${renderMock(screen)}</div>
        <footer class="wizard-footer">
          <div>${currentIndex >= 0 ? `<b>${currentIndex + 1}</b> of ${total}` : "Operate"}<span class="mini-progress"><i style="width:${currentIndex >= 0 ? ((currentIndex + 1) / total) * 100 : 100}%"></i></span></div>
          <div class="row"><button class="secondary" data-prev ${currentIndex <= 0 ? "disabled" : ""}>Back</button><button class="primary" data-next ${currentIndex < 0 || currentIndex === total - 1 ? "disabled" : ""}>Continue</button></div>
        </footer>
      </section>
      <aside class="contract-panel">
        <div class="panel-heading"><span class="status accent">Control contract</span><h2>What this screen means</h2></div>
        ${detailList("Persisted state", screen.persistedState)}
        ${detailList("Owning operation", screen.operations, "code")}
        ${detailList("Tenant bridge", screen.bridge, "code")}
        ${detailList("Errors and retries", screen.errors, "errors")}
        ${detailList("User-visible", screen.visible)}
        <section class="contract-block"><h3>Underlying tickets</h3><div class="tickets">${ticketLinks(screen.tickets)}</div></section>
      </aside>
    </div>`;
};

const scoreTotal = (scores) => Object.values(scores).reduce((sum, value) => sum + value, 0);

const renderDecision = () => {
  document.querySelector("#app").innerHTML = `
    <header class="page-header decision-header"><div><span class="eyebrow">Narrow product decision</span><h1>${escapeHtml(decision.question)}</h1><p>${escapeHtml(decision.narrowChoice)}</p></div></header>
    <div class="option-list">
      ${flowOptions
        .map(
          (option) => `
          <article class="option-card ${option.recommended ? "recommended" : ""}">
            <div class="option-summary"><div>${option.recommended ? '<span class="status accent">Recommended</span>' : '<span class="status neutral">Alternative</span>'}<h2>${escapeHtml(option.title)}</h2><p>${escapeHtml(option.strapline)}</p></div><div class="total-score"><b>${scoreTotal(option.scores)}</b><span>/ 30</span></div></div>
            <div class="score-grid">${rubricCriteria.map((criterion) => `<span><small>${escapeHtml(criterion.label)}</small><b>${option.scores[criterion.id]}</b></span>`).join("")}</div>
            <div class="option-notes"><p><b>Usage</b>${escapeHtml(option.usage)}</p><p><b>Hides</b>${escapeHtml(option.hides)}</p></div>
            <pre><code>${escapeHtml(option.interfaceSketch)}</code></pre>
            <button class="${option.recommended ? "primary" : "secondary"}" data-ratify="${option.id}">${option.recommended ? "Ratify this flow" : "Choose this alternative"}</button>
          </article>`,
        )
        .join("")}
    </div>
    <section class="decision-callout"><span class="brand-mark">✦</span><div><span class="mock-kicker">Architecture held constant</span><h2>One capability ledger. One tenant container. Two boot profiles.</h2><p>The choice changes presentation only. Every credible flow preserves the same isolated setup→operate transition and explicit activation gate.</p></div></section>`;
};

const setCurrent = (nextId) => {
  currentId = nextId;
  simulatedState = "idle";
  location.hash = nextId;
  render();
};

const render = () => {
  renderNavigation();
  document.querySelectorAll("[data-top-nav]").forEach((button) =>
    button.classList.toggle("active", button.dataset.topNav === currentId || (button.dataset.topNav === "setup" && byId.has(currentId) && currentId !== "operate")),
  );
  if (currentId === "decision") renderDecision();
  else renderScreen(byId.get(currentId) ?? byId.get("subscription"));
  document
    .querySelector("#theme-toggle")
    .setAttribute("aria-label", `Use ${document.documentElement.dataset.theme === "dark" ? "light" : "dark"} theme`);
};

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.screen) setCurrent(target.dataset.screen);
  if (target.dataset.topNav === "setup") setCurrent("subscription");
  if (target.dataset.topNav === "operate") setCurrent("operate");
  if (target.dataset.topNav === "decision") setCurrent("decision");
  if (target.hasAttribute("data-simulate")) {
    simulatedState = simulatedState === "done" ? "idle" : "done";
    render();
  }
  if (target.hasAttribute("data-activate")) {
    setCurrent("operate");
    const toast = document.querySelector("#toast");
    toast.textContent = "Activation healthy. Ambience is online in Operate.";
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 4200);
  }
  if (target.hasAttribute("data-repair")) {
    const completed = simulatedState === "repairing";
    simulatedState = completed ? "done" : "repairing";
    render();
    if (completed) {
      const toast = document.querySelector("#toast");
      toast.textContent = "WhatsApp repaired. Returned to Operate with Managed Chats preserved.";
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 4200);
    }
  }
  if (target.hasAttribute("data-next")) {
    const index = setupScreens.findIndex((screen) => screen.id === currentId);
    if (setupScreens[index + 1]) setCurrent(setupScreens[index + 1].id);
  }
  if (target.hasAttribute("data-prev")) {
    const index = setupScreens.findIndex((screen) => screen.id === currentId);
    if (setupScreens[index - 1]) setCurrent(setupScreens[index - 1].id);
  }
  if (target.dataset.ratify) {
    document.querySelector("#toast").textContent = `${flowOptions.find((option) => option.id === target.dataset.ratify).title} selected in this prototype. Record the final ratification on #187.`;
    document.querySelector("#toast").classList.add("show");
    setTimeout(() => document.querySelector("#toast").classList.remove("show"), 4200);
  }
  if (target.id === "theme-toggle") {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    target.setAttribute("aria-label", `Use ${next === "dark" ? "light" : "dark"} theme`);
  }
});

window.addEventListener("hashchange", () => {
  currentId = location.hash.replace("#", "") || "subscription";
  render();
});

render();
