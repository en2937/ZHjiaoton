import {rateAt} from '../traffic-sandbox/dist/engine.mjs';
export const PERIOD_MODEL_VERSION='period-dispersion-v1';
export function periodProfile(classTime){
 const factor=classTime==='08:00'?.8:classTime==='10:00'?1.2:1;
 return {version:PERIOD_MODEL_VERSION,id:factor<1?'early-concentrated':factor>1?'later-dispersed':'survey-reference',label:factor<1?'早八集中模板':factor>1?'十点分散模板':'问卷参考模板',factor,centerMinute:40,basis:'user-approved-simulation-assumption',note:'分时曲线为模拟假设：早八较集中、十点较分散；不是分时实测问卷。'};
}
// Smooth monotone time warp. Endpoints and the 40th minute stay fixed.
export function warpMinute(minute,profile){
 const x=Math.max(0,Math.min(1,minute/60)),c=profile.centerMinute/60,k=(profile.factor-1)/(c*(1-c));
 return 60*(x+k*x*(1-x)*(x-c));
}
const warpDerivative=(minute,profile)=>{const x=minute/60,c=profile.centerMinute/60,k=(profile.factor-1)/(c*(1-c));return 1+k*((1-2*x)*(x-c)+x*(1-x));};
function profileRate(curve,minute,profile){
 if(minute>=60)return 0;let lo=0,hi=60;
 for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(warpMinute(mid,profile)<minute)lo=mid;else hi=mid;}
 const reference=(lo+hi)/2;return rateAt(curve,reference)/warpDerivative(reference,profile);
}
export function applyPeriodProfile(sim,profile=periodProfile(sim.departureScenario.classTime)){
 const state=sim.surveyDepartures,referenceCurve=state.curve,referenceByMinute=[...state.plannedByMinute];
 for(const event of state.plan){event.referenceProfileTime=event.time;event.time=warpMinute(event.time/60,profile)*60;event.leadSeconds=3600-event.time;}
 state.plan.sort((a,b)=>a.time-b.time||a.id-b.id);state.plannedByMinute=Array(61).fill(0);
 for(const event of state.plan)state.plannedByMinute[Math.min(59,Math.floor(event.time/60))]++;
 // The old Hermite curve describes the source distribution, not the warped one.
 if(profile.factor!==1)delete state.curve;
 const times=state.plan.map(e=>e.time/60),mean=times.reduce((sum,v)=>sum+v,0)/times.length;
 return {...profile,totalPeople:times.length,plannedByMinute:[...state.plannedByMinute],referenceByMinute,standardDeviationMinutes:Math.sqrt(times.reduce((sum,v)=>sum+(v-mean)**2,0)/times.length),curveSamples:referenceCurve?Array.from({length:61},(_,minute)=>({minute,rate:profileRate(referenceCurve,minute,profile)})):null};
}
