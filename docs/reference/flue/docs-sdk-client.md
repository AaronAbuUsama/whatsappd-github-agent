<!-- source: https://flueframework.com/docs/sdk/client/ -->
---
description: Configure an SDK client for a deployed Flue application.
title: createFlueClient(...) | Flue
image: https://flueframework.com/docs/og4.jpg
---

# createFlueClient(...)

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/sdk/client/index.md) 

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

In a browser, `baseUrl` may be relative to `location.origin`. This is the usual same-origin setup:

```ts
const client = createFlueClient({ baseUrl: '/api' });
```

Outside a browser, `baseUrl` must be absolute; a relative value throws an error.

## `createFlueClient(...)`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for the public routes of a deployed Flue application.

## `CreateFlueClientOptions`

| Field   | Type           | Default      | Description                                                                                                     |
| ------- | -------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| baseUrl | string         | —            | URL where the public flue() sub-app is mounted, including any pathname. Browser clients may use a relative URL. |
| fetch   | typeof fetch   | global fetch | Custom HTTP implementation. Also used for Durable Streams event streaming.                                      |
| headers | RequestHeaders | —            | Headers merged into each HTTP and stream request.                                                               |
| token   | string         | —            | Bearer token added to HTTP and stream requests.                                                                 |

## `RequestHeaders`

```ts
type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

Use a function to resolve headers separately for each HTTP request and stream reconnection.

## Docs Navigation

Current page: [createFlueClient(...)](https://flueframework.com/docs/sdk/client/)

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