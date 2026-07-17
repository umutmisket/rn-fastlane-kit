#!/usr/bin/env node
/**
 * rn-fastlane-kit — interactive fastlane setup generator.
 *
 * Run from a React Native project root:
 *   npx github:umutmisket/rn-fastlane-kit      (or: node setup.js during local dev)
 *
 * Auto-detects identifiers from the project, asks for the rest, then writes:
 *   fastlane/project.json   (identifiers — committed)
 *   fastlane/Fastfile       (copied from the kit — project-agnostic)
 *   fastlane/Appfile        (copied from the kit)
 *   fastlane/.env           (secrets — gitignored)
 *   fastlane/.env.example   (shareable template)
 *
 * No hardcoded ids ever land in the Fastfile, so a copied setup cannot leak another
 * project's package name / bundle id / scheme.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TEMPLATES_DIR = path.join(__dirname, "templates");
const PROJECT_ROOT = process.cwd();
const FASTLANE_DIR = path.join(PROJECT_ROOT, "fastlane");

// ── tiny prompt helpers ───────────────────────────────────────────────────────
// Buffered line queue: robust to both interactive TTY and piped stdin (lines that
// arrive before a prompt is shown are queued instead of dropped).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const _lineQueue = [];
let _pending = null;
let _closed = false;
rl.on("line", (line) => {
  if (_pending) {
    const p = _pending;
    _pending = null;
    p(line);
  } else _lineQueue.push(line);
});
rl.on("close", () => {
  _closed = true;
  if (_pending) {
    const p = _pending;
    _pending = null;
    p(null);
  }
});
function nextLine() {
  if (_lineQueue.length) return Promise.resolve(_lineQueue.shift());
  if (_closed) return Promise.resolve(null);
  return new Promise((res) => {
    _pending = res;
  });
}
function write(s) {
  process.stdout.write(s);
}

// Ask with a default shown in [brackets]; empty answer keeps the default.
async function ask(label, def) {
  const suffix = def ? ` [${def}]` : "";
  write(`${label}${suffix}: `);
  const raw = await nextLine();
  const answer = (raw == null ? "" : raw).trim();
  return answer || def || "";
}

// Muted input for secrets (suppresses per-keystroke echo on a TTY).
async function askSecret(label) {
  write(`${label}: `);
  const orig = rl._writeToOutput;
  rl._writeToOutput = () => {};
  const raw = await nextLine();
  rl._writeToOutput = orig;
  write("\n");
  return (raw == null ? "" : raw).trim();
}

async function askYesNo(label, defYes) {
  const def = defYes ? "Y/n" : "y/N";
  write(`${label} [${def}]: `);
  const raw = await nextLine();
  const a = (raw == null ? "" : raw).trim().toLowerCase();
  if (!a) return !!defYes;
  return a === "y" || a === "yes" || a === "e" || a === "evet";
}

// ── build number templates ────────────────────────────────────────────────────
// Mirrors the Fastfile's scheme: the build number encodes the marketing version plus an
// iteration counter, and only the ENCODING differs per platform. Kept in sync with
// validate_build_template! in templates/Fastfile.
const BUILD_FIELDS = ["major", "minor", "patch", "iteration"];
const BUILD_TOKEN = /\{(\w+)(?::(\d+))?\}/g;
const BUILD_PRESETS = {
  compact: {
    android: "{major}{minor:1}{patch:1}{iteration:2}",
    ios: "{major}{minor:1}{patch:1}{iteration:2}",
  },
  wide: {
    android: "{major}{minor:2}{patch:1}{iteration:2}",
    ios: "{major}.{minor}.{patch}{iteration:2}",
  },
};

function tokensOf(template) {
  return [...template.matchAll(BUILD_TOKEN)].map((m) => ({ name: m[1], width: m[2] }));
}

// Returns an error string, or null when the template is usable.
function validateBuildTemplate(platform, template) {
  const tokens = tokensOf(template);
  if (!tokens.length) return `{alan} yer tutucusu yok: ${template}`;

  const unknown = tokens.map((t) => t.name).filter((n) => !BUILD_FIELDS.includes(n));
  if (unknown.length) return `bilinmeyen alan: ${unknown.map((n) => `{${n}}`).join(", ")} (geçerli: ${BUILD_FIELDS.join(", ")})`;

  const missing = BUILD_FIELDS.filter((f) => !tokens.some((t) => t.name === f));
  if (missing.length) return `eksik alan: ${missing.map((f) => `{${f}}`).join(", ")}`;

  if (platform === "android" && template.includes(".")) {
    return "Android versionCode tam sayı olmalı — nokta kullanılamaz";
  }
  // Within a run of adjacent fields only the first may be variable-width.
  for (const run of template.split(/[^{}\w:]+/)) {
    for (const t of tokensOf(run).slice(1)) {
      if (!t.width) return `'{${t.name}}' başka bir alanın hemen ardında geliyor, genişlik belirtmeli (ör. {${t.name}:1})`;
    }
  }
  return null;
}

// Renders a sample so the chosen scheme can be eyeballed before it's written.
function renderBuildNumber(template, major, minor, patch, iteration) {
  const values = { major, minor, patch, iteration };
  return template.replace(BUILD_TOKEN, (_m, name, width) => {
    const v = String(values[name]);
    return width ? v.padStart(Number(width), "0") : v;
  });
}

// ── detection ─────────────────────────────────────────────────────────────────
function readSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function detectAndroidPackage() {
  const gradle = readSafe(path.join(PROJECT_ROOT, "android", "app", "build.gradle"));
  const m = gradle.match(/applicationId\s+["']([^"']+)["']/);
  return m ? m[1] : "";
}

function detectIos() {
  const iosDir = path.join(PROJECT_ROOT, "ios");
  let workspace = "",
    scheme = "",
    bundleId = "",
    teamId = "";
  try {
    const ws = fs.readdirSync(iosDir).find((f) => f.endsWith(".xcworkspace"));
    if (ws) {
      workspace = `ios/${ws}`;
      scheme = ws.replace(/\.xcworkspace$/, "");
    }
    const projDir = fs.readdirSync(iosDir).find((f) => f.endsWith(".xcodeproj"));
    if (projDir) {
      const pbx = readSafe(path.join(iosDir, projDir, "project.pbxproj"));
      const bundles = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";]+)"?;/g)].map((x) => x[1].trim()).filter((v) => v && !/test/i.test(v) && !v.includes("$("));
      if (bundles.length) bundleId = bundles[0];
      const team = pbx.match(/DEVELOPMENT_TEAM\s*=\s*"?([^";]+)"?;/);
      if (team) teamId = team[1].trim();
    }
  } catch {
    /* ios dir missing — leave blanks */
  }
  return { workspace, scheme, bundleId, teamId };
}

