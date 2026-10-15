import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedSimulation} from '../shared-simulation.mjs';
import {Simulation} from '../dist/engine.mjs';
import {studentStateFromSandbox} from '../student-data.mjs';
const clone=x=>structuredClone(x);
const survey={mode:'survey',classTime:'08:00',observationTime:'07:01',totalPeople:36};
test('fixed and survey always select their corresponding rule, including presets and reset',()=>{
 const r=new SharedSimulation({running:false,speed:8,settings:{behaviorMode:'grouped',guidanceCoverage:60}});
 assert.equal(r.sim.settings.behaviorMode,'original');
 r.control({action:'departureScenario',config:{...survey,observationTime:null}});
 assert.equal(r.sim.settings.behaviorMode,'grouped');assert.equal(r.packet().behavior.enabled,true);
 r.control({action:'reset'});assert.equal(r.sim.settings.behaviorMode,'grouped');
 r.control({action:'preset',preset:'normal'});assert.equal(r.sim.departureScenario.mode,'fixed');assert.equal(r.sim.settings.behaviorMode,'original');
 r.control({action:'departureScenario',config:{...survey,observationTime:null}});
 r.control({action:'departureScenario',config:{mode:'fixed'}});assert.equal(r.sim.settings.behaviorMode,'original');assert.equal(r.sim.settings.guidanceCoverage,60);
 assert.equal(r.running,false);assert.equal(r.speed,8);
});
test('observation worker applies grouped routing before pre-roll, using the same seed and demand',async()=>{
 const settings={demand:12,motorDemand:2,northDemand:1,guidanceCoverage:80,northBypassShare:70};
 const r=new SharedSimulation({running:false,seed:42,settings});await r.controlAsync({action:'departureScenario',config:survey});
 const expected=new Simulation({seed:42,settings:{...settings,behaviorMode:'grouped'},departureScenario:survey});expected.step(60);
 assert.deepEqual(clone(r.sim),clone(expected));
 assert.equal(r.sim.time,60);assert.equal(r.sim.settings.behaviorMode,'grouped');
 const s=studentStateFromSandbox(r.packet());assert.deepEqual(s.settings,r.sim.settings);assert.deepEqual(s.clock,r.packet().clock);
});
test('contradictory manual rules reject atomically, and compatible full settings remain accepted',()=>{
 const r=new SharedSimulation({running:false}),before=clone(r.packet());
 assert.throws(()=>r.control({action:'settings',settings:{behaviorMode:'grouped',demand:50}}),{status:422});assert.deepEqual(clone(r.packet()),before);
 r.control({action:'settings',settings:{...r.sim.settings,demand:20}});assert.equal(r.sim.settings.demand,20);
 r.control({action:'departureScenario',config:{...survey,observationTime:null}});const p=clone(r.packet());
 assert.throws(()=>r.control({action:'settings',settings:{behaviorMode:'original',guidanceCoverage:0}}),{status:422});assert.deepEqual(clone(r.packet()),p);
});
test('matching restored scenes keep all current traffic and configuration without reset',()=>{
 const r=new SharedSimulation({running:false,departureScenario:{mode:'survey'},settings:{guidanceCoverage:50}});r.sim.step(12);
 const saved=clone(r.packet()),restored=new SharedSimulation({initialPacket:saved,preserveRunId:true});
 assert.deepEqual(clone(restored.sim),saved.simulation);assert.equal(restored.runId,saved.runId);assert.equal(restored.settingsRevision,saved.settingsRevision);
});
test('legacy mismatches migrate once, retain identity and position, and invalidate old proposals',()=>{
 const r=new SharedSimulation({running:false,departureScenario:{mode:'survey'}});r.sim.step(8);
 const saved=clone(r.packet());saved.simulation.settings.behaviorMode='original';
 const before=saved.simulation.cars.map(c=>[c.id,c.kind,c.p,c.edgeIndex,c.v,c.route.exit,c.behavior?.knowledge,c.behavior?.willingness]);
 const a=new SharedSimulation({initialPacket:saved,preserveRunId:true});
 assert.equal(a.sim.settings.behaviorMode,'grouped');assert.equal(a.sim.time,saved.simulation.time);assert.equal(a.runId,saved.runId);assert.equal(a.settingsRevision,saved.settingsRevision+1);
 assert.deepEqual(a.sim.cars.map(c=>[c.id,c.kind,c.p,c.edgeIndex,c.v,c.route.exit,c.behavior?.knowledge,c.behavior?.willingness]),before);
 assert.throws(()=>a.control({action:'settings',settings:{demand:30},expected:{runId:saved.runId,settingsRevision:saved.settingsRevision,settings:saved.simulation.settings}}),{status:409});
 const again=new SharedSimulation({initialPacket:clone(a.packet()),preserveRunId:true});assert.equal(again.settingsRevision,a.settingsRevision);assert.deepEqual(clone(again.sim),clone(a.sim));
});
