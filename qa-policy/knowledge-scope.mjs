// Validate named places and data scope, not every word of a natural question.
export const DATA_LIMIT_REPLY='受限于数据，我暂时无法回答这个问题';
export const KNOWLEDGE_POLICY_VERSION='campus-known-scope-v2';
const teachingAliases=['东教学楼','东教','东教楼','东区教学楼','东教学区','教学楼','教学区','地点2','地点二','出发点2','出发点二'];
for(const [i,n]of [...'一二三四五六'].entries())for(const digit of [n,String(i+1)])teachingAliases.push('东'+digit+'教学楼','东'+digit+'号教学楼','东'+digit+'教','东'+digit);
const dormAliases=['学生宿舍','学生寝室','学生公寓','住宿区','寝室区','宿舍区','宿舍楼','宿舍','寝室','寝室楼','地点1','地点一','出发点1','出发点一'];
for(const name of ['云峰','碧峰','紫云'])for(const suffix of ['学园宿舍区','学园宿舍','学园寝室','学园','宿舍区','宿舍楼','宿舍','寝室',''])dormAliases.push(name+suffix);
export const knownPlaces=[{id:'1',name:'云峰学园',aliases:dormAliases},{id:'2',name:'东教学楼',aliases:teachingAliases}];
const roadNames=['藕舫南路','藕舫中路','迪臣中路','北侧环岛线','北侧环岛','环岛线','环岛路','环岛','便捷小路','小路','主道路','主路','西侧路口','东侧路口','东北出入口','东北入口','西北出口','西南出口','东南出口','西出口','东出口','A路口','B路口','路口A','路口B','A','B'];
const compact=q=>String(q).normalize('NFKC').replace(/\s+/g,'').replace(/[⟦⟧]/g,'');
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const aliases=knownPlaces.flatMap(p=>p.aliases.map(alias=>({alias,id:p.id}))).sort((a,b)=>b.alias.length-a.alias.length);
const placePattern=new RegExp(aliases.map(p=>escaped(p.alias)).join('|'),'g');
// Only place-name boundaries are constrained. Ordinary verbs/adverbs stay free.
const prefix=/(?:从|去|到|往|回|在|离|距|与|和|及|或|是|为|由|自|住|叫|指|问|我|你|的|请|给|条|至|对|比|看|查|找|们|出发地|目的地|起点|终点|为什么|怎么|如何|查询|推荐|规划|途经|经过|抵达|到达|了解|比较|分析|关于|有关|前往|返回|请问|问下|附近的)$/;
function startsName(text,index){return index===0||/[\s\p{P}\p{S}]/u.test(text[index-1])||prefix.test(text.slice(0,index));}
export function placeText(question){
 const text=compact(question);
 return text.replace(placePattern,(alias,index)=>{
  if(!startsName(text,index))return alias;
  if(/[0-9一二三四五六]$/.test(alias)&&/[0-9零一二三四五六七八九十]/.test(text[index+alias.length]||''))return alias;
  return '⟦'+aliases.find(p=>p.alias===alias).id+'⟧';
 });
}
export function canonicalQuestion(question){return placeText(question).replace(/⟦([12])⟧/g,(_,id)=>knownPlaces.find(p=>p.id===id).name);}
function entityText(question){
 let text=placeText(question);
 const pattern=new RegExp(roadNames.sort((a,b)=>b.length-a.length).map(escaped).join('|'),'g');
 return text.replace(pattern,(name,index)=>(startsName(text,index)||/^(?:[AB]路口|路口[AB])$/.test(name))?'⟦road⟧':name);
}
const unsupported=/真实(?:路况|交通|流量|车流|人数|数据)|实(?:测|际测量)(?:的|后|到|收益|用时|数据)|(?:保证|确保|肯定|一定)(?:能|会|不|准|到)|天气|下雨|气温|课表|历史数据|昨天|明天|后天|门牌|经纬|坐标|在哪|位于|(?:几|多少)(?:层|间|教室)|老师|教师|课程名称|电话号码|联系方式|楼内|楼里|室内/;
const unknownEntity=/教学楼|教学区|学园|宿舍|寝室|图书馆|食堂|体育馆|学院|医院|实验楼|大楼|校门|校区|地铁|车站|公园|广场|火星|[东西南北]教|东[0-9一二三四五六七八九十]+|[东西南北][门路]|[东西南北][A-Za-z0-9一二三四五六七八九十]*楼|[A-Za-z0-9]+路口|路口[A-Za-z0-9]+|北侧路口|南侧路口|云峰|碧峰|紫云/;
function unknownTarget(text){
 const verbs=/(?=(从|去往|前往|返回|回到|抵达|到达|经过|沿着|去|到|回)([^，。？！?,;；!]{1,45}))/g;
 for(const m of text.matchAll(verbs)){
  if(m[1]==='到'&&/(?:收|得|看|想|提|说|听|检测|观察|统计|等|达|不|快|迟)$/.test(text.slice(0,m.index)))continue;
  if(m[1]==='回'&&/[撤收挽]$/.test(text.slice(0,m.index)))continue;
  const target=m[2].split(/上(?:课|早|晚|[零〇一二两三四五六七八九十0-9])|骑|走|出发|动身|赶课|几点|多久|怎么|哪|什么|咋|啥|如何|需要|大概|预计|要|可以|能|会|更|最快|好|堵|有|想|的课|前往|去|到|返回|回|在|看看|看书/)[0];
  if(m[1]==='从'&&/^(?:认知|意愿|引导|信息|策略|数据|参数|交通|当前|现在|实际|路线|模型|问卷)/.test(target))continue;
  if(!target||/^(?:现在|当前|时候|这里|那里|这儿|那儿|零|〇|一|二|两|三|四|五|六|七|八|九|十|[0-9])/.test(target))continue;
  if(/^⟦(?:[12]|road)⟧/.test(target))continue;
  // A route reference is ordinary language; explicit unknown place names are not.
  if(/^(?:哪|这|那|另一|其他|主|北侧|小路|环岛|路口|路段|路边|外面|校园)/.test(target))continue;
  return true;
 }
 // An explicitly named, unavailable route must not fall back to the UI trip.
 for(const m of text.matchAll(/(?:的|走|选择|沿着|经由)([\p{Script=Han}A-Za-z]{1,12}?)(?:路线|线路)/gu)){
  if(!/^(?:一条|一|条|更|最|比较|相对|快|近|短|省时|省距离|合适|适合|最佳|推荐|通行|出行|骑行|直接|绕行|那|这|哪|几|的|我|们|不|太|很)+$/.test(m[1]))return true;
 }
 return false;
}
export function aliasAcknowledgement(question){
 const masked=placeText(question),ids=[...masked.matchAll(/⟦([12])⟧/g)].map(m=>m[1]);
 if(!ids.length||new Set(ids).size!==1)return null;
 const remainder=masked.replace(/⟦[12]⟧/g,'');
 if(!remainder||/(?:就是|是指|指的是|说的是|问的是|意思是|也叫|等于|同一个|同一含义|别名|=)/.test(remainder)){
  if(/出发|上课|拥堵|怎么|路线|距离|多久|时间/.test(remainder))return null;
  return '已识别，这些名称都按'+knownPlaces.find(p=>p.id===ids[0]).name+'处理。';
 }
 return null;
}
export function questionScope(question,{audience='student'}={}){
 const text=compact(question),masked=entityText(question);
 for(const m of text.matchAll(/([A-Za-z0-9]+)路口|路口([A-Za-z0-9]+)/g))if(!['A','B'].includes(m[1]||m[2]))return {allowed:false,reason:'unknown-place'};
 if(audience==='student'&&/参数|人数|权重|问卷|认知|意愿|引导覆盖|比例|占比|车流量|配时|红绿灯|设为|设置|调到|调参|执行|撤回|撤销/.test(text))return {allowed:false,reason:'unsupported-student-fact'};
 if(/单向|双向|车道|道路宽|扩宽/.test(text)||unsupported.test(text))return {allowed:false,reason:'unavailable-fact'};
 if(/(?:北侧|西侧|南侧|北|西|南|新|老|其他|另一)的(?:教学楼|教学区|宿舍)/.test(text))return {allowed:false,reason:'unknown-place'};
 if(/(?:地点|出发点)(?![12一二](?![0-9]))[0-9一二三四五六七八九十]+/.test(text)||unknownEntity.test(masked)||unknownTarget(masked))return {allowed:false,reason:'unknown-place'};
 if(aliasAcknowledgement(question))return {allowed:true};
 const topic=/路|交通|车|出发|动身|上课|早八|赶课|到达|抵达|堵|排队|等待|用时|耗时|距离|近|远|时间|多久/;
 const adminTopic=/绕行|分流|参数|设置|调参|优化|方案|引导|认知|意愿|问卷|调查|权重|信号|配时|覆盖|触达|场景|模式|沙盘|仿真|种子|倍速|暂停|播放|当前.*状态/;
 return topic.test(text)||/⟦[12]⟧/.test(masked)&&/去|到|回|走|从|前往/.test(text)||(audience==='admin'&&adminTopic.test(text))?{allowed:true}:{allowed:false,reason:'out-of-scope'};
}
export function resolveQuestionTrip(question,trip){
 const text=placeText(question),effective={...trip};
 const origins=[...text.matchAll(/(?:从|由|自)⟦([12])⟧/g)].map(m=>m[1]);
 const pair=/⟦([12])⟧(?:出发)?(?:到|去|至|往|回)⟦([12])⟧/.exec(text);if(pair)origins.push(pair[1]);
 const destinations=[...text.matchAll(/(?:去|到|前往|去往|返回|回|抵达|到达)⟦([12])⟧/g)].map(m=>m[1]);if(pair)destinations.push(pair[2]);
 if(new Set(origins).size>1||new Set(destinations).size>1)return {trip:effective,clarification:'请说明本次出发地和目的地，暂时一次比较一段行程。'};
 if(origins.length)effective.origin=origins[0];
 if(destinations.length){effective.destination=destinations[0];if(!origins.length&&effective.origin===effective.destination)effective.origin=effective.destination==='1'?'2':'1';}
 return {trip:effective};
}
export function tripMatchesQuestion(question,trip){const r=resolveQuestionTrip(question,trip);return !r.clarification&&r.trip.origin===trip.origin&&r.trip.destination===trip.destination;}
export function knowledgePolicy(audience){
 return {version:KNOWLEDGE_POLICY_VERSION,audience,knownPlaces,knownRoads:roadNames,scope:'仅当前沙盘中确实存在的交通数据；师生出发推演由独立后端负责',uncertaintyReply:DATA_LIMIT_REPLY,
  instruction:'先按knownPlaces识别同义地点。东一至东六、东1至东6及相应教学楼名称都按地点2；碧峰、紫云及其宿舍/学园名称都按地点1。它们是本项目用户确认的映射，不代表有逐栋楼的精细数据。正常口语、助词和时间表达不因词表未收录而拒答。未知地点或缺少事实才返回missing_data/out_of_scope，不能借用默认地点；缺少上课时间等可补充输入时应澄清，不当作未知知识。非ok不得生成控制参数。管理员数据不足时reply为uncertaintyReply，basis为空；模糊控制指令只能澄清，不能猜数值。'};
}
export const reportsUncertainty=text=>/受限于数据|不确定|无法(?:确认|判断|回答)|暂(?:时)?不(?:清楚|知道)|缺少[^。；]{0,20}数据|没有[^。；]{0,20}数据/.test(String(text));
