// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\permissions\patterns.ts
// Exhaustive catalog of dangerous shell / filesystem patterns used by the
// `DangerClassifier` to assign a risk severity to a tool invocation.
//
// Each pattern carries a severity ('medium' | 'high' | 'critical') and a
// short human-readable description. Patterns are intentionally broad and
// overlap on purpose: the classifier picks the highest severity across all
// matches, so a single dangerous indicator is enough to escalate a request.

/** Risk severity assigned to a single pattern. */
export type PatternSeverity = 'medium' | 'high' | 'critical';

/** Logical group a pattern belongs to. Useful for logs and UI. */
export type PatternCategory =
  | 'mass_delete'
  | 'disk_overwrite'
  | 'credentials'
  | 'dangerous_pipe'
  | 'privilege_escalation'
  | 'persistence'
  | 'remote_execution'
  | 'filesystem_writes_outside_workspace'
  | 'package_install';

/** A single dangerous-command pattern. */
export interface DangerousPattern {
  /** Stable id used in logs and tests. */
  readonly id: string;
  /** Severity when this pattern matches. */
  readonly severity: PatternSeverity;
  /** Category used for grouping. */
  readonly category: PatternCategory;
  /** Short human description of the risk. */
  readonly description: string;
  /** Compiled regex. Always anchored at the start of the substring. */
  readonly regex: RegExp;
}

/**
 * Pass-through helper that returns a `RegExp`. The signature accepts
 * either a `RegExp` literal (the common case in this file) or a source
 * string (so tests can recompile patterns with extra flags). The `flags`
 * argument is only honoured when `source` is a string.
 */
function re(source: RegExp | string, flags?: 'i'): RegExp {
  if (source instanceof RegExp) return source;
  return new RegExp(source, flags);
}

/**
 * The complete catalog. Order is not significant — the classifier sorts by
 * severity when reporting matches.
 */
