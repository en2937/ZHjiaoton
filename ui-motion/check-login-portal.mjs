import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../',import.meta.url), before = process.argv.includes('--before');
const evidence = process.argv.find(arg=>arg.startsWith('--evidence='))?.slice('--evidence='.length) || 'login-portal';
if (!/^[a-z0-9-]+$/.test(evidence)) throw new Error('Invalid evidence directory name');
const packet = await fetch('http://127.0.0.1:4173/api/simulation').then(r=>r.json());
const identity = {instanceId:packet.instanceId,runId:packet.runId,settingsRevision:packet.settingsRevision,
  settings:packet.simulation.settings,departure:packet.simulation.departureScenario,running:packet.running,speed:packet.speed};
const protectedFiles = ['traffic-sandbox/dist/engine.mjs','traffic-sandbox/dist/route.mjs','traffic-sandbox/shared-simulation.mjs',
  'admin-access/server.mjs','admin-access/auth.mjs','admin-access/ai.mjs','dify-integration-lab/server.mjs'];
const protectedHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async p=>[p,createHash('sha256').update(await readFile(new URL(p,root))).digest('hex')])));
const record = {identity,time:packet.simulation.time,protectedHashes};
const output = name=>new URL('ui-validation/'+evidence+'/'+name+'.json',root);
if(before) await writeFile(new URL('admin-access/private/'+evidence+'-before.json',root),JSON.stringify(packet));
else {
  const original=JSON.parse(await readFile(output('before')));
  const {instanceId:oldInstance,...oldIdentity}=original.identity,{instanceId:newInstance,...newIdentity}=identity;
  const sameIdentity=process.argv.includes('--after-recovery')?JSON.stringify(oldIdentity)===JSON.stringify(newIdentity):JSON.stringify(identity)===JSON.stringify(original.identity);
  if(!sameIdentity||JSON.stringify(protectedHashes)!==JSON.stringify(original.protectedHashes))throw new Error('Live state/configuration or protected source changed');
  if(process.argv.includes('--after-recovery'))record.recoveredFromCheckpoint=true;
  const assets=[['http://127.0.0.1:4174/login.mjs','admin-access/public/login.mjs'],
    ['http://127.0.0.1:4174/login.css','admin-access/public/login.css'],
    ['http://127.0.0.1:4174/admin.css','admin-access/public/admin.css'],
    ['http://127.0.0.1:4173/app.mjs','traffic-sandbox/dist/app.mjs']];
  const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
  record.resources=await Promise.all(assets.map(async([url,path])=>{const response=await fetch(url),data=Buffer.from(await response.arrayBuffer());return {url,status:response.status,match:hash(data)===hash(await readFile(new URL(path,root)))};}));
  if(record.resources.some(row=>row.status!==200||!row.match))throw new Error('Served resources do not match built outputs');
  await writeFile(new URL('admin-access/private/'+evidence+'-final.json',root),JSON.stringify(packet));
}
await writeFile(output(before?'before':'after'),JSON.stringify(record,null,2));
console.log(before?'Full private checkpoint and continuity record saved.':process.argv.includes('--after-recovery')?'Recovered runId/configuration and protected sources verified.':'Original live identity, configuration and protected sources are unchanged.');