function detectAppName() {
  try {
    return JSON.parse(readSafe(path.join(PROJECT_ROOT, "package.json"))).name || "";
  } catch {
    return "";
  }
}

// Marketing version is shared across platforms; only the build-number encoding differs.
async function askBuildScheme() {
  const sample = (tpl) => renderBuildNumber(tpl, 7, 4, 7, 2);
  console.log("\n── Build number şeması ───────────────────");
  console.log("Marketing version her iki platformda aynıdır (package.json -> version).");
  console.log("Build number (Android versionCode / iOS CFBundleVersion) versiondan + o sürümün");
  console.log("kaçıncı yüklemesi olduğundan otomatik türetilir; sadece yazımı değişir.");
  console.log("Örnek: marketing version 7.4.7, o sürümün 2. yüklemesi ->\n");
  console.log(`  1) compact   Android ${sample(BUILD_PRESETS.compact.android)}   iOS ${sample(BUILD_PRESETS.compact.ios)}`);
  console.log(`  2) wide      Android ${sample(BUILD_PRESETS.wide.android)}  iOS ${sample(BUILD_PRESETS.wide.ios)}`);
  console.log("  3) custom    (template'leri elle gir)\n");

  const choice = await ask("Seçim (1/2/3)", "1");
  if (choice === "2") return { ...BUILD_PRESETS.wide };
  if (choice !== "3") return { ...BUILD_PRESETS.compact };

  console.log('\nAlanlar: {major} {minor} {patch} {iteration}. ":N" = N haneye sıfırla doldur.');
  console.log("Bir alan başka bir alanın hemen ardında geliyorsa genişlik belirtmeli.");
  const out = {};
  for (const platform of ["android", "ios"]) {
    for (;;) {
      const tpl = await ask(`  ${platform} template`, BUILD_PRESETS.compact[platform]);
      const err = validateBuildTemplate(platform, tpl);
      if (err) {
        console.log(`  ⚠️  ${err}`);
        continue;
      }
      console.log(`  ✓ 7.4.7 #2 -> ${renderBuildNumber(tpl, 7, 4, 7, 2)}`);
      out[platform] = tpl;
      break;
    }
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🚀 fastlane-kit setup\n");
  if (!fs.existsSync(path.join(PROJECT_ROOT, "package.json"))) {
    console.log("⚠️  package.json bulunamadı — bu komutu React Native proje kökünden çalıştır.");
  }

  const dAndroid = detectAndroidPackage();
  const dIos = detectIos();
  const dName = detectAppName();

  console.log("Algılanan değerler default olarak sunulur; Enter ile geçebilir, yazarak değiştirebilirsin.\n");

  console.log("── Kimlikler ─────────────────────────────");
  const app_name = await ask("App adı (log/etiket)", dName);
  const android_package = await ask("Android package (applicationId)", dAndroid);
  const ios_bundle_id = await ask("iOS bundle id", dIos.bundleId || dAndroid);
  const ios_team_id = await ask("iOS Team ID (Apple Developer)", dIos.teamId);
  const ios_scheme = await ask("iOS scheme", dIos.scheme || app_name);
  const ios_workspace = await ask("iOS workspace (repo köküne göre yol)", dIos.workspace || `ios/${ios_scheme}.xcworkspace`);

  console.log("\n── Android Play ──────────────────────────");
  const android_play_json = await ask("Play service-account.json yolu", "fastlane/play-service-account.json");

  const build_number = await askBuildScheme();

  console.log("\n── Sürüm notu / changelog ────────────────");
  const locale = await ask("Play changelog locale", "tr-TR");

  console.log("\n── Log için (opsiyonel) ──────────────────");
  const api_url_env_key = await ask(".env içindeki base-URL değişken adı (boş = atla)", "");

  console.log("\n── App Store Connect API Key (iOS, secret) ─");
  const ASC_KEY_ID = await ask("ASC Key ID", "");
  const ASC_ISSUER_ID = await ask("ASC Issuer ID", "");
  const ASC_KEY_PATH = await ask(".p8 dosya yolu", "fastlane/appstore_api_key.p8");

  console.log("\n── Android release keystore (secret) ─────");
  const ANDROID_KEYSTORE_FILE = await ask("Keystore dosya yolu (tam yol)", "");
  const ANDROID_KEY_ALIAS = await ask("Key alias", "");
  const ANDROID_KEYSTORE_PASSWORD = await askSecret("Keystore password (gizli)");
  const ANDROID_KEY_PASSWORD = await askSecret("Key password (gizli, boş = keystore ile aynı)").then((v) => v || ANDROID_KEYSTORE_PASSWORD);

  // ── build config object ──
  const config = {
    app_name,
    android_package,
    android_play_json,
    ios_bundle_id,
    ios_team_id,
    ios_scheme,
    ios_workspace,
    android_changelog_locales: [locale],
    build_number,
  };
  if (api_url_env_key) config.api_url_env_key = api_url_env_key;

  // ── confirm ──
  console.log("\n──────────── ÖZET ────────────");
  console.log(JSON.stringify(config, null, 2));
  console.log("secrets -> fastlane/.env (gitignore'lu)");
  console.log("──────────────────────────────");
  if (!(await askYesNo("\nBu değerlerle dosyalar yazılsın mı?", true))) {
    console.log("İptal edildi. Hiçbir dosya yazılmadı.");
    rl.close();
    return;
  }

  // ── write files ──
  fs.mkdirSync(FASTLANE_DIR, { recursive: true });

  await writeGuarded(path.join(FASTLANE_DIR, "project.json"), JSON.stringify(config, null, 2) + "\n");
  await writeGuarded(path.join(FASTLANE_DIR, "Fastfile"), readSafe(path.join(TEMPLATES_DIR, "Fastfile")));
  await writeGuarded(path.join(FASTLANE_DIR, "Appfile"), readSafe(path.join(TEMPLATES_DIR, "Appfile")));

  // Created empty on purpose: the Fastfile refuses to ship on an empty release note, so an
  // unwritten note fails the lane instead of shipping placeholder text to the store.
  if (!fs.existsSync(path.join(FASTLANE_DIR, "release_notes.txt"))) {
    fs.writeFileSync(path.join(FASTLANE_DIR, "release_notes.txt"), "");
    console.log("  yazıldı: fastlane/release_notes.txt (boş — sürüm notunu buraya yaz)");
  }

  const envExample = readSafe(path.join(TEMPLATES_DIR, "env.example"));
  await writeGuarded(path.join(FASTLANE_DIR, ".env.example"), envExample);

  const envReal = envExample
    .replace(/^ASC_KEY_ID=.*$/m, `ASC_KEY_ID=${ASC_KEY_ID}`)
    .replace(/^ASC_ISSUER_ID=.*$/m, `ASC_ISSUER_ID=${ASC_ISSUER_ID}`)
    .replace(/^ASC_KEY_PATH=.*$/m, `ASC_KEY_PATH=${ASC_KEY_PATH}`)
    .replace(/^ANDROID_KEYSTORE_FILE=.*$/m, `ANDROID_KEYSTORE_FILE=${ANDROID_KEYSTORE_FILE}`)
    .replace(/^ANDROID_KEYSTORE_PASSWORD=.*$/m, `ANDROID_KEYSTORE_PASSWORD=${ANDROID_KEYSTORE_PASSWORD}`)
    .replace(/^ANDROID_KEY_ALIAS=.*$/m, `ANDROID_KEY_ALIAS=${ANDROID_KEY_ALIAS}`)
    .replace(/^ANDROID_KEY_PASSWORD=.*$/m, `ANDROID_KEY_PASSWORD=${ANDROID_KEY_PASSWORD}`);
  await writeGuarded(path.join(FASTLANE_DIR, ".env"), envReal);

  ensureGitignore();

  console.log("\n✅ Bitti. Yazılan dosyalar fastlane/ altında.\n");
  printNextSteps();
  rl.close();
}

// Write, but ask before overwriting an existing file.
async function writeGuarded(target, content) {
  if (fs.existsSync(target)) {
    const rel = path.relative(PROJECT_ROOT, target);
    if (!(await askYesNo(`${rel} zaten var — üzerine yazılsın mı?`, false))) {
      console.log(`  atlandı: ${rel}`);
      return;
    }
  }
  fs.writeFileSync(target, content);
  console.log(`  yazıldı: ${path.relative(PROJECT_ROOT, target)}`);
}

// Make sure fastlane secrets are gitignored (append if missing).
function ensureGitignore() {
  const giPath = path.join(PROJECT_ROOT, ".gitignore");
  let gi = readSafe(giPath);
  const needed = ["**/fastlane/.env", "**/fastlane/*.p8", "**/fastlane/play-service-account.json", "**/fastlane/report.xml", "**/fastlane/*.mobileprovision"];
  const missing = needed.filter((line) => !gi.includes(line));
  if (missing.length === 0) return;
  const block = `\n# fastlane secrets & artifacts (added by fastlane-kit)\n${missing.join("\n")}\n`;
  fs.appendFileSync(giPath, block);
  console.log(`  .gitignore güncellendi (${missing.length} satır)`);
}

function printNextSteps() {
  console.log("── Sonraki adımlar ────────────────────────────────────");
  console.log("1. Secret dosyalarını yerine koy:");
  console.log("   • App Store Connect .p8  -> " + "(project.json/.env'deki ASC_KEY_PATH)");
  console.log("   • Play service-account.json -> " + "(project.json android_play_json)");
  console.log("2. fastlane/.env içindeki keystore/ASC değerlerini doğrula.");
  console.log("3. Android imzalama + release guard'ı android/app/build.gradle'a ekle");
  console.log("   (rn-fastlane-kit README'deki snippet).");
  console.log("4. fastlane/release_notes.txt'e sürüm notunu yaz (boşsa lane hata verir).");
  console.log("5. package.json -> version gerçek store sürümü olsun (build number oradan türer).");
  console.log("6. Test: fastlane android stg   |   fastlane ios stg");
  console.log("────────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("\nHata:", e.message);
  try {
    rl.close();
  } catch {}
  process.exit(1);
});
