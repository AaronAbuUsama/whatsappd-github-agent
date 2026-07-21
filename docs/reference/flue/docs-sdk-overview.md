<!-- source: https://flueframework.com/docs/sdk/overview/ -->
---
description: Reference for consuming deployed Flue agents and workflows with @flue/sdk.
title: SDK overview | Flue
image: https://flueframework.com/docs/og4.jpg
---

# SDK overview

Last updated Jun 20, 2026 [ View as Markdown ](https://flueframework.com/docs/sdk/overview/index.md) 

The client SDK is exported from `@flue/sdk`. Use it from applications that consume deployed Flue agents and workflows.

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

## Client

[createFlueClient(...)](https://flueframework.com/docs/sdk/client/) configures access to a deployed Flue application.

## API namespaces

* [client.agents](https://flueframework.com/docs/sdk/agents/) invokes persistent agent instances and streams their events.
* [client.workflows](https://flueframework.com/docs/sdk/workflows/) starts workflow runs.
* [client.runs](https://flueframework.com/docs/sdk/runs/) inspects and streams runs exposed by their owning workflows.

Deployment-wide listing (all runs, all agents) is a server-side concern: compose your own endpoints from the `listRuns()`, `getRun()`, and `listAgents()` primitives exported by `@flue/runtime`. See [compose your own admin endpoints](https://flueframework.com/docs/api/routing-api/#compose-your-own-admin-endpoints).

## Shared types

* [Events and records](https://flueframework.com/docs/sdk/events/) describes observable events, records, and normalized model-turn data.
* [Errors](https://flueframework.com/docs/sdk/errors/) describes HTTP and stream errors.

## Docs Navigation

Current page: [SDK overview](https://flueframework.com/docs/sdk/overview/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

### SDK

* [ Overview ](https://flueframework.com/docs/sdk/overview/)
* [ createFlueClient(...) ](https://flueframework.com/docs/sdk/client/)  
  * [ CreateFlueClientOptions ](https://flueframework.com/docs/sdk/client/#createflueclientoptions)
  * [ RequestHeaders ](https://flueframework.com/docs/sdk/client/#requestheaders)
* [ client.agents ](https://flueframework.com/docs/sdk/agents/)  
  * [ prompt(...) ](https://flueframework.com/docs/sdk/agents/#clientagentsprompt)
  * [ send(...) ](https://flueframework.com/docs/sdk/agents/#clientagentssend)
  * [ stream(...) ](https://flueframework.com/docs/sdk/agents/#clientagentsstream)
* [ client.workflows ](https://flueframework.com/docs/sdk/workflows/)  
  * [ invoke(...) ](https://flueframework.com/docs/sdk/workflows/#clientworkflowsinvoke)
* [ client.runs ](https://flueframework.com/docs/sdk/runs/)  
  * [ get(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsget)
  * [ events(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsevents)
  * [ stream(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsstream)
* [ Events and records ](https://flueframework.com/docs/sdk/events/)
* [ Errors ](https://flueframework.com/docs/sdk/errors/)