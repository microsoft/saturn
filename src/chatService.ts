// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { randomBytes } from 'node:crypto';
import { defaultReasoningEffort, fixTimeoutMs, primaryModel } from './config';
import { ensureAdoMcpServer, resolveCopilotCli } from './copilot';
import { ensureFeatureClone } from './git';
import { type DesignAgentContext, runDesignTurn } from './designAgent';
import { type FeatureBuildContext, runFeatureBuild } from './featureBuild';
import {
    addMessage,
    type Artifact,
    type ChatMessage,
    type Conversation,
    createArtifact,
    createFeatureBuild,
    type DesignOption,
    type FeatureBuild,
    getArtifact,
    getConversation,
    latestArtifact,
    listMessages,
    searchRelatedArtifacts,
    updateArtifact,
    updateConversation
} from './chatStore';
import { consoleLogger, describeError, type Logger } from './util';

// Orchestrates the Chat tab: it wires the design agent and the feature-build pipeline to the store. It
// resolves the Copilot CLI + a dedicated feature clone once (cached), runs a conversational design turn
// (injecting cross-session memory), persists messages/artifacts, and - on approval - kicks off a feature
// build. Building is serialized so two builds never fight over the shared clone.

const logger: Logger = consoleLogger;

function chatEffort(): string {
    const configured = (process.env.SATURN_CHAT_EFFORT ?? '').trim();
    // Chat is interactive, so default to 'high' (fast + strong) rather than the agents' 'max'. Override with
    // SATURN_CHAT_EFFORT.
    return configured !== '' ? configured : 'high';
}

function chatTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.SATURN_CHAT_TIMEOUT_MS ?? '', 10);
    return Number.isNaN(parsed) || parsed <= 0 ? 600_000 : parsed;
}

// --- lazily-resolved, cached build environment (CLI + clone + optional ADO MCP) --------------------------

interface BuildEnv {
    readonly cliPath: string;
    readonly cloneDir: string;
    readonly allowMcpServerName?: string;
}

let cachedCliPath: string | undefined;
let cachedCloneDir: string | undefined;
let cloneInFlight: Promise<string> | undefined;
let cachedMcpServer: string | undefined;
let mcpResolved = false;

async function ensureBuildEnv(): Promise<BuildEnv | undefined> {
    if (cachedCliPath === undefined) {
        cachedCliPath = resolveCopilotCli();
    }
    if (cachedCliPath === undefined) {
        return undefined;
    }
    if (!mcpResolved) {
        cachedMcpServer = ensureAdoMcpServer(undefined);
        mcpResolved = true;
    }
    if (cachedCloneDir === undefined) {
        cloneInFlight = cloneInFlight ?? ensureFeatureClone(logger);
        cachedCloneDir = await cloneInFlight;
    }
    return {
        cliPath: cachedCliPath,
        cloneDir: cachedCloneDir,
        ...(cachedMcpServer !== undefined ? { allowMcpServerName: cachedMcpServer } : {})
    };
}

// Serialize feature builds: they branch + edit the shared feature clone, so only one may run at a time.
let buildChain: Promise<void> = Promise.resolve();
function enqueueBuild(task: () => Promise<void>): void {
    buildChain = buildChain.then(task).catch((error: unknown) => {
        logger.warn(`Chat service: queued feature build threw: ${describeError(error)}`);
    });
}

// --- chat turns ------------------------------------------------------------------------------------------

/** The state returned to the dashboard after a turn (the refreshed conversation + messages + latest doc). */
export interface ChatTurnResult {
    readonly conversation: Conversation;
    readonly messages: readonly ChatMessage[];
    readonly artifact?: Artifact;
}

// Heuristic: on the spec path, once the agent has asked, read the user's answer to decide whether they want
// technical detail. Best-effort only - the agent's own guidance also adapts to whatever the user says.
function inferAudience(message: string): 'technical' | 'non-technical' | undefined {
    const lc = message.toLowerCase();
    if (/\b(non-?technical|plain|simple|business|summary|high[-\s]?level)\b/.test(lc) || /^\s*no\b/.test(lc)) {
        return 'non-technical';
    }
    if (/\b(technical|details?|engineer|deep|full|architecture|design doc)\b/.test(lc) || /^\s*yes\b/.test(lc)) {
        return 'technical';
    }
    return undefined;
}

function upsertArtifact(
    conversation: Conversation,
    designDoc: { title: string; markdown: string },
    feasibility: Artifact['feasibility'],
    options: readonly DesignOption[]
): Artifact | undefined {
    const existing = latestArtifact(conversation.id);
    if (existing !== undefined && (existing.status === 'draft' || existing.status === 'approved')) {
        return updateArtifact(existing.id, {
            title: designDoc.title,
            markdown: designDoc.markdown,
            version: existing.version + 1,
            status: 'draft',
            options,
            ...(feasibility !== undefined ? { feasibility } : {})
        });
    }
    return createArtifact({
        conversationId: conversation.id,
        title: designDoc.title,
        markdown: designDoc.markdown,
        options,
        ...(feasibility !== undefined ? { feasibility } : {})
    });
}

/**
 * Handle one chat turn: persist the user message, run the design agent (with prior related work injected as
 * cross-session memory), persist the reply and any design document, and auto-title the conversation. Returns
 * the refreshed state, or undefined if the conversation does not exist.
 */
