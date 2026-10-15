// Creates a NEW scenario from recorded settings after the sandbox service exited.
// This is not a checkpoint recovery and cannot restore lost vehicles or history.
import {readFile,writeFile} from 'node:fs/promises';
import {SharedSimulation} from '../traffic-sandbox/shared-simulation.mjs';
const before = JSON.parse(await readFile(new URL('../ui-validation/site-motion/production-before.json',import.meta.url)));
const {identity} = before;
const runtime = new SharedSimulation({running:identity.running,speed:identity.speed,settings:identity.settings,departureScenario:identity.departure});
const packet = runtime.packet();
await writeFile(new URL('../admin-access/private/site-motion-restart-initial.json',import.meta.url),JSON.stringify(packet));
await writeFile(new URL('../ui-validation/site-motion/restart-record.json',import.meta.url),JSON.stringify({
  reason:'Sandbox stopped responding (ECONNREFUSED) at final verification; cause not established. Other original service listeners were subsequently confirmed alive.',
  type:'new-scenario-from-recorded-configuration',oldRunId:identity.runId,oldSimulationTime:identity.time,
  newRunId:packet.runId,newSimulationTime:packet.simulation.time,settings:packet.simulation.settings,
  departureScenario:packet.simulation.departureScenario,restoredOriginalVehicles:false,restoredOriginalProgress:false,
},null,2));
console.log('Prepared a new scenario with the recorded configuration. Original vehicle/history continuity is not restored.');
