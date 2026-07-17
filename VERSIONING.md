# Versioning schemes

> Every build number in this file was produced by the same functions the lanes call
> (`render_build_number` / `derive_build_number` in `templates/Fastfile`) rather than typed
> by hand — including the rows that error.

## The model

One marketing version, two encodings.

- **Marketing version** — `package.json` → `version`. The user-facing release label, bumped
  once per cycle with `fastlane bump`. The *same* value ships to both platforms: Android
  `versionName`, iOS `MARKETING_VERSION`. Nothing about it is per-platform.
- **Iteration** — which upload of that marketing version this is. Never set by hand: the lane
  reads the store's history, finds the highest iteration already used for this version, adds 1.
  Since stg and prod ship to the same app, they share one counter and can't collide.
- **Build number** — marketing version + iteration, packed into one value. Android
  `versionCode`, iOS `CURRENT_PROJECT_VERSION`. Both carry identical information; only the
  *encoding* differs, which is the entire reason templates exist.

So `7.4.7` on its 2nd upload is one fact with (under `wide`) two spellings: `704702` on
Android, `7.4.702` on iOS.

## Template syntax

Fields are `{major}` `{minor}` `{patch}` `{iteration}`. A `:N` suffix zero-pads to N digits
and, more importantly, *reserves* exactly N digits — a value that doesn't fit is an error
rather than a silent overflow that would break ordering.

```jsonc
// fastlane/project.json
"build_number": {
  "android": "{major}{minor:2}{patch:1}{iteration:2}",   // 7.4.7 #2 -> 704702
  "ios":     "{major}.{minor}.{patch}{iteration:2}"      // 7.4.7 #2 -> 7.4.702
}
```

Three rules the Fastfile enforces before it builds anything:

1. **A field directly following another field must declare a width.** Without a separator
   between them there's nothing to stop digits smearing across the boundary once a value
   reaches two digits. `{major}{minor:2}{patch}{iteration:2}` is rejected — `{patch:1}` fixes it.
   A field that follows a separator (like `{patch}` after a `.`) is free to grow.
2. **Android must render a plain integer.** It's a `versionCode`; dots are rejected outright.
3. **`{iteration}`'s width sets the ceiling.** `{iteration:2}` → 99 uploads per marketing
   version, `{iteration:3}` → 999. Widening the field genuinely buys you more uploads.

## `compact` — the default

What the kit shipped before templates existed. Both platforms get the same integer. Cheapest to read, but minor and patch are capped at 9.

```
android: {major}{minor:1}{patch:1}{iteration:2}
ios:     {major}{minor:1}{patch:1}{iteration:2}
```

| marketing version | iteration | Android `versionCode` | iOS `CURRENT_PROJECT_VERSION` | note |
|---|---|---|---|---|
| `1.0.0` | 1 | `10001` | `10001` | first upload of a brand-new app |
| `7.4.7` | 2 | `74702` | `74702` | reference example |
| `7.4.7` | 99 | `74799` | `74799` | MAX iteration — last upload allowed for this version |
| `7.4.7` | 100 | **error** | **error** | iteration overflow |
| `7.9.9` | 99 | `79999` | `79999` | MAX minor + MAX patch + MAX iteration |
| `7.10.0` | 1 | **error** | **error** | minor overflow |
| `7.0.10` | 1 | **error** | **error** | patch overflow |
| `99.0.0` | 1 | `990001` | `990001` | major has no width, so it just keeps growing |

Ceilings: minor ≤ **9**, patch ≤ **9**, 99 uploads per version. Largest `versionCode` at major 9 is `99999` — about 21000× under Play's 2,100,000,000 limit, so major has room to keep growing.

## `wide`

Two digits for minor, and iOS keeps a dotted build number that mirrors the marketing version. Minor goes to 99; patch is still capped at 9.

```
android: {major}{minor:2}{patch:1}{iteration:2}
ios:     {major}.{minor}.{patch}{iteration:2}
```

