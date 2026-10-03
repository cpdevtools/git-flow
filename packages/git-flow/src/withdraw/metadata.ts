/**
 * Read and write the withdrawal marker in a release body.
 *
 * Two things change on the body: a banner at the very top so a reader of the
 * release page cannot miss it, and a `withdrawn:` entry in the Artifact
 * Metadata YAML block so tooling finds it where it already looks.
 */

import { parse, parseDocument } from 'yaml';
import type { Withdrawal } from './types.js';

const METADATA_RE = /(## Artifact Metadata\s*```yaml\s*\n)([\s\S]*?)(\n\s*```)/m;
const BANNER_START = '<!-- gitflow:withdrawn -->';
const BANNER_END = '<!-- /gitflow:withdrawn -->';
const BANNER_RE = new RegExp(`${BANNER_START}[\\s\\S]*?${BANNER_END}\\n*`, 'm');

export const WITHDRAWN_TITLE_PREFIX = '[WITHDRAWN] ';

/** The marker in a release body, if the release is withdrawn. */
export function readWithdrawal(body: string | null | undefined): Withdrawal | undefined {
  const match = body?.match(METADATA_RE);
  if (!match) return undefined;
  try {
    const parsed = parse(match[2]!) as { withdrawn?: unknown } | null;
    const w = parsed?.withdrawn;
    if (w && typeof w === 'object' && typeof (w as Withdrawal).kind === 'string') {
      return w as Withdrawal;
    }
  } catch {
    // Malformed YAML: treat as not withdrawn, the same way the picker treats it as no metadata.
  }
  return undefined;
}

export function isWithdrawn(body: string | null | undefined): boolean {
  return readWithdrawal(body) !== undefined;
}

export function renderBanner(w: Withdrawal): string {
  const lines = [
    `> ⛔ **WITHDRAWN (${w.kind})** — ${w.reason}`,
    `> Withdrawn ${w.at} by ${w.by}. This release is hidden from \`gitflow deploy\` and refused by the deploy side.`,
  ];
  if (w.replacedBy) lines.push(`> Use **${w.replacedBy}** instead.`);
  if (w.registry && w.registry !== 'pending') lines.push(`> Registry: ${w.registry}.`);
  if (w.assets && w.assets !== 'pending') lines.push(`> Assets: ${w.assets}.`);
  return `${BANNER_START}\n${lines.join('\n')}\n${BANNER_END}\n\n`;
}

/**
 * Return the body with the marker set (or removed when `withdrawal` is null).
 *
 * A body without a metadata block cannot carry the marker; the caller should
 * refuse such a release (it predates git-flow's metadata and the picker never
 * offers it anyway).
 */
export function setWithdrawalInBody(body: string, withdrawal: Withdrawal | null): string {
  const match = body.match(METADATA_RE);
  if (!match) {
    throw new Error('release body has no "## Artifact Metadata" block; cannot mark it');
  }
  const doc = parseDocument(match[2]!);
  if (withdrawal) {
    const entry: Record<string, string> = {
      kind: withdrawal.kind,
      reason: withdrawal.reason,
      at: withdrawal.at,
      by: withdrawal.by,
    };
    if (withdrawal.replacedBy) entry.replacedBy = withdrawal.replacedBy;
    if (withdrawal.registry) entry.registry = withdrawal.registry;
    if (withdrawal.assets) entry.assets = withdrawal.assets;
    doc.set('withdrawn', entry);
  } else {
    doc.delete('withdrawn');
  }
  const updatedYaml = doc.toString().replace(/\n$/, '');
  let updated = body.replace(METADATA_RE, (_m, start: string, _yaml: string, end: string) => {
    return `${start}${updatedYaml}${end}`;
  });
  updated = updated.replace(BANNER_RE, '');
  if (withdrawal) updated = renderBanner(withdrawal) + updated;
  return updated;
}

export function withdrawnTitle(name: string): string {
  return name.startsWith(WITHDRAWN_TITLE_PREFIX) ? name : WITHDRAWN_TITLE_PREFIX + name;
}

export function restoredTitle(name: string): string {
  return name.startsWith(WITHDRAWN_TITLE_PREFIX) ? name.slice(WITHDRAWN_TITLE_PREFIX.length) : name;
}
