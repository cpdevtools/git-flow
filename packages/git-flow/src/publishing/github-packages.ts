/**
 * GitHub Packages version deletion, shared by the scheduled cleanup and by
 * `gitflow withdraw --registry delete`.
 *
 * `GITHUB_TOKEN` with `packages: write` can delete versions of a package that
 * is linked to the repository, which is how git-flow publishes. GitHub refuses
 * to delete a package's last remaining version through this endpoint; that is
 * reported rather than escalated to deleting the whole package.
 */

export interface GitHubPackageRef {
  type: 'npm' | 'nuget' | 'container';
  name: string;
}

/** GitHub Packages type + name for an artifact declaration, or null if none. */
export function githubPackageRef(artifactType: string, name: string): GitHubPackageRef | null {
  switch (artifactType) {
    case 'npm':
    case 'ng-lib':
      return { type: 'npm', name: name.replace(/^@[^/]+\//, '') };
    case 'nuget':
    case 'dotnet-lib':
      return { type: 'nuget', name };
    case 'docker':
    case 'docker-image':
      return { type: 'container', name: name.split('/').pop() ?? name };
    default:
      return null;
  }
}

export type PackageDeleteOutcome = 'deleted' | 'not-found' | 'last-version' | 'failed';

interface PackageVersion {
  id: number;
  name: string;
  metadata?: { container?: { tags?: string[] } };
}

async function gh(
  token: string,
  path: string,
  init: { method?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function paginate<T>(token: string, path: string): Promise<T[] | undefined> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const { status, body } = await gh(token, `${path}${sep}per_page=100&page=${page}`);
    if (status === 404) return undefined;
    if (status !== 200 || !Array.isArray(body)) {
      if (all.length === 0) throw new Error(`GET ${path} returned ${status}`);
      return all;
    }
    all.push(...(body as T[]));
    if ((body as T[]).length < 100) return all;
  }
}

/**
 * Delete one version of a GitHub package. Tries the organisation endpoint and
 * falls back to the user one, since the owner can be either.
 */
export async function deleteGitHubPackageVersion(
  token: string,
  owner: string,
  ref: GitHubPackageRef,
  version: string,
): Promise<PackageDeleteOutcome> {
  for (const scope of ['orgs', 'users'] as const) {
    const base = `/${scope}/${owner}/packages/${ref.type}/${encodeURIComponent(ref.name)}`;
    const versions = await paginate<PackageVersion>(token, `${base}/versions`);
    if (versions === undefined) continue; // not under this scope
    const match = versions.find((v) =>
      ref.type === 'container'
        ? (v.metadata?.container?.tags ?? []).includes(version)
        : v.name === version,
    );
    if (!match) return 'not-found';
    const { status, body } = await gh(token, `${base}/versions/${match.id}`, { method: 'DELETE' });
    if (status === 204) return 'deleted';
    if (status === 400 && JSON.stringify(body).includes('last version')) return 'last-version';
    return 'failed';
  }
  return 'not-found';
}
