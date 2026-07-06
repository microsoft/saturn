// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Persisted todo-plans for the Builder Autopilot (design + feature-build) agents. They live OUTSIDE the code
// repository, under ~/.saturn/chat/plans/ (or $SATURN_HOME/chat/plans/), so the agent can create a checklist,
// work through it across multiple turns, and iterate until every item is done. This is intentionally separate
// from the repo's own todo.md. Persistence is best-effort and never throws (it is an aid, not a dependency).

/** One step in a task plan. */
export interface TaskPlanItem {
    readonly text: string;
    readonly done: boolean;
}

/** A persisted todo-plan for a design turn or a feature build. */
export interface TaskPlan {
    readonly id: string;
    readonly kind: 'design' | 'build';
    readonly goal: string;
    readonly items: readonly TaskPlanItem[];
    readonly complete: boolean;
    readonly iterations: number;
    readonly updatedAt: string;
}

function plansDir(): string {
    const home = (process.env.SATURN_HOME ?? '').trim() !== '' ? (process.env.SATURN_HOME ?? '').trim() : path.join(os.homedir(), '.saturn');
    return path.join(home, 'chat', 'plans');
}

function planFilePath(kind: 'design' | 'build', id: string): string {
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(plansDir(), `${kind}-${safeId}.json`);
}

/** Persist (create or overwrite) a task plan outside the code repo. Best-effort; never throws. */
export function savePlan(plan: TaskPlan): void {
    try {
        mkdirSync(plansDir(), { recursive: true });
        writeFileSync(planFilePath(plan.kind, plan.id), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    } catch {
        /* plan persistence is an aid, not a dependency */
    }
}

/** Load a previously-persisted plan, or undefined if none/unreadable. */
export function loadPlan(kind: 'design' | 'build', id: string): TaskPlan | undefined {
    try {
        const file = planFilePath(kind, id);
        if (!existsSync(file)) {
            return undefined;
        }
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as TaskPlan).items)) {
            return parsed as TaskPlan;
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/** Render a plan's items as a markdown checklist (for embedding in prompts or messages). */
export function renderChecklist(items: readonly TaskPlanItem[]): string {
    return items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
}
