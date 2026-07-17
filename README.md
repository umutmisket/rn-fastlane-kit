# rn-fastlane-kit

Interactive **fastlane setup generator** for bare React Native projects. One command
scaffolds a project's fastlane files, asking for the Android/iOS identifiers (and the
other required values) — so you never copy another project's package name / bundle id /
scheme by hand again.

> It's a **generator**, not a runtime dependency. You run it once per project; it writes
> files into `fastlane/` that are committed with that project. Nothing from this package
> is imported at build time.

## Why it's safe to reuse

The generated `Fastfile` and `Appfile` contain **no hardcoded identifiers** — they're
byte-for-byte identical across projects. Everything project-specific lives in one generated
file, `fastlane/project.json`:

```jsonc
{
  "app_name":        "myapp",
  "android_package": "com.acme.myapp",
  "ios_bundle_id":   "com.acme.myapp",     // may differ from Android
  "ios_team_id":     "3B8MDUV9S4",
  "ios_scheme":      "myapp",
  "ios_workspace":   "ios/myapp.xcworkspace",
  "android_play_json": "fastlane/play-service-account.json",
  "android_changelog_locales": ["tr-TR"],
  "api_url_env_key": "MYAPP_BASE_URL",      // optional, for a log line only
  "build_number": {                          // how to encode the build number per platform
    "android": "{major}{minor:2}{patch:1}{iteration:2}",
    "ios":     "{major}.{minor}.{patch}{iteration:2}"
  }
}
```

Secrets (ASC API key, keystore passwords) go to `fastlane/.env` (gitignored).

## Usage

From the target React Native project root:

```bash
npx github:umutmisket/rn-fastlane-kit
```

No install, no copying — `npx` pulls the latest from GitHub and runs the generator.
(During local development of this kit: `node setup.js` from a project root.)

It auto-detects what it can (Android `applicationId`, iOS workspace/scheme/bundle/team)
and offers them as defaults — press Enter to accept, or type to override. Then it writes:

| File | Committed? | Contents |
|---|---|---|
| `fastlane/project.json` | yes | identifiers |
| `fastlane/Fastfile` | yes | build/deploy lanes (identical across projects) |
| `fastlane/Appfile` | yes | reads project.json |
| `fastlane/release_notes.txt` | yes | created empty — write the note before shipping |
| `fastlane/.env.example` | yes | secret template |
| `fastlane/.env` | **no** (gitignored) | real secrets |

It also appends the fastlane secret patterns to the project's `.gitignore` if missing.

## After setup

1. Drop the secret files in place:
   - App Store Connect `.p8` → the path you gave as `ASC_KEY_PATH`
   - Play `service-account.json` → the path you gave as `android_play_json`
