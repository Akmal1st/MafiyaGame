// State, networking, host logic, bots, automatic host, narrator, sounds and stats.
// The UI lives in app.js. Both are classic scripts sharing the global scope.
const {R,ORDER,MIN_PLAYERS,composition,isMafia}=window.MafiaRoles;
const {t,roleName,roleDesc,errText}=window.I18N;
const app=document.getElementById("app");
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $=id=>document.getElementById(id);

// ---------- local storage (best effort) ----------
const store={
 get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},
 set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}},
 del(k){try{localStorage.removeItem(k)}catch{}}
};
const SESSION_KEY="mafia:session"; // {kind:'host'|'player', code, token}
const hostGameKey=code=>"mafia:host:"+code;
const roomKey=code=>"mafia:room:"+code;

// ---------- app state ----------
const urlRoom=(new URLSearchParams(location.search).get("room")||"").trim().toUpperCase();
const BASE=location.origin+location.pathname.replace(/index\.html$/,"");
let V={screen:"loading",err:"",state:null,secret:null,showRole:false,me:null,session:store.get(SESSION_KEY)};
// Host-only UI state for the current deal: manual night overrides, vote corrections, toggles.
let G=null;
const prefs=Object.assign({voice:true,sound:true},store.get("mafia:prefs")||{});
const savePrefs=()=>store.set("mafia:prefs",prefs);

function inviteLink(code){return `${BASE}?room=${code}`}
function setSession(s){V.session=s;s?store.set(SESSION_KEY,s):store.del(SESSION_KEY)}

// ---------- networking: public MQTT brokers over secure WebSockets ----------
// There is no game server. The host's browser holds the room; players send messages to it
// through free public MQTT brokers (plain WSS, no WebRTC, so it works on mobile networks).
// The host listens on every broker it can reach; each player uses whichever one works for them.
// Messages are end-to-end encrypted (ECDH P-256 + AES-GCM), so nobody watching a broker sees roles.
// window.MAFIA_MQTT can replace the broker list (array of wss:// URLs).
const BROKERS=window.MAFIA_MQTT||["wss://broker.emqx.io:8084/mqtt","wss://broker.hivemq.com:8884/mqtt","wss://test.mosquitto.org:8081/mqtt"];
const TOPIC="mafiyagame/v1/";
const rs=new MafiaRoom.RoomStore();
let HR=null,hostPriv=null,clients=[],pc=null,heartbeat=null,wakeLock=null,lastHeard=0;
const conns=new Map(); // host: cid -> {cid,pub,key,client,playerId,seen}
const net={online:false};
const randHex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,"0")).join("");

// ----- crypto -----
const b64=buf=>{const a=new Uint8Array(buf);let s="";for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode.apply(null,a.subarray(i,i+8192));return btoa(s)};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const ECDH={name:"ECDH",namedCurve:"P-256"};
const genKeys=()=>crypto.subtle.generateKey(ECDH,true,["deriveKey"]);
const exportPub=async k=>b64(await crypto.subtle.exportKey("raw",k));
async function derive(priv,pubB64){
 const pub=await crypto.subtle.importKey("raw",unb64(pubB64),ECDH,false,[]);
 return crypto.subtle.deriveKey({name:"ECDH",public:pub},priv,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function seal(key,obj){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const d=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(obj)));
 return {iv:b64(iv),d:b64(d)};
}
async function unseal(key,m){
 const d=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(m.iv)},key,unb64(m.d));
 return JSON.parse(new TextDecoder().decode(d));
}

