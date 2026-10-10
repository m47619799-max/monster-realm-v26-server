import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WebSocketServer } from "./ws-lite.mjs";
import { fileURLToPath } from "url";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||8080);
const DATA_FILE=process.env.DATA_FILE||path.join(__dirname,"data.json");
const WEB_DIR=path.resolve(__dirname,"game");
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",".json":"application/json; charset=utf-8",".txt":"text/plain; charset=utf-8"};
function serveGame(req,res){
  try{
    const u=new URL(req.url,"http://localhost");
    const pathname=decodeURIComponent(u.pathname);
    if(pathname.includes("\0"))throw new Error("Invalid path");
    const requested=pathname==="/"?"/index.html":pathname;
    const absolute=path.resolve(WEB_DIR,"."+requested);
    if(absolute!==WEB_DIR&&!absolute.startsWith(WEB_DIR+path.sep)){res.writeHead(403);res.end("Forbidden");return}
    fs.stat(absolute,(err,st)=>{
      if(err||!st.isFile()){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found");return}
      const headers={"Content-Type":MIME[path.extname(absolute).toLowerCase()]||"application/octet-stream","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"};
      res.writeHead(200,headers);
      if(req.method==="HEAD"){res.end();return}
      const stream=fs.createReadStream(absolute);
      stream.on("error",()=>res.destroy());stream.pipe(res);
    });
  }catch(e){res.writeHead(400);res.end("Invalid request")}
}


function loadDb(){
  try{return JSON.parse(fs.readFileSync(DATA_FILE,"utf8"))}
  catch(e){
    if(e?.code==="ENOENT")return{players:{}};
    // Do not accidentally reset all live player accounts when storage is corrupted.
    throw new Error(`Cannot read player database ${DATA_FILE}: ${e.message}`);
  }
}
let db=loadDb(); if(!db.players)db.players={};
function saveDb(){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  const temp=`${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(db,null,2),{mode:0o600});
  fs.renameSync(temp,DATA_FILE);
}
function keyName(s){return String(s||"").trim().replace(/\s+/g," ").toLowerCase()}
function cleanName(s){
  s=String(s||"").trim().replace(/\s+/g," ");
  if(!s||s.length>20)throw new Error("Trainer name must be 1-20 characters.");
  return s;
}
function publicPlayer(p){
  return{id:p.id,name:p.name,avatar:p.avatar||1,online:isOnline(p.id),profile:p.profile||{activeTrio:[],collection:[],stats:{}}}
}
function sendJson(res,status,obj){
  res.writeHead(status,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"});
  res.end(JSON.stringify(obj));
}
async function readJson(req){
  return await new Promise((resolve,reject)=>{
    let s="";req.on("data",c=>{s+=c;if(s.length>2_000_000){req.destroy();reject(new Error("Payload too large"))}});
    req.on("end",()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});req.on("error",reject);
  });
}

const sessions=new Map();        // token -> playerId
const clients=new Map();         // playerId -> Set<ws>
const rooms=new Map();           // roomId -> room
const challenges=new Map();      // challengeId -> challenge

function sessionPlayer(token){const id=sessions.get(String(token||""));return id?db.players[id]:null}
function isOnline(id){return clients.has(id)&&[...clients.get(id)].some(ws=>ws.readyState===1)}
function push(id,msg){
  const set=clients.get(id);if(!set)return;
  const data=JSON.stringify(msg);for(const ws of set)if(ws.readyState===1)ws.send(data);
}
function roomPublic(room){
  return{
    roomId:room.roomId,roomName:room.roomName,
    phase:room.phase||"waiting",prepEndsAt:room.prepEndsAt||null,serverNow:Date.now(),
    selectedIndices:room.selectedIndices||{},
    players:room.players.map(id=>{
      const p=db.players[id],team=room.teams[id]||[];
      return{id:p.id,name:p.name,avatar:p.avatar||1,team};
    }),
    battle:room.battle?{
      hp:room.battle.hp,active:room.battle.active,cooldowns:room.battle.cooldowns,
      turn:room.battle.turn,winner:room.battle.winner,
      round:room.battle.round,lastLog:room.battle.lastLog,rematchReady:[...room.battle.rematchReady]
    }:null
  };
}
function broadcastRoom(room,type="pvp_state"){
  const msg={type,room:roomPublic(room)};
  room.players.forEach(id=>push(id,msg));
}
function randomRoomId(){
  let id;do{id=String(Math.floor(10_000_000+Math.random()*90_000_000))}while(rooms.has(id));return id;
}
function clamp(n,a,b){n=Number(n)||0;return Math.max(a,Math.min(b,n))}
function sanitizeSkill(s){
  return{name:String(s?.name||"Skill").slice(0,90),power:clamp(s?.power,0,100),type:String(s?.type||"Neutral").slice(0,16)};
}
function sanitizeMonster(m){
  return{
    name:String(m?.name||"Monster").slice(0,40),level:clamp(m?.level,1,85),type:String(m?.type||"Neutral").slice(0,16),
    rarity:String(m?.rarity||"Normal").slice(0,16),img:String(m?.img||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,48),
    maxHp:clamp(m?.maxHp,20,5000),atk:clamp(m?.atk,1,1200),def:clamp(m?.def,1,1200),speed:clamp(m?.speed,1,500),
    crit:clamp(m?.crit,0,.35),titanDragon:!!m?.titanDragon,titanWeakness:!!m?.titanWeakness,
    skills:(Array.isArray(m?.skills)?m.skills:[]).slice(0,9).map(sanitizeSkill)
  };
}
function sanitizeTeam(team){return(Array.isArray(team)?team:[]).slice(0,3).map(sanitizeMonster)}
function sanitizeRoster(roster,team){
 const result=(Array.isArray(roster)?roster:[]).slice(0,500).map(sanitizeMonster);
 // Older game clients can still connect using the active battle trio.
 return result.length>=3?result:sanitizeTeam(team);
}
function initialSlots(roster,team){
 const used=new Set();
 return team.slice(0,3).map(m=>{
   let index=roster.findIndex((r,i)=>!used.has(i)&&r.name===m.name&&r.level===m.level&&r.img===m.img);
   if(index<0)index=roster.findIndex((r,i)=>!used.has(i));
   used.add(index);return index;
 });
}
function createRoomData(roomName,owner,team,roster){
 const roomId=randomRoomId(),safeRoster=sanitizeRoster(roster,team);
 return {roomId,roomName,roomNameKey:keyName(roomName),ownerId:owner,
  players:[owner],teams:{[owner]:team},rosters:{[owner]:safeRoster},
  selectedIndices:{[owner]:initialSlots(safeRoster,team)},phase:"waiting",prepEndsAt:null,battle:null,prepTimer:null};
}
// The server owns the clock. Clients cannot reset or lengthen the 30-second window.
function startPreparation(room){
 if(room.players.length!==2||room.phase!=="waiting")return;
 if(room.players.some(id=>(room.teams[id]||[]).length!==3))return;
 room.phase="select";room.prepEndsAt=Date.now()+30000;
 room.prepTimer=setTimeout(()=>finishPreparation(room.roomId),30000);
 broadcastRoom(room,"room_update");
}
function finishPreparation(roomId){
 const room=rooms.get(roomId);
 if(!room||room.phase!=="select")return;
 if(Date.now()<room.prepEndsAt){
   clearTimeout(room.prepTimer);room.prepTimer=setTimeout(()=>finishPreparation(roomId),room.prepEndsAt-Date.now());return;
 }
 room.phase="battle";room.prepTimer=null;resetBattle(room,1);broadcastRoom(room,"pvp_state");
}
function handlePvpPick(playerId,msg){
 const room=rooms.get(String(msg.roomId||""));
 if(!room||!room.players.includes(playerId))return;
 if(room.phase!=="select"||Date.now()>=room.prepEndsAt){
   if(room.phase==="select")finishPreparation(room.roomId);
   push(playerId,{type:"error",message:"Selection time is over. Battle is starting."});return;
 }
 const slot=Number(msg.slot),rosterIndex=Number(msg.rosterIndex);
 const roster=room.rosters[playerId]||[],slots=room.selectedIndices[playerId]||[];
 if(!Number.isInteger(slot)||slot<0||slot>2||!Number.isInteger(rosterIndex)||rosterIndex<0||rosterIndex>=roster.length){
  push(playerId,{type:"error",message:"Invalid monster selection."});return;
 }
 if(slots.some((v,i)=>i!==slot&&v===rosterIndex)){
  push(playerId,{type:"error",message:"A monster cannot occupy two team slots."});return;
 }
 slots[slot]=rosterIndex;
 room.teams[playerId]=slots.map(i=>roster[i]);
 broadcastRoom(room,"room_update");
}

function relation(attacker,target){
  if(target?.type==="Titan"){
    if(target.titanDragon)return 1;
    if(["Fire","Electric","Water"].includes(attacker))return 1.5;
    return 1;
  }
  const strong={
    Fire:["Nature","Earth"],Water:["Wind","Dark"],Nature:["Earth","Electric"],Electric:["Water","Wind"],
    Earth:["Electric","Water"],Wind:["Dark","Dragon"],Dark:["Dragon","Fire"],Dragon:["Fire","Nature"],
    Titan:["Fire","Water","Nature","Electric","Earth","Wind","Dark","Dragon"]
  };
  const weak={
    Fire:["Dark","Dragon"],Water:["Earth","Electric"],Nature:["Fire","Dragon"],Electric:["Nature","Earth"],
    Earth:["Fire","Nature"],Wind:["Water","Electric"],Dark:["Water","Wind"],Dragon:["Wind","Dark"],Titan:[]
  };
  if((strong[attacker]||[]).includes(target?.type))return 1.5;
  if((weak[attacker]||[]).includes(target?.type))return .67;
  return 1;
}
function resetBattle(room,round=1){
  const [a,b]=room.players;
  room.battle={
    hp:{[a]:room.teams[a].map(m=>m.maxHp),[b]:room.teams[b].map(m=>m.maxHp)},
    active:{[a]:0,[b]:0},
    turn:round%2===1?a:b,winner:null,round,lastLog:`Round ${round} started.`,rematchReady:new Set(),
    cooldowns:{[a]:room.teams[a].map(()=>Array(9).fill(0)),[b]:room.teams[b].map(()=>Array(9).fill(0))}
  };
}
function startRoomIfReady(room){startPreparation(room)}
function findRoomForPlayer(id){
  for(const room of rooms.values())if(room.players.includes(id))return room;
  return null;
}
function beginNextPvpTurn(room,playerId){
  const cds=room.battle.cooldowns?.[playerId];
  if(!cds)return;
  for(const monsterCds of cds)for(let i=1;i<monsterCds.length;i++){
    monsterCds[i]=Math.max(0,(Number(monsterCds[i])||0)-1);
  }
}
function handlePvpSwitch(playerId,msg){
  const room=rooms.get(String(msg.roomId||""));
  if(!room||room.phase!=="battle"||!room.battle||!room.players.includes(playerId))return;
  const b=room.battle;
  if(b.winner||b.turn!==playerId){push(playerId,{type:"error",message:"You may only switch during your own turn."});return}
  const i=Number(msg.monsterIndex);
  if(!Number.isInteger(i)||i<0||i>=3||!room.teams[playerId]?.[i]||(b.hp[playerId]?.[i]||0)<=0){
    push(playerId,{type:"error",message:"Select one of your three living monsters."});return;
  }
  if(b.active[playerId]===i)return;
  b.active[playerId]=i;
  b.lastLog=`${db.players[playerId].name} switched to ${room.teams[playerId][i].name}. Free switch: attack is still available!`;
  // Intentionally no turn change, no cooldown decrement and no damage.
  broadcastRoom(room);
}
function handlePvpAction(playerId,msg){
  const room=rooms.get(String(msg.roomId||""));if(!room||room.phase!=="battle"||!room.battle)return;
  const b=room.battle;if(b.winner||b.turn!==playerId)return;
  const other=room.players.find(id=>id!==playerId);if(!other)return;
  const ai=b.active[playerId]||0,di=b.active[other]||0,att=room.teams[playerId][ai],def=room.teams[other][di];
  if(!att||!def)return;
  const si=clamp(msg.skillIndex,0,Math.max(0,att.skills.length-1)),skill=att.skills[si]||{name:"Strike",power:12,type:att.type};
  const remaining=(b.cooldowns?.[playerId]?.[ai]?.[si]||0);
  if(si>0&&remaining>0){
    push(playerId,{type:"error",message:`${skill.name} needs ${remaining} more turn(s) to recharge.`});
    broadcastRoom(room);return;
  }
  if(si>0)b.cooldowns[playerId][ai][si]=4;
  const mult=relation(skill.type,def),variance=.92+Math.random()*.16,crit=Math.random()<att.crit;
  let damage=Math.max(2,Math.round((att.atk*.55+skill.power*2.15-def.def*.24)*mult*variance*(crit?1.5:1)));
  b.hp[other][di]=Math.max(0,b.hp[other][di]-damage);
  b.lastLog=`${db.players[playerId].name}'s ${att.name} used ${skill.name}: ${damage} damage${crit?" CRITICAL!":""}${mult>1?" • SUPER EFFECTIVE":mult<1?" • RESISTED":""}.`;
  if(b.hp[other][di]<=0){
    const nextAlive=b.hp[other].findIndex(hp=>hp>0);
    if(nextAlive<0){
      b.winner=playerId;b.turn=null;b.lastLog+=` ${db.players[playerId].name} wins the round!`;
    }else{
      b.active[other]=nextAlive;
      b.lastLog+=` ${room.teams[other][nextAlive].name} enters battle.`;
      b.turn=other;
    }
  }else b.turn=other;
  if(b.turn===other)beginNextPvpTurn(room,other);
  broadcastRoom(room);
}
function handleRematch(playerId,msg){
  const room=rooms.get(String(msg.roomId||""));if(!room?.battle?.winner)return;
  room.battle.rematchReady.add(playerId);broadcastRoom(room);
  if(room.battle.rematchReady.size===2){
    // A rematch reopens a fresh 30-second team selection, not an instant attack.
    room.battle=null;room.phase="waiting";room.prepEndsAt=null;
    startPreparation(room);
  }
}
function leaveRoom(playerId,roomId){
  const room=rooms.get(String(roomId||""))||findRoomForPlayer(playerId);if(!room)return;
  if(!room.players.includes(playerId))return;
  room.players.filter(id=>id!==playerId).forEach(id=>push(id,{type:"room_closed"}));
  if(room.prepTimer)clearTimeout(room.prepTimer);
  rooms.delete(room.roomId);
}

const server=http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){sendJson(res,200,{ok:true});return}
  if(req.method==="GET"&&req.url.split("?")[0]==="/health"){sendJson(res,200,{ok:true,edition:"V28",mode:"Render Free test",rooms:rooms.size,players:Object.keys(db.players).length});return}
  if(req.method==="GET"&&req.url.split("?")[0]==="/"){sendJson(res,200,{ok:true,service:"Monster Realm V28 PvP server",mode:"test",help:"This URL is a backend API, not the playable CrazyGames website. Try /health."});return}
  if(req.method==="GET"||req.method==="HEAD"){serveGame(req,res);return}
  if(req.method!=="POST"){sendJson(res,404,{ok:false,error:"Not found"});return}
  let body={};try{body=await readJson(req)}catch(e){sendJson(res,400,{ok:false,error:"Invalid JSON"});return}
  try{
    const url=req.url.split("?")[0];
    if(url==="/api/session"){
      const name=cleanName(body.name),nk=keyName(name),hash=String(body.passwordHash||"");
      if(!hash)throw new Error("Password hash missing.");
      let p=Object.values(db.players).find(x=>x.nameKey===nk);
      if(p){
        if(p.passwordHash!==hash)throw new Error("That trainer name already exists with a different password.");
        p.name=name;p.avatar=clamp(body.avatar,1,10);
      }else{
        const id=crypto.randomUUID();
        p={id,name,nameKey:nk,passwordHash:hash,avatar:clamp(body.avatar,1,10),friends:[],requests:[],profile:{activeTrio:[],collection:[],stats:{}},createdAt:new Date().toISOString()};
        db.players[id]=p;saveDb();
      }
      const token=crypto.randomBytes(24).toString("hex");sessions.set(token,p.id);saveDb();
      sendJson(res,200,{ok:true,token,playerId:p.id,player:publicPlayer(p)});return;
    }
    const p=sessionPlayer(body.token);if(!p)throw new Error("Session expired. Reload the game.");

    if(url==="/api/profile/sync"){
      const x=body.profile||{};p.avatar=clamp(x.avatar||p.avatar,1,10);
      p.profile={activeTrio:sanitizeTeam(x.activeTrio),collection:(Array.isArray(x.collection)?x.collection:[]).slice(0,500).map(m=>({
        name:String(m.name||"").slice(0,40),baseName:String(m.baseName||"").slice(0,40),level:clamp(m.level,1,85),type:String(m.type||"").slice(0,16),rarity:String(m.rarity||"").slice(0,16),img:String(m.img||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,48)
      })),stats:x.stats||{}};
      saveDb();sendJson(res,200,{ok:true});return;
    }
    if(url==="/api/profile/get"){
      const target=db.players[String(body.playerId||"")];if(!target)throw new Error("Player not found.");
      sendJson(res,200,{ok:true,profile:publicPlayer(target)});return;
    }
    if(url==="/api/friends/request"){
      const tn=keyName(body.targetName),target=Object.values(db.players).find(x=>x.nameKey===tn);
      if(!target)throw new Error("No player with that exact name.");
      if(target.id===p.id)throw new Error("You cannot add yourself.");
      if(p.friends.includes(target.id))throw new Error("Already friends.");
      if(!target.requests.includes(p.id))target.requests.push(p.id);saveDb();
      push(target.id,{type:"friend_request",from:{id:p.id,name:p.name,avatar:p.avatar}});
      sendJson(res,200,{ok:true,message:"Friend request sent."});return;
    }
    if(url==="/api/friends/accept"){
      const from=db.players[String(body.fromId||"")];if(!from||!p.requests.includes(from.id))throw new Error("Friend request not found.");
      p.requests=p.requests.filter(x=>x!==from.id);if(!p.friends.includes(from.id))p.friends.push(from.id);if(!from.friends.includes(p.id))from.friends.push(p.id);saveDb();
      push(from.id,{type:"friend_accepted",friend:{id:p.id,name:p.name,avatar:p.avatar}});
      sendJson(res,200,{ok:true});return;
    }
    if(url==="/api/friends/decline"){
      p.requests=p.requests.filter(x=>x!==String(body.fromId||""));saveDb();sendJson(res,200,{ok:true});return;
    }
    if(url==="/api/friends/list"){
      sendJson(res,200,{ok:true,
        friends:p.friends.map(id=>db.players[id]).filter(Boolean).map(x=>({id:x.id,name:x.name,avatar:x.avatar,online:isOnline(x.id)})),
        requests:p.requests.map(id=>db.players[id]).filter(Boolean).map(x=>({id:x.id,name:x.name,avatar:x.avatar}))
      });return;
    }
    if(url==="/api/rooms/create"){
      const old=findRoomForPlayer(p.id);if(old)leaveRoom(p.id,old.roomId);
      const team=sanitizeTeam(body.team);
      if(team.length!==3)throw new Error("Online PvP requires exactly 3 monsters.");
      const roomName=String(body.roomName||"crazy").trim().slice(0,24)||"crazy";
      const room=createRoomData(roomName,p.id,team,body.roster);
      rooms.set(room.roomId,room);sendJson(res,200,{ok:true,room:roomPublic(room)});push(p.id,{type:"room_update",room:roomPublic(room)});return;
    }
    if(url==="/api/rooms/join"){
      const room=rooms.get(String(body.roomId||""));if(!room)throw new Error("Room ID not found.");
      if(room.roomNameKey!==keyName(body.roomName))throw new Error("Room name does not match.");
      if(room.players.length>=2&&!room.players.includes(p.id))throw new Error("Room is full.");
      const team=sanitizeTeam(body.team);
      if(team.length!==3)throw new Error("Online PvP requires exactly 3 monsters.");
      const existing=findRoomForPlayer(p.id);
      if(existing&&existing.roomId!==room.roomId)leaveRoom(p.id,existing.roomId);
      if(room.phase!=="waiting")throw new Error("Match is already preparing or in progress.");
      if(!room.players.includes(p.id))room.players.push(p.id);
      const roster=sanitizeRoster(body.roster,team);
      room.teams[p.id]=team;room.rosters[p.id]=roster;room.selectedIndices[p.id]=initialSlots(roster,team);
      startRoomIfReady(room);
      sendJson(res,200,{ok:true,room:roomPublic(room)});
      if(room.phase==="waiting")broadcastRoom(room,"room_update");return;
    }
    if(url==="/api/challenge/send"){
      const target=db.players[String(body.targetId||"")];if(!target||!p.friends.includes(target.id))throw new Error("Friend not found.");
      if(!isOnline(target.id))throw new Error("Friend is offline.");
      const team=sanitizeTeam(body.team);
      if(team.length!==3)throw new Error("Online PvP requires exactly 3 monsters.");
      const challengeId=crypto.randomUUID(),c={challengeId,from:p.id,to:target.id,team,roster:sanitizeRoster(body.roster,team),createdAt:Date.now()};challenges.set(challengeId,c);
      push(target.id,{type:"challenge",challengeId,from:{id:p.id,name:p.name,avatar:p.avatar}});
      sendJson(res,200,{ok:true});return;
    }
    if(url==="/api/challenge/accept"){
      const c=challenges.get(String(body.challengeId||""));if(!c||c.to!==p.id)throw new Error("Challenge expired.");
      const from=db.players[c.from];if(!from)throw new Error("Challenger unavailable.");
      const team=sanitizeTeam(body.team);
      if(team.length!==3)throw new Error("Online PvP requires exactly 3 monsters.");
      const oldFrom=findRoomForPlayer(from.id),oldTo=findRoomForPlayer(p.id);
      if(oldFrom)leaveRoom(from.id,oldFrom.roomId);
      if(oldTo)leaveRoom(p.id,oldTo.roomId);
      const roomName="friends",room=createRoomData(roomName,from.id,c.team,c.roster);
      const roster=sanitizeRoster(body.roster,team);
      room.players.push(p.id);room.teams[p.id]=team;room.rosters[p.id]=roster;
      room.selectedIndices[p.id]=initialSlots(roster,team);
      rooms.set(room.roomId,room);challenges.delete(c.challengeId);startRoomIfReady(room);
      sendJson(res,200,{ok:true,room:roomPublic(room)});return;
    }
    if(url==="/api/challenge/decline"){challenges.delete(String(body.challengeId||""));sendJson(res,200,{ok:true});return}
    throw new Error("Unknown endpoint.");
  }catch(e){sendJson(res,400,{ok:false,error:e.message||String(e)})}
});

