// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\skills\matcher.ts
// SkillMatcher: decide which skills apply to a given user message.
//
// The matcher is intentionally simple and explainable:
//   1. Every `always: true` skill is included unconditionally.
//   2. For every other skill, check whether any of its `triggers` appears
//      as a case-insensitive substring of the user message.
//   3. The result is capped at MAX_MATCHED_SKILLS (3) so a chatty user
//      does not blow up the context window.
//
// The matcher never throws. A malformed skill (no triggers, empty name)
// is silently skipped so the rest of the system keeps working.

import type { Skill } from './loader.js';

/** Maximum number of skills returned per call. */
export const MAX_MATCHED_SKILLS = 3;

/** Result of {@link SkillMatcher.findRelevant}. */
export interface SkillMatch {
  /** The matched skill. */
  readonly skill: Skill;
  /** Score (higher = more relevant). Currently either 1 (always) or 2 (trigger). */
  readonly score: number;
  /** Trigger phrase that matched, when `score` is `2`. */
  readonly matchedTrigger?: string;
}

/** Public configuration of {@link SkillMatcher}. */
export interface SkillMatcherOptions {
  /** Hard cap on the number of returned skills. Default {@link MAX_MATCHED_SKILLS}. */
  readonly maxResults?: number;
  /**
   * Optional override of the trigger-matcher. Defaults to a case-insensitive
   * substring check on the user message.
   */
  readonly matchTrigger?: (trigger: string, userMessage: string) => boolean;
}

/**
 * Pure helper that selects skills for a user message. The class is
 * stateless; instances can be re-used across threads.
 */
export class SkillMatcher {
  private readonly maxResults: number;
  private readonly matchTrigger: (trigger: string, userMessage: string) => boolean;

  constructor(options: SkillMatcherOptions = {}) {
    this.maxResults = options.maxResults ?? MAX_MATCHED_SKILLS;
    this.matchTrigger = options.matchTrigger ?? defaultTriggerMatch;
  }

  /**
   * Pick the most relevant skills for `userMessage`. Skills with
   * `always: true` are always returned; trigger-based matches are added
   * afterwards, sorted by trigger length (longer triggers are more
   * specific).
   */
  findRelevant(userMessage: string, availableSkills: readonly Skill[]): readonly SkillMatch[] {
    const matches: SkillMatch[] = [];
    const message = userMessage.toLowerCase();

    for (const skill of availableSkills) {
      if (skill.always) {
        matches.push({ skill, score: 1 });
        continue;
      }
      if (skill.triggers.length === 0) continue;
      let firstTrigger: string | undefined;
      let firstLength = -1;
      for (const trigger of skill.triggers) {
        if (this.matchTrigger(trigger, message)) {
          if (trigger.length > firstLength) {
            firstLength = trigger.length;
            firstTrigger = trigger;
          }
        }
      }
      if (firstTrigger !== undefined) {
        matches.push({ skill, score: 2, matchedTrigger: firstTrigger });
      }
    }

    // Always-skills first, then trigger-matches ordered by specificity.
    matches.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const aLen = a.matchedTrigger?.length ?? 0;
      const bLen = b.matchedTrigger?.length ?? 0;
      return bLen - aLen;
    });

    return matches.slice(0, this.maxResults);
  }
}

/**
 * Default trigger matcher: case-insensitive substring of the trigger
 * inside the (already lowercased) user message. Whitespace at the edges
 * of the trigger is ignored.
 */
function defaultTriggerMatch(trigger: string, loweredMessage: string): boolean {
  const normalised = trigger.trim().toLowerCase();
  if (normalised.length === 0) return false;
  return loweredMessage.includes(normalised);
}

/** Factory that creates a fresh {@link SkillMatcher}. */
export function createSkillMatcher(options: SkillMatcherOptions = {}): SkillMatcher {
  return new SkillMatcher(options);
}
