/**
 * Provider-aware registry.
 *
 * Backs both the artifact-type and deploy-method registries. A key (an artifact
 * type, or an `artifactType.method` pair) can be supplied by more than one
 * provider — git-flow itself, a plugin installed at the project level, or one
 * installed at the workspace root — so the registry stores every registration
 * and resolves between them instead of letting the last writer win.
 *
 * Precedence is by **location, most local first**, carried over from the
 * archived scaffold plans (`old/plan-scaffoldRepo.prompt.md` §4.2,
 * `old/plan-scaffoldCli.prompt.md` §6.1), which ranked project-local generators
 * above repo-level ones above packages from `node_modules`. Applied here:
 *
 *   project  — a plugin in the project's own package.json
 *   workspace — a plugin in the workspace-root package.json
 *   builtin  — shipped inside git-flow
 *
 * Anything installed therefore beats a built-in, and a project-level plugin
 * beats a workspace-level one. A tie *within* a level cannot be resolved by
 * location, and is deliberately an error rather than an arbitrary winner: a
 * silently wrong handler in a release pipeline publishes the wrong artifact and
 * nobody finds out. Callers break such ties explicitly, by naming the provider.
 */

/** Provider name recorded for everything shipped inside git-flow. */
export const BUILTIN_PROVIDER = '@cpdevtools/git-flow';

export type PluginAnchor = 'project' | 'workspace' | 'builtin';

/** Higher wins. */
const ANCHOR_RANK: Record<PluginAnchor, number> = {
  project: 3,
  workspace: 2,
  builtin: 1,
};

export interface Registration<T> {
  /** Package name of whatever supplied this, e.g. '@org/git-flow-plugin-helm'. */
  provider: string;
  anchor: PluginAnchor;
  value: T;
}

export class ProviderConflictError extends Error {
  constructor(
    readonly key: string,
    readonly providers: string[],
    what: string,
  ) {
    super(
      `${what} '${key}' is supplied by more than one plugin at the same level:\n` +
        providers.map((p) => `  - ${p}`).join('\n') +
        `\n\nLocation cannot break this tie. Name the one you want on the artifact:\n` +
        `  artifacts:\n` +
        `    - type: ${key}\n` +
        `      provider: '${providers[0]}'\n` +
        `\nOr uninstall the one you do not want.`,
    );
    this.name = 'ProviderConflictError';
  }
}

/**
 * Registry state lives on globalThis, keyed by a registered Symbol, NOT as a
 * module-private Map.
 *
 * tsup builds this package as CJS with `splitting: false` and seven entry
 * points, so provider-registry.ts is inlined into `index`, `artifacts`,
 * `build-pack` and `publish-release` — four independent module instances. A
 * module-private Map would mean four independent registries, and a process that
 * touches two entry points (the CLI already imports from both `artifacts` and
 * `build-pack`) would register into one and dispatch from another — the exact
 * dual-instance failure the plugin contract exists to prevent, reintroduced
 * inside our own package. `Symbol.for` gives every copy the same store.
 */
const STORE_KEY = Symbol.for('@cpdevtools/git-flow:provider-registries');

type Store = Map<string, Map<string, Map<string, Registration<unknown>>>>;

function sharedStore(): Store {
  const holder = globalThis as { [STORE_KEY]?: Store };
  return (holder[STORE_KEY] ??= new Map());
}

export class ProviderRegistry<T> {
  /** key → provider → registration */
  private readonly entries: Map<string, Map<string, Registration<T>>>;

  constructor(private readonly what: string) {
    const store = sharedStore();
    let entries = store.get(what);
    if (!entries) {
      entries = new Map();
      store.set(what, entries);
    }
    this.entries = entries as Map<string, Map<string, Registration<T>>>;
  }

  register(key: string, value: T, provider: string, anchor: PluginAnchor): void {
    let byProvider = this.entries.get(key);
    if (!byProvider) {
      byProvider = new Map();
      this.entries.set(key, byProvider);
    }
    // Re-registering the same key from the same provider replaces it, which is
    // what a plugin reloaded in one process should do.
    byProvider.set(provider, { provider, anchor, value });
  }

  /**
   * Resolve a key, optionally pinned to a provider.
   *
   * Returns undefined when nothing is registered, so callers can raise their own
   * "unknown type" error with the vocabulary of their domain. Throws when the
   * choice is genuinely ambiguous.
   */
  resolve(key: string, provider?: string): T | undefined {
    const byProvider = this.entries.get(key);
    if (!byProvider || byProvider.size === 0) return undefined;

    if (provider) {
      const pinned = byProvider.get(provider);
      if (!pinned) {
        throw new Error(
          `${this.what} '${key}' is not supplied by '${provider}'.\n` +
            `Available: ${[...byProvider.keys()].join(', ')}`,
        );
      }
      return pinned.value;
    }

    const candidates = [...byProvider.values()];
    const best = Math.max(...candidates.map((c) => ANCHOR_RANK[c.anchor]));
    const winners = candidates.filter((c) => ANCHOR_RANK[c.anchor] === best);

    if (winners.length > 1) {
      throw new ProviderConflictError(key, winners.map((w) => w.provider).sort(), this.what);
    }

    return winners[0]!.value;
  }

  /** Every registered key, sorted — for "did you mean" style error messages. */
  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** Providers supplying a key, sorted. */
  providersOf(key: string): string[] {
    return [...(this.entries.get(key)?.keys() ?? [])].sort();
  }

  has(key: string): boolean {
    return (this.entries.get(key)?.size ?? 0) > 0;
  }
}
