# @cpdevtools/git-flow

Core library for Git-based versioning and release workflows with a unified CLI tool.

## Installation

```bash
pnpm add @cpdevtools/git-flow
```

## Features

### CLI Tool (`gitflow`)

A modern CLI with autocomplete support for build and pack operations:

```bash
# Display all available commands
gitflow --help

# Pack project artifacts
gitflow pack

# Apply version to project files
gitflow apply-version 1.2.3

# Enable autocomplete (bash/zsh)
gitflow autocomplete
```

**Subcommands:**
- `pack` - Automatically detect project type (NPM/NuGet) and create artifacts
- `apply-version` - Apply version to package.json or .csproj files
- `autocomplete` - Setup shell autocomplete
- `help` - Display help for any command

**Integration in projects:**
```json
{
  "scripts": {
    "github.actions.pack": "gitflow pack",
    "github.actions.build": "npm run build"
  }
}
```

See [CLI-TOOLS.md](./CLI-TOOLS.md) for complete documentation, hook system, and configuration options.

### Version Resolution

Resolve version placeholders based on branch and run number:

```typescript
import { resolveVersion } from '@cpdevtools/git-flow/version';

const result = await resolveVersion({
  placeholder: '0.0.0-DEFAULT',
  branch: 'main',
  versionsByPlaceholder: { '0.0.0-DEFAULT': '2.0.0' },
  runNumber: 123,
});

console.log(result.resolved); // "2.0.0" or "2.0.0-main.build.123"
```

### Branch Operations

Determine branch type and sanitize branch names:

```typescript
import { getBranchType, sanitizeBranchName } from '@cpdevtools/git-flow/branch';

const type = getBranchType('feature/new-feature'); // "development"
const sanitized = sanitizeBranchName('feature/new-feature'); // "feature.new-feature"
```

## Development

See the [monorepo root](../../README.md) for development instructions.

## License

MIT
