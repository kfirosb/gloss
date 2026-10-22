// Renders the Homebrew cask for a published Gloss release.
//
//   node scripts/homebrew-cask.mjs [--version 0.16.2] [--tap ~/project/homebrew-tap]
//
// The version defaults to package.json. The checksum of each architecture's
// DMG (arm64 and x64) is read from its `.sha256` asset of the matching GitHub
// release, so the release must be published first with both DMGs. With --tap the cask is written to <tap>/Casks/gloss.rb;
// without it the cask is printed to stdout. Committing and pushing the tap is
// left to the release protocol.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'kfirosb/gloss';
const releaseVersion = /^\d+\.\d+\.\d+$/;
const sha256Hex = /^[0-9a-f]{64}$/;
// Homebrew's `arch` stanza names (arm, intel) and the electron-builder suffix of each DMG.
const architectures = { arm: 'arm64', intel: 'x64' };

export function dmgName(version, architecture) {
  return `Gloss-${version}-${architectures[architecture]}.dmg`;
}

export function checksumUrl(version, architecture) {
  return `https://github.com/${repository}/releases/download/v${version}/${dmgName(version, architecture)}.sha256`;
}

// Parses the `shasum -a 256` line published beside the DMG. The file name is
// checked so a checksum copied from another release cannot be pinned by mistake.
export function parseChecksum(text, expectedFile) {
  const match = /^([0-9A-Fa-f]{64})\s+\*?(\S+)\s*$/.exec(String(text).trim());
  if (!match) throw new Error(`No SHA-256 digest found for ${expectedFile}`);
  const [, digest, file] = match;
  if (file !== expectedFile) {
    throw new Error(`Checksum is for ${file}, expected ${expectedFile}`);
  }
  return digest.toLowerCase();
}

/** `sha256` holds one digest per architecture ({ arm, intel }); the cask picks the DMG for the Mac it runs on. */
export function renderCask({ version, sha256 }) {
  if (!releaseVersion.test(version)) throw new Error(`Not a release version: ${version}`);
  for (const architecture of Object.keys(architectures)) {
    const digest = sha256?.[architecture];
    if (!sha256Hex.test(digest))
      throw new Error(`Not a SHA-256 digest for ${architecture}: ${digest}`);
  }
  return `cask "gloss" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha256.arm}",
         intel: "${sha256.intel}"

  url "https://github.com/${repository}/releases/download/v#{version}/Gloss-#{version}-#{arch}.dmg"
  name "Gloss"
  desc "Translate Claude Code and Codex conversations into your language"
  homepage "https://github.com/${repository}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Gloss.app"

  zap trash: [
    "~/.gloss",
    "~/Library/Application Support/gloss",
    "~/.language-assistant",
    "~/Library/Application Support/language-assistant",
    "~/Library/Preferences/io.github.kfirosb.gloss.plist",
    "~/Library/Saved Application State/io.github.kfirosb.gloss.savedState",
  ]

  caveats <<~EOS
    Gloss needs Codex or Claude Code signed in, and ripgrep
    (brew install ripgrep) for file search.
  EOS
end
`;
}

function parseArgs(argv) {
  const options = { version: undefined, tap: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--version' && value) options.version = value;
    else if (flag === '--tap' && value) options.tap = value.replace(/^~(?=\/|$)/, homedir());
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    i += 1;
  }
  return options;
}

async function fetchChecksum(version, architecture) {
  const url = checksumUrl(version, architecture);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return parseChecksum(await response.text(), dmgName(version, architecture));
}

async function fetchChecksums(version) {
  const entries = await Promise.all(
    Object.keys(architectures).map(async (architecture) => [
      architecture,
      await fetchChecksum(version, architecture),
    ]),
  );
  return Object.fromEntries(entries);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const version = options.version ?? JSON.parse(readFileSync(packagePath, 'utf8')).version;
  const cask = renderCask({ version, sha256: await fetchChecksums(version) });
  if (!options.tap) {
    process.stdout.write(cask);
    return;
  }
  const target = join(options.tap, 'Casks', 'gloss.rb');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, cask);
  console.log(`Wrote ${target} for Gloss ${version}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
