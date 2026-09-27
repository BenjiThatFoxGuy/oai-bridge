# Releasing

This is for maintainers. Skip unless you're cutting a new version.

## One-time setup (per repo)

The `release.yml` workflow needs an npm token to publish. Without it, every tag push fails at the `npm publish` step with `ENEEDAUTH`.

**Bootstrap order matters for a brand-new package name.** A granular access
token can only be scoped to packages that already exist under your account —
you can't pre-scope one to a name nobody has published yet. So the very
first release has to happen once, by hand, before CI can take over:

1. Create/verify your npmjs.com account and enable 2FA (npm requires it to
   publish).
2. From this repo, locally: `npm login` (this is where your 2FA code goes),
   then `bun run build && npm publish --access public`. This claims
   `oai-bridge` and makes your account its owner.
3. *Now* mint a granular token at <https://www.npmjs.com/settings/USERNAME/tokens>:
   - **Permissions:** Read and write
   - **Packages:** select `oai-bridge` specifically (not "all packages" —
     narrower scope means less to lose if the token ever leaks)
   - **Expiration:** 1 year is reasonable; put a reminder somewhere to
     rotate it before it lapses. An expired token just fails CI loudly with
     `ENEEDAUTH` — it doesn't fail open.
4. Add it as `NPM_TOKEN` at <https://github.com/BenjiThatFoxGuy/oai-bridge/settings/secrets/actions>
   (or via `gh secret set NPM_TOKEN`).

Every release after that goes through the tag-push → CI path below; you
shouldn't need to run `npm publish` by hand again.

The workflow uses `id-token: write` to attach **provenance attestation**
automatically (this needs a public repo, which this one is). Verify with:

```bash
npm view oai-bridge --json | jq '.dist.attestations'
```

## Pre-flight

```bash
bun run typecheck
bun test
bun run lint
bun run build
npm publish --dry-run
```

All must pass with zero warnings.

## Version bump

Follow [SemVer](https://semver.org/):

- **patch** (0.1.0 → 0.1.1): bug fixes, no API change.
- **minor** (0.1.0 → 0.2.0): new features, backward-compatible API additions.
- **major** (0.1.0 → 1.0.0): breaking API changes.

```bash
# Edit:
#   package.json   → "version"
#   src/server.ts  → VERSION constant
#   CHANGELOG.md   → add new section, move "Unreleased" entries

git add package.json src/server.ts CHANGELOG.md
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

The `release.yml` GitHub Action then:
1. Runs `typecheck + test + lint + build` against the tag's commit.
2. Publishes to npm with provenance attestation (only succeeds if `NPM_TOKEN` is set — see One-time setup above).
3. Compiles standalone binaries (Linux, macOS, Windows) and attaches them to the GitHub Release.

## Re-running a failed publish

If the tag was pushed but publish failed (e.g. missing secret), fix the underlying cause and re-trigger without retagging:

```bash
gh workflow run release.yml -f ref=v0.3.0
```

This dispatches the same workflow against the existing tag's commit. Skip the `binaries` job (gated to `tags: v*` only) — manual dispatch publishes to npm only.

## Manual publish (if CI is unavailable)

```bash
# From a shell that has 2FA pop-up access (browser).
bun run build
npm publish --access public
# Provenance attestation is only available from CI, not local publish.
```

Requires a token with **publish permission for `oai-bridge`**.

## Rolling back

You have **72 hours** after publish to `npm unpublish oai-bridge@x.y.z` (npm's current policy — it used to be 24 hours, don't trust older advice). After that, the version is permanent — but you can `npm deprecate oai-bridge@x.y.z "use a.b.c instead"` to nudge users.

Never re-publish the same version with different content. Bump the patch instead.
