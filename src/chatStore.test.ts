// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addMessage,
  closeChatDb,
  createArtifact,
  createConversation,
  createFeatureBuild,
  getArtifact,
  getConversation,
  latestArtifact,
  listArtifacts,
  listMessages,
  pruneChatStore,
  searchIndexAvailable,
  searchRelatedArtifacts,
  updateArtifact,
  updateConversation
} from './chatStore';

describe('chatStore', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'saturn-chat-'));
    process.env.SATURN_CHAT_DIR = directory;
    closeChatDb();
  });

  afterEach(() => {
    closeChatDb();
    delete process.env.SATURN_CHAT_DIR;
    rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a conversation, its messages, and a design-doc artifact', () => {
    const convo = createConversation({ title: 'Dark mode', mode: 'design', requester: 'me' });
    expect(getConversation(convo.id)?.title).toBe('Dark mode');

    addMessage({ conversationId: convo.id, role: 'user', content: 'Add a dark mode toggle' });
    const reply = addMessage({ conversationId: convo.id, role: 'assistant', content: 'Sure, here is a plan' });
    const messages = listMessages(convo.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.id).toBe(reply.id);

    const artifact = createArtifact({
      conversationId: convo.id,
      title: 'Dark mode design',
      markdown: '# Dark mode\nToggle in settings.',
      feasibility: 'possible',
      options: [{ label: 'CSS variables', summary: 'Theme via CSS custom properties', recommended: true }]
    });
    expect(getArtifact(artifact.id)?.options[0]?.label).toBe('CSS variables');
    expect(latestArtifact(convo.id)?.id).toBe(artifact.id);

    const updated = updateArtifact(artifact.id, { status: 'approved', selectedOption: 'CSS variables' });
    expect(updated?.status).toBe('approved');
    expect(updated?.selectedOption).toBe('CSS variables');
    expect(listArtifacts(convo.id)).toHaveLength(1);
  });

  it('finds related prior design docs by shared keywords and excludes the current conversation', () => {
    const prior = createConversation({ title: 'Auth', mode: 'design', requester: 'me' });
    createArtifact({
      conversationId: prior.id,
      title: 'Passkey authentication design',
      markdown: 'Implement passkey WebAuthn registration and ceremony flows.'
    });
    const current = createConversation({ title: 'New', mode: 'design', requester: 'me' });

    const related = searchRelatedArtifacts('We want passkey WebAuthn registration', current.id);
    expect(related.map((r) => r.conversationId)).toContain(prior.id);
    // The current conversation is always excluded from its own related-work results.
    expect(related.every((r) => r.conversationId !== current.id)).toBe(true);
  });

  it('returns nothing for a query with only short or stopword tokens', () => {
    const convo = createConversation({ title: 'X', mode: 'design', requester: 'me' });
    createArtifact({ conversationId: convo.id, title: 'Whatever', markdown: 'Body text here' });
    const other = createConversation({ title: 'Y', mode: 'design', requester: 'me' });
    expect(searchRelatedArtifacts('the a an is to', other.id)).toHaveLength(0);
  });

  it('recalls a conversation by a keyword found only in its chat messages (FTS)', () => {
    if (!searchIndexAvailable()) {
      return; // FTS5 not compiled into this SQLite build; the LIKE fallback only scans design docs.
    }
    const prior = createConversation({ title: 'Telemetry', mode: 'design', requester: 'me' });
    // The distinctive keyword 'kusto' appears in a MESSAGE, not in the design-doc body.
    addMessage({ conversationId: prior.id, role: 'user', content: 'We should query kusto for these events' });
    createArtifact({ conversationId: prior.id, title: 'Telemetry pipeline', markdown: 'A pipeline for events.' });

    const current = createConversation({ title: 'New', mode: 'design', requester: 'me' });
    const related = searchRelatedArtifacts('how do we use kusto for dashboards', current.id);
    expect(related.map((r) => r.conversationId)).toContain(prior.id);
  });

  it('prunes archived conversations past the retention window and cascades their rows', () => {
    const old = createConversation({ title: 'Old', mode: 'design', requester: 'me' });
    addMessage({ conversationId: old.id, role: 'user', content: 'old message' });
    const oldArtifact = createArtifact({ conversationId: old.id, title: 'Old doc', markdown: 'old' });
    createFeatureBuild({
      conversationId: old.id,
      artifactId: oldArtifact.id,
      title: 'Old build',
      branch: 'saturn/feature/old',
      requester: 'me'
    });
    updateConversation(old.id, { status: 'archived' });

    const activeRecent = createConversation({ title: 'Active', mode: 'design', requester: 'me' });
    const archivedRecent = createConversation({ title: 'Recent', mode: 'design', requester: 'me' });
    updateConversation(archivedRecent.id, { status: 'archived' });

    // Prune anything archived + older than 1 day, evaluated as if "now" were 10 days in the future so both
    // archived conversations fall outside the window.
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const result = pruneChatStore({ maxAgeDays: 1, now: future, vacuum: false });

    expect(result.removedConversations).toBe(2);
    expect(result.removedMessages).toBeGreaterThanOrEqual(1);
    expect(result.removedArtifacts).toBe(1);
    expect(result.removedFeatureBuilds).toBe(1);
    // The ACTIVE conversation is always kept, regardless of age.
    expect(getConversation(activeRecent.id)?.id).toBe(activeRecent.id);
    expect(getConversation(old.id)).toBeUndefined();
    expect(getConversation(archivedRecent.id)).toBeUndefined();
  });

  it('keeps archived conversations that are still within the retention window', () => {
    const convo = createConversation({ title: 'Keep', mode: 'design', requester: 'me' });
    updateConversation(convo.id, { status: 'archived' });
    // A just-archived conversation is inside a 90-day window, so it survives.
    const result = pruneChatStore({ maxAgeDays: 90, vacuum: false });
    expect(result.removedConversations).toBe(0);
    expect(getConversation(convo.id)?.status).toBe('archived');
  });
});
