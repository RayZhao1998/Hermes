# Releasing Hermes

This repository is configured to publish from a single Git tag:

- npmjs.com
- GitHub Releases

If the package name is scoped, the same workflow can also publish to GitHub Packages.

## One-time setup

Configure npm Trusted Publishing for the package on npmjs.com:

1. Open the package settings on npmjs.com and find `Trusted publishing`.
2. Add a `GitHub Actions` trusted publisher with:
   - Organization or user: your GitHub owner
   - Repository: your GitHub repository
   - Workflow filename: `release.yml`
   - Environment name: leave empty unless this workflow is later protected by a GitHub environment
3. Make sure the values match GitHub exactly, including letter case and the `.yml` suffix.

For this repository, the expected GitHub Actions trusted publisher values are:

- Organization or user: `RayZhao1998`
- Repository: `Hermes`
- Workflow filename: `release.yml`

`GITHUB_TOKEN` is provided automatically by GitHub Actions, so you do not need to create additional secrets for npm publish, GitHub Releases, or GitHub Packages.

## Package naming

The workflow is currently configured around the unscoped package name `hermes-gateway`.

- `hermes` and `hermes-cli` are already taken on npm.
- `hermes-gateway` can publish to npmjs as a normal public package.
- GitHub Packages npm registry only supports scoped package names such as `@your-scope/hermes-gateway`.
- With the current unscoped name, the workflow skips the GitHub Packages publish step automatically.

## Release flow

1. Update `package.json` with the new version.
2. Merge the release commit into your default branch.
3. Push the matching tag:

```bash
git tag v0.0.2
git push origin v0.0.2
```

The release workflow then:

1. Runs `npm ci`
2. Runs `npm run build`
3. Runs `npm test`
4. Verifies that the Git tag version matches `package.json`
5. Publishes to npm via GitHub Actions OIDC trusted publishing
6. Publishes to GitHub Packages only if the package name is scoped
7. Creates a GitHub Release with generated notes

## Notes

- The workflow will fail if the tag version and `package.json` version do not match.
- Trusted publishing requires a GitHub-hosted runner plus npm CLI `11.5.1+` and Node `22.14.0+`; the workflow uses Node 24 to satisfy this requirement.
- npm generates provenance automatically when trusted publishing is used from a public GitHub repository, so the workflow does not need a separate npm token or `--provenance` flag.
- The published npm tarball is restricted by the `files` field in `package.json`, so only the built CLI output and README are shipped.
- If you later want GitHub Packages, rename the package to a scoped name before publishing the first version there.
