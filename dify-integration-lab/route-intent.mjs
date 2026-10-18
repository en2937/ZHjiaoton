// Deliberately exact: a keyword match could discard a destination or a negation.
const timeQuestions = new Set(['哪条路更快','哪条路时间最短','我赶时间，帮我选一条路']);
const distanceQuestions = new Set(['哪条路更近','哪条路距离更短']);
export function localCriterion(question, preference) {
  const normalized=question.trim().replace(/[。！？!?．.]+$/u,'');
  if(timeQuestions.has(normalized))return 'time';
  if(distanceQuestions.has(normalized))return 'distance';
  return normalized==='按当前偏好推荐路线'?preference:null;
}
export function selectRoute(routes, criterion) {
  const field=criterion==='distance'?'distanceMeters':'travelTimeSeconds';
  return routes.reduce((best,route)=>!best||route[field]<best[field]?route:best,null);
}
