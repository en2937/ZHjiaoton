import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDeparturePlan,Simulation} from '../dist/engine.mjs';
import {rateAt,timeAtMass,partialArea,curvePath} from '../dist/engine.mjs';
const config={mode:'survey',classTime:'08:00',totalPeople:360};
test('curve connects three reference peaks, stays nonnegative, integrates to N and ends flat at zero',()=>{
 const state=makeDeparturePlan(config),curve=state.curve;
 assert.deepEqual(curve.referencePeaks,[{minute:35,rate:64},{minute:40,rate:36},{minute:45,rate:33}]);
 assert(Math.abs(curve.integral-360)<1e-9);
 for(const peak of curve.peaks)assert(Math.abs(rateAt(curve,peak.minute)-peak.rate)<1e-9);
 for(let minute=0;minute<=60;minute+=.02){const rate=rateAt(curve,minute);assert(Number.isFinite(rate)&&rate>=0&&rate<=curve.peakRate+1e-8);}
 for(let i=0;i<curve.segments.length-1;i++){assert.equal(curve.segments[i].m1,curve.segments[i+1].m0);assert.equal(curve.segments[i].y1,curve.segments[i+1].y0);}
 assert.equal(curve.anchors.at(-1).rate,0);assert.equal(curve.segments.at(-1).m1,0);assert.equal(rateAt(curve,60),0);assert.equal(rateAt(curve,61),0);assert(curvePath(curve).endsWith('290.00 57.00'));
});
test('actual fixed-seed departures follow curve area; no extra demand or empty gaps between main peaks',()=>{
 for(const totalPeople of [1,2,36,360,2000]){
  const state=makeDeparturePlan({...config,totalPeople});assert.equal(state.plan.length,totalPeople);assert.equal(state.plannedByMinute.reduce((a,b)=>a+b,0),totalPeople);assert.equal(state.plannedByMinute[60],0);
  assert(state.plan.every((e,i)=>e.time>0&&e.time<3600&&(!i||state.plan[i-1].time<=e.time)));
  const counts=state.plan.reduce((all,e)=>(all[e.sourceCategory]=(all[e.sourceCategory]??0)+1,all),{});
  for(const category of state.categories)assert.equal(counts[category.id]??0,category.plannedPeople);
  for(let i=0;i<state.plan.length;i++){const minute=state.plan[i].time/60,s=state.curve.segments.find(row=>minute<=row.x+row.h),mass=s.cumulative+partialArea(s,(minute-s.x)/s.h);assert(mass>=i-1e-8&&mass<i+1+1e-8);}
 }
 const state=makeDeparturePlan(config);assert(state.plannedByMinute.slice(36,45).every(n=>n>0));assert(state.plan.some(e=>e.time<1800));assert(rateAt(state.curve,59)>0&&rateAt(state.curve,59)<rateAt(state.curve,50));
 assert.deepEqual(state,makeDeparturePlan(config));assert.notDeepEqual(state.plan,makeDeparturePlan({...config,seed:20261015}).plan);
});
test('all scheduled riders survive a blocked entry; previous batch model remains explicit and restorable',()=>{
 const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0},departureScenario:config});
 const normal=sim.entryLeader.bind(sim);sim.entryLeader=(ref,car)=>car?.surveyDepartureId!==undefined?{p:0,v:0}:normal(ref,car);
 sim.step(3600);const state=sim.departureState();assert.equal(state.departed,360);assert.equal(state.entryWaiting,360);assert.equal(state.entered,0);assert.equal(state.plannedCurve.model,'smooth-peaks-v1');
 const legacy=makeDeparturePlan({...config,distributionModel:'questionnaire-batches-v1'});assert.equal(legacy.curve,undefined);assert(legacy.plannedByMinute.slice(37,39).every(n=>n===0));
});
