import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.doUnmock("@libsql/client");
  vi.resetModules();
});

describe("tenant credential schema initialization", () => {
  it("retries on the same store instance after a transient initialization failure", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient tenant database outage"))
      .mockResolvedValue({ rows: [] });
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({ execute }),
    }));
    const { libsqlStore } = await import("../../packages/installation/src/tenant-credentials.ts");
    const store = libsqlStore({ url: "libsql://tenant.example", authToken: "scoped-test-token" });

    await expect(store.read("creds")).rejects.toThrow("transient tenant database outage");
    await expect(store.read("creds")).resolves.toBeNull();

    expect(execute).toHaveBeenCalledTimes(3);
  });
});
