import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url), out = new URL('ui-validation/site-motion/', root);
const protectedFiles = ['traffic-sandbox/dist/engine.mjs', 'traffic-sandbox/dist/route.mjs', 'traffic-sandbox/shared-simulation.mjs',
  'admin-access/server.mjs', 'admin-access/auth.mjs', 'admin-access/ai.mjs', 'admin-access/client/login-form.mjs',
  'dify-integration-lab/server.mjs', 'dify-integration-lab/student.mjs'];
const hash = data => createHash('sha256').update(data).digest('hex');
const packet = await fetch('http://127.0.0.1:4173/api/simulation').then(r => r.json());
const identity = {instanceId: packet.instanceId, runId: packet.runId, settingsRevision: packet.settingsRevision,
  running: packet.running, speed: packet.speed, settings: packet.simulation.settings,
  departure: packet.simulation.departureScenario, time: packet.simulation.time};
const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async path => [path, hash(await readFile(new URL(path, root)))])));
const assets = [['http://127.0.0.1:4173/app.mjs','traffic-sandbox/dist/app.mjs'],
  ['http://127.0.0.1:4183/student/app.mjs','dify-integration-lab/public/student/app.mjs'],
  ['http://127.0.0.1:4183/student/style.css','dify-integration-lab/public/student/style.css'],
  ['http://127.0.0.1:4174/admin-ai.mjs','admin-access/public/admin-ai.mjs'],
  ['http://127.0.0.1:4174/login.mjs','admin-access/public/login.mjs']];
const resources = await Promise.all(assets.map(async ([url,path]) => {
  const response = await fetch(url), remote = Buffer.from(await response.arrayBuffer()), local = await readFile(new URL(path, root));
  return {url, path, status: response.status, match: hash(remote) === hash(local)};
}));
if (resources.some(row => !row.match || row.status !== 200)) throw new Error('Served assets do not match local outputs');
const mode = process.argv.includes('--before') ? 'before' : 'after';
let continuity;
if (mode === 'after') {
  const before = JSON.parse(await readFile(new URL('production-before.json', out)));
  const {time: oldTime, ...oldIdentity} = before.identity, {time, ...newIdentity} = identity;
  const configuration = value => ({running: value.running, speed: value.speed, settings: value.settings, departure: value.departure});
  continuity = {sameRuntime: JSON.stringify(oldIdentity) === JSON.stringify(newIdentity),
    sameConfiguration: JSON.stringify(configuration(before.identity)) === JSON.stringify(configuration(identity)),
    sameProtectedSources: JSON.stringify(before.protectedHashes) === JSON.stringify(protectedHashes),
    restartedAfterExternalInterruption: process.argv.includes('--restarted')};
  if (!continuity.sameConfiguration || !continuity.sameProtectedSources || !continuity.sameRuntime && !continuity.restartedAfterExternalInterruption) throw new Error('Protected source or production settings changed');
}
await writeFile(new URL(`production-${mode}.json`, out), JSON.stringify({identity, protectedHashes, resources, continuity}, null, 2));
console.log(`Production ${mode}: ${resources.length} assets match; identity and protected sources recorded.`);
