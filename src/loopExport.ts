// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { z } from 'zod';
import { loopBaseUrl, loopTokenResource, loopWorkspaceId } from './config';
import { describeError, type Logger, runCommand, type RunCommandResult } from './util';

// Optional integration: export a design-doc artifact to a Microsoft Loop workspace page. It is GATED - only
// offered when an LWS base URL + workspace are configured AND the LWS health endpoint responds - because the
// Loop Web Service (LWS) is not reachable from every host (it typically needs corpnet/VPN). With no
// SATURN_LOOP_BASE_URL set, everything here is dormant and the dashboard never shows the export button.

const azureCliTokenSchema = z.object({ accessToken: z.string() });

/** Whether Loop export is even configured (a base URL + workspace id are set). */
export function loopExportConfigured(): boolean {
    return loopBaseUrl() !== '' && loopWorkspaceId() !== '';
}

function trimmedBase(): string {
    return loopBaseUrl().replace(/\/+$/, '');
}

/** Result of a Loop availability probe: available only when configured AND the health endpoint responds. */
export interface LoopStatus {
    readonly available: boolean;
    readonly reason?: string;
}

/**
 * Whether exporting to Loop is currently AVAILABLE: configured + the LWS `/v0.1/health/ready` endpoint responds
 * OK. Returns a reason when unavailable so the UI can keep the button hidden (optionally with an explanation).
 */
export async function loopExportStatus(): Promise<LoopStatus> {
    if (!loopExportConfigured()) {
        return { available: false, reason: 'not configured' };
    }
    try {
        const response = await fetch(`${trimmedBase()}/v0.1/health/ready`, { method: 'GET' });
        if (!response.ok) {
            return { available: false, reason: `health check returned ${String(response.status)}` };
        }
        return { available: true };
    } catch (error) {
        return { available: false, reason: describeError(error) };
    }
}

function loopBearerHeader(): string | undefined {
    let result: RunCommandResult;
    try {
        // az is a .cmd shim on Windows, so it must go through the shell. Every argument is a fixed constant
        // except the resource URI (from a trusted env var), so there is no command-injection surface here.
        result = runCommand('az', ['account', 'get-access-token', '--resource', loopTokenResource(), '--output', 'json'], {
            timeoutMs: 30_000,
            shell: process.platform === 'win32'
        });
    } catch {
        return undefined;
    }
    if (result.status !== 0) {
        return undefined;
    }
    try {
        const parsed = azureCliTokenSchema.safeParse(JSON.parse(result.stdout));
        if (parsed.success && parsed.data.accessToken !== '') {
            return `Bearer ${parsed.data.accessToken}`;
        }
    } catch {
        /* malformed CLI output */
    }
    return undefined;
}

const loopPageResponseSchema = z
    .object({
        id: z.string().optional(),
        webUrl: z.string().optional(),
        url: z.string().optional(),
        links: z.object({ webUrl: z.string().optional() }).loose().optional()
    })
    .loose();

/** The result of exporting to Loop: the new page URL when the service returns one. */
export interface LoopExportResult {
    readonly url?: string;
}

/**
 * Export a design doc (title + markdown) to a Loop workspace page: mint a delegated token via the Azure CLI,
 * POST to LWS `/v0.1/workspaces/{workspaceId}/pages` with the markdown as raw content (LWS converts it), and
 * return the new page URL. Throws with a clear message when the token or the service is unavailable.
 */
export async function exportArtifactToLoop(title: string, markdown: string, logger: Logger): Promise<LoopExportResult> {
    if (!loopExportConfigured()) {
        throw new Error('Loop export is not configured (set SATURN_LOOP_BASE_URL and SATURN_LOOP_WORKSPACE_ID).');
    }
    const auth = loopBearerHeader();
    if (auth === undefined) {
        throw new Error('Could not obtain a Loop access token from the Azure CLI. Run `az login` on the host.');
    }
    const url = `${trimmedBase()}/v0.1/workspaces/${encodeURIComponent(loopWorkspaceId())}/pages`;
    const body = JSON.stringify({ title, content: { type: 'raw', value: markdown } });
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
            body
        });
    } catch (error) {
        throw new Error(`Could not reach the Loop service: ${describeError(error)}`);
    }
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Loop page creation failed (${String(response.status)}): ${text.slice(0, 400)}`);
    }
    let pageUrl: string | undefined;
    try {
        const parsed = loopPageResponseSchema.safeParse(await response.json());
        if (parsed.success) {
            pageUrl = parsed.data.webUrl ?? parsed.data.url ?? parsed.data.links?.webUrl;
        }
    } catch {
        /* response body was not JSON; the page may still have been created */
    }
    logger.info(`Loop export: created a page for "${title}"${pageUrl !== undefined ? ` (${pageUrl})` : ''}.`);
    return { ...(pageUrl !== undefined ? { url: pageUrl } : {}) };
}
