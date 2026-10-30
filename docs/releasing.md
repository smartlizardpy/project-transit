# Releasing and automatic updates

Installed copies of Project Transit update themselves from this repository's GitHub Releases.

## How updates reach players

1. A version tag (`v0.2.1`) is pushed.
2. `.github/workflows/release.yml` builds the app and publishes a release:
   - It runs the type check and tests first; no release is made if they fail.
   - It builds macOS (Apple Silicon and Intel), Windows and Linux.
   - Each build is signed with the update key. The release also gets `latest.json`, which lists the newest version and its signed download for each platform.
3. The desktop app checks `https://github.com/smartlizardpy/project-transit/releases/latest/download/latest.json`:
   - 8 seconds after launch, then every 6 hours (Settings → Automatic updates turns this off; Settings → Check now checks at once).
   - If the version there is newer, it downloads the update in the background and shows "Version x is ready".
   - **Restart now** saves the game, installs and relaunches. **Later** keeps playing; the update installs when the player quits.
4. The app only installs updates whose signature matches the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

The browser version does not update itself; it is always the code it was served from.

## Making a release

1. Bump the version in all three places (they must match):
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Commit, then tag and push:

   ```sh
   git tag v0.2.1
   git push origin main v0.2.1
   ```

3. Watch the run: `gh run watch` (about 15–20 minutes). The release appears under Releases when all builds finish.

Installed apps pick up the release within 6 hours, or at their next launch.

## The signing key

- **Private key:** `~/.tauri/project-transit.key`, with its password in `~/.tauri/project-transit.key.password`, on the machine that set this up.
- **GitHub copy:** both are stored as the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which the release workflow uses.
- **Never commit them.** Only the public key is in the repository.
- **Back the key up somewhere safe.** If it is lost, installed copies can no longer be updated. Everyone would have to download a new version by hand, once, after the key is replaced.

To build signed update files locally:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/project-transit.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/project-transit.key.password)"
pnpm tauri build --config src-tauri/tauri.release.conf.json
```

Plain `pnpm app:build` needs no key and makes no update files.

## macOS signing

Builds are ad-hoc signed, not notarised (that needs a paid Apple Developer account). The first time, players right-click the app and choose **Open**. Updates installed by the app itself do not ask again.
