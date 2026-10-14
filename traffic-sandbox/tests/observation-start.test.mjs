import test from 'node:test';
import assert from 'node:assert/strict';
import {departureConfig,observationOffset,Simulation} from '../dist/engine.mjs';
import {SharedSimulation} from '../shared-simulation.mjs';
import {studentStateFromSandbox} from '../student-data.mjs';
const settings={demand:4,electric:55,outbound:72,motorDemand:0,northDemand:1,northBypassShare:30};
const config={mode:'survey',classTime:'08:00',totalPeople:72,observationTime:'07:45'};
test('observation times include both bounds of each period and reject out-of-period values',()=>{
 for(const [lesson,start,mid]of [['08:00','07:00','07:30'],['10:00','09:00','09:30'],['14:00','13:00','13:30']]){
  for(const [time,offset]of [[start,0],[mid,1800],[lesson,3600]])assert.equal(observationOffset(departureConfig({...config,classTime:lesson,observationTime:time})),offset);
 }
 for(const time of ['06:59','08:01','13:30','bad','07:30:01'])assert.throws(()=>departureConfig({...config,observationTime:time}));
 assert.throws(()=>departureConfig({mode:'fixed',observationTime:'07:30'}));
 assert.equal(observationOffset(departureConfig({...config,classTime:'00:00',observationTime:'23:30'})),1800);
});
test('late observation equals full continuous pre-roll; early demand remains counted',async()=>{
 const runtime=new SharedSimulation({running:false,settings,seed:42});
 const reference=new Simulation({seed:42,settings,departureScenario:config});reference.step(2700);
 const original=runtime.sim,preparation=runtime.controlAsync({action:'departureScenario',config});
 assert.equal(runtime.sim,original);assert.equal(runtime.sim.time,0);
 await preparation;assert.deepEqual(structuredClone(runtime.sim),structuredClone(reference));
 const state=runtime.sim.departureState();assert.ok(state.departed>0);assert.equal(state.notYetDeparted+state.entryWaiting+state.entered,72);assert.equal(state.active+state.completed,state.entered);
 assert.equal(runtime.sim.clockState().label,'07:45:00');assert.deepEqual(studentStateFromSandbox(runtime.packet()).clock,runtime.packet().clock);
 assert.equal(runtime.running,false);
});
test('paused/speed/reset resume at observation time and repeat the same prepared state',async()=>{
 const runtime=new SharedSimulation({running:false,speed:8,settings});await runtime.controlAsync({action:'departureScenario',config:{...config,observationTime:'07:30'}});
 const prepared=structuredClone(runtime.sim);runtime.advance(.25);assert.ok(Math.abs(runtime.sim.time-1800)<1e-7);
 runtime.control({action:'play',running:true});runtime.advance(.25);assert.ok(Math.abs(runtime.sim.time-1802)<1e-7);
 await runtime.controlAsync({action:'reset'});assert.deepEqual(structuredClone(runtime.sim),prepared);assert.equal(runtime.running,true);assert.equal(runtime.speed,8);
 runtime.control({action:'departureScenario',config:{mode:'fixed'}});assert.equal(runtime.sim.time,0);
});
test('changes while preparing cancel stale candidates; concurrent preparation is rejected',async()=>{
 const runtime=new SharedSimulation({running:false,settings}),original=runtime.sim;
 const pending=runtime.controlAsync({action:'departureScenario',config});
 await assert.rejects(runtime.controlAsync({action:'departureScenario',config}),{status:409});
 runtime.control({action:'settings',settings:{northDemand:2}});runtime.control({action:'settings',settings:{northDemand:1}});
 await assert.rejects(pending,{status:409});assert.equal(runtime.sim,original);assert.equal(runtime.sim.time,0);assert.equal(runtime.preparingObservation,false);
});
test('existing snapshot restore preserves raw scene without applying observation again',async()=>{
 const runtime=new SharedSimulation({running:false,settings});await runtime.controlAsync({action:'departureScenario',config});runtime.sim.step(5);
 const saved=structuredClone(runtime.packet()),restored=new SharedSimulation({initialPacket:saved,preserveRunId:true});
 assert.deepEqual(structuredClone(restored.sim),saved.simulation);assert.equal(restored.runId,saved.runId);
 const legacy=new SharedSimulation({running:false,settings});const prior=structuredClone(legacy.packet());delete prior.simulation.departureScenario.observationTime;
 const old=new SharedSimulation({initialPacket:prior,preserveRunId:true});assert.deepEqual(structuredClone(old.sim),prior.simulation);
});
