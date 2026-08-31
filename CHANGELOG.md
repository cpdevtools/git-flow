# Test release workflow

## 1.0.5

- `build-pack`, `test`: warm up dotnet first-time-use before parallel project builds. Parallel first-ever `dotnet` invocations on a fresh runner race on NuGet's `NuGet-Migrations` named mutex (.NET 6 shm implementation → `IOException`/`EEXIST`); one serial `dotnet nuget locals all --list` now writes the migration marker before any project scripts run.
- `build-pack`: projects cancelled by fail-fast are now reported separately from failed ones instead of inflating the failure count.
