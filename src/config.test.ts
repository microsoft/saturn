import { describe, expect, it } from '@jest/globals';
import {
  BOT_REVIEW_MARKER,
  buildBotDisclaimer,
  buildCommentWithDisclaimer,
  buildPullRequestWebUrl,
  buildRepositoryApiUrl
} from './config';

describe('config', () => {
  it('builds a repository API url for a relative path', () => {
    expect(buildRepositoryApiUrl('/pullRequests?api-version=7.1')).toBe(
      'https://dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests?api-version=7.1'
    );
  });

  it('builds a pull request web url', () => {
    expect(buildPullRequestWebUrl(123)).toBe('https://office.visualstudio.com/OC/_git/office-bohemia/pullrequest/123');
  });

  it('builds a disclaimer that names the user and disclaims sign-off', () => {
    const disclaimer = buildBotDisclaimer('alias@microsoft.com');
    expect(disclaimer).toContain('alias@microsoft.com');
    expect(disclaimer).toContain('Saturn');
    expect(disclaimer.toLowerCase()).toContain('not a sign-off');
  });

  it('wraps a comment with the disclaimer header and the hidden idempotency marker', () => {
    const wrapped = buildCommentWithDisclaimer('The actual finding body.', 'alias@microsoft.com');
    expect(wrapped).toContain('Automated review by Saturn');
    expect(wrapped).toContain('alias@microsoft.com');
    expect(wrapped).toContain('The actual finding body.');
    expect(wrapped).toContain(BOT_REVIEW_MARKER);
  });

  it('exposes a stable idempotency marker', () => {
    expect(BOT_REVIEW_MARKER).toBe('<!-- saturn-review:v1 -->');
  });
});