// ----- brokers -----
function connectBroker(url){
 return new Promise((res,rej)=>{
  let c;
  try{c=mqtt.connect(url,{clientId:"mf_"+randHex(8),clean:true,connectTimeout:8000,reconnectPeriod:3000,keepalive:30})}catch(e){return rej(e)}
  const tm=setTimeout(()=>{c.end(true);rej(new Error("timeout "+url))},10000);
  c.once("connect",()=>{clearTimeout(tm);res(c)});
  c.on("error",()=>{});
 });
}
function stopNet(clearRoom){
 clearBotTimers();
 clearInterval(heartbeat);heartbeat=null;
 if(clearRoom&&HR)clients.forEach(c=>{try{c.publish(TOPIC+HR.code+"/k","",{retain:true,qos:1})}catch{}});
 const old=clients;clients=[];setTimeout(()=>old.forEach(c=>{try{c.end(true)}catch{}}),clearRoom?800:0);
 if(pc){try{pc.client.end(true)}catch{}pc=null}
 conns.clear();net.online=false;hostPriv=null;
 if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null}
}
function goHome(){
 if(HR)store.del(roomKey(HR.code));
 stopNet(true);setSession(null);G=null;HR=null;V.state=null;V.secret=null;V.err="";V.me=null;
 history.replaceState(null,"",location.pathname);V.screen="home";render();
}

// Keep the host's screen on: if the host phone sleeps, players can't reach the room.
async function keepAwake(){
 try{if("wakeLock" in navigator&&!wakeLock&&document.visibilityState==="visible"){wakeLock=await navigator.wakeLock.request("screen");wakeLock.addEventListener("release",()=>{wakeLock=null})}}catch{}
}
document.addEventListener("visibilitychange",()=>{if(HR)keepAwake()});

