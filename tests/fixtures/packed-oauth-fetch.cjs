const jwtPayload = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "packed-account" } }),
).toString("base64url");
const accessToken = `e30.${jwtPayload}.signature`;
const authOrigin = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Invalid packed OAuth request: ${message}`);
};

const assertExactKeys = (value, keys, label) => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} body must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} body fields changed`,
  );
};

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert(url.origin === authOrigin, `unexpected OAuth origin ${url.origin}`);
  assert(request.method === "POST", `${url.pathname} must use POST`);

  if (url.pathname === "/api/accounts/deviceauth/usercode") {
    assert(request.headers.get("content-type") === "application/json", "user-code content type changed");
    const body = JSON.parse(await request.text());
    assertExactKeys(body, ["client_id"], "user-code");
    assert(body.client_id === clientId, "user-code client_id changed");
    return Response.json({ device_auth_id: "packed-device", user_code: "PACK-TEST", interval: 0 });
  }
  if (url.pathname === "/api/accounts/deviceauth/token") {
    assert(request.headers.get("content-type") === "application/json", "device-token content type changed");
    const body = JSON.parse(await request.text());
    assertExactKeys(body, ["device_auth_id", "user_code"], "device-token");
    assert(body.device_auth_id === "packed-device", "device-token id changed");
    assert(body.user_code === "PACK-TEST", "device-token user code changed");
    return Response.json({ authorization_code: "packed-code", code_verifier: "packed-verifier" });
  }
  if (url.pathname === "/oauth/token") {
    assert(
      request.headers.get("content-type") === "application/x-www-form-urlencoded",
      "token-exchange content type changed",
    );
    const body = new URLSearchParams(await request.text());
    assert(
      JSON.stringify([...body.keys()].sort()) ===
        JSON.stringify(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"].sort()),
      "token-exchange body fields changed",
    );
    assert(body.get("client_id") === clientId, "token-exchange client_id changed");
    assert(body.get("grant_type") === "authorization_code", "token-exchange grant type changed");
    assert(body.get("code") === "packed-code", "token-exchange authorization code changed");
    assert(body.get("code_verifier") === "packed-verifier", "token-exchange verifier changed");
    assert(body.get("redirect_uri") === `${authOrigin}/deviceauth/callback`, "token-exchange redirect changed");
    return Response.json({
      access_token: accessToken,
      refresh_token: "packed-refresh-secret",
      expires_in: 3600,
    });
  }
  throw new Error(`Unexpected network request in packed CLI test: ${url.href}`);
};
