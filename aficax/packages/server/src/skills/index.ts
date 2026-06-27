// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\skills\index.ts
// Barrel re-export for the skills subsystem.

export {
  SkillLoader,
  createSkillLoader,
  parseSkillFile,
  parseSkillFrontmatter,
  type Skill,
  type SkillLoaderOptions,
  type SkillSource,
} from './loader.js';

export {
  MAX_MATCHED_SKILLS,
  SkillMatcher,
  createSkillMatcher,
  type SkillMatch,
  type SkillMatcherOptions,
} from './matcher.js';

export {
  SkillInjector,
  createSkillInjector,
  type SkillInjectorOptions,
} from './injector.js';

export {
  parseFrontmatter,
  type ParsedFrontmatter,
  type YamlValue,
} from './yaml-mini.js';