| marketing version | iteration | Android `versionCode` | iOS `CURRENT_PROJECT_VERSION` | note |
|---|---|---|---|---|
| `1.0.0` | 1 | `100001` | `1.0.001` | first upload of a brand-new app |
| `7.4.7` | 2 | `704702` | `7.4.702` | reference example |
| `7.4.7` | 99 | `704799` | `7.4.799` | MAX iteration — last upload allowed for this version |
| `7.4.7` | 100 | **error** | **error** | iteration overflow |
| `7.99.9` | 99 | `799999` | `7.99.999` | MAX minor + MAX patch + MAX iteration |
| `7.100.0` | 1 | **error** | `7.100.001` | minor overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `7.0.10` | 1 | **error** | `7.0.1001` | patch overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `99.0.0` | 1 | `9900001` | `99.0.001` | major has no width, so it just keeps growing |

Note the asymmetry: a dotted iOS component can grow freely because the `.` delimits it, while the packed Android `versionCode` cannot. Android is what fails first, and that's deliberate — the error names the field and the width to widen.

Ceilings: minor ≤ **99**, patch ≤ **9**, 99 uploads per version. Largest `versionCode` at major 9 is `999999` — about 2100× under Play's 2,100,000,000 limit, so major has room to keep growing.

## `wide-patch`

Same idea, but patch also gets two digits — for projects that patch past .9 within a minor.

```
android: {major}{minor:2}{patch:2}{iteration:2}
ios:     {major}.{minor}.{patch}{iteration:2}
```

| marketing version | iteration | Android `versionCode` | iOS `CURRENT_PROJECT_VERSION` | note |
|---|---|---|---|---|
| `1.0.0` | 1 | `1000001` | `1.0.001` | first upload of a brand-new app |
| `7.4.7` | 2 | `7040702` | `7.4.702` | reference example |
| `7.4.7` | 99 | `7040799` | `7.4.799` | MAX iteration — last upload allowed for this version |
| `7.4.7` | 100 | **error** | **error** | iteration overflow |
| `7.99.99` | 99 | `7999999` | `7.99.9999` | MAX minor + MAX patch + MAX iteration |
| `7.100.0` | 1 | **error** | `7.100.001` | minor overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `7.0.100` | 1 | **error** | `7.0.10001` | patch overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `99.0.0` | 1 | `99000001` | `99.0.001` | major has no width, so it just keeps growing |

Note the asymmetry: a dotted iOS component can grow freely because the `.` delimits it, while the packed Android `versionCode` cannot. Android is what fails first, and that's deliberate — the error names the field and the width to widen.

Ceilings: minor ≤ **99**, patch ≤ **99**, 99 uploads per version. Largest `versionCode` at major 9 is `9999999` — about 210× under Play's 2,100,000,000 limit, so major has room to keep growing.

## `deep`

Three digits of iteration: 999 uploads per marketing version instead of 99. For projects that push many builds per version (heavy QA cycles).

```
android: {major}{minor:2}{patch:2}{iteration:3}
ios:     {major}.{minor}.{patch}{iteration:3}
```

| marketing version | iteration | Android `versionCode` | iOS `CURRENT_PROJECT_VERSION` | note |
|---|---|---|---|---|
| `1.0.0` | 1 | `10000001` | `1.0.0001` | first upload of a brand-new app |
| `7.4.7` | 2 | `70407002` | `7.4.7002` | reference example |
| `7.4.7` | 999 | `70407999` | `7.4.7999` | MAX iteration — last upload allowed for this version |
| `7.4.7` | 1000 | **error** | **error** | iteration overflow |
| `7.99.99` | 999 | `79999999` | `7.99.99999` | MAX minor + MAX patch + MAX iteration |
| `7.100.0` | 1 | **error** | `7.100.0001` | minor overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `7.0.100` | 1 | **error** | `7.0.100001` | patch overflow — Android's packing is the binding limit; iOS's dotted form still renders |
| `99.0.0` | 1 | `990000001` | `99.0.0001` | major has no width, so it just keeps growing |

Note the asymmetry: a dotted iOS component can grow freely because the `.` delimits it, while the packed Android `versionCode` cannot. Android is what fails first, and that's deliberate — the error names the field and the width to widen.

Ceilings: minor ≤ **99**, patch ≤ **99**, 999 uploads per version. Largest `versionCode` at major 9 is `99999999` — about 21× under Play's 2,100,000,000 limit, so major has room to keep growing.

## What does my next build get?

Say the store is on **7.5.2** and Play already holds `705201` and `705202`. You run a lane
again. Does it stay 7.5.2, or move to 7.5.3?

