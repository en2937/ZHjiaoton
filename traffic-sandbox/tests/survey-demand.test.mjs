import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,SURVEY_DEPARTURES,makeDeparturePlan,departureConfig,classSeconds,formatSimulationClock,roadGeometry,currentRef} from '../dist/engine.mjs';
import {SharedSimulation} from '../shared-simulation.mjs';
import {studentStateFromSandbox} from '../student-data.mjs';

const config={mode:'survey',classTime:'08:00',totalPeople:360,distributionModel:'questionnaire-batches-v1'};
const settings={demand:4,motorDemand:0,northDemand:0,electric:40,outbound:80};
function conservation(sim){const state=sim.departureState();assert.equal(state.planned,state.notYetDeparted+state.entryWaiting+state.entered);assert.equal(state.departed,state.entryWaiting+state.entered);assert.equal(state.entered,state.active+state.completed);return state;}
test('raw sample counts define exact quotas; sample size is separate from scenario total',()=>{
 assert.deepEqual(SURVEY_DEPARTURES.groups.map(g=>g.count),[0,9,12,7,6,2]);assert.equal(SURVEY_DEPARTURES.sampleSize,36);
 assert.deepEqual(makeDeparturePlan(config).categories.map(g=>g.plannedPeople),[0,90,120,70,60,20]);
 assert.deepEqual(makeDeparturePlan({...config,totalPeople:36}).categories.map(g=>g.plannedPeople),[0,9,12,7,6,2]);
 for(const totalPeople of [1,2,35,37,101,359,1000,2000]){
  const planned=makeDeparturePlan({...config,totalPeople});assert.equal(planned.plan.length,totalPeople);assert.equal(planned.categories[0].plannedPeople,0);
  for(const [i,category]of planned.categories.entries())assert.ok(Math.abs(category.plannedPeople-totalPeople*SURVEY_DEPARTURES.groups[i].count/36)<1);
 }
});
test('category intervals cover the entire pre-class window and point answers use explicit smoothing',()=>{
 const plan=makeDeparturePlan(config);assert.equal(plan.plan.length,360);
 for(const event of plan.plan){const group=SURVEY_DEPARTURES.groups.find(g=>g.id===event.category);assert.ok(event.leadSeconds>=group.minLead*60&&event.leadSeconds<group.maxLead*60);assert.ok(Math.abs(event.time+event.leadSeconds-3600)<1e-8);}
 assert.ok(plan.plan.some(event=>event.time<1800));assert.ok(plan.plan.every(event=>event.time>=0&&event.time<3600));
 assert.ok(plan.plan.every((event,i)=>i===0||plan.plan[i-1].time<=event.time));
});
test('fixed seed repeats the whole departure schedule independently of traffic RNG',()=>{
 assert.deepEqual(makeDeparturePlan(config),makeDeparturePlan(config));assert.notDeepEqual(makeDeparturePlan(config).plan,makeDeparturePlan({...config,seed:20261015}).plan);
 const a=new Simulation({seed:42,settings,departureScenario:config}),b=new Simulation({seed:42,settings,departureScenario:config});
 a.step(120);b.step(120);assert.deepEqual(a.snapshot(),b.snapshot());
});
test('planned curve has pre-class peaks and drops to zero after the last batch',()=>{
 const state=makeDeparturePlan(config),bins=state.plannedByMinute;assert.equal(bins.reduce((a,b)=>a+b,0),360);assert.equal(bins.at(-1),0);
 assert.ok(Math.max(...bins)>=40);assert.ok(bins.slice(0,30).some(n=>n>0));assert.ok(bins.slice(45,60).some(n=>n>0));
 assert.ok(bins.slice(37,39).every(n=>n===0));
});
test('blocked entry keeps all scheduled demand; release conserves entry and completion counts',()=>{
 const sim=new Simulation({settings,departureScenario:config}),normalEntry=sim.entryLeader.bind(sim);
 sim.entryLeader=(ref,exclude)=>ref.edge==='access1'&&exclude?.surveyDepartureId!==undefined?{p:0,v:0}:normalEntry(ref,exclude);
 for(let t=0;t<3600;t+=60){sim.step(60);conservation(sim);}
 const blocked=conservation(sim);assert.equal(blocked.departed,360);assert.equal(blocked.entryWaiting,360);assert.equal(blocked.entered,0);
 assert.equal(new Set(sim.pending[1].map(c=>c.surveyDepartureId)).size,360);
 for(const rider of sim.pending[1]){assert.notEqual(rider.kind,'motor');assert.equal(rider.route.origin,1);assert.equal(rider.route.exit,'southEast');assert.ok(['1-south','1-ring','1-ring-north'].includes(rider.route.id));}
 sim.entryLeader=normalEntry;
 for(let t=0;t<1800;t+=30){sim.step(30);conservation(sim);}
 const released=conservation(sim);assert.equal(released.entered,360);assert.equal(released.entryWaiting,0);assert.equal(released.notYetDeparted,0);assert.ok(released.completed>0);
});
test('other directional cycling, motor and north flows keep their existing demand rules',()=>{
 const a=new Simulation({seed:42,settings:{...settings,demand:12,motorDemand:6,northDemand:5}}),b=new Simulation({seed:42,settings:{...settings,demand:12,motorDemand:6,northDemand:5},departureScenario:config});
 const generated=sim=>{const count={reverse:0,motor:0,north:0,source:0};const make=sim.newCar.bind(sim);sim.newCar=(direction,...args)=>{const car=make(direction,...args);if(direction===0)count.north++;else if(car.kind==='motor')count.motor++;else if(direction===-1)count.reverse++;else count.source++;return car;};return count;};
 const old=generated(a),survey=generated(b);a.step(120);b.step(120);assert.equal(old.motor,survey.motor);assert.equal(old.north,survey.north);assert.equal(old.reverse,survey.reverse);assert.ok(old.source>0);
 const due=b.surveyDepartures.nextIndex;assert.equal(survey.source,due);assert.equal(b.credit[1],0);
});
test('pause and playback speeds preserve scheduled demand; reset repeats and presets return to fixed',()=>{
 const runtime=new SharedSimulation({running:false,settings}),oldRun=runtime.runId;
 runtime.control({action:'departureScenario',config,expectedRunId:oldRun});assert.notEqual(runtime.runId,oldRun);assert.equal(runtime.running,false);assert.deepEqual(runtime.sim.settings,{...runtime.sim.settings,...settings});
 const plan=structuredClone(runtime.sim.surveyDepartures.plan);runtime.advance(.25);assert.equal(runtime.sim.time,0);
 runtime.control({action:'play',running:true});runtime.control({action:'speed',speed:1});runtime.advance(.25);assert.equal(runtime.sim.time,.25);
 runtime.control({action:'speed',speed:8});runtime.advance(.25);assert.ok(Math.abs(runtime.sim.time-2.25)<1e-8);conservation(runtime.sim);
 runtime.control({action:'reset'});assert.deepEqual(runtime.sim.surveyDepartures.plan,plan);assert.equal(runtime.sim.time,0);
 runtime.control({action:'preset',preset:'normal'});assert.equal(runtime.sim.departureState().mode,'fixed');assert.equal(runtime.sim.settings.demand,12);assert.equal(runtime.sim.clockState().label,'07:50:00');
});
test('administrator/student adapters share lesson, clock, settings and demand counters',()=>{
 const runtime=new SharedSimulation({running:false,settings});runtime.control({action:'departureScenario',config});runtime.sim.step(124);
 const packet=runtime.packet(),student=studentStateFromSandbox(packet);assert.deepEqual(student.clock,packet.clock);assert.deepEqual(student.departureScenario,packet.departureScenario);assert.deepEqual(student.settings,packet.simulation.settings);assert.equal(student.runId,packet.runId);
 assert.equal(packet.clock.startSeconds,7*3600);assert.equal(packet.clock.classSeconds,8*3600);assert.equal(packet.clock.label,'07:02:04');assert.ok(Math.abs(packet.clock.seconds-(7*3600+runtime.sim.time))<1e-8);
 const midnight=new Simulation({settings,departureScenario:{...config,classTime:'00:00'}});assert.equal(midnight.clockState().label,'前一天 23:00:00');assert.equal(midnight.clockState().secondsUntilClass,3600);
});
test('restore preserves the current scene, vehicles, RNG, clock and configuration without enabling survey',()=>{
 const original=new SharedSimulation({settings,running:false});original.sim.step(10);const packet=structuredClone(original.packet());
 delete packet.simulation.departureScenario;delete packet.simulation.clockStartSeconds;delete packet.simulation.surveyDepartures;
 const resumed=new SharedSimulation({initialPacket:packet,preserveRunId:true});assert.deepEqual(structuredClone(resumed.sim),packet.simulation);assert.equal(resumed.runId,packet.runId);assert.equal(resumed.sim.departureState().mode,'fixed');assert.equal(resumed.sim.clockState().startSeconds,28200);
 const survey=new SharedSimulation({settings,running:false});survey.control({action:'departureScenario',config});survey.sim.step(600);const saved=structuredClone(survey.packet());
 const restored=new SharedSimulation({initialPacket:saved,preserveRunId:true});assert.deepEqual(structuredClone(restored.sim),saved.simulation);assert.deepEqual(restored.packet().departureScenario,saved.departureScenario);conservation(restored.sim);
});
test('invalid scenario and stale activation cannot mutate the current runtime',()=>{
 const runtime=new SharedSimulation({settings,running:false}),before=structuredClone(runtime.packet());
 for(const config of [{mode:'survey',totalPeople:36.5},{mode:'survey',totalPeople:0},{mode:'survey',totalPeople:2001},{mode:'survey',classTime:'25:00'},{mode:'unknown'},{mode:'survey',violation:1}])assert.throws(()=>runtime.control({action:'departureScenario',config}));
 assert.throws(()=>runtime.control({action:'departureScenario'}));assert.throws(()=>runtime.control({action:'departureScenario',config:{}}));
 assert.throws(()=>runtime.control({action:'departureScenario',config,expectedRunId:'stale'}));assert.deepEqual(structuredClone(runtime.packet()),before);
});
