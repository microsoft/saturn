// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';
import {
  BOT_REVIEW_MARKER,
  buildBotDisclaimer,
  buildCommentWithDisclaimer,
  buildPullRequestWebUrl,
  buildRepositoryApiUrl,
  parseRepoUrl,
  suppressedCategoriesForPath
} from './config';

describe('config', () => {
  it('builds a repository API url for a relative path', () => {
    expect(buildRepositoryApiUrl('/pullRequests?api-version=7.1')).toBe(
      'https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repo-id/pullRequests?api-version=7.1'
    );
  });

  it('builds a pull request web url', () => {
    expect(buildPullRequestWebUrl(123)).toBe(
      'https://test-org.visualstudio.com/test-project/_git/test-repo/pullrequest/123'
    );
  });

  it('builds a disclaimer that names the user and disclaims sign-off', () => {
    const disclaimer = buildBotDisclaimer('alias@contoso.com');
    expect(disclaimer).toContain('alias@contoso.com');
    expect(disclaimer).toContain('Saturn');
    expect(disclaimer.toLowerCase()).toContain('not a sign-off');
    // Generative-AI transparency: outputs must be flagged as AI-generated and fallible.
    expect(disclaimer).toContain('AI-generated');
    expect(disclaimer.toLowerCase()).toContain('incorrect');
  });

  it('wraps a comment with the disclaimer header and the hidden idempotency marker', () => {
    const wrapped = buildCommentWithDisclaimer('The actual finding body.', 'alias@contoso.com');
    expect(wrapped).toContain('Automated review by Saturn');
    expect(wrapped).toContain('alias@contoso.com');
    expect(wrapped).toContain('The actual finding body.');
    expect(wrapped).toContain(BOT_REVIEW_MARKER);
  });

  it('exposes a stable idempotency marker', () => {
    expect(BOT_REVIEW_MARKER).toBe('<!-- saturn-review:v1 -->');
  });
});

describe('parseRepoUrl', () => {
  it('parses a modern dev.azure.com repo URL', () => {
    expect(parseRepoUrl('https://dev.azure.com/contoso/MyProject/_git/my-repo')).toEqual({
      organization: 'contoso',
      project: 'MyProject',
      repositoryName: 'my-repo'
    });
  });

  it('parses a legacy visualstudio.com repo URL (org from subdomain)', () => {
    expect(parseRepoUrl('https://contoso.visualstudio.com/MyProject/_git/my-repo')).toEqual({
      organization: 'contoso',
      project: 'MyProject',
      repositoryName: 'my-repo'
    });
  });

  it('decodes URL-encoded segments', () => {
    expect(parseRepoUrl('https://dev.azure.com/contoso/My%20Project/_git/my%20repo')).toEqual({
      organization: 'contoso',
      project: 'My Project',
      repositoryName: 'my repo'
    });
  });

  it('returns undefined when the URL has no _git segment', () => {
    expect(parseRepoUrl('https://dev.azure.com/contoso/MyProject')).toBeUndefined();
  });

  it('returns undefined for a non-URL string', () => {
    expect(parseRepoUrl('not a url')).toBeUndefined();
  });
});

describe('suppressedCategoriesForPath', () => {
  it('suppresses design and api nits in test files', () => {
    const suppressed = suppressedCategoriesForPath('src/foo.test.ts');
    expect(suppressed.has('design')).toBe(true);
    expect(suppressed.has('api')).toBe(true);
  });

  it('never suppresses security, privacy, or correctness, even in test files', () => {
    const suppressed = suppressedCategoriesForPath('src/foo.test.ts');
    expect(suppressed.has('security')).toBe(false);
    expect(suppressed.has('privacy')).toBe(false);
    expect(suppressed.has('correctness')).toBe(false);
  });

  it('suppresses nothing in a normal source file', () => {
    expect(suppressedCategoriesForPath('src/foo.ts').size).toBe(0);
  });
});
