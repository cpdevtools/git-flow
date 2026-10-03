/**
 * Withdrawing a release: it still exists, with its tag, assets and history,
 * but `gitflow deploy` never offers it and the deploy side refuses it.
 *
 * The marker lives in the release body's `## Artifact Metadata` block — the
 * same block the deploy picker already reads — so there is one source of
 * truth and it is visible on the release page.
 */

export const WITHDRAW_KINDS = [
  'broken',
  'security',
  'accidental',
  'obsolete',
  'superseded',
  'temporary',
  'legal',
] as const;

export type WithdrawKind = (typeof WITHDRAW_KINDS)[number];

/** What to do to the package in its registries. */
export type RegistryEffect = 'mark' | 'delete' | 'none';
/** What to do with the release's attached files (deploy bundles, tarballs). */
export type AssetsEffect = 'keep' | 'delete';

export interface Withdrawal {
  /** One of WITHDRAW_KINDS; kept as a plain string so a new kind needs no schema change. */
  kind: string;
  reason: string;
  /** ISO timestamp. */
  at: string;
  /** Who withdrew it (GitHub login or git user). */
  by: string;
  /** For `superseded`: the version to use instead. */
  replacedBy?: string;
  /** Outcome of the registry effect, recorded by the workflow. */
  registry?: 'marked' | 'deleted' | 'unsupported' | 'none' | 'pending';
  /** Outcome of the assets effect, recorded by the workflow. */
  assets?: 'kept' | 'deleted' | 'pending';
}

export interface KindInfo {
  summary: string;
  /** Default registry effect offered by the prompt. */
  registry: RegistryEffect;
  /** Default assets effect offered by the prompt. */
  assets: AssetsEffect;
  /**
   * Whether the deploy side may be forced to deploy it anyway (rollbacks).
   * Never for kinds where deploying is itself the harm.
   */
  forceable: boolean;
}

export const KIND_INFO: Record<WithdrawKind, KindInfo> = {
  broken: {
    summary: 'The build is defective',
    registry: 'mark',
    assets: 'keep',
    forceable: false,
  },
  security: {
    summary: 'A vulnerability in this version or a dependency',
    registry: 'mark',
    assets: 'keep',
    forceable: false,
  },
  accidental: {
    summary: 'Released by mistake (wrong branch, premature merge)',
    registry: 'delete',
    assets: 'keep',
    forceable: false,
  },
  obsolete: {
    summary: 'No longer needed; nothing replaces it',
    registry: 'none',
    assets: 'keep',
    forceable: true,
  },
  superseded: {
    summary: 'Replaced by a specific later version',
    registry: 'none',
    assets: 'keep',
    forceable: true,
  },
  temporary: {
    summary: 'A preview or throwaway build that was never meant to persist',
    registry: 'none',
    assets: 'keep',
    forceable: true,
  },
  legal: {
    summary: 'Must not be distributed (licensing, contractual)',
    registry: 'delete',
    assets: 'delete',
    forceable: false,
  },
};

export function isWithdrawKind(value: string): value is WithdrawKind {
  return (WITHDRAW_KINDS as readonly string[]).includes(value);
}

/** Whether the deploy side may deploy a release withdrawn for this kind when forced. */
export function isForceableKind(kind: string): boolean {
  return isWithdrawKind(kind) ? KIND_INFO[kind].forceable : false;
}