// ----- host side -----
const ALIVE_MS=25000; // a player is shown offline after this long without a message
function sendTo(conn,obj){
 if(!HR)return;
 seal(conn.key,obj).then(s=>{try{conn.client.publish(TOPIC+HR.code+"/p/"+conn.cid,JSON.stringify(s),{qos:1})}catch{}});
}
// Saves the room, sends every player their view, updates the host's own screen.
function hostBroadcast(){
 if(!HR)return;
 store.set(roomKey(HR.code),HR);
 const st=rs.publicState(HR);
 conns.forEach(c=>{if(c.playerId)sendTo(c,{t:"sync",state:st,secret:rs.secretFor(HR,c.playerId)})});
 onHostState(rs.hostView(HR));
 onPhase(st);
 recordHostStats();
 render();
 scheduleBots();
}
function refreshConnected(){
 const now=Date.now();let changed=false;
 HR.players.forEach(p=>{
  const on=!!p.bot||!!p.host||[...conns.values()].some(c=>c.playerId===p.id&&now-c.seen<ALIVE_MS);
  if(p.connected!==on){p.connected=on;changed=true}
 });
 return changed;
}
function bindConn(conn,p){
 // One live connection per player: a reloaded page replaces the old one.
 conns.forEach((c,k)=>{if(c!==conn&&c.playerId===p.id)conns.delete(k)});
 conn.playerId=p.id;p.connected=true;
}
async function onHostMessage(client,payload){
 if(!HR||!hostPriv)return;
 let m;try{m=JSON.parse(payload.toString())}catch{return}
 if(!m||typeof m.c!=="string"||m.c.length>40||typeof m.pub!=="string"||m.pub.length>200)return;
 let conn=conns.get(m.c);
 if(!conn||conn.pub!==m.pub){
  let key;try{key=await derive(hostPriv,m.pub)}catch{return}
  conn={cid:m.c,pub:m.pub,key,client,playerId:null,seen:0};conns.set(m.c,conn);
 }
 let msg;try{msg=await unseal(conn.key,m)}catch{return}
 if(!msg||typeof msg!=="object")return;
 conn.client=client;conn.seen=Date.now();
 const reply=o=>sendTo(conn,o);
 const type={leave:"left",act:"acted",chat:"chatted"}[msg.t]||"joined";
 try{
  if(msg.t==="ping"){
   // Heartbeat; also re-binds a player after the host reloaded the page.
   let p=null;try{p=rs.findPlayer(HR,msg.token)}catch{}
   if(p&&conn.playerId!==p.id){bindConn(conn,p);return hostBroadcast()}
   if(refreshConnected())hostBroadcast();
   return reply({t:"pong"});
  }
  if(msg.t==="join"){
   const {player}=rs.join(HR.code,msg.name);
   bindConn(conn,player);
   reply({t:type,ok:true,token:player.token,playerId:player.id,name:player.name});
  }else if(msg.t==="resume"){
   const p=rs.findPlayer(HR,msg.token);
   bindConn(conn,p);
   reply({t:type,ok:true,playerId:p.id,name:p.name});
  }else if(msg.t==="leave"){
   const p=rs.findPlayer(HR,msg.token);
   rs.remove(HR,p.id);conn.playerId=null;
   reply({t:type,ok:true});
  }else if(msg.t==="act"){
   const p=rs.findPlayer(HR,msg.token);
   rs.setPick(HR,p.id,String(msg.kind||""),msg.target);
   reply({t:type,ok:true});
  }else if(msg.t==="chat"){
   const p=rs.findPlayer(HR,msg.token);
   rs.addChat(HR,p.id,msg.text);
   reply({t:type,ok:true});
  }else return;
  hostBroadcast();
 }catch(e){reply({t:type,ok:false,code:e.code||"error",error:e.message||""})}
}
function hostOnline(){net.online=clients.some(c=>c.connected);render()}
function attachHostClient(c){
 if(!HR){c.end(true);return}
 const code=HR.code;
 const announce=()=>{c.subscribe(TOPIC+code+"/h",{qos:1});c.publish(TOPIC+code+"/k",JSON.stringify({pub:HR.hostKey.pub}),{retain:true,qos:1})};
 announce();
 c.on("connect",()=>{announce();hostOnline()});
 c.on("close",hostOnline);c.on("offline",hostOnline);
 c.on("message",(topic,payload)=>{if(topic===TOPIC+code+"/h")onHostMessage(c,payload)});
 clients.push(c);hostOnline();
}
// Connects to every broker it can; resolves true as soon as one works.
async function startHost(){
 const priv=await crypto.subtle.importKey("jwk",HR.hostKey.priv,ECDH,false,["deriveKey"]);
 hostPriv=priv;
 clearInterval(heartbeat);
 heartbeat=setInterval(()=>{
  if(!HR)return;
  conns.forEach((c,k)=>{if(Date.now()-c.seen>5*60000)conns.delete(k)});
  if(refreshConnected())hostBroadcast();
 },5000);
 keepAwake();
 return new Promise(res=>{
  let left=BROKERS.length,done=false;
  BROKERS.forEach(url=>connectBroker(url).then(c=>{
   if(hostPriv!==priv){c.end(true);return}
   attachHostClient(c);if(!done){done=true;res(true)}
  },()=>{if(--left===0&&!done){done=true;res(false)}}));
 });
}
const ok=(x={})=>({ok:true,...x});
const hostOps={
 async "host:create"(){
  stopNet();
  const room=rs.create();
  const keys=await genKeys();
  room.hostKey={priv:await crypto.subtle.exportKey("jwk",keys.privateKey),pub:await exportPub(keys.publicKey)};
  HR=room;
  if(await startHost()){
   store.set(roomKey(room.code),room);
   return ok({code:room.code,hostToken:room.hostToken,state:rs.hostView(room)});
  }
  stopNet();rs.rooms.delete(room.code);HR=null;
  return {ok:false,error:t("err_net")};
 },
 "host:kick"(d){
  const p=rs.remove(HR,Number(d.playerId));
  if(p)conns.forEach((c,k)=>{if(c.playerId===p.id){sendTo(c,{t:"kicked"});conns.delete(k)}});
  hostBroadcast();return ok();
 },
 "host:start"(){rs.start(HR);G=null;hostBroadcast();return ok()},
 "host:addbot"(){rs.addBot(HR);hostBroadcast();return ok()},
 "host:settings"(d){rs.setSettings(HR,d);hostBroadcast();return ok()},
 "host:hostplayer"(d){rs.setHostPlayer(HR,d.name===null?null:d.name);hostBroadcast();return ok()},
 "host:reset"(){rs.reset(HR);G=null;hostBroadcast();return ok()},
 "host:dead"(d){rs.setDead(HR,Number(d.id),!!d.dead);hostBroadcast();return ok()},
 "host:night"(){rs.resolveNight(HR,k=>G&&G.night[k]!==undefined&&G.night[k]!==""?G.night[k]:null);if(G){G.night={};G.votes={}}saveG();hostBroadcast();return ok()},
 "host:vote"(d){rs.resolveVote(HR,id=>totalVotes(id),!!d.skip);if(G)G.votes={};saveG();hostBroadcast();return ok()},
 "host:timer"(d){if(d.seconds)rs.startTimer(HR,d.label||"disc",d.seconds);else rs.stopTimer(HR);hostBroadcast();return ok()}
};
// Votes = votes from phones + the host's manual correction.
function totalVotes(i){return Math.max(0,(rs.voteTally(HR)[i]||0)+((G&&G.votes[i])||0))}
function saveG(){if(G&&HR)store.set(hostGameKey(HR.code),G)}

