# Plugins

A plugin adds artifact types and deploy methods. Installing the package is what enables it — there
is no list to maintain in `release-artifacts.yml`.

```ts
import type { GitFlowPlugin } from '@cpdevtools/git-flow/artifacts';

export default {
  name: '@org/git-flow-plugin-helm',
  artifactTypes: { 'helm-chart': helmHandler },
  deployMethods: [{ artifactType: 'docker-image', method: 'k8s', handler: k8sHandler }],
} satisfies GitFlowPlugin;
```

## A plugin exports data and never calls in

The registries are module-private state inside a bundled CJS build, so **every copy of
`@cpdevtools/git-flow` on disk owns a different one**. A plugin installed in your repository
resolves your repository's copy, while the build-pack action runs out of its own checkout. A plugin
that called `registerArtifactType` itself would register into a registry the running process never
reads, and would simply appear not to work — with no error.

Exporting a manifest removes the problem: the only thing crossing the boundary is a plain object,
and the types come from `import type`, which erases at compile time. git-flow imports the module,
reads the export, and registers on the plugin's behalf.

For plugins that must compute their registrations, an optional `register(api)` hook receives the
registration API **by argument** — again, never by import.

```ts
export default {
  name: '@org/git-flow-plugin-dynamic',
  register(api) {
    for (const region of REGIONS) {
      api.registerDeployMethod('docker-image', `swarm-${region}`, makeHandler(region));
    }
  },
} satisfies GitFlowPlugin;
```

## Discovery

A dependency is treated as a plugin when either:

- its name matches `git-flow-plugin-*` or `@scope/git-flow-plugin-*`, or
- its own `package.json` carries a `gitflow.plugin` key.

Both the project's and the workspace root's dependencies are scanned. Resolution goes through
`createRequire` from the declaring manifest, because a bare dynamic import would resolve from the
action's checkout rather than your repository.

## Precedence

Most local wins. Installed plugins are defaults you can override closer to the artifact:

1. `provider:` on the artifact — always wins
2. Plugins declared in the **project's** `package.json`
3. Plugins declared in the **workspace root's** `package.json`
4. Built-ins shipped with git-flow

```yaml
artifacts:
  - type: helm-chart
    provider: '@org/git-flow-plugin-helm'
```

A tie within a level is a **hard error naming both packages** rather than a silent pick. `provider:`
is the fix, and it also lets two artifacts in one file use the same type name from different
plugins.

`name` on the manifest is the provider key, so it must match the installed package name — it is what
`provider:` refers to.

## Built-ins are a plugin

Everything git-flow ships is declared on one manifest and applied through the same path an installed
plugin takes. There is no privileged set seeded behind the registry's back, built-ins sit at the
lowest rung of the same ladder, and the published contract is exercised by first-party code — so it
cannot quietly rot.

## Writing an artifact type

```ts
interface ArtifactType<T> {
  pack(artifact: T, ctx: PackContext): Promise<void>;
  packDeploy(artifact: T, ctx: PackDeployContext): Promise<void>;
  upload(artifact: T, ctx: UploadContext): Promise<void>;
  publish(artifact: T, registry: Registry, ctx: PublishContext): Promise<void>;
  getRegistries(artifact: T): string[];
  getVersion(artifact: T, projectVersion: string): string;
}
```

`pack` records what it produced onto the artifact object; later phases read it back from the
`.artifact.yml` descriptor. Return an empty array from `getRegistries` for a type that publishes
nothing.

Contexts carry `workspaceRoot` as well as `projectCwd`, so a handler can reach a generated client or
a sibling tool without guessing at `..` depth.

## Writing a deploy method

```ts
interface DeployMethodHandler {
  copyFiles(ctx: DeployMethodContext): Promise<void>;
  generateDeployYml(ctx: DeployMethodContext): Promise<void>;
  supportsParallelMajors?: boolean;
}
```

Two phases rather than one, because of the override path: a project that puts custom source files in
`.deploy/<method>/` but no `deploy.yml` gets its files copied and then only `generateDeployYml`
called, so it keeps the generated manifest without reimplementing the method.

Deploy methods are registered against an **artifact type**, never globally — `swarm` for a
`docker-image` is not `swarm` in the abstract.

`supportsParallelMajors` is a capability the handler declares rather than a list of method names
inside git-flow. It defaults to `false`: `versioning: major` requires the handler to derive every
shared identity from the deployment slot, and one that has not done that work would silently collide
with the major already deployed.
