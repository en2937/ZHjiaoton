// Coordinates follow Map.png using a 1687 × 1472 drawing space.
// The main route follows Map1.png; the roundabout and north link follow Map.png and the user's red-line annotation.
// These are manually traced simulation paths, not a georeferenced road network.
export const MAP = { width: 1687, height: 1472, image: '/assets/Map.png' };
export const POINTS = [
  [246,262],[305,253],[370,242],[424,233],
  [441,325],[460,426],[476,518],[492,611],[508,701],[519,789],
  [568,784],[619,779],[686,766],[755,753],[828,739],[901,724],
  [978,710],[1050,697],[1114,685],[1163,677],
  [1188,707],[1220,750],[1256,814],[1287,881],[1319,953],
  [1346,1026],[1367,1104],[1383,1182],[1396,1261]
];
export const LABELS = [
  {key:'start', title:'出发点 1', subtitle:'宿舍区附近', x:246,y:262},
  {key:'end', title:'出发点 2', subtitle:'教学区附近', x:1396,y:1261}
];
export const JUNCTIONS = [
  {id:'west',name:'西侧路口',pointIndex:9,offset:0},
  {id:'east',name:'东侧路口',pointIndex:19,offset:13}
];

// User-confirmed rule: both motor directions use the eastern carriageway of Oufang South Road.
// A separately traced centreline makes "east" geographical, independent of travel direction.
export const MOTOR_ROAD = {
  name:'藕舫南路', carriageway:'east', directions:[1,-1], fromPoint:19,
  points:[
    [1180,677],[1205,707],[1237,750],[1272,814],[1304,881],
    [1336,953],[1363,1026],[1388,1104],[1402,1182],[1417,1261]
  ]
};
export const MOTOR_POINTS = POINTS.map((p,i)=>i<MOTOR_ROAD.fromPoint?p:MOTOR_ROAD.points[i-MOTOR_ROAD.fromPoint]);

// Both directions stay on their geographical side, regardless of map arrows.
export const MIDDLE_ROAD = {
 name:'藕舫中路',directions:[1,-1],nonMotorCarriageway:'west',motorCarriageway:'east',
 points:[[1163,677],[1156,662],[1146,647],[1136,625],[1124,600],[1115,575],[1106,550],[1098,525],[1089,500],[1083,475],[1078,450],[1073,400],[1069,350],[1067,300],[1068,250],[1070,200],[1074,150],[1078,100],[1080,75],[1082,60]],
 motorPoints:[[1180,677],[1172,662],[1164,647],[1154,625],[1142,600],[1133,575],[1124,550],[1116,525],[1106,500],[1100,475],[1094,450],[1087,400],[1086,350],[1084,300],[1084,250],[1084,200],[1090,150],[1094,100],[1096,75],[1098,60]]
};

// Dichen Middle Road divides traffic by travel direction, for all vehicle types.
// Arrays share north/south junction endpoints and are stored north → south.
export const DICHEN_ROAD = {
 name:'迪臣中路',directions:[1,-1],southboundCarriageway:'west',northboundCarriageway:'east',
 points:[[424,233],[427,249],[429,260],[436,300],[440,325],[448,375],[457,426],[466,480],[472,518],[477,550],[487,611],[497,670],[503,701],[512,752],[516,773],[519,789]],
 southboundPoints:[[424,233],[419,249],[421,260],[428,300],[432,325],[440,375],[449,426],[457,480],[463,518],[468,550],[478,611],[488,670],[494,701],[503,752],[507,773],[519,789]],
 northboundPoints:[[424,233],[435,249],[437,260],[444,300],[448,325],[457,375],[466,426],[475,480],[480,518],[485,550],[495,611],[506,670],[512,701],[521,752],[525,773],[519,789]]
};

