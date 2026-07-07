// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { consoleLogger } from './util';
import { exportArtifactToLoop, loopExportConfigured, loopExportStatus } from './loopExport';

describe('loopExport gating', () => {
    const saved = {
        base: process.env.SATURN_LOOP_BASE_URL,
        workspace: process.env.SATURN_LOOP_WORKSPACE_ID
    };

    beforeEach(() => {
        delete process.env.SATURN_LOOP_BASE_URL;
        delete process.env.SATURN_LOOP_WORKSPACE_ID;
    });

    afterEach(() => {
        if (saved.base === undefined) {
            delete process.env.SATURN_LOOP_BASE_URL;
        } else {
            process.env.SATURN_LOOP_BASE_URL = saved.base;
        }
        if (saved.workspace === undefined) {
            delete process.env.SATURN_LOOP_WORKSPACE_ID;
        } else {
            process.env.SATURN_LOOP_WORKSPACE_ID = saved.workspace;
        }
    });

    it('is not configured by default', () => {
        expect(loopExportConfigured()).toBe(false);
    });

    it('reports unavailable without any network call when not configured', async () => {
        const status = await loopExportStatus();
        expect(status.available).toBe(false);
        expect(status.reason).toBe('not configured');
    });

    it('refuses to export when Loop is not configured', async () => {
        await expect(exportArtifactToLoop('Title', '# doc', consoleLogger)).rejects.toThrow(/not configured/);
    });

    it('is configured once a base URL and workspace are set', () => {
        process.env.SATURN_LOOP_BASE_URL = 'https://loop.example';
        process.env.SATURN_LOOP_WORKSPACE_ID = 'ws-123';
        expect(loopExportConfigured()).toBe(true);
    });
});
