# Releasing Hermes

This repository is configured to publish from a single Git tag:

- npmjs.com
- GitHub Releases

If the package name is scoped, the same workflow can also publish to GitHub Packages.

## One-time setup

1. In GitHub, open `Settings -> Secrets and variables -> Actions`.
2. Add a repository secret named `NPM_TOKEN`.
3. Create the token in npm with publish permission for the target package scope.

`GITHUB_TOKEN` is provided automatically by GitHub Actions, so you do not need to create a second secret for Releases or GitHub Packages.

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
git tag v0.0.1
git push origin v0.0.1
```

The release workflow then:

1. Runs `npm ci`
2. Runs `npm run build`
3. Runs `npm test`
4. Verifies that the Git tag version matches `package.json`
5. Publishes to npm with provenance
6. Publishes to GitHub Packages only if the package name is scoped
7. Creates a GitHub Release with generated notes

## Notes

- The workflow will fail if the tag version and `package.json` version do not match.
- The workflow will fail if `NPM_TOKEN` is missing or does not have access to the configured npm scope.
- The published npm tarball is restricted by the `files` field in `package.json`, so only the built CLI output and README are shipped.
- If you later want GitHub Packages, rename the package to a scoped name before publishing the first version there.