// Directed road segments for junction branching. Dashed portions are simulation extensions
// where the supplied stitched image stops showing the road.
const road=(points,extra={})=>({points,...extra});
export const EDGES={
 access1:road(POINTS.slice(0,4)),
 // Two-way connection from source 1's junction to the northern roundabout entry.
 northConnector:road([[424,233],[450,230],[500,222],[550,213],[600,205],[650,196],[700,188],[735,182],[747,180],[751,194],[760,211],[765,225],[767,240],[771,260],[782,300],[795,350],[808,400],[821,450],[834,500],[840,525],[846,546],[850,550]]),
 northWest:road(DICHEN_ROAD.points,{directionPoints:{1:DICHEN_ROAD.southboundPoints,'-1':DICHEN_ROAD.northboundPoints},lateralOffset:0}),
 linkWest:road(POINTS.slice(9,14)),
 linkMiddle:road(POINTS.slice(13,17)),
 linkEast:road(POINTS.slice(16,20),{motorPoints:[...POINTS.slice(16,19),MOTOR_ROAD.points[0]]}),
 // The new Map.png shows a one-way half-roundabout north of the main corridor.
 // Its southern side runs west → east; the northern arc runs east → west.
 ringWestConnector:road([[755,753],[754,741],[752,729],[749,716],[746,705],[720,700]]),
 ringBottom:road([[720,700],[740,700],[750,701],[768,694],[805,688],[845,681],[885,672],[930,664],[950,660],[970,657],[975,665]],{roundabout:true}),
 // Shared arcs let both entry routes follow and queue behind the same vehicles.
 ringArcEast:road([[975,665],[980,657],[1005,654],[1015,649],[1015,641],[1015,631],[1006,615],[990,600],[968,584],[946,571],[920,562],[896,557],[850,550]],{roundabout:true}),
 ringArcWest:road([[850,550],[824,566],[804,581],[786,590],[767,605],[750,625],[742,630],[734,640],[728,650],[724,660],[720,670],[717,680],[716,690],[720,700]],{roundabout:true}),
 ringEastConnector:road([[978,710],[978,700],[976,690],[975,680],[975,665]]),
 middleRoad:road(MIDDLE_ROAD.points,{motorPoints:MIDDLE_ROAD.motorPoints,motorEast:true,lateralOffset:1.8}),
 accessNorth:road([[1086,0],[1082,60]],{motorPoints:[[1102,0],[1098,60]],motorEast:true,lateralOffset:1.8,virtualFrom:0}),
 southEast:road(POINTS.slice(19),{motorPoints:MOTOR_ROAD.points,motorEast:true}),
 exitSouthEast:road([[1396,1261],[1405,1330],[1423,1410],[1430,1472],[1435,1512]],{
   motorPoints:[[1417,1261],[1426,1330],[1442,1410],[1449,1472],[1454,1512]],motorEast:true,virtualFrom:3,exit:'southEast'}),
 exitWestNorth:road([[424,233],[430,215],[423,180],[413,130],[400,65],[390,0],[384,-40]],{lateralOffset:0,virtualFrom:5,exit:'northWest'}),
 exitWestSouth:road([[519,789],[510,809],[512,850],[513,871],[515,1050],[518,1280],[520,1512]],{lateralOffset:0,virtualFrom:3,exit:'southWest'}),
 exitWestWest:road([[519,789],[453,802],[393,814],[240,846],[80,878],[-40,902]],{virtualFrom:2,exit:'west'}),
 exitEastNorth:road([[1082,60],[1086,0],[1090,-40]],{
   motorPoints:[[1098,60],[1102,0],[1106,-40]],motorEast:true,lateralOffset:1.8,virtualFrom:0,exit:'northEast'}),
 exitEastEast:road([[1163,677],[1245,663],[1342,647],[1450,630],[1572,610],[1574,661],[1646,661],[1727,661]],{
   motorPoints:[[1180,677],[1245,663],[1342,647],[1450,630],[1572,610],[1574,661],[1646,661],[1727,661]],virtualFrom:6,exit:'east'})
};
export const EXITS=[
 {id:'northWest',name:'西北出口',x:393,y:17},
 {id:'southWest',name:'西南出口',x:520,y:1451},
 {id:'west',name:'西出口',x:22,y:889},
 {id:'northEast',name:'东北出入口',x:1093,y:17},
 {id:'east',name:'东出口',x:1664,y:661},
 {id:'southEast',name:'东南出口',x:1447,y:1451}
];
const ref=(edge,direction=1)=>({edge,direction});
const route=(origin,id,refs,turns)=>({origin,id,refs,turns,exit:EDGES[refs.at(-1).edge].exit});
const p1=[ref('access1'),ref('northWest')],p2=[ref('southEast',-1)];
const mainEast=[ref('linkWest'),ref('linkMiddle'),ref('linkEast')];
const mainWest=[ref('linkEast',-1),ref('linkMiddle',-1),ref('linkWest',-1)];
const ringEast=[ref('linkWest'),ref('ringWestConnector'),ref('ringBottom'),ref('ringEastConnector',-1),ref('linkEast')];
const ringWest=[ref('linkEast',-1),ref('ringEastConnector'),ref('ringArcEast'),ref('ringArcWest'),ref('ringWestConnector',-1),ref('linkWest',-1)];
const northBypassEast=[ref('access1'),ref('northConnector'),ref('ringArcWest'),ref('ringBottom'),ref('ringEastConnector',-1),ref('linkEast')];
export const ROUTES={
 '1-south':route(1,'1-south',[...p1,...mainEast,ref('southEast'),ref('exitSouthEast')],[{j:0,movement:'left'},{j:1,movement:'right'}]),
 '1-east':route(1,'1-east',[...p1,...mainEast,ref('exitEastEast')],[{j:0,movement:'left'},{j:1,movement:'straight'}]),
 '1-north':route(1,'1-north',[...p1,...mainEast,ref('middleRoad'),ref('exitEastNorth')],[{j:0,movement:'left'},{j:1,movement:'left'}]),
 '1-ring':route(1,'1-ring',[...p1,...ringEast,ref('southEast'),ref('exitSouthEast')],[{j:0,movement:'left'},{j:1,movement:'right'}]),
 '1-ring-north':route(1,'1-ring-north',[...northBypassEast,ref('southEast'),ref('exitSouthEast')],[{j:1,movement:'right'}]),
 '1-bypass-east':route(1,'1-bypass-east',[...northBypassEast,ref('exitEastEast')],[{j:1,movement:'straight'}]),
 '1-bypass-north':route(1,'1-bypass-north',[...northBypassEast,ref('middleRoad'),ref('exitEastNorth')],[{j:1,movement:'left'}]),
 '1-west':route(1,'1-west',[...p1,ref('exitWestWest')],[{j:0,movement:'right'}]),
 '1-west-south':route(1,'1-west-south',[...p1,ref('exitWestSouth')],[{j:0,movement:'straight'}]),
 '2-west-north':route(2,'2-west-north',[...p2,...mainWest,ref('northWest',-1),ref('exitWestNorth')],[{j:1,movement:'left'},{j:0,movement:'right'}]),
 '2-west-south':route(2,'2-west-south',[...p2,...mainWest,ref('exitWestSouth')],[{j:1,movement:'left'},{j:0,movement:'left'}]),
 '2-west':route(2,'2-west',[...p2,...mainWest,ref('exitWestWest')],[{j:1,movement:'left'},{j:0,movement:'straight'}]),
 '2-ring':route(2,'2-ring',[...p2,...ringWest,ref('northWest',-1),ref('exitWestNorth')],[{j:1,movement:'left'},{j:0,movement:'right'}]),
 '2-ring-north':route(2,'2-ring-north',[...p2,ref('linkEast',-1),ref('ringEastConnector'),ref('ringArcEast'),ref('northConnector',-1),ref('exitWestNorth')],[{j:1,movement:'left'}]),
 '2-north':route(2,'2-north',[...p2,ref('middleRoad'),ref('exitEastNorth')],[{j:1,movement:'straight'}]),
 '2-east':route(2,'2-east',[...p2,ref('exitEastEast')],[{j:1,movement:'right'}]),
 'north-south':route('north','north-south',[ref('accessNorth'),ref('middleRoad',-1),ref('southEast'),ref('exitSouthEast')],[{j:1,movement:'straight'}]),
 'north-west':route('north','north-west',[ref('accessNorth'),ref('middleRoad',-1),...mainWest,ref('northWest',-1),ref('exitWestNorth')],[{j:1,movement:'right'},{j:0,movement:'right'}]),
 'north-east':route('north','north-east',[ref('accessNorth'),ref('middleRoad',-1),ref('exitEastEast')],[{j:1,movement:'left'}])
};
export const APPROACHES=[
 {edge:'northWest',direction:1,j:0,origin:1},
 {edge:'linkWest',direction:-1,j:0,origin:2},
 {edge:'linkEast',direction:1,j:1,origin:1},
 {edge:'southEast',direction:-1,j:1,origin:2},
 {edge:'middleRoad',direction:-1,j:1,origin:'north',controlDirection:1}
];
// Ordinary ring/branch choices remain fixed; this policy controls only the A bypass.
export const BASE_ROUTE_WEIGHTS={
 1:[['1-south',.46],['1-ring',.10],['1-east',.12],['1-north',.12],['1-west',.10],['1-west-south',.10]],
 '-1':[['2-west-north',.46],['2-ring',.10],['2-west',.12],['2-west-south',.12],['2-north',.10],['2-east',.10]],
 0:[['north-south',.60],['north-west',.30],['north-east',.10]]
};
export const NORTH_BYPASS_ROUTES={
 '1-south':'1-ring-north','1-ring':'1-ring-north','1-east':'1-bypass-east','1-north':'1-bypass-north',
 '2-west-north':'2-ring-north','2-ring':'2-ring-north'
};
