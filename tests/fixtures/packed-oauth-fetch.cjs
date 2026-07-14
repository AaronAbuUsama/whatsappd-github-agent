const jwtPayload = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "packed-account" } }),
).toString("base64url");
const accessToken = `e30.${jwtPayload}.signature`;

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/api/accounts/deviceauth/usercode")) {
    return Response.json({ device_auth_id: "packed-device", user_code: "PACK-TEST", interval: 0 });
  }
  if (url.endsWith("/api/accounts/deviceauth/token")) {
    return Response.json({ authorization_code: "packed-code", code_verifier: "packed-verifier" });
  }
  if (url.endsWith("/oauth/token")) {
    return Response.json({
      access_token: accessToken,
      refresh_token: "packed-refresh-secret",
      expires_in: 3600,
    });
  }
  throw new Error(`Unexpected network request in packed CLI test: ${url}`);
};
