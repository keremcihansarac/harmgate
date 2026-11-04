// Packs the built extension into a zip for a GitHub release, next to the version file that
// installed copies read to learn about a new version. Pass the release tag to check it matches.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const out = join(root, 'release');
const tag = process.argv[2];

const { version } = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`package.json says ${pkg.version}, the manifest says ${version}`);
if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match version ${version}`);
for (const ruleset of ['adult', 'gambling', 'gore']) {
  await readFile(join(dist, 'rules', `${ruleset}.json`)).catch(() => {
    throw new Error(`The build has no ${ruleset} rules. Run "npm run lists" before "npm run build".`);
  });
}

await rm(out, { recursive: true, force: true });
const folder = join(out, 'harmgate');
await mkdir(out, { recursive: true });
await cp(dist, folder, { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, file), join(folder, file));

const zip = `harmgate-${version}.zip`;
execFileSync('zip', ['-qr', zip, 'harmgate'], { cwd: out, stdio: 'inherit' });
await rm(folder, { recursive: true });
await writeFile(join(out, 'version.json'), `${JSON.stringify({ version })}\n`);
console.log(`release/${zip}`);
