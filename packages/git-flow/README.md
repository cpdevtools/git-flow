# @cpdevtools/git-flow

Core library for Git-based versioning and release workflows.

## Installation

```bash
pnpm add @cpdevtools/git-flow
```

## Features

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
# Test change
