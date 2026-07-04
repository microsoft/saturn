// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Pluggable LLM-provider registry for the setup installer. Today only the GitHub Copilot CLI (Saturn's
// backend) is implemented; the interface is deliberately provider-agnostic so direct-API providers
// (OpenAI / Anthropic / Azure OpenAI) can be added later without touching the setup UI or endpoints.

/** A selectable LLM provider. */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  /** Whether the provider needs an API key/endpoint (Copilot CLI does not - it uses the CLI's own auth). */
  readonly needsApiKey: boolean;
}

/** The models a provider offers, plus the recommended default. */
export interface ModelList {
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** When true, the UI also lets the user type a custom model id the provider accepts. */
  readonly allowCustom: boolean;
}

/** A model's tunable capabilities, as reported by the provider. */
export interface ModelCapabilities {
  /** Reasoning-effort levels, lowest-to-highest. */
  readonly effortLevels: readonly string[];
  /** Recommended default effort (the highest, per the requirement). */
  readonly defaultEffort: string;
  /** Selectable context-window sizes (tokens), or null when the provider uses the model's inherent window. */
  readonly contextSizes: readonly number[] | null;
  /** Recommended default context size (the highest), or null when not selectable. */
  readonly defaultContextSize: number | null;
}

const COPILOT_PROVIDER_ID = 'copilot';

// Reasoning-effort levels accepted by the GitHub Copilot CLI (--effort), lowest to highest. Verified against
// `copilot --help`. The opus-4.5 model ignores --effort (fixed level); the Copilot wrapper handles that.
const COPILOT_EFFORT_LEVELS: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

// Models Saturn is validated against on the Copilot CLI. The UI also allows a custom id (allowCustom) so any
// model the installed CLI supports can be used without a code change.
const COPILOT_MODELS: readonly string[] = ['claude-opus-4.8', 'claude-opus-4.5', 'claude-sonnet-4.5', 'gpt-5'];
const COPILOT_DEFAULT_MODEL = 'claude-opus-4.8';

/** The providers the installer can offer right now. */
export function listProviders(): readonly ProviderInfo[] {
  return [{ id: COPILOT_PROVIDER_ID, name: 'GitHub Copilot CLI', needsApiKey: false }];
}

/** True when the given id is a known/supported provider. */
export function isKnownProvider(providerId: string): boolean {
  return listProviders().some((provider) => provider.id === providerId);
}

/** The models a provider offers (queried where the provider supports it; a validated list for Copilot). */
export function listModels(providerId: string): ModelList {
  if (providerId === COPILOT_PROVIDER_ID) {
    return { models: COPILOT_MODELS, defaultModel: COPILOT_DEFAULT_MODEL, allowCustom: true };
  }
  return { models: [], defaultModel: '', allowCustom: true };
}

/**
 * A model's capabilities. Per the requirement the defaults are the HIGHEST available. The Copilot CLI does
 * not expose a context-window setting (each model uses its inherent window), so contextSizes is null there.
 */
export function modelCapabilities(providerId: string, model: string): ModelCapabilities {
  void model; // reserved for future per-model capability differences (context sizes, etc.)
  if (providerId === COPILOT_PROVIDER_ID) {
    return {
      effortLevels: COPILOT_EFFORT_LEVELS,
      defaultEffort: COPILOT_EFFORT_LEVELS[COPILOT_EFFORT_LEVELS.length - 1] ?? 'max',
      contextSizes: null,
      defaultContextSize: null
    };
  }
  return { effortLevels: ['default'], defaultEffort: 'default', contextSizes: null, defaultContextSize: null };
}
