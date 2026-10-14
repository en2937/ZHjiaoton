import {parentPort,workerData} from 'node:worker_threads';
import {Simulation} from './dist/engine.mjs';
// Prepare a separate candidate, then the shared owner commits it atomically.
const sim=new Simulation({seed:workerData.seed,settings:workerData.settings,departureScenario:workerData.config});
sim.step(workerData.offset);
parentPort.postMessage(sim);