**It stays 7.5.2.** No build lane ever touches the marketing version — it reads
`package.json` → `version` exactly as written. Only the iteration moves (`wide` scheme):

| command | marketing version | Android `versionCode` | iOS build |
|---|---|---|---|
| `fastlane android stg` | 7.5.2 | `705203` | `7.5.202` |
| `fastlane android prod` | 7.5.2 | `705204` | `7.5.203` |

Users still see "7.5.2"; you've shipped the 3rd and 4th upload *of that release*. Which lane
you run makes no difference — stg and prod share the counter.

Moving to 7.5.3 is a separate, deliberate command:

```bash
fastlane bump          # package.json 7.5.2 -> 7.5.3, commit, tag v7.5.3, push
```

| command | marketing version | Android `versionCode` | iOS build |
|---|---|---|---|
| `fastlane android stg` | 7.5.3 | `705301` | `7.5.301` |

The iteration counter restarts at `01` because it's scoped to the marketing version.

The rule underneath: **the store's history feeds the iteration counter, nothing else.** The
marketing version has exactly one source, `package.json`. So "what's live in the store" does
not decide your next version — what's in `package.json` does.

That split is deliberate. The marketing version is what users see, which makes it a decision
("is this a new release?"), not a side effect of building. And because `bump` commits and
tags, every release is anchored in git history.

Bump types, from `7.5.2`:

| command | result |
|---|---|
| `fastlane bump` | `7.5.2` → `7.5.3` |
| `fastlane bump bump:minor` | `7.5.2` → `7.6.0` |
| `fastlane bump bump:major` | `7.5.2` → `8.0.0` |

### Forgetting to bump doesn't error

Neither store stops you. Play accepts `705203` under `versionName` 7.5.2 (the `versionCode`
is what must be unique), and TestFlight files `7.5.202` under marketing version 7.5.2. So a
forgotten bump fails silently — it just keeps shipping 7.5.2. Starting a new cycle? Run
`fastlane bump` first.

### Falling *behind* the store does error

The opposite case is the dangerous one. If `package.json` says `7.5.1` while Play already has
`705202`, every derived code lands under what's live and Play rejects the upload — normally
after a full native build and a slow upload. The Android lane already has the store's whole
code list in hand, so it checks up front instead:

```
package.json is at v7.5.1, which derives versionCode 705101 — but the store already has
705202. A release must raise the versionCode, so this build would be rejected on upload.
package.json has fallen behind the store: set it to the real store version, then `fastlane
bump`.
```

This is Android-only: that lane reads every `versionCode` across every track, while the iOS
lane only asks for the current version's highest build and so can't see the whole picture.

## Store limits worth knowing

- **Android `versionCode` ≤ 2,100,000,000** (Google Play, hard limit).
  Every scheme above clears it by orders of magnitude, which is why `{major}` is left
  variable-width — it can grow for years without any packing change.
- **iOS `CFBundleVersion` allows at most three period-separated integers.** This is why the
  dotted iOS templates fold patch and iteration into the *third* component
  (`{patch}{iteration:2}` → `7.4.702`) instead of adding a fourth (`7.4.7.2` — rejected by Apple).
- **Both stores require the build number to increase** within a marketing version. The
  iteration counter guarantees that as long as the template stays put.

## Changing a template on a live app

The encoding is a promise to the store's history, so changing it mid-version breaks the
"must increase" rule. The lanes handle the two platforms differently, on purpose:

- **iOS fails loudly.** It reads a single value (TestFlight's highest build for the current
  marketing version). If no iteration of the template can produce that value, the store and
  the template disagree and guessing would collide — so the lane stops and says so.
- **Android just works.** It reads every `versionCode` across all tracks, so codes that match
  no candidate are normal (they belong to other versions) and are ignored.

The safe move after any template change: `fastlane bump` to a new marketing version, so the
iteration counter starts fresh under the new encoding.

## Choosing

Start at `compact`. Move to `wide` when minor needs to pass 9, `wide-patch` when patch does,
`deep` when a single version genuinely needs more than 99 uploads. Anything else: write your
own templates — the presets are just two strings in `project.json`, not special cases in code.

Existing projects need no action: a `project.json` with no `build_number` key falls back to
`compact`, which reproduces the kit's original `major*10000 + minor*1000 + patch*100 + iteration`
formula exactly.
