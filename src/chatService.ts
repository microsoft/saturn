// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { randomBytes } from 'node:crypto';
import { defaultReasoningEffort, fixTimeoutMs, primaryModel } from './config';
import { ensureAdoMcpServer, resolveCopilotCli } from './copilot';
import { ensureFeatureClone } from './git';
import { type DesignAgentContext, runDesignTurn } from './designAgent';
import { runFinderTurn } from './finderAgent';
import { addressFeatureBuildFeedback, type FeatureBuildContext, runFeatureBuild } from './featureBuild';
import { exportArtifactToLoop, loopExportStatus } from './loopExport';
import { type TaskPlanItem } from './taskPlan';
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
    getFeatureBuild,
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
    // Max thinking for Builder Autopilot too (opus-4.8 at max effort); override with SATURN_CHAT_EFFORT.
    return configured !== '' ? configured : defaultReasoningEffort();
}

function chatTimeoutMs(): number {
    // Generous 30-min per-invocation cap: a design turn (research + multi-pass todo plan at max effort on a
    // large repo) can run long, so this stays well above the old 10-min value while still bounding a genuine
    // hang. Override with SATURN_CHAT_TIMEOUT_MS (a positive value).
    const parsed = Number.parseInt(process.env.SATURN_CHAT_TIMEOUT_MS ?? '', 10);
    return Number.isNaN(parsed) || parsed <= 0 ? 1_800_000 : parsed;
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
    /** The AI-suggested title for this turn (derived from the main design call; refines a provisional title). */
    readonly suggestedTitle?: string;
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
    onProgress?: (chunk: string) => void,
    onPlan?: (items: readonly TaskPlanItem[]) => void
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
        timeoutMs: chatTimeoutMs()
    };

    const turnInput = { conversation, history: priorHistory, userMessage, relatedWork: related };
    const result =
        conversation.mode === 'finder'
            ? await runFinderTurn(ctx, turnInput, logger, onProgress, onPlan)
            : await runDesignTurn(ctx, turnInput, logger, onProgress, onPlan);

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
        ...(result.suggestedTitle !== undefined && result.suggestedTitle.trim() !== ''
            ? { suggestedTitle: result.suggestedTitle.trim() }
            : {}),
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
    const parentConversation = getConversation(conversationId);
    if (parentConversation !== undefined && parentConversation.mode === 'finder') {
        return {
            status: 'error',
            message: 'This is a Feature Finder report, not a buildable design. Start a Builder chat to design a specific idea.'
        };
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

/** Outcome of an owner-initiated "address review feedback" request. */
export interface AddressFeedbackResult {
    readonly status: 'queued' | 'error';
    readonly message?: string;
}

/**
 * Queue an owner-initiated pass to address the open review comments on a feature build's PR. It runs on the
 * same serialized build queue (so it never collides with a build) and ONLY when explicitly requested - it
 * does not poll or consume model capacity on its own.
 */
export async function addressFeatureFeedback(buildId: string): Promise<AddressFeedbackResult> {
    const build = getFeatureBuild(buildId);
    if (build === undefined) {
        return { status: 'error', message: 'Build not found.' };
    }
    if (build.status !== 'pr-open' || build.prId === undefined) {
        return { status: 'error', message: 'This build has no open pull request to address yet.' };
    }
    const artifact = getArtifact(build.artifactId);
    if (artifact === undefined) {
        return { status: 'error', message: 'The design document for this build was not found.' };
    }
    const env = await ensureBuildEnv();
    if (env === undefined) {
        return { status: 'error', message: 'The GitHub Copilot CLI is not available on the server.' };
    }
    const ctx: FeatureBuildContext = {
        cliPath: env.cliPath,
        model: primaryModel(),
        reasoningEffort: defaultReasoningEffort(),
        cloneDir: env.cloneDir,
        timeoutMs: fixTimeoutMs(),
        ...(env.allowMcpServerName !== undefined ? { allowMcpServerName: env.allowMcpServerName } : {})
    };
    enqueueBuild(() => addressFeatureBuildFeedback(build, artifact, ctx, logger));
    return { status: 'queued' };
}

/** Outcome of exporting a design doc to Loop. */
export interface LoopExportOutcome {
    readonly status: 'exported' | 'unavailable' | 'error';
    readonly url?: string;
    readonly message?: string;
}

/**
 * Export a design-doc artifact to a Loop workspace page (gated on Loop being configured + reachable). On
 * success a link is posted back into the conversation. Never throws - failures are returned as a status.
 */
export async function exportArtifactToLoopService(artifactId: string): Promise<LoopExportOutcome> {
    const artifact = getArtifact(artifactId);
    if (artifact === undefined) {
        return { status: 'error', message: 'Design document not found.' };
    }
    const status = await loopExportStatus();
    if (!status.available) {
        return { status: 'unavailable', message: `Loop export is not available (${status.reason ?? 'unknown'}).` };
    }
    try {
        const result = await exportArtifactToLoop(artifact.title, artifact.markdown, logger);
        addMessage({
            conversationId: artifact.conversationId,
            role: 'assistant',
            content:
                result.url !== undefined
                    ? `\ud83d\udcc4 Exported **${artifact.title}** to Loop: [open the page](${result.url}).`
                    : `\ud83d\udcc4 Exported **${artifact.title}** to Loop.`
        });
        return { status: 'exported', ...(result.url !== undefined ? { url: result.url } : {}) };
    } catch (error) {
        return { status: 'error', message: describeError(error) };
    }
}
