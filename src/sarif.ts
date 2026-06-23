// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { readAllPullRequestReviews, type StoredIterationReview, type StoredReview } from './saturnStore';
import { readAuditFindings } from './auditStore';

/** A single SARIF 2.1.0 result (one finding), surfaced in a platform's code-scanning / security tab. */
interface SarifResult {
  readonly ruleId: string;
  readonly level: 'error' | 'warning' | 'note';
  readonly message: { readonly text: string };
  readonly locations: readonly {
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string };
      readonly region: { readonly startLine: number };
    };
  }[];
  readonly properties: Record<string, unknown>;
}

/** A minimal SARIF 2.1.0 log of Saturn's findings (one run, one result per posted finding). */
export interface SarifLog {
  readonly version: '2.1.0';
  readonly $schema: string;
  readonly runs: readonly {
    readonly tool: {
      readonly driver: {
        readonly name: string;
        readonly informationUri: string;
        readonly rules: readonly { readonly id: string }[];
      };
    };
    readonly results: readonly SarifResult[];
  }[];
}

/** The most-recently-reviewed iteration of a PR (highest iteration id). */
function latestIteration(review: StoredReview): StoredIterationReview | undefined {
  let latest: StoredIterationReview | undefined;
  for (const iteration of review.iterations) {
    if (latest === undefined || iteration.iterationId > latest.iterationId) {
      latest = iteration;
    }
  }
  return latest;
}

/** Map a Saturn severity to a SARIF result level. blocking/major are errors, minor a warning, nit a note. */
function sarifLevel(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'blocking' || severity === 'major') {
    return 'error';
  }
  return severity === 'minor' ? 'warning' : 'note';
}

/**
 * Build a SARIF 2.1.0 log of the latest-iteration findings across all reviewed PRs, so a platform can
 * surface Saturn's findings in its code-scanning / security tab. Served read-only by the dashboard.
 */
export function buildSarifLog(): SarifLog {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();
  for (const review of readAllPullRequestReviews()) {
    const iteration = latestIteration(review);
    if (iteration === undefined) {
      continue;
    }
    for (const comment of iteration.comments) {
      const ruleId = comment.category !== undefined && comment.category !== '' ? comment.category : 'correctness';
      ruleIds.add(ruleId);
      results.push({
        ruleId,
        level: sarifLevel(comment.severity),
        message: { text: `${comment.title}\n\n${comment.body}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: comment.filePath.replace(/^\/+/, '') },
              region: { startLine: comment.line > 0 ? comment.line : 1 }
            }
          }
        ],
        properties: {
          severity: comment.severity,
          category: ruleId,
          pullRequestId: review.pullRequestId,
          confidence: comment.confidence,
          findingId: comment.findingId
        }
      });
    }
  }
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'Saturn',
            informationUri: 'https://github.com/microsoft/saturn',
            rules: [...ruleIds].map((id) => ({ id }))
          }
        },
        results
      }
    ]
  };
}

/**
 * Build a SARIF 2.1.0 log of the codebase audit findings (open + resolved), so a platform can surface the
 * security/privacy/correctness/... findings in its code-scanning tab. Each finding's primary and related
 * locations become SARIF locations. Served read-only by the dashboard at /api/audit/sarif.
 */
export function buildAuditSarifLog(): SarifLog {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();
  for (const finding of readAuditFindings()) {
    if (finding.status === 'dismissed') {
      continue;
    }
    ruleIds.add(finding.category);
    const locations = [{ filePath: finding.filePath, line: finding.line }, ...(finding.relatedLocations ?? [])].map(
      (location) => ({
        physicalLocation: {
          artifactLocation: { uri: location.filePath.replace(/^\/+/, '') },
          region: { startLine: location.line > 0 ? location.line : 1 }
        }
      })
    );
    results.push({
      ruleId: finding.category,
      level: sarifLevel(finding.severity),
      message: { text: `${finding.title}\n\n${finding.body}` },
      locations,
      properties: {
        severity: finding.severity,
        category: finding.category,
        status: finding.status,
        confidence: finding.confidence,
        findingId: finding.id,
        adoBugId: finding.adoBugId,
        introducedAt: finding.introducedAt,
        firstSeenAt: finding.firstSeenAt
      }
    });
  }
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'Saturn Codebase Audit',
            informationUri: 'https://github.com/microsoft/saturn',
            rules: [...ruleIds].map((id) => ({ id }))
          }
        },
        results
      }
    ]
  };
}
