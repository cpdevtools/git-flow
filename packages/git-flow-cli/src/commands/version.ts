/**
 * gitflow version
 *
 * Interactive version-key setter. Reads versions.yml, presents branch-aware
 * semver bump options (filtered against existing git tags), writes the chosen
 * version back, and commits.
 *
 * Flags:
 *   --key       -k   Version key to update (e.g. MAIN). Skips key selection.
 *   --no-commit      Write versions.yml but skip the git commit.
 */

import { Command, Flags } from '@oclif/core';
import { execFileSync } from 'node:child_process';
import prompts from 'prompts';
import {
  isPreRelease,
  computeBumpOptions,
  filterExistingTags,
  keyDisplayName,
  findVersionsFile,
  readVersionsFile,
  writeVersionsFile,
  type BumpOption,
} from '@cpdevtools/git-flow';

// ─── Group metadata ───────────────────────────────────────────────────────────

const GROUP_ORDER: BumpOption['group'][] = [
  'stay-prerelease',
  'finish-prerelease',
  'next-version',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentBranch(): string {
  return execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function buildSelectChoices(
  options: BumpOption[],
): { choices: Array<{ title: string; value: BumpOption; disabled?: boolean }>; initial: number } {
  const choices: Array<{ title: string; value: BumpOption; disabled?: boolean }> = [];

  for (const group of GROUP_ORDER) {
    const groupOptions = options.filter((o) => o.group === group);
    for (const opt of groupOptions) {
      const disabledNote = opt.disabled ? `  ✗ ${opt.disabledReason}` : '';
      const label = opt.label.padEnd(18);
      const result = opt.result.padEnd(22);
      const title = `${label}${result}${opt.description}${disabledNote}`;
      choices.push({ title, value: opt, disabled: opt.disabled });
    }
  }

  // Default to 'next' (same channel, next number); fall back to first selectable.
  const advanceIdx = choices.findIndex((c) => !c.disabled && c.value.id === 'next');
  const initial =
    advanceIdx !== -1 ? advanceIdx : choices.findIndex((c) => !c.disabled);

  return { choices, initial: Math.max(0, initial) };
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default class Version extends Command {
  static override description =
    'Interactively set a version key in versions.yml and commit the change.';

  static override examples = [
    '<%= config.bin %> version',
    '<%= config.bin %> version --key MAIN',
    '<%= config.bin %> version --key MAIN --no-commit',
  ];

  static override flags = {
    key: Flags.string({
      char: 'k',
      description: 'Version key to update (e.g. MAIN). Skips the key selection prompt.',
    }),
    'no-commit': Flags.boolean({
      description: 'Write versions.yml but skip the git commit.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Version);

    const branch = getCurrentBranch();
    const cwd = process.cwd();

    // ── 1. Find + read versions.yml ───────────────────────────────────────────
    const versionsPath = await findVersionsFile(cwd);
    if (!versionsPath) {
      this.error(
        'No versions.yml found. Expected at .publish/versions.yml or .github/versions.yml.',
      );
    }

    const versions = await readVersionsFile(versionsPath);
    const placeholders = Object.keys(versions);
    if (placeholders.length === 0) {
      this.error('versions.yml is empty.');
    }

    // ── 2. Select version key ─────────────────────────────────────────────────
    let placeholder: string;

    if (flags.key) {
      const match = placeholders.find((p) => keyDisplayName(p) === flags.key);
      if (!match) {
        this.error(
          `Key "${flags.key}" not found. Available: ${placeholders.map(keyDisplayName).join(', ')}.`,
        );
      }
      placeholder = match!;
    } else if (placeholders.length === 1) {
      placeholder = placeholders[0];
    } else {
      const r = await prompts({
        type: 'select',
        name: 'placeholder',
        message: 'Select version key:',
        choices: placeholders.map((p) => ({ title: keyDisplayName(p), value: p })),
      });
      if (!r.placeholder) process.exit(0);
      placeholder = r.placeholder as string;
    }

    const keyName = keyDisplayName(placeholder);
    const currentVersion = versions[placeholder];

    // ── 3. Print header ───────────────────────────────────────────────────────
    const headerLeft = `  gitflow · set version`;
    const headerRight = `branch: ${branch}`;
    const pad = Math.max(2, 72 - headerLeft.length - headerRight.length);
    this.log(`\n${headerLeft}${' '.repeat(pad)}${headerRight}\n`);
    this.log(`  ◇  Version key   ${keyName}`);
    this.log(
      `  ◇  Current       ${currentVersion}   ${isPreRelease(currentVersion) ? 'pre-release' : 'stable'}\n`,
    );

    // ── 4. Compute + filter options ───────────────────────────────────────────
    const raw = computeBumpOptions(currentVersion);
    const options = await filterExistingTags(raw);

    const selectableCount = options.filter((o) => !o.disabled).length;
    if (selectableCount === 0) {
      this.error('All version options are already released. No changes available.');
    }

    // ── 5. Prompt for bump choice ─────────────────────────────────────────────
    const { choices, initial } = buildSelectChoices(options);
    const r = await prompts({
      type: 'select',
      name: 'bump',
      message: 'How should the version change?',
      choices,
      initial,
    });
    if (!r.bump) process.exit(0);
    const selected = r.bump as BumpOption;

    // ── 6. Write versions.yml ─────────────────────────────────────────────────
    versions[placeholder] = selected.result;
    await writeVersionsFile(versionsPath, versions);
    this.log(`\n  ✔  versions.${keyName} → ${selected.result}`);

    // ── 7. Commit ─────────────────────────────────────────────────────────────
    if (!flags['no-commit']) {
      const msg = `chore: set ${keyName} → ${selected.result}`;
      execFileSync('git', ['add', versionsPath], { stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', msg], { stdio: 'pipe' });
      this.log(`  ✔  committed    ${msg}`);
    }

    this.log('');
  }
}
