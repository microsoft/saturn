import { describe, expect, it } from "@jest/globals";
import {
  BOT_REVIEW_MARKER,
  buildBotDisclaimer,
  buildCommentWithDisclaimer,
  buildPullRequestWebUrl,
  buildRepositoryApiUrl,
  parseRepoUrl,
} from "./config";

describe("config", () => {
  it("builds a repository API url for a relative path", () => {
    expect(buildRepositoryApiUrl("/pullRequests?api-version=7.1")).toBe(
      "https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repo-id/pullRequests?api-version=7.1",
    );
  });

  it("builds a pull request web url", () => {
    expect(buildPullRequestWebUrl(123)).toBe(
      "https://test-org.visualstudio.com/test-project/_git/test-repo/pullrequest/123",
    );
  });

  it("builds a disclaimer that names the user and disclaims sign-off", () => {
    const disclaimer = buildBotDisclaimer("alias@microsoft.com");
    expect(disclaimer).toContain("alias@microsoft.com");
    expect(disclaimer).toContain("Saturn");
    expect(disclaimer.toLowerCase()).toContain("not a sign-off");
  });

  it("wraps a comment with the disclaimer header and the hidden idempotency marker", () => {
    const wrapped = buildCommentWithDisclaimer(
      "The actual finding body.",
      "alias@microsoft.com",
    );
    expect(wrapped).toContain("Automated review by Saturn");
    expect(wrapped).toContain("alias@microsoft.com");
    expect(wrapped).toContain("The actual finding body.");
    expect(wrapped).toContain(BOT_REVIEW_MARKER);
  });

  it("exposes a stable idempotency marker", () => {
    expect(BOT_REVIEW_MARKER).toBe("<!-- saturn-review:v1 -->");
  });
});

describe("parseRepoUrl", () => {
  it("parses a modern dev.azure.com repo URL", () => {
    expect(
      parseRepoUrl("https://dev.azure.com/contoso/MyProject/_git/my-repo"),
    ).toEqual({
      organization: "contoso",
      project: "MyProject",
      repositoryName: "my-repo",
    });
  });

  it("parses a legacy visualstudio.com repo URL (org from subdomain)", () => {
    expect(
      parseRepoUrl("https://contoso.visualstudio.com/MyProject/_git/my-repo"),
    ).toEqual({
      organization: "contoso",
      project: "MyProject",
      repositoryName: "my-repo",
    });
  });

  it("decodes URL-encoded segments", () => {
    expect(
      parseRepoUrl("https://dev.azure.com/contoso/My%20Project/_git/my%20repo"),
    ).toEqual({
      organization: "contoso",
      project: "My Project",
      repositoryName: "my repo",
    });
  });

  it("returns undefined when the URL has no _git segment", () => {
    expect(
      parseRepoUrl("https://dev.azure.com/contoso/MyProject"),
    ).toBeUndefined();
  });

  it("returns undefined for a non-URL string", () => {
    expect(parseRepoUrl("not a url")).toBeUndefined();
  });
});
