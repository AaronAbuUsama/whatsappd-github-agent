import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssues = {
  addLabels: vi.fn(),
  addAssignees: vi.fn(),
  removeAssignees: vi.fn(),
};

vi.mock("../../agent/lib/github.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/lib/github.ts")>();
  return {
    ...actual,
    getOctokit: () => ({ rest: { issues: mockIssues } }) as never,
  };
});

const dummyCtx = {} as ToolContext;

describe("github_add_labels", () => {
  beforeEach(() => {
    mockIssues.addLabels.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
  });

  it("adds labels and returns the resulting set", async () => {
    mockIssues.addLabels.mockResolvedValue({ data: [{ name: "bug" }, { name: "p1" }] });
    const { default: tool } = await import("../../agent/tools/github_add_labels.ts");

    const result = await tool.execute({ issue_number: 7, labels: ["p1"] }, dummyCtx);

    expect(mockIssues.addLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      labels: ["p1"],
    });
    expect(result).toEqual({ issue_number: 7, labels: ["bug", "p1"] });
  });

  it("refuses a repo outside the write allow-list before calling the API", async () => {
    const { default: tool } = await import("../../agent/tools/github_add_labels.ts");
    await expect(
      tool.execute({ owner: "x", repo: "y", issue_number: 7, labels: ["bug"] }, dummyCtx),
    ).rejects.toThrow(/not in the write allow-list/);
    expect(mockIssues.addLabels).not.toHaveBeenCalled();
  });
});

describe("github_assign", () => {
  beforeEach(() => {
    mockIssues.addAssignees.mockReset();
    mockIssues.removeAssignees.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
  });

  it("requires at least one of add/remove", async () => {
    const { default: tool } = await import("../../agent/tools/github_assign.ts");
    await expect(tool.execute({ issue_number: 7 }, dummyCtx)).rejects.toThrow(/add.*or.*remove/i);
    expect(mockIssues.addAssignees).not.toHaveBeenCalled();
    expect(mockIssues.removeAssignees).not.toHaveBeenCalled();
  });

  it("adds assignees and returns the resulting logins", async () => {
    mockIssues.addAssignees.mockResolvedValue({ data: { assignees: [{ login: "octocat" }] } });
    const { default: tool } = await import("../../agent/tools/github_assign.ts");

    const result = await tool.execute({ issue_number: 7, add: ["octocat"] }, dummyCtx);

    expect(mockIssues.addAssignees).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      assignees: ["octocat"],
    });
    expect(mockIssues.removeAssignees).not.toHaveBeenCalled();
    expect(result).toEqual({ issue_number: 7, assignees: ["octocat"] });
  });

  it("removes before adding when both are given", async () => {
    mockIssues.removeAssignees.mockResolvedValue({ data: { assignees: [] } });
    mockIssues.addAssignees.mockResolvedValue({ data: { assignees: [{ login: "newdev" }] } });
    const { default: tool } = await import("../../agent/tools/github_assign.ts");

    await tool.execute({ issue_number: 7, add: ["newdev"], remove: ["olddev"] }, dummyCtx);

    const removeOrder = mockIssues.removeAssignees.mock.invocationCallOrder[0]!;
    const addOrder = mockIssues.addAssignees.mock.invocationCallOrder[0]!;
    expect(removeOrder).toBeLessThan(addOrder);
  });
});