2. Add the Android signing + release guard to `android/app/build.gradle` (snippet below).
3. Write `fastlane/release_notes.txt` (scaffolded empty; the lanes refuse to ship on an
   empty note, so it can't silently reach the store unwritten).
4. Make sure `package.json` `version` is the **real** store version — the build number is
   derived from it.
5. Test: `fastlane android stg` / `fastlane ios stg`.

The Play app must already exist with **one AAB uploaded manually** — the Play API can't
create an app from scratch. Give the service account "Release manager" access.

## Lanes (in the generated Fastfile)

```bash
fastlane bump                 # new cycle: patch +1, commit+tag+push
fastlane bump bump:minor      # 1.2.4 -> 1.3.0
fastlane android stg | prod   # build + Play internal | production(draft)
fastlane ios stg | prod       # build + TestFlight
```

- **Marketing version** = `package.json` `version`; bumped once per cycle via `fastlane bump`.
  Must reflect the real store version. The same value ships to both platforms
  (Android `versionName`, iOS `MARKETING_VERSION`).
- **Build number** (Android `versionCode`, iOS `CURRENT_PROJECT_VERSION`) is derived
  automatically — you never set it by hand. See below.

## Build number scheme

A build number encodes the marketing version plus an **iteration** — "which upload of this
version is this". The iteration is read back from the store (highest existing + 1), so it
never resets and stg/prod can't collide.

Both platforms carry the same information; only the *encoding* differs, and projects
disagree on that. So each platform gets a template in `project.json` → `build_number`.
Fields are `{major}` `{minor}` `{patch}` `{iteration}`; `:N` zero-pads to N digits.

`setup.js` offers two presets — for marketing version **7.4.7**, 2nd upload:

| preset | Android `versionCode` | iOS `CURRENT_PROJECT_VERSION` |
|---|---|---|
| `compact` (default) | `74702` | `74702` |
| `wide` | `704702` | `7.4.702` |

```jsonc
// compact — {major}{minor:1}{patch:1}{iteration:2}  (both platforms)
// wide    — android: {major}{minor:2}{patch:1}{iteration:2}   ->  704702
//           ios:     {major}.{minor}.{patch}{iteration:2}     ->  7.4.702
```

Rules the Fastfile enforces before it builds anything:

- A field that **directly follows another field** (no separator between) must declare a
  width — otherwise its digits smear into the neighbour once it hits two digits.
  `{major}{minor:2}{patch}{iteration:2}` is rejected; `{patch:1}` fixes it.
- **Android must render a plain integer** — no dots (it's a `versionCode`). iOS may use
  dots (`CFBundleVersion` compares dotted components numerically).
- A value that doesn't fit its declared width is an error, not a silent overflow. With
  `compact`, version `7.10.7` fails on `{minor:1}` — switch to `{minor:2}` (i.e. `wide`).

**Changing the template mid-version:** iOS fails loudly if TestFlight's highest build for
the current marketing version can't be produced by the template. Run `fastlane bump` for a
new marketing version so the counter starts fresh.

See **[VERSIONING.md](VERSIONING.md)** for the full scheme comparison — rendered output for
every preset including its ceiling and overflow rows, plus the store limits behind them.

## android/app/build.gradle snippet

The Fastfile passes `-PappVersionCode/-PappVersionName` and expects release signing from
`fastlane/.env` via `System.getenv`. Add this to `android/app/build.gradle`:

```groovy
android {
    defaultConfig {
        // fastlane passes these for release builds; manual/debug builds use the dev fallback.
        def resolvedVersionCode = (project.findProperty("appVersionCode") ?: "1").toString().toInteger()
        def resolvedVersionName = (project.findProperty("appVersionName") ?: "0.0.0-dev").toString()
        versionCode resolvedVersionCode
        versionName resolvedVersionName
    }
    signingConfigs {
        release {
            def keystoreFile = System.getenv("ANDROID_KEYSTORE_FILE")
            if (keystoreFile) {
                storeFile file(keystoreFile)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
        debug { storeFile file('debug.keystore'); storePassword 'android'; keyAlias 'androiddebugkey'; keyPassword 'android' }
    }
    buildTypes {
        release {
            // Real release key if env is set; otherwise fall back to debug (the guard blocks store builds).
            signingConfig System.getenv("ANDROID_KEYSTORE_FILE") ? signingConfigs.release : signingConfigs.debug
            minifyEnabled enableProguardInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
}

// Release build guard — blocks a release AAB without fastlane / with missing config.
gradle.taskGraph.whenReady { graph ->
    def isRelease = graph.allTasks.any { t ->
        t.project.path == ":app" && (t.name == "bundleRelease" || t.name == "assembleRelease")
    }
    if (!isRelease) return
    if (!project.hasProperty("appVersionCode") || !project.hasProperty("appVersionName")) {
        throw new IllegalStateException("Release build needs appVersionCode/appVersionName. Run via Fastlane.")
    }
    def keystoreVars = ["ANDROID_KEYSTORE_FILE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]
    def missing = keystoreVars.findAll { !System.getenv(it) }
    if (!missing.isEmpty()) {
        throw new IllegalStateException("Missing release signing env vars: ${missing.join(', ')}. Fill fastlane/.env.")
    }
}
```

## Repo layout

```
rn-fastlane-kit/
├── package.json        # bin: rn-fastlane-kit -> setup.js
├── setup.js            # the interactive generator (CLI entry)
├── templates/
│   ├── Fastfile        # project-agnostic
│   ├── Appfile
│   └── env.example
└── README.md
```