// ----- bots (run here, on the host's device) -----
const botTimers=new Map();let botStage="";
function clearBotTimers(){botTimers.forEach(clearTimeout);botTimers.clear()}
// Each living bot makes its move a few seconds into the night / day, like a person would.
function scheduleBots(){
 if(!HR||!HR.started||HR.game.winner)return clearBotTimers();
 const sk=HR.game.round+":"+HR.game.stage;
 if(sk!==botStage){clearBotTimers();botStage=sk}
 HR.players.forEach(p=>{
  if(!p.bot||HR.game.dead[p.id])return;
  Object.keys(rs.actionsFor(HR,p.id)).forEach(kind=>{
   const key=p.id+":"+kind;
   if(botTimers.has(key)||(HR.picks[p.id]&&HR.picks[p.id][kind]!==undefined))return;
   const day=kind==="vote"||kind==="jd";
   const delay=MafiaBots.urgent(rs,HR,p.id,kind)?1500+Math.random()*1500:day?5000+Math.random()*9000:1500+Math.random()*5000;
   botTimers.set(key,setTimeout(()=>{
    if(!HR||HR.game.round+":"+HR.game.stage!==sk)return;
    try{
     const tg=MafiaBots.decide(rs,HR,p.id,kind);
     if(tg!=null){rs.setPick(HR,p.id,kind,tg);hostBroadcast()}
     else if(kind==="jd")setTimeout(()=>{if(botStage===sk)botTimers.delete(key)},3000); // the judge looks again later
    }catch(e){console.warn(e)}
   },delay));
  });
 });
}

// ----- automatic host: ends each phase when everyone is done or time is up -----
setInterval(()=>{
 if(HR&&HR.started&&HR.settings.auto&&!HR.game.winner){
  const tm=HR.game.timer,elapsed=tm?Date.now()-(tm.ends-tm.total*1000):0;
  if(rs.timerExpired(HR)||(elapsed>6000&&rs.phaseDone(HR))){
   if(HR.game.stage==="night")hostOps["host:night"]();else hostOps["host:vote"]({});
  }
 }
 tickTimers();
},1000);

