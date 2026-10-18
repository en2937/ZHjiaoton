export const FORECAST_MODEL_VERSION='class-replay-rider-v2';
export const AVOIDANCE_POLICY=Object.freeze({coarseMinutes:10,refineMinutes:5,nearMinimumSeconds:15});
export function departureGoal(question){
 const text=String(question).replace(/\s+/g,'');
 if(/不(?:需要|用|必)(?:特意)?(?:避开|避免|躲开|避|绕开)(?:拥堵|堵车|堵|高峰)/.test(text))return 'latest-with-buffer';
 return /避(?:开|免)?(?:拥堵|堵车|堵|高峰)|错峰|躲开?(?:拥堵|堵车|高峰)|少(?:点)?(?:堵车|拥堵)|不想(?:堵|被堵)|不要(?:堵|被堵)|路上别堵|少等(?:一会|红灯|车)/.test(text)?'avoid-congestion':'latest-with-buffer';
}
export function selectAvoidance(results,preference='time'){
 if(!results.length)return null;
 const minimum=Math.min(...results.map(r=>r.delaySeconds));
 return [...results].filter(r=>r.delaySeconds<=minimum+AVOIDANCE_POLICY.nearMinimumSeconds).sort((a,b)=>b.departureSeconds-a.departureSeconds||a.delaySeconds-b.delaySeconds||(preference==='distance'?a.distanceMeters-b.distanceMeters:0)||a.arrivalSeconds-b.arrivalSeconds)[0];
}
export function forecastMessage(forecast,destination){
 const r=forecast.recommendation;if(!r)return forecast.reason;
 const goal=forecast.objective?.id==='avoid-congestion'?'为减少等待与慢行，':'尽量晚出发，';
 return '按'+forecast.classTime+'上课场景推演，'+goal+'建议'+r.departureTime+'前出发，走'+r.name+'，预计'+r.arrivalTime+'到达'+destination+'，至少预留5分钟。';
}
