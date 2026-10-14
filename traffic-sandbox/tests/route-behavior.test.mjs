import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,studentProfile,BEHAVIOR_MODEL,isStudent,routeCompatible} from '../dist/engine.mjs';
import {ROUTES,NORTH_BYPASS_ROUTES} from '../dist/route.mjs';
import {SharedSimulation} from '../shared-simulation.mjs';
import {studentStateFromSandbox} from '../student-data.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
const empty=settings=>{const sim=new Simulation({settings});sim.cars=[];sim.pending={1:[],'-1':[],0:[]};sim.studentOrdinal=0;return sim;};
const rider=(sim,profile={})=>{const car=sim.newCar(1,0,'electric',undefined,{normalRouteId:'1-south',bypassDraw:0});Object.assign(car.behavior,profile);car.route=ROUTES['1-south'];return car;};
const favorable=sim=>Object.fromEntries(Object.keys(ROUTES).map(id=>[id,{length:100,wait:id.includes('bypass')||id.includes('ring-north')?0:100}]));
test('raw marginals repeat in seeded independent blocks without using traffic RNG',()=>{
 for(const block of [0,1,10]){const profiles=Array.from({length:36},(_,i)=>studentProfile(block*36+i+1));for(const key of ['knowledge','willingness'])for(const [group,n]of Object.entries(BEHAVIOR_MODEL[key]))assert.equal(profiles.filter(p=>p[key]===group).length,n);assert.deepEqual(profiles,profiles.map(p=>studentProfile(p.ordinal)));}
 const a=empty({behaviorMode:'original'}),b=empty({behaviorMode:'grouped',guidanceCoverage:100});
 for(let i=0;i<100;i++){const x=a.newCar(1,i),y=b.newCar(1,i);assert.equal(a.seed,b.seed);for(const key of ['id','kind','maxV','requestedAt'])assert.equal(x[key],y[key]);assert.equal(x.route.exit,y.route.exit);assert.deepEqual(x.behavior.knowledge,y.behavior.knowledge);}
});
test('unknown, unreached, unwilling, thresholds and strategy have separate reactions',()=>{
 const sim=empty({behaviorMode:'grouped',northBypassShare:100,guidanceCoverage:0});
 const c=rider(sim,{knowledge:'unknown',willingness:'conditional',reachDraw:.2,trialDraw:0,receivedGuide:false});
 const costs=favorable(sim);assert.equal(sim.behaviorDecision(c,costs).reason,'notAware');
 sim.settings.guidanceCoverage=10;assert.equal(sim.behaviorDecision(c,costs).reason,'notReached');
 sim.settings.guidanceCoverage=100;assert.equal(sim.behaviorDecision(c,costs).reason,'selected');assert.equal(c.behavior.receivedGuide,true);
 c.behavior.willingness='unwilling';assert.equal(sim.behaviorDecision(c,costs).reason,'unwilling');
 c.behavior.willingness='occasional';c.behavior.trialDraw=.5;assert.equal(sim.behaviorDecision(c,costs).reason,'trialNotTaken');
 c.behavior.willingness='conditional';assert.equal(sim.behaviorDecision(c,costs).reason,'selected');
 costs['1-south'].wait=0;assert.equal(sim.behaviorDecision(c,costs).reason,'notEnoughSaving');
 costs['1-south'].wait=100;sim.settings.northBypassShare=0;assert.equal(sim.behaviorDecision(c,costs).reason,'strategyNotAssigned');
 c.behavior.receivedGuide=false;c.behavior.knowledge='untried';sim.settings.guidanceCoverage=0;assert.equal(sim.behaviorDecision(c,costs).reason,'untriedWithoutGuide');
});
test('rerouting is continuous, respects fork/destination, retains identities and received information on undo',()=>{
 const sim=empty({behaviorMode:'grouped',northBypassShare:100,guidanceCoverage:0});
 const a=rider(sim,{knowledge:'unknown',willingness:'conditional',trialDraw:0,reachDraw:0}),b=rider(sim,{knowledge:'known',trialDraw:0});
 b.edgeIndex=1;b.p=5;sim.cars=[a,b];const identity=clone(a.behavior),pos=sim.cars.map(c=>[c.id,c.p,c.edgeIndex,c.route.exit]);
 // Keep route estimates controlled for this rule-level fixture.
 sim.behaviorCosts=()=>favorable(sim);sim.setSettings({guidanceCoverage:100});
 assert.equal(a.route.id,'1-ring-north');assert.equal(b.route.id,'1-south');assert.equal(b.behaviorDecision.reason,'passedFork');
 assert.deepEqual(sim.cars.map(c=>[c.id,c.p,c.edgeIndex,c.route.exit]),pos);
 assert.equal(a.behavior.knowledge,identity.knowledge);assert.equal(a.behavior.willingness,identity.willingness);
 a.edgeIndex=1;a.p=4;const after=clone(a.route);sim.setSettings({guidanceCoverage:0,northBypassShare:0});assert.deepEqual(a.route,after);assert.equal(a.behavior.receivedGuide,true);
 sim.setSettings({behaviorMode:'original'});assert.deepEqual(a.route,after);
});
test('current populations and exclusive reasons have the declared denominators',()=>{
 const sim=empty({behaviorMode:'grouped',northBypassShare:100,guidanceCoverage:0});
 for(let i=0;i<36;i++){const car=rider(sim);sim.cars.push(car);}sim.rerouteForBypassShare();
 sim.pending[1].push(rider(sim));sim.cars.push(sim.newCar(1,0,'motor'),sim.newCar(0,0,'electric'));
 const b=sim.behaviorState();assert.equal(b.onMap.count,36);assert.equal(b.entryWaiting.count,1);assert.deepEqual(b.onMap.knowledge,BEHAVIOR_MODEL.knowledge);assert.deepEqual(b.onMap.willingness,BEHAVIOR_MODEL.willingness);
 assert.equal(b.eligible.count,b.eligible.bypassSelected+Object.values(b.eligible.reasons).reduce((s,n)=>s+n,0));assert.equal(b.eligible.count+Object.values(b.ineligible).reduce((s,n)=>s+n,0),b.onMap.count);
});
test('checkpoint upgrade only adds stable metadata and settings, preserving raw existing traffic',()=>{
 const runtime=new SharedSimulation({running:false,settings:{northDemand:1}});runtime.sim.step(20);const packet=clone(runtime.packet());
 delete packet.simulation.studentOrdinal;delete packet.simulation.lastBehaviorReview;delete packet.simulation.settings.behaviorMode;delete packet.simulation.settings.guidanceCoverage;for(const c of [...packet.simulation.cars,...Object.values(packet.simulation.pending).flat()]){delete c.behavior;delete c.routeSelectionMode;}
 const restored=new SharedSimulation({initialPacket:packet,preserveRunId:true});const strip=x=>{x=clone(x);delete x.studentOrdinal;delete x.lastBehaviorReview;delete x.settings.behaviorMode;delete x.settings.guidanceCoverage;for(const c of [...x.cars,...Object.values(x.pending).flat()]){delete c.behavior;delete c.routeSelectionMode;}return x;};
 assert.deepEqual(strip(restored.sim),strip(packet.simulation));assert.equal(restored.runId,packet.runId);assert.equal(restored.sim.settings.behaviorMode,'original');assert.deepEqual(clone(restored.sim),clone(new SharedSimulation({initialPacket:packet}).sim));
});
test('pause/speed and shared student time/settings remain from the owner; invalid fields reject atomically',()=>{
 const r=new SharedSimulation({running:false,settings:{behaviorMode:'grouped',guidanceCoverage:30},departureScenario:{mode:'survey'}});r.advance(.2);assert.equal(r.sim.time,0);r.control({action:'play',running:true});r.control({action:'speed',speed:8});r.advance(.2);assert.equal(r.sim.time,1.6);
 const p=clone(r.packet()),student=studentStateFromSandbox(p);assert.deepEqual(student.settings,p.simulation.settings);assert.deepEqual(student.clock,p.clock);assert.equal(p.behavior.runId,p.runId);
 for(const settings of [{behaviorMode:'bad'},{guidanceCoverage:101},{knowledge:50},{guidanceCoverage:'20'}])assert.throws(()=>r.control({action:'settings',settings}),{status:422});assert.equal(r.settingsRevision,0);
});
test('reading behavior snapshots at different rates cannot change the simulated outcome',()=>{
 const settings={behaviorMode:'grouped',guidanceCoverage:50,northBypassShare:80,northDemand:1},a=new Simulation({settings}),b=new Simulation({settings});
 for(let i=0;i<50;i++){a.step(.1);b.step(.1);a.behaviorState();a.snapshot();}
 assert.deepEqual(clone(a),clone(b));
});
test('restoring independent owners from the same packet cannot mutate their fixture or each other',()=>{
 const source=new SharedSimulation({running:false,settings:{behaviorMode:'grouped'}}),packet=source.packet(),before=clone(packet.simulation);
 const a=new SharedSimulation({initialPacket:packet}),b=new SharedSimulation({initialPacket:packet});a.control({action:'settings',settings:{behaviorMode:'original',guidanceCoverage:50}});assert.deepEqual(clone(source.sim),before);assert.deepEqual(clone(b.sim),before);
});