const wss=new WebSocketServer({server});
wss.on("connection",(ws,req)=>{
  let token="";try{token=new URL(req.url,"http://localhost").searchParams.get("token")||""}catch(e){}
  const p=sessionPlayer(token);if(!p){ws.close(1008,"Invalid session");return}
  if(!clients.has(p.id))clients.set(p.id,new Set());clients.get(p.id).add(ws);
  ws.send(JSON.stringify({type:"hello",player:publicPlayer(p)}));
  // Re-send current room after a websocket reconnect or a late connection.
  const currentRoom=findRoomForPlayer(p.id);
  if(currentRoom)ws.send(JSON.stringify({type:currentRoom.battle?"pvp_state":"room_update",room:roomPublic(currentRoom)}));
  ws.on("message",raw=>{
    try{
      const msg=JSON.parse(String(raw));
      if(msg.type==="pvp_pick")handlePvpPick(p.id,msg);
      if(msg.type==="pvp_switch")handlePvpSwitch(p.id,msg);
      if(msg.type==="pvp_action")handlePvpAction(p.id,msg);
      if(msg.type==="pvp_rematch")handleRematch(p.id,msg);
      if(msg.type==="room_leave")leaveRoom(p.id,msg.roomId);
    }catch(e){ws.send(JSON.stringify({type:"error",message:e.message||"Invalid message"}))}
  });
  ws.on("close",()=>{
    const set=clients.get(p.id);if(set){set.delete(ws);if(!set.size)clients.delete(p.id)}
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Monster Realm V28 ONLINE listening on port ${PORT}`));