// ---------- timers on every phone ----------
let timerEnd=0,timerKey="",timerBeeped="";
function syncTimer(st){
 const tm=st&&st.game&&st.game.timer;
 if(!tm){timerEnd=0;timerKey="";return}
 const key=st.game.round+st.game.stage+tm.label+tm.total;
 // Keep the local end time stable unless the timer itself changed (avoids jitter on every sync).
 if(key!==timerKey||Math.abs(Date.now()+tm.left-timerEnd)>2500){timerEnd=Date.now()+tm.left;timerKey=key}
}
const fmt=ms=>{const s=Math.ceil(ms/1000);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")};
function tickTimers(){
 if(!timerEnd)return;
 const left=Math.max(0,timerEnd-Date.now());
 document.querySelectorAll(".tmr-val").forEach(el=>{el.textContent=fmt(left)});
 document.querySelectorAll(".tmr-bar").forEach(el=>{el.style.width=(100*left/((el.dataset.total||1)*1000))+"%"});
 if(left===0&&timerBeeped!==timerKey){timerBeeped=timerKey;beep(3);if(navigator.vibrate)navigator.vibrate([200,100,200])}
 else if(left>0&&left<=10000&&timerBeeped!==timerKey&&timerBeeped!==timerKey+"10"){timerBeeped=timerKey+"10";beep(1)}
}

// ---------- sounds ----------
let audio=null;
document.addEventListener("pointerdown",()=>{try{audio=audio||new (window.AudioContext||window.webkitAudioContext)();audio.resume()}catch{}},{passive:true});
function beep(n=1){
 if(!prefs.sound||!audio)return;
 for(let i=0;i<n;i++){
  const o=audio.createOscillator(),g=audio.createGain(),t0=audio.currentTime+i*0.35;
  o.frequency.value=880;g.gain.setValueAtTime(0.0001,t0);g.gain.exponentialRampToValueAtTime(0.3,t0+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t0+0.25);
  o.connect(g).connect(audio.destination);o.start(t0);o.stop(t0+0.3);
 }
}

// ---------- voice narrator (host phone) ----------
// Speaks in the chosen language; if the phone has no Uzbek voice, it speaks Russian instead.
function speak(key,...args){
 if(!prefs.voice||!("speechSynthesis" in window))return;
 const voices=speechSynthesis.getVoices();
 let lang=I18N.lang;
 if(lang==="uz"&&!voices.some(v=>/^uz/i.test(v.lang)))lang="ru";
 const text=I18N.tIn(lang,key,...args).replace(/<[^>]+>/g,"");
 const u=new SpeechSynthesisUtterance(text);
 u.lang=lang==="uz"?"uz-UZ":"ru-RU";
 const v=voices.find(v=>v.lang&&v.lang.toLowerCase().startsWith(lang));if(v)u.voice=v;
 u.rate=0.95;
 speechSynthesis.speak(u);
}
let phaseKey="";
// Called after every host update: announce the new phase once.
function onPhase(st){
 if(!st.started){phaseKey="";return}
 const g=st.game,key=g.round+g.stage+(g.winner||"");
 if(key===phaseKey)return;
 const first=!phaseKey;phaseKey=key;
 if(first&&!(g.round===1&&g.stage==="night"))return; // page reload: stay quiet
 const nm=id=>(st.players.find(p=>p.id===id)||{}).name||"?";
 const n=g.news;
 if(g.stage==="day"&&n&&n.k==="night"){
  speak(n.died.length?"nar_morning_died":"nar_morning_none",n.died.map(nm).join(", "));
 }else if(g.stage==="night"&&n&&n.k==="day"){
  speak(n.pardoned?"nar_pardoned":n.out!==null?"nar_exiled":"nar_no_exile",nm(n.out!==null?n.out:n.pardoned));
 }
 if(g.winner)speak("win_"+g.winner);
 else if(g.stage==="night")speak("nar_night");
 beep(1);
}

// ---------- stats (kept on this phone) ----------
const STATS_KEY="mafia:stats";
const sideOf=role=>isMafia(role)?"maf":role==="man"?"man":"civ";
function loadStats(){const s=store.get(STATS_KEY)||{};return {games:s.games||[],mine:s.mine||[]}}
function saveStats(s){s.games=s.games.slice(-200);s.mine=s.mine.slice(-200);store.set(STATS_KEY,s)}
// The host's phone records every finished game with everyone's role.
function recordHostStats(){
 if(!HR||!HR.started||!HR.game.winner||HR.game.statsSaved)return;
 HR.game.statsSaved=true;
 const s=loadStats(),w=HR.game.winner;
 s.games.push({ts:Date.now(),winner:w,rounds:HR.game.round,players:HR.players.map(p=>({name:p.name,role:HR.roles[p.id],won:sideOf(HR.roles[p.id])===w,bot:!!p.bot,alive:!HR.game.dead[p.id]}))});
 if(HR.hostPlayerId!==null){const r=HR.roles[HR.hostPlayerId];s.mine.push({ts:Date.now(),role:r,won:sideOf(r)===w,winner:w})}
 saveStats(s);
}
// Each player's phone records their own results.
let lastMineKey="";
function recordPlayerStats(){
 const st=V.state,sec=V.secret;
 if(!st||!st.started||!st.game.winner||!sec)return;
 const key=st.code+":"+st.game.round+":"+sec.role+":"+st.game.winner;
 const done=store.get("mafia:lastgame");
 if(key===lastMineKey||done===key)return;
 lastMineKey=key;store.set("mafia:lastgame",key);
 const s=loadStats();s.mine.push({ts:Date.now(),role:sec.role,won:sideOf(sec.role)===st.game.winner,winner:st.game.winner});saveStats(s);
}

// ----- player side -----
let pending=null; // {type, resolve}
// Tries all brokers at once; uses the first one where the host's room is announced.
function findHost(code){
 return new Promise((res,rej)=>{
  let left=BROKERS.length,done=false,sawBroker=false;
  const fail=()=>{if(--left===0&&!done){done=true;rej(new Error(t(sawBroker?"err_host_offline":"err_net")))}};
  BROKERS.forEach(url=>connectBroker(url).then(c=>{
   if(done){c.end(true);return}
   sawBroker=true;
   const kt=TOPIC+code+"/k";
   const tm=setTimeout(()=>{c.end(true);fail()},8000);
   const first=(topic,payload)=>{
    if(topic!==kt)return;
    let pub=null;try{pub=JSON.parse(payload.toString()).pub}catch{}
    clearTimeout(tm);c.removeListener("message",first);
    if(done||!pub){c.end(true);if(!pub)fail();return}
    done=true;res({client:c,hostPub:pub});
   };
   c.on("message",first);
   c.subscribe(kt,{qos:1});
  },fail));
 });
}
async function playerConnect(code){
 if(pc&&pc.code===code&&pc.client.connected)return pc;
 if(pc){try{pc.client.end(true)}catch{}pc=null}
 const {client,hostPub}=await findHost(code);
 const keys=await genKeys();
 const me={client,code,cid:randHex(10),pub:await exportPub(keys.publicKey),priv:keys.privateKey,key:await derive(keys.privateKey,hostPub),hostPub};
 const pt=TOPIC+code+"/p/"+me.cid,kt=TOPIC+code+"/k";
 client.subscribe(pt,{qos:1});
 client.on("message",async(topic,payload)=>{
  if(pc!==me)return;
  if(topic===kt){ // host re-announced (same key after a reload); empty means the room was closed
   let pub=null;try{pub=JSON.parse(payload.toString()).pub}catch{}
   if(!pub){net.online=false;V.err=t("err_host_closed");render()}
   return;
  }
  if(topic!==pt)return;
  let msg;try{msg=await unseal(me.key,JSON.parse(payload.toString()))}catch{return}
  onPlayerMessage(msg);
 });
 client.on("close",()=>{if(pc===me){net.online=false;render()}});
 pc=me;
 startPlayerHeartbeat();
 return me;
}
function playerSend(obj){
 if(!pc)return false;
 seal(pc.key,obj).then(s=>{try{pc.client.publish(TOPIC+pc.code+"/h",JSON.stringify({c:pc.cid,pub:pc.pub,...s}),{qos:1})}catch{}});
 return true;
}
let playerPhase="";
function onPlayerMessage(msg){
 if(!msg||typeof msg!=="object")return;
 lastHeard=Date.now();
 if(!net.online){net.online=true;V.err="";render()}
 if(pending&&msg.t===pending.type){const p=pending;pending=null;p.resolve(msg);return}
 if(msg.t==="sync"){
  V.state=msg.state;if(!msg.secret)V.showRole=false;V.secret=msg.secret;
  syncTimer(V.state);
  const g=V.state.game,k=V.state.started?g.round+g.stage+g.winner:"";
  if(playerPhase&&k!==playerPhase){beep(1);if(navigator.vibrate)navigator.vibrate(200)}
  playerPhase=k;
  recordPlayerStats();
  if(!isTyping())render();
 }
 else if(msg.t==="kicked"){stopNet();setSession(null);V.screen="kicked";render()}
}
// Don't redraw while someone types in the chat box (it would lose focus).
const isTyping=()=>document.activeElement&&document.activeElement.id==="chatin"&&document.activeElement.value;
function startPlayerHeartbeat(){
 clearInterval(heartbeat);
 heartbeat=setInterval(()=>{
  if(!pc||V.session?.kind!=="player")return;
  playerSend({t:"ping",token:V.session.token});
  if(net.online&&Date.now()-lastHeard>ALIVE_MS){net.online=false;render()}
 },8000);
}
function request(msg,type){
 return new Promise(res=>{
  const tm=setTimeout(()=>{if(pending&&pending.type===type)pending=null;res({ok:false,error:t("err_host_silent")})},12000);
  pending={type,resolve:r=>{clearTimeout(tm);res(r)}};
  if(!playerSend(msg)){clearTimeout(tm);pending=null;res({ok:false,error:t("err_no_host_link")})}
 });
}
async function playerResume(retry=3000){
 const s=V.session;if(!s||s.kind!=="player")return;
 try{await playerConnect(s.code)}catch(e){V.err=e.message;render();return setTimeout(()=>playerResume(Math.min(retry*1.5,15000)),retry)}
 const r=await request({t:"resume",token:s.token},"joined");
 if(r.ok){V.me={id:r.playerId,name:r.name};net.online=true;lastHeard=Date.now();V.err="";V.screen="player";render();return}
 if(r.code==="no_player"||r.code==="no_room"){stopNet();setSession(null);V.screen="join";V.err=t("err_not_in_room");return render()}
 V.err=errText(r);render();setTimeout(()=>playerResume(Math.min(retry*1.5,15000)),retry);
}
const isHostPlayer=()=>V.session?.kind==="host"&&HR&&HR.hostPlayerId!==null;
const playerOps={
 async "player:join"(d){
  try{await playerConnect(d.code)}catch(e){return {ok:false,error:e.message}}
  const r=await request({t:"join",name:d.name},"joined");
  if(r.ok){net.online=true;lastHeard=Date.now()}
  return r;
 },
 // The host who plays acts directly on the room; other players send a message.
 async "player:act"(d){
  if(isHostPlayer()){rs.setPick(HR,HR.hostPlayerId,d.kind,d.target);hostBroadcast();return ok()}
  return request({t:"act",token:V.session.token,kind:d.kind,target:d.target},"acted");
 },
 async "player:chat"(d){
  if(isHostPlayer()){rs.addChat(HR,HR.hostPlayerId,d.text);hostBroadcast();return ok()}
  return request({t:"chat",token:V.session.token,text:d.text},"chatted");
 },
 async "player:leave"(d){if(pc)await request({t:"leave",token:d.token},"left");return ok()}
};

async function emit(ev,data){
 const fn=hostOps[ev]||playerOps[ev];
 if(!fn)return {ok:false,error:"unknown"};
 try{return await fn(data||{})}catch(e){return {ok:false,code:e.code,error:e.message||t("err_generic")}}
}

// The host keeps G (UI-only state) per deal.
function onHostState(st){
 V.state=st;
 syncTimer(st);
 if(!st.started){G=null;store.del(hostGameKey(st.code));return}
 const key=st.roles.map(r=>r.id+r.role).join(",");
 if(!G||G.key!==key){
  const saved=store.get(hostGameKey(st.code));
  G=saved&&saved.key===key&&saved.night?saved:{key,votes:{},night:{},showRoles:false};
 }
}

// ---------- startup ----------
async function boot(){
 if("serviceWorker" in navigator&&location.protocol!=="file:")navigator.serviceWorker.register("sw.js").catch(()=>{});
 const s=V.session;
 if(s&&(!urlRoom||urlRoom===s.code)){
  if(s.kind==="host"){
   const saved=store.get(roomKey(s.code));
   if(saved&&saved.hostToken===s.token&&saved.hostKey){
    HR=rs.restore(saved);onHostState(rs.hostView(HR));phaseKey="";onPhase(rs.publicState(HR));V.screen="host";render();
    if(!await startHost()){V.err=t("err_net_restore");render()}
    return;
   }
  }else{V.screen="player";render();return playerResume()}
  setSession(null);
 }
 V.screen=urlRoom?"join":"home";render();
}
