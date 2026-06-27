// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\skills\injector.ts
// SkillInjector: append the matched skills to the system prompt.
//
// The injector is intentionally dumb: it joins each skill's body under
// a clear Markdown header, separated by horizontal rules. The caller is
// responsible for picking which skills to inject (via the
// {@link SkillMatcher}). The injector never reads from disk; it operates
// only on the {@link Skill} objects it is given.

import type { Skill } from './loader.js';
import type { SkillMatch } from './matcher.js';

/** Public configuration of {@link SkillInjector}. */
export interface SkillInjectorOptions {
  /**
   * Maximum number of characters the injected block may add to the
   * prompt. When the joined block would exceed this budget, skills are
   * dropped from the tail of the list (already-matched `always: true`
   * skills are kept first).
   */
  readonly maxInjectedChars?: number;
  /**
   * Override the header template. Receives the skill name and the
   * 1-based index in the injected block; must return a Markdown
   * header line.
   */
  readonly headerFor?: (skill: Skill, index: number) => string;
}

const DEFAULT_MAX_CHARS = 12_000;

const SKILLS_HEADER = '# Active Skills';

/**
 * Build the "active skills" block that gets appended to the system
 * prompt. The block is empty when no skills are passed in; callers can
 * still concatenate it without special-casing.
 */
export class SkillInjector {
  private readonly maxInjectedChars: number;
  private readonly headerFor: (skill: Skill, index: number) => string;

  constructor(options: SkillInjectorOptions = {}) {
    this.maxInjectedChars = options.maxInjectedChars ?? DEFAULT_MAX_CHARS;
    this.headerFor = options.headerFor ?? defaultHeaderFor;
  }

  /**
   * Inject the matched skills into `systemPrompt`. The original prompt
   * is preserved verbatim; the skills block is appended (when non-empty)
   * after a horizontal rule.
   */
  inject(skills: readonly SkillMatch[], systemPrompt: string): string {
    if (skills.length === 0) return systemPrompt;
    const rendered = this.renderBlock(skills);
    if (rendered === null) return systemPrompt;
    if (systemPrompt.trim().length === 0) {
      return rendered;
    }
    return `${systemPrompt.trimEnd()}\n\n---\n\n${rendered}`;
  }

  /**
   * Render the skills block on its own (handy for tests and the
   * `/sessions/:id/skills` route).
   */
  renderBlock(skills: readonly SkillMatch[]): string | null {
    if (skills.length === 0) return null;
    const kept: SkillMatch[] = [];
    let budget = this.maxInjectedChars;
    for (const match of skills) {
      const piece = this.renderSkill(match, kept.length + 1);
      if (piece.length > budget) {
        // Drop any remaining matches; we cannot honour the budget.
        break;
      }
      budget -= piece.length;
      kept.push(match);
    }
    if (kept.length === 0) return null;
    const blocks: string[] = [SKILLS_HEADER];
    for (let i = 0; i < kept.length; i++) {
      const piece = this.renderSkill(kept[i]!, i + 1);
      blocks.push(piece);
    }
    return blocks.join('\n\n');
  }

  private renderSkill(match: SkillMatch, index: number): string {
    const header = this.headerFor(match.skill, index);
    const tag = match.matchedTrigger !== undefined ? ` (trigger: "${match.matchedTrigger}")` : '';
    return `${header}${tag}\n\n${match.skill.body.trim()}`;
  }
}

function defaultHeaderFor(skill: Skill, index: number): string {
  return `## Skill ${String(index)}: ${skill.name}`;
}

/** Factory that creates a fresh {@link SkillInjector}. */
export function createSkillInjector(options: SkillInjectorOptions = {}): SkillInjector {
  return new SkillInjector(options);
}
