// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// Persistent store for the Chat tab: conversations, their messages, and the design-doc artifacts the design
// agent produces. Mirrors the fixStore pattern (node:sqlite DatabaseSync, INSERT OR REPLACE, zod row parsing,
// a lazily-opened singleton handle under ~/.saturn). Chat is available to all dashboard viewers, so nothing
// here is gated on the owner identity - the HTTP layer decides who may call what.

/** How a conversation began: a design request, or a spec from a PM / non-developer. */
export type ConversationMode = 'design' | 'spec';

/** Whether the requester wants technical detail. Resolved by the agent asking on the spec path. */
export type ConversationAudience = 'technical' | 'non-technical';

/** Lifecycle of a conversation (archived is a soft delete kept for transcript download). */
export type ConversationStatus = 'active' | 'archived';

/** A single chat conversation (one thread in the left pane). */
export interface Conversation {
    readonly id: string;
    readonly title: string;
    readonly mode: ConversationMode;
    readonly audience?: ConversationAudience;
    /** Who started it (trusted identity, or 'anonymous' for tunnel viewers). */
    readonly requester: string;
    readonly status: ConversationStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

/** A single message in a conversation. */
export interface ChatMessage {
    readonly id: string;
    readonly conversationId: string;
    readonly role: MessageRole;
    readonly content: string;
    /** Set when this (assistant) message produced or updated a design-doc artifact. */
    readonly artifactId?: string;
    readonly createdAt: string;
}

/** The design agent's verdict on whether the request can be built. */
export type Feasibility = 'possible' | 'not-possible' | 'conditional';

/** One design option the agent proposes (the user may pick one before a build). */
export interface DesignOption {
    readonly label: string;
    readonly summary: string;
    readonly recommended?: boolean;
}

/** Lifecycle of a design-doc artifact from draft through an opened PR. */
export type ArtifactStatus = 'draft' | 'approved' | 'building' | 'built' | 'failed';

/** A design document (markdown, may contain mermaid code blocks) attached to a conversation. */
export interface Artifact {
    readonly id: string;
    readonly conversationId: string;
    readonly kind: 'design-doc';
    readonly title: string;
    readonly markdown: string;
    readonly feasibility?: Feasibility;
    readonly options: readonly DesignOption[];
    /** The option the user (or the agent, as a fallback) selected before building. */
    readonly selectedOption?: string;
    readonly status: ArtifactStatus;
    readonly version: number;
    /** The fix/feature task id once a build has been kicked off from this artifact. */
    readonly buildTaskId?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

const conversationRowSchema = z
    .object({
        id: z.string(),
        title: z.string(),
        mode: z.enum(['design', 'spec']).catch('design'),
        audience: z.enum(['technical', 'non-technical']).nullable(),
        requester: z.string(),
        status: z.enum(['active', 'archived']).catch('active'),
        createdAt: z.string(),
        updatedAt: z.string()
    })
    .loose();

const messageRowSchema = z
    .object({
        id: z.string(),
        conversationId: z.string(),
        role: z.enum(['user', 'assistant', 'system']).catch('assistant'),
        content: z.string(),
        artifactId: z.string().nullable(),
        createdAt: z.string()
    })
    .loose();

const designOptionSchema = z.object({
    label: z.string(),
    summary: z.string(),
    recommended: z.boolean().optional()
});

const artifactRowSchema = z
    .object({
        id: z.string(),
        conversationId: z.string(),
        kind: z.literal('design-doc').catch('design-doc'),
        title: z.string(),
        markdown: z.string(),
        feasibility: z.enum(['possible', 'not-possible', 'conditional']).nullable(),
        options: z.string(),
        selectedOption: z.string().nullable(),
        status: z.enum(['draft', 'approved', 'building', 'built', 'failed']).catch('draft'),
        version: z.number(),
        buildTaskId: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string()
    })
    .loose();

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'design',
  audience TEXT,
  requester TEXT NOT NULL DEFAULT 'anonymous',
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  artifactId TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'design-doc',
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  feasibility TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  selectedOption TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  buildTaskId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_msg_convo ON chat_messages(conversationId, createdAt);
CREATE INDEX IF NOT EXISTS idx_artifact_convo ON artifacts(conversationId, createdAt);
CREATE INDEX IF NOT EXISTS idx_convo_updatedAt ON conversations(updatedAt);
CREATE TABLE IF NOT EXISTS feature_builds (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  artifactId TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  selectedOption TEXT,
  requester TEXT NOT NULL DEFAULT 'anonymous',
  prId INTEGER,
  prUrl TEXT,
  lastAction TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_convo ON feature_builds(conversationId, createdAt);
CREATE INDEX IF NOT EXISTS idx_feature_status ON feature_builds(status);
`;

const INSERT_CONVERSATION_SQL = `
INSERT OR REPLACE INTO conversations (id, title, mode, audience, requester, status, createdAt, updatedAt)
VALUES (:id, :title, :mode, :audience, :requester, :status, :createdAt, :updatedAt)
`;

const INSERT_MESSAGE_SQL = `
INSERT OR REPLACE INTO chat_messages (id, conversationId, role, content, artifactId, createdAt)
VALUES (:id, :conversationId, :role, :content, :artifactId, :createdAt)
`;

const INSERT_ARTIFACT_SQL = `
INSERT OR REPLACE INTO artifacts (
  id, conversationId, kind, title, markdown, feasibility, options, selectedOption, status, version,
  buildTaskId, createdAt, updatedAt
) VALUES (
  :id, :conversationId, :kind, :title, :markdown, :feasibility, :options, :selectedOption, :status, :version,
  :buildTaskId, :createdAt, :updatedAt
)
`;

function chatDir(): string {
    const override = process.env.SATURN_CHAT_DIR;
    return override !== undefined && override.trim() !== '' ? override : path.join(os.homedir(), '.saturn', 'chat');
}

function dbFilePath(): string {
    return path.join(chatDir(), 'chat.db');
}

let dbInstance: DatabaseSync | undefined;
let dbInstancePath: string | undefined;

function getDb(): DatabaseSync {
    const target = dbFilePath();
    if (dbInstance !== undefined && dbInstancePath === target) {
        return dbInstance;
    }
    if (dbInstance !== undefined) {
        try {
            dbInstance.close();
        } catch {
            /* ignore */
        }
        dbInstance = undefined;
    }
    mkdirSync(chatDir(), { recursive: true });
    const database = new DatabaseSync(target);
    database.exec(TABLE_SQL);
    dbInstance = database;
    dbInstancePath = target;
    return database;
}

/** Close the SQLite handle (used by tests to start from a clean store). */
export function closeChatDb(): void {
    if (dbInstance !== undefined) {
        try {
            dbInstance.close();
        } catch {
            /* ignore */
        }
        dbInstance = undefined;
        dbInstancePath = undefined;
    }
}

// --- conversations ---------------------------------------------------------------------------------------

function rowToConversation(raw: unknown): Conversation | undefined {
    const parsed = conversationRowSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    const row = parsed.data;
    return {
        id: row.id,
        title: row.title,
        mode: row.mode,
        ...(row.audience !== null ? { audience: row.audience } : {}),
        requester: row.requester,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

/** Inputs to create a conversation (id + timestamps are filled in here). */
export interface NewConversation {
    readonly title: string;
    readonly mode: ConversationMode;
    readonly requester: string;
}

/** Create and persist a new (active) conversation. */
export function createConversation(input: NewConversation): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
        id: randomUUID(),
        title: input.title.trim() === '' ? 'New chat' : input.title.trim(),
        mode: input.mode,
        requester: input.requester,
        status: 'active',
        createdAt: now,
        updatedAt: now
    };
    getDb()
        .prepare(INSERT_CONVERSATION_SQL)
        .run({
            id: conversation.id,
            title: conversation.title,
            mode: conversation.mode,
            audience: null,
            requester: conversation.requester,
            status: conversation.status,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt
        });
    return conversation;
}

/** Look up a single conversation by id. */
export function getConversation(id: string): Conversation | undefined {
    return rowToConversation(getDb().prepare('SELECT * FROM conversations WHERE id = :id').get({ id }));
}

/** List conversations, most-recently-updated first. Excludes archived unless includeArchived is set. */
export function listConversations(includeArchived = false): readonly Conversation[] {
    const sql = includeArchived
        ? 'SELECT * FROM conversations ORDER BY updatedAt DESC'
        : "SELECT * FROM conversations WHERE status = 'active' ORDER BY updatedAt DESC";
    const rows = getDb().prepare(sql).all();
    const result: Conversation[] = [];
    for (const row of rows) {
        const conversation = rowToConversation(row);
        if (conversation !== undefined) {
            result.push(conversation);
        }
    }
    return result;
}

/** Fields that may be patched on a conversation. */
export interface ConversationPatch {
    readonly title?: string;
    readonly audience?: ConversationAudience;
    readonly status?: ConversationStatus;
}

/** Apply a partial update to a conversation (always bumps updatedAt). Returns the updated row. */
export function updateConversation(id: string, patch: ConversationPatch): Conversation | undefined {
    const sets: string[] = ['updatedAt = :updatedAt'];
    const params: Record<string, string | null> = { id, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) {
        sets.push('title = :title');
        params.title = patch.title.trim() === '' ? 'New chat' : patch.title.trim();
    }
    if (patch.audience !== undefined) {
        sets.push('audience = :audience');
        params.audience = patch.audience;
    }
    if (patch.status !== undefined) {
        sets.push('status = :status');
        params.status = patch.status;
    }
    getDb()
        .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = :id`)
        .run(params);
    return getConversation(id);
}

/** Mark a conversation's updatedAt as now (called after a new message so it sorts to the top). */
export function touchConversation(id: string): void {
    getDb()
        .prepare('UPDATE conversations SET updatedAt = :updatedAt WHERE id = :id')
        .run({ id, updatedAt: new Date().toISOString() });
}

// --- messages --------------------------------------------------------------------------------------------

function rowToMessage(raw: unknown): ChatMessage | undefined {
    const parsed = messageRowSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    const row = parsed.data;
    return {
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        content: row.content,
        ...(row.artifactId !== null ? { artifactId: row.artifactId } : {}),
        createdAt: row.createdAt
    };
}

/** Inputs to append a message (id + timestamp are filled in here). */
export interface NewMessage {
    readonly conversationId: string;
    readonly role: MessageRole;
    readonly content: string;
    readonly artifactId?: string;
}

/** Append a message to a conversation and bump the conversation's updatedAt. */
export function addMessage(input: NewMessage): ChatMessage {
    const message: ChatMessage = {
        id: randomUUID(),
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
        createdAt: new Date().toISOString()
    };
    getDb()
        .prepare(INSERT_MESSAGE_SQL)
        .run({
            id: message.id,
            conversationId: message.conversationId,
            role: message.role,
            content: message.content,
            artifactId: message.artifactId ?? null,
            createdAt: message.createdAt
        });
    touchConversation(input.conversationId);
    return message;
}

/** All messages in a conversation, oldest first. */
export function listMessages(conversationId: string): readonly ChatMessage[] {
    const rows = getDb()
        .prepare('SELECT * FROM chat_messages WHERE conversationId = :conversationId ORDER BY createdAt ASC')
        .all({ conversationId });
    const result: ChatMessage[] = [];
    for (const row of rows) {
        const message = rowToMessage(row);
        if (message !== undefined) {
            result.push(message);
        }
    }
    return result;
}

// --- artifacts -------------------------------------------------------------------------------------------

function parseOptions(raw: string): readonly DesignOption[] {
    try {
        const parsed = z.array(designOptionSchema).safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function rowToArtifact(raw: unknown): Artifact | undefined {
    const parsed = artifactRowSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    const row = parsed.data;
    return {
        id: row.id,
        conversationId: row.conversationId,
        kind: row.kind,
        title: row.title,
        markdown: row.markdown,
        ...(row.feasibility !== null ? { feasibility: row.feasibility } : {}),
        options: parseOptions(row.options),
        ...(row.selectedOption !== null ? { selectedOption: row.selectedOption } : {}),
        status: row.status,
        version: row.version,
        ...(row.buildTaskId !== null ? { buildTaskId: row.buildTaskId } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

/** Inputs to create a design-doc artifact (id, version, timestamps filled in here). */
export interface NewArtifact {
    readonly conversationId: string;
    readonly title: string;
    readonly markdown: string;
    readonly feasibility?: Feasibility;
    readonly options?: readonly DesignOption[];
}

/** Create and persist a new draft design-doc artifact. */
export function createArtifact(input: NewArtifact): Artifact {
    const now = new Date().toISOString();
    const artifact: Artifact = {
        id: randomUUID(),
        conversationId: input.conversationId,
        kind: 'design-doc',
        title: input.title.trim() === '' ? 'Design document' : input.title.trim(),
        markdown: input.markdown,
        ...(input.feasibility !== undefined ? { feasibility: input.feasibility } : {}),
        options: input.options ?? [],
        status: 'draft',
        version: 1,
        createdAt: now,
        updatedAt: now
    };
    getDb()
        .prepare(INSERT_ARTIFACT_SQL)
        .run({
            id: artifact.id,
            conversationId: artifact.conversationId,
            kind: artifact.kind,
            title: artifact.title,
            markdown: artifact.markdown,
            feasibility: artifact.feasibility ?? null,
            options: JSON.stringify(artifact.options),
            selectedOption: null,
            status: artifact.status,
            version: artifact.version,
            buildTaskId: null,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt
        });
    return artifact;
}

/** Fields that may be patched on an artifact. */
export interface ArtifactPatch {
    readonly title?: string;
    readonly markdown?: string;
    readonly feasibility?: Feasibility;
    readonly options?: readonly DesignOption[];
    readonly selectedOption?: string;
    readonly status?: ArtifactStatus;
    readonly version?: number;
    readonly buildTaskId?: string;
}

/** Apply a partial update to an artifact (always bumps updatedAt). Returns the updated row. */
export function updateArtifact(id: string, patch: ArtifactPatch): Artifact | undefined {
    const sets: string[] = ['updatedAt = :updatedAt'];
    const params: Record<string, string | number | null> = { id, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) {
        sets.push('title = :title');
        params.title = patch.title;
    }
    if (patch.markdown !== undefined) {
        sets.push('markdown = :markdown');
        params.markdown = patch.markdown;
    }
    if (patch.feasibility !== undefined) {
        sets.push('feasibility = :feasibility');
        params.feasibility = patch.feasibility;
    }
    if (patch.options !== undefined) {
        sets.push('options = :options');
        params.options = JSON.stringify(patch.options);
    }
    if (patch.selectedOption !== undefined) {
        sets.push('selectedOption = :selectedOption');
        params.selectedOption = patch.selectedOption;
    }
    if (patch.status !== undefined) {
        sets.push('status = :status');
        params.status = patch.status;
    }
    if (patch.version !== undefined) {
        sets.push('version = :version');
        params.version = patch.version;
    }
    if (patch.buildTaskId !== undefined) {
        sets.push('buildTaskId = :buildTaskId');
        params.buildTaskId = patch.buildTaskId;
    }
    getDb()
        .prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = :id`)
        .run(params);
    return getArtifact(id);
}

/** Look up a single artifact by id. */
export function getArtifact(id: string): Artifact | undefined {
    return rowToArtifact(getDb().prepare('SELECT * FROM artifacts WHERE id = :id').get({ id }));
}

/** All artifacts for a conversation, oldest first. */
export function listArtifacts(conversationId: string): readonly Artifact[] {
    const rows = getDb()
        .prepare('SELECT * FROM artifacts WHERE conversationId = :conversationId ORDER BY createdAt ASC')
        .all({ conversationId });
    const result: Artifact[] = [];
    for (const row of rows) {
        const artifact = rowToArtifact(row);
        if (artifact !== undefined) {
            result.push(artifact);
        }
    }
    return result;
}

/** The most-recent artifact for a conversation (the one the preview pane shows by default). */
export function latestArtifact(conversationId: string): Artifact | undefined {
    return rowToArtifact(
        getDb()
            .prepare('SELECT * FROM artifacts WHERE conversationId = :conversationId ORDER BY createdAt DESC LIMIT 1')
            .get({ conversationId })
    );
}

// --- cross-session memory (find prior related work) ------------------------------------------------------

/** A prior design-doc artifact relevant to a new request, with its conversation's title for context. */
export interface RelatedArtifact {
    readonly conversationId: string;
    readonly conversationTitle: string;
    readonly artifact: Artifact;
    /** How many distinct query tokens matched (higher = more relevant). */
    readonly score: number;
}

const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
    'about', 'after', 'again', 'build', 'building', 'could', 'design', 'feature', 'should', 'would', 'there',
    'their', 'which', 'while', 'where', 'with', 'that', 'this', 'from', 'have', 'into', 'then', 'than', 'they',
    'them', 'want', 'need', 'make', 'made', 'using', 'the', 'and', 'for', 'are', 'can', 'you', 'your', 'how',
    'why', 'what', 'when', 'who'
]);

function tokenizeQuery(query: string): readonly string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length >= 4 && !SEARCH_STOPWORDS.has(raw) && !seen.has(raw)) {
            seen.add(raw);
            tokens.push(raw);
        }
        if (tokens.length >= 12) {
            break;
        }
    }
    return tokens;
}

/**
 * Find design-doc artifacts from OTHER conversations relevant to `query`, so a NEW chat can build on prior
 * analysis instead of starting over. This is what makes chat memory useful across sessions: the design agent
 * injects these as prior context. Tokenizes the query, prefilters with SQL LIKE, then scores each candidate
 * by how many distinct tokens appear in its title/markdown (ties broken by recency). Most relevant first.
 */
export function searchRelatedArtifacts(
    query: string,
    excludeConversationId: string,
    limit = 3
): readonly RelatedArtifact[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) {
        return [];
    }
    const params: Record<string, string> = { exclude: excludeConversationId };
    const likeClauses: string[] = [];
    tokens.forEach((token, index) => {
        const key = `t${String(index)}`;
        params[key] = `%${token}%`;
        likeClauses.push(`(a.title LIKE :${key} OR a.markdown LIKE :${key})`);
    });
    const sql = `
    SELECT a.*, c.title AS conversationTitle
    FROM artifacts a JOIN conversations c ON c.id = a.conversationId
    WHERE a.conversationId != :exclude AND (${likeClauses.join(' OR ')})
    ORDER BY a.updatedAt DESC
    LIMIT 50`;
    const rows = getDb().prepare(sql).all(params);
    const scored: RelatedArtifact[] = [];
    for (const row of rows) {
        const artifact = rowToArtifact(row);
        if (artifact === undefined) {
            continue;
        }
        const titleParse = z.object({ conversationTitle: z.string() }).loose().safeParse(row);
        const conversationTitle = titleParse.success ? titleParse.data.conversationTitle : '(untitled)';
        const haystack = `${artifact.title}\n${artifact.markdown}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
            if (haystack.includes(token)) {
                score += 1;
            }
        }
        if (score > 0) {
            scored.push({ conversationId: artifact.conversationId, conversationTitle, artifact, score });
        }
    }
    scored.sort((left, right) =>
        right.score !== left.score
            ? right.score - left.score
            : right.artifact.updatedAt.localeCompare(left.artifact.updatedAt)
    );
    return scored.slice(0, limit);
}

// --- feature builds (the design -> PR pipeline records; surfaced on the Code Autopilot tab) --------------

/** Lifecycle of a feature build kicked off from an approved design doc. */
export type FeatureBuildStatus =
    | 'queued'
    | 'branching'
    | 'implementing'
    | 'validating'
    | 'pushing'
    | 'pr-open'
    | 'failed';

/** A feature build: turns an approved design-doc artifact into a branch + PR (Code Autopilot for features). */
export interface FeatureBuild {
    readonly id: string;
    readonly conversationId: string;
    readonly artifactId: string;
    readonly title: string;
    readonly branch: string;
    readonly status: FeatureBuildStatus;
    readonly selectedOption?: string;
    readonly requester: string;
    readonly prId?: number;
    readonly prUrl?: string;
    readonly lastAction?: string;
    readonly lastError?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

const featureBuildRowSchema = z
    .object({
        id: z.string(),
        conversationId: z.string(),
        artifactId: z.string(),
        title: z.string(),
        branch: z.string(),
        status: z
            .enum(['queued', 'branching', 'implementing', 'validating', 'pushing', 'pr-open', 'failed'])
            .catch('queued'),
        selectedOption: z.string().nullable(),
        requester: z.string(),
        prId: z.number().nullable(),
        prUrl: z.string().nullable(),
        lastAction: z.string().nullable(),
        lastError: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string()
    })
    .loose();

const INSERT_FEATURE_BUILD_SQL = `
INSERT OR REPLACE INTO feature_builds (
  id, conversationId, artifactId, title, branch, status, selectedOption, requester, prId, prUrl, lastAction,
  lastError, createdAt, updatedAt
) VALUES (
  :id, :conversationId, :artifactId, :title, :branch, :status, :selectedOption, :requester, :prId, :prUrl,
  :lastAction, :lastError, :createdAt, :updatedAt
)
`;

function rowToFeatureBuild(raw: unknown): FeatureBuild | undefined {
    const parsed = featureBuildRowSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    const row = parsed.data;
    return {
        id: row.id,
        conversationId: row.conversationId,
        artifactId: row.artifactId,
        title: row.title,
        branch: row.branch,
        status: row.status,
        ...(row.selectedOption !== null ? { selectedOption: row.selectedOption } : {}),
        requester: row.requester,
        ...(row.prId !== null ? { prId: row.prId } : {}),
        ...(row.prUrl !== null ? { prUrl: row.prUrl } : {}),
        ...(row.lastAction !== null ? { lastAction: row.lastAction } : {}),
        ...(row.lastError !== null ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

/** Inputs to create a feature build (id + timestamps filled in here). */
export interface NewFeatureBuild {
    readonly conversationId: string;
    readonly artifactId: string;
    readonly title: string;
    readonly branch: string;
    readonly requester: string;
    readonly selectedOption?: string;
}

/** Create and persist a new (queued) feature build. */
export function createFeatureBuild(input: NewFeatureBuild): FeatureBuild {
    const now = new Date().toISOString();
    const build: FeatureBuild = {
        id: randomUUID(),
        conversationId: input.conversationId,
        artifactId: input.artifactId,
        title: input.title,
        branch: input.branch,
        status: 'queued',
        ...(input.selectedOption !== undefined ? { selectedOption: input.selectedOption } : {}),
        requester: input.requester,
        createdAt: now,
        updatedAt: now
    };
    getDb()
        .prepare(INSERT_FEATURE_BUILD_SQL)
        .run({
            id: build.id,
            conversationId: build.conversationId,
            artifactId: build.artifactId,
            title: build.title,
            branch: build.branch,
            status: build.status,
            selectedOption: build.selectedOption ?? null,
            requester: build.requester,
            prId: null,
            prUrl: null,
            lastAction: null,
            lastError: null,
            createdAt: build.createdAt,
            updatedAt: build.updatedAt
        });
    return build;
}

/** Fields that may be patched on a feature build. */
export interface FeatureBuildPatch {
    readonly status?: FeatureBuildStatus;
    readonly prId?: number;
    readonly prUrl?: string;
    readonly lastAction?: string;
    readonly lastError?: string | null;
}

/** Apply a partial update to a feature build (always bumps updatedAt). */
export function updateFeatureBuild(id: string, patch: FeatureBuildPatch): FeatureBuild | undefined {
    const sets: string[] = ['updatedAt = :updatedAt'];
    const params: Record<string, string | number | null> = { id, updatedAt: new Date().toISOString() };
    if (patch.status !== undefined) {
        sets.push('status = :status');
        params.status = patch.status;
    }
    if (patch.prId !== undefined) {
        sets.push('prId = :prId');
        params.prId = patch.prId;
    }
    if (patch.prUrl !== undefined) {
        sets.push('prUrl = :prUrl');
        params.prUrl = patch.prUrl;
    }
    if (patch.lastAction !== undefined) {
        sets.push('lastAction = :lastAction');
        params.lastAction = patch.lastAction;
    }
    if (patch.lastError !== undefined) {
        sets.push('lastError = :lastError');
        params.lastError = patch.lastError;
    }
    getDb()
        .prepare(`UPDATE feature_builds SET ${sets.join(', ')} WHERE id = :id`)
        .run(params);
    return getFeatureBuild(id);
}

/** Look up a single feature build by id. */
export function getFeatureBuild(id: string): FeatureBuild | undefined {
    return rowToFeatureBuild(getDb().prepare('SELECT * FROM feature_builds WHERE id = :id').get({ id }));
}

/** All feature builds, most-recent first (rendered on the Code Autopilot tab). */
export function listFeatureBuilds(limit = 100): readonly FeatureBuild[] {
    const rows = getDb().prepare('SELECT * FROM feature_builds ORDER BY updatedAt DESC LIMIT :limit').all({ limit });
    const result: FeatureBuild[] = [];
    for (const row of rows) {
        const build = rowToFeatureBuild(row);
        if (build !== undefined) {
            result.push(build);
        }
    }
    return result;
}