export async function handleChatTurn(
    conversationId: string,
    userMessage: string,
    onProgress?: (chunk: string) => void
): Promise<ChatTurnResult | undefined> {
    let conversation = getConversation(conversationId);
    if (conversation === undefined) {
        return undefined;
    }

    const priorHistory = listMessages(conversationId);
    addMessage({ conversationId, role: 'user', content: userMessage });

    // Resolve the audience from the user's answer once the agent has already asked (intent-based, any chat).
    if (conversation.audience === undefined && priorHistory.some((m) => m.role === 'assistant')) {
        const audience = inferAudience(userMessage);
        if (audience !== undefined) {
            conversation = updateConversation(conversationId, { audience }) ?? conversation;
        }
    }

    const env = await ensureBuildEnv();
    if (env === undefined) {
        addMessage({
            conversationId,
            role: 'assistant',
            content: 'The GitHub Copilot CLI is not available on the server, so I cannot research or design right now.'
        });
        return { conversation, messages: listMessages(conversationId) };
    }

    const related = searchRelatedArtifacts(`${conversation.title}\n${userMessage}`, conversationId);
    const ctx: DesignAgentContext = {
        cliPath: env.cliPath,
        model: primaryModel(),
        reasoningEffort: chatEffort(),
        repoRoot: env.cloneDir,
        timeoutMs: chatTimeoutMs(),
        ...(env.allowMcpServerName !== undefined ? { allowMcpServerName: env.allowMcpServerName } : {})
    };

    const result = await runDesignTurn(ctx, { conversation, history: priorHistory, userMessage, relatedWork: related }, logger, onProgress);

    let artifact: Artifact | undefined;
    if (result.designDoc !== undefined) {
        artifact = upsertArtifact(conversation, result.designDoc, result.feasibility, result.options);
    }
    addMessage({
        conversationId,
        role: 'assistant',
        content: result.reply,
        ...(artifact !== undefined ? { artifactId: artifact.id } : {})
    });

    if (conversation.title === 'New chat' || conversation.title.trim() === '') {
        const suggested =
            result.suggestedTitle !== undefined && result.suggestedTitle.trim() !== ''
                ? result.suggestedTitle.trim()
                : userMessage.trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 60);
        if (suggested !== '') {
            conversation = updateConversation(conversationId, { title: suggested }) ?? conversation;
        }
    }

    return {
        conversation: getConversation(conversationId) ?? conversation,
        messages: listMessages(conversationId),
        ...(artifact !== undefined ? { artifact } : { ...(latestArtifact(conversationId) !== undefined ? { artifact: latestArtifact(conversationId) } : {}) })
    };
}

// --- approve + build -------------------------------------------------------------------------------------

/** Outcome of an approve-and-build request. */
export interface ApproveResult {
    readonly status: 'building' | 'needs-selection' | 'not-feasible' | 'error';
    readonly build?: FeatureBuild;
    readonly options?: readonly DesignOption[];
    readonly message?: string;
}

/**
 * Approve a design and start a feature build. Option-selection rule (#4): if the doc has multiple options and
 * none was picked, ask once (needs-selection) unless proceedWithBest is set, in which case pick the
 * recommended (or first) option. A not-feasible design is never built.
 */
export async function approveAndBuild(
    conversationId: string,
    artifactId: string,
    opts: { readonly selectedOption?: string; readonly proceedWithBest?: boolean; readonly requester: string }
): Promise<ApproveResult> {
    const artifact = getArtifact(artifactId);
    if (artifact === undefined || artifact.conversationId !== conversationId) {
        return { status: 'error', message: 'Design document not found.' };
    }
    if (artifact.feasibility === 'not-possible') {
        addMessage({
            conversationId,
            role: 'assistant',
            content: `I can't build **${artifact.title}** because it was assessed as not feasible. Let's refine the requirements first.`
        });
        return { status: 'not-feasible', message: 'The design was assessed as not feasible.' };
    }

    const options = artifact.options;
    let selected = opts.selectedOption;
    if (selected === undefined) {
        if (options.length <= 1) {
            selected = options[0]?.label;
        } else if (opts.proceedWithBest !== true) {
            const list = options.map((o) => `- **${o.label}**${o.recommended === true ? ' (recommended)' : ''}: ${o.summary}`).join('\n');
            addMessage({
                conversationId,
                role: 'assistant',
                content: `This design has more than one option. Which should I build?\n\n${list}\n\nReply with the option name, or say "go with the best" and I'll build the recommended one.`
            });
            return { status: 'needs-selection', options };
        } else {
            selected = (options.find((o) => o.recommended === true) ?? options[0])?.label;
        }
    }

    const env = await ensureBuildEnv();
    if (env === undefined) {
        return { status: 'error', message: 'The GitHub Copilot CLI is not available on the server.' };
    }

    const branch = `saturn/feature/${randomBytes(4).toString('hex')}`;
    const build = createFeatureBuild({
        conversationId,
        artifactId,
        title: artifact.title,
        branch,
        requester: opts.requester,
        ...(selected !== undefined ? { selectedOption: selected } : {})
    });
    updateArtifact(artifactId, { status: 'approved', ...(selected !== undefined ? { selectedOption: selected } : {}) });
    addMessage({
        conversationId,
        role: 'assistant',
        content: `🚧 Starting the build for **${artifact.title}**${selected !== undefined ? ` (approach: **${selected}**)` : ''}. I'll create a branch, implement it, validate the code twice, and open a pull request - I'll post the link here when it's ready.`
    });

    const buildCtx: FeatureBuildContext = {
        cliPath: env.cliPath,
        model: primaryModel(),
        reasoningEffort: defaultReasoningEffort(),
        cloneDir: env.cloneDir,
        timeoutMs: fixTimeoutMs(),
        ...(env.allowMcpServerName !== undefined ? { allowMcpServerName: env.allowMcpServerName } : {})
    };
    enqueueBuild(() => runFeatureBuild(build, artifact, buildCtx, logger));
    return { status: 'building', build };
}