export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  // -- Mass deletion ----------------------------------------------------
  {
    id: 'mass_delete.rm_rf_root',
    severity: 'critical',
    category: 'mass_delete',
    description: 'rm -rf of root, home, or filesystem root',
    regex: re(/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|\s+-?[a-zA-Z]*r[a-zA-Z]*\s+-?[a-zA-Z]*f[a-zA-Z]*\s+|\s+--recursive\s+--force\s+|\s+--no-preserve-root\s+)[\/~]/),
  },
  {
    id: 'mass_delete.rm_no_preserve_root',
    severity: 'critical',
    category: 'mass_delete',
    description: 'rm --no-preserve-root bypasses the safety check',
    regex: re(/\brm\b[^\n]*--no-preserve-root/),
  },
  {
    id: 'mass_delete.find_delete',
    severity: 'critical',
    category: 'mass_delete',
    description: 'find ... -delete / -exec rm ... targeting root or home',
    regex: re(/\bfind\b[^\n]*(\/-delete|-delete\s+\/|\/-exec\s+rm\b|\/-exec\s+rmdir\b)/),
  },
  {
    id: 'mass_delete.shred',
    severity: 'high',
    category: 'mass_delete',
    description: 'shred / srm secure deletion',
    regex: re(/\b(shred|srm|wipe)\b\s+-/),
  },

  // -- Disk overwrite ---------------------------------------------------
  {
    id: 'disk_overwrite.dd_to_dev',
    severity: 'critical',
    category: 'disk_overwrite',
    description: 'dd writing directly to a block device',
    regex: re(/\bdd\b[^\n]*\bof=\/dev\//),
  },
  {
    id: 'disk_overwrite.mkfs',
    severity: 'critical',
    category: 'disk_overwrite',
    description: 'mkfs formatting a block device',
    regex: re(/\bmkfs(\.[a-z0-9]+)?\s+\/dev\//),
  },
  {
    id: 'disk_overwrite.fdisk_parted',
    severity: 'critical',
    category: 'disk_overwrite',
    description: 'fdisk / parted partition-table manipulation',
    regex: re(/\b(fdisk|parted|sfdisk|cfdisk|sgdisk)\b\s+\/dev\//),
  },

  // -- Credentials ------------------------------------------------------
  {
    id: 'credentials.ssh_dir',
    severity: 'critical',
    category: 'credentials',
    description: 'access to ~/.ssh/ contents',
    regex: re(/\.ssh\/(id_rsa|id_ed25519|id_ecdsa|known_hosts|authorized_keys|config)/),
  },
  {
    id: 'credentials.aws_credentials',
    severity: 'critical',
    category: 'credentials',
    description: 'access to AWS credentials',
    regex: re(/\.aws\/(credentials|config)/),
  },
  {
    id: 'credentials.env_file',
    severity: 'critical',
    category: 'credentials',
    description: 'access to .env files (project or home)',
    regex: re(/(\.env|\.env\.[a-z]+|\.envrc)$/),
  },
  {
    id: 'credentials.gpg_private',
    severity: 'critical',
    category: 'credentials',
    description: 'access to GPG private keys',
    regex: re(/\.gnupg\/(private-keys-v1\.d|openpgp-revocs\.d|trustdb\.gpg)/),
  },
  {
    id: 'credentials.kube_config',
    severity: 'high',
    category: 'credentials',
    description: 'access to Kubernetes config / service account tokens',
    regex: re(/\.kube\/(config|.*\.token)/),
  },
  {
    id: 'credentials.npm_token',
    severity: 'high',
    category: 'credentials',
    description: 'access to npm auth token',
    regex: re(/\.npmrc/),
  },
  {
    id: 'credentials.netrc',
    severity: 'high',
    category: 'credentials',
    description: 'access to .netrc (plain-text credentials)',
    regex: re(/\.netrc$/),
  },

  // -- Dangerous pipes --------------------------------------------------
  {
    id: 'dangerous_pipe.curl_to_shell',
    severity: 'critical',
    category: 'dangerous_pipe',
    description: 'curl ... | sh / bash (remote code execution)',
    regex: re(/\bcurl\b[^\n|]*\|\s*(ba)?sh\b/, 'i'),
  },
  {
    id: 'dangerous_pipe.wget_to_shell',
    severity: 'critical',
    category: 'dangerous_pipe',
    description: 'wget ... | sh / bash (remote code execution)',
    regex: re(/\bwget\b[^\n|]*\|\s*(ba)?sh\b/, 'i'),
  },
  {
    id: 'dangerous_pipe.fetch_to_shell',
    severity: 'critical',
    category: 'dangerous_pipe',
    description: 'fetch ... | sh / bash (BSD remote code execution)',
    regex: re(/\bfetch\b[^\n|]*\|\s*(ba)?sh\b/, 'i'),
  },
  {
    id: 'dangerous_pipe.eval_remote',
    severity: 'critical',
    category: 'dangerous_pipe',
    description: 'bash -c "$(curl ...)" / eval of remote output',
    regex: re(/\b(eval|bash|sh)\b[^\n]*\$\(\s*(curl|wget)\b/, 'i'),
  },

  // -- Privilege escalation --------------------------------------------
  {
    id: 'privilege_escalation.chmod_world_writable',
    severity: 'high',
    category: 'privilege_escalation',
    description: 'chmod 777 / a+rwx makes files world-writable',
    regex: re(/\bchmod\b[^\n]*(\b777\b|\ba\+rwx\b|\bo\+w\b)/),
  },
  {
    id: 'privilege_escalation.chown_root',
    severity: 'high',
    category: 'privilege_escalation',
    description: 'chown to root or system accounts',
    regex: re(/\bchown\b[^\n]*\b(root|wheel|daemon|bin|sys)\b/),
  },
  {
    id: 'privilege_escalation.sudo',
    severity: 'high',
    category: 'privilege_escalation',
    description: 'sudo invocation (broad category, often legitimate but risky)',
    regex: re(/\bsudo\b\s+/),
  },
  {
    id: 'privilege_escalation.su_root',
    severity: 'high',
    category: 'privilege_escalation',
    description: 'su to root or another user',
    regex: re(/\bsu\b\s+-?\s*(root|[a-z_][a-z0-9_-]{0,31})\b/),
  },

  // -- Persistence / boot-time hooks -----------------------------------
  {
    id: 'persistence.crontab',
    severity: 'high',
    category: 'persistence',
    description: 'crontab modification (scheduled persistence)',
    regex: re(/\bcrontab\b\s+(-[a-z]*e|-[a-z]*l|\s+-)/),
  },
  {
    id: 'persistence.systemctl_enable',
    severity: 'high',
    category: 'persistence',
    description: 'systemctl enable / start on boot',
    regex: re(/\bsystemctl\b\s+(enable|start|restart|reload)\s+/),
  },
  {
    id: 'persistence.shell_rc',
    severity: 'high',
    category: 'persistence',
    description: 'writes to ~/.bashrc / ~/.zshrc / ~/.profile / ~/.bash_profile',
    regex: re(/(^|\s|>)~(\/|\/\.|\.)(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|tcshrc|cshrc)$/),
  },
  {
    id: 'persistence.systemd_unit',
    severity: 'high',
    category: 'persistence',
    description: 'writes to /etc/systemd/system / systemd user unit dirs',
    regex: re(/(\/etc\/systemd\/system|\.config\/systemd\/user)\/[a-zA-Z0-9_-]+\.service\b/),
  },
  {
    id: 'persistence.initd',
    severity: 'high',
    category: 'persistence',
    description: 'writes to /etc/init.d scripts',
    regex: re(/(\/etc\/init\.d\/|\/etc\/rc\.local)/),
  },

  // -- Remote execution (network) --------------------------------------
  {
    id: 'remote_execution.ssh_command',
    severity: 'high',
    category: 'remote_execution',
    description: 'ssh user@host "command" — runs a command on a remote host',
    regex: re(/\bssh\b[^\n]*@/),
  },
  {
    id: 'remote_execution.scp_upload',
    severity: 'medium',
    category: 'remote_execution',
    description: 'scp upload (file transfer to remote host)',
    regex: re(/\bscp\b[^\n]*:[^\n]*\s+[^\n]*@/),
  },
  {
    id: 'remote_execution.rsync_remote',
    severity: 'medium',
    category: 'remote_execution',
    description: 'rsync to a remote host',
    regex: re(/\brsync\b[^\n]*[a-zA-Z0-9_.-]+:/),
  },

  // -- Package install (bypasses review) -------------------------------
  {
    id: 'package_install.npm_global',
    severity: 'high',
    category: 'package_install',
    description: 'npm / pnpm / yarn global install',
    regex: re(/\b(npm|pnpm|yarn)\b\s+(install|i|add)\s+(-g|--global)\b/, 'i'),
  },
  {
    id: 'package_install.pip_user',
    severity: 'medium',
    category: 'package_install',
    description: 'pip / pip3 install (not pinned, may execute setup.py)',
    regex: re(/\b(pip|pip3|pipx)\b\s+install\b/, 'i'),
  },
  {
    id: 'package_install.brew_install',
    severity: 'medium',
    category: 'package_install',
    description: 'brew install / cask install',
    regex: re(/\bbrew\s+install\b/, 'i'),
  },
  {
    id: 'package_install.apt_install',
    severity: 'high',
    category: 'package_install',
    description: 'apt / apt-get / dnf / yum install (system-wide)',
    regex: re(/\b(apt|apt-get|dnf|yum|zypper|pacman)\b\s+(-y\s+)?install\b/, 'i'),
  },

  // -- Writes outside the workspace (path-based, used by write_file) ---
  // These are evaluated by the classifier, not by the bash pattern matcher.
  {
    id: 'filesystem.sensitive_path',
    severity: 'critical',
    category: 'filesystem_writes_outside_workspace',
    description: 'writes to /etc, /boot, /usr, /var, /lib, /sys, /proc',
    regex: re(/^\/(etc|boot|usr|var|lib|sys|proc|sbin|bin)(\/|$)/),
  },
  {
    id: 'filesystem.home_dotfiles',
    severity: 'high',
    category: 'filesystem_writes_outside_workspace',
    description: 'writes to well-known dotfile / credential locations',
    regex: re(/^~(\/|\/\.)(ssh|aws|gnupg|kube|config\/systemd)/),
  },
  {
    id: 'filesystem.windows_system',
    severity: 'high',
    category: 'filesystem_writes_outside_workspace',
    description: 'writes to Windows system / Program Files directories',
    regex: re(/^[a-zA-Z]:\\(Windows|Program Files|ProgramData|System32)(\\|$)/),
  },
];

/**
 * Lookup table for patterns by id. Useful for tests and for producing a
 * user-facing list of "what we look for".
 */
export const DANGEROUS_PATTERNS_BY_ID: ReadonlyMap<string, DangerousPattern> =
  new Map(DANGEROUS_PATTERNS.map((p) => [p.id, p]));

/** Return every pattern that matches `text`. */
export function findMatchingPatterns(text: string): DangerousPattern[] {
  const matches: DangerousPattern[] = [];
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.regex.test(text)) {
      matches.push(pattern);
    }
  }
  return matches;
}

/** Pick the highest severity among a list of patterns. */
export function highestSeverity(
  patterns: readonly DangerousPattern[],
): PatternSeverity {
  let best: PatternSeverity = 'medium';
  for (const p of patterns) {
    if (p.severity === 'critical') return 'critical';
    if (p.severity === 'high' && best === 'medium') best = 'high';
  }
  return best;
}
