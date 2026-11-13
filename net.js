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
const prefs=Object.assign({voice:true,sound:true,vibe:true},store.get("mafia:prefs")||{});
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
let HR=null,hostPriv=null,clients=[],heartbeat=null,wakeLock=null,lastHeard=0,hostRetry=[];
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
// Topics of a room: k = host key (retained), a = host online "1"/"0" (retained, "0" is the host's last will),
// q = a player asks the host to announce itself again, h = to the host, p/<cid> = to one player.
const topic=(code,x)=>TOPIC+code+"/"+x;
function connectBroker(url,will){
 return new Promise((res,rej)=>{
  let c;
  try{c=mqtt.connect(url,{clientId:"mf_"+randHex(8),clean:true,connectTimeout:8000,reconnectPeriod:3000,keepalive:30,will})}catch(e){return rej(e)}
  const tm=setTimeout(()=>{c.end(true);rej(new Error("timeout "+url))},10000);
  c.once("connect",()=>{clearTimeout(tm);res(c)});
  c.on("error",()=>{});
 });
}
function stopNet(clearRoom){
 clearBotTimers();
 clearInterval(heartbeat);heartbeat=null;
 hostRetry.forEach(clearTimeout);hostRetry=[];
 if(clearRoom&&HR)clients.forEach(c=>{try{c.publish(topic(HR.code,"k"),"",{retain:true,qos:1});c.publish(topic(HR.code,"a"),"",{retain:true,qos:1})}catch{}});
 const old=clients;clients=[];setTimeout(()=>old.forEach(c=>{try{c.end(true)}catch{}}),clearRoom?800:0);
 playerClose();
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
// A phone that comes back from the background (or back online) reconnects at once instead of waiting.
function wakeNet(){
 clients.forEach(c=>{if(!c.connected&&!c.disconnecting)try{c.reconnect()}catch{}});
 P.pool.forEach(b=>{if(!b.client.connected&&!b.client.disconnecting)try{b.client.reconnect()}catch{}});
 if(HR)announceAll();
 if(P.code)probe();
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){if(HR)keepAwake();wakeNet()}});
window.addEventListener("online",wakeNet);

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
function hostOnline(){
 net.online=clients.some(c=>c.connected);
 if(net.online&&V.err===t("err_net_restore"))V.err="";
 render();
}
// The room key and "host is online" are retained, so a player who opens the link later still finds them.
// They are sent again every 30 s and whenever a player asks, because a public broker may forget them.
function announce(c){
 if(!HR||!c.connected)return;
 try{
  c.publish(topic(HR.code,"k"),JSON.stringify({pub:HR.hostKey.pub}),{retain:true,qos:1});
  c.publish(topic(HR.code,"a"),"1",{retain:true,qos:1});
 }catch{}
}
function announceAll(){clients.forEach(announce)}
function attachHostClient(c){
 if(!HR){c.end(true);return}
 const code=HR.code;let lastAsk=0;
 const up=()=>{c.subscribe([topic(code,"h"),topic(code,"q")],{qos:1});announce(c)};
 up();
 c.on("connect",()=>{up();hostOnline()});
 c.on("close",hostOnline);c.on("offline",hostOnline);
 c.on("message",(tp,payload)=>{
  if(tp===topic(code,"h"))onHostMessage(c,payload);
  else if(tp===topic(code,"q")&&Date.now()-lastAsk>2000){lastAsk=Date.now();announce(c)}
 });
 clients.push(c);hostOnline();
}
// Connects to every broker it can and keeps retrying the ones that failed, so a player whose
// network reaches only one of them still finds the room. Resolves true as soon as one works.
async function startHost(){
 const priv=await crypto.subtle.importKey("jwk",HR.hostKey.priv,ECDH,false,["deriveKey"]);
 hostPriv=priv;
 clearInterval(heartbeat);
 let beats=0;
 heartbeat=setInterval(()=>{
  if(!HR)return;
  conns.forEach((c,k)=>{if(Date.now()-c.seen>5*60000)conns.delete(k)});
  if(++beats%6===0)announceAll();
  if(refreshConnected())hostBroadcast();
 },5000);
 keepAwake();
 const will={topic:topic(HR.code,"a"),payload:"0",retain:true,qos:1};
 return new Promise(res=>{
  let left=BROKERS.length,done=false;
  const attempt=(url,first)=>connectBroker(url,will).then(c=>{
   if(hostPriv!==priv){c.end(true);return}
   attachHostClient(c);if(!done){done=true;res(true)}
  },()=>{
   if(first&&--left===0&&!done){done=true;res(false)}
   if(hostPriv===priv)hostRetry.push(setTimeout(()=>{if(hostPriv===priv)attempt(url,false)},15000));
  });
  BROKERS.forEach(url=>attempt(url,true));
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
 "host:timer"(d){if(d.seconds)rs.startTimer(HR,d.label||"disc",d.seconds);else rs.stopTimer(HR);hostBroadcast();return ok()},
 "host:extend"(d){rs.extendTimer(HR,d.seconds||30);timerBeeped="";hostBroadcast();return ok()},
 "host:nudge"(){const n=rs.nudge(HR);hostBroadcast();return ok({n})},
 "host:notice"(d){rs.announce(HR,d.text);hostBroadcast();return ok()}
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
     else if(kind==="jd"||kind==="vote")setTimeout(()=>{if(botStage===sk){botTimers.delete(key);scheduleBots()}},3000); // looks again later (a bot that held back its vote, the judge)
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
 if(left===0&&timerBeeped!==timerKey){timerBeeped=timerKey;beep(3);vibe([200,100,200])}
 else if(left>0&&left<=10000&&timerBeeped!==timerKey&&timerBeeped!==timerKey+"10"){timerBeeped=timerKey+"10";beep(1)}
}

// ---------- sounds, vibration, pop-up messages ----------
function vibe(p){if(prefs.vibe&&navigator.vibrate)try{navigator.vibrate(p)}catch{}}
let toastEl=null,toastTm=null;
function toast(text){
 if(!toastEl){toastEl=document.createElement("div");toastEl.className="toast";toastEl.setAttribute("role","status");document.body.appendChild(toastEl)}
 toastEl.textContent=text;toastEl.classList.add("on");
 clearTimeout(toastTm);toastTm=setTimeout(()=>toastEl.classList.remove("on"),3500);
}
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
// Always speaks in the app's language. Phones rarely ship an Uzbek voice, so Uzbek text is read by a
// Turkish voice (close pronunciation, spelling adapted), or by the phone's default voice if there is none.
let voiceList=[];
const loadVoices=()=>{try{voiceList=speechSynthesis.getVoices()}catch{}};
if("speechSynthesis" in window){loadVoices();speechSynthesis.addEventListener?.("voiceschanged",loadVoices)}
const findVoice=p=>voiceList.find(v=>v.lang&&v.lang.toLowerCase().replace("_","-").startsWith(p));
// Uzbek texts use the new alphabet (ö, ğ, ş, ç). Voices are trained on the old spelling, so convert back for them.
const uzOld=s=>s.replace(/Ö/g,"Oʻ").replace(/ö/g,"oʻ").replace(/Ğ/g,"Gʻ").replace(/ğ/g,"gʻ").replace(/Ş/g,"Sh").replace(/ş/g,"sh").replace(/Ç/g,"Ch").replace(/ç/g,"ch");
// Uzbek spelled the way a Turkish voice reads it (ş, ç, ğ are the same letters).
const uzForTurkish=s=>s.replace(/[ʻʼ‘’`']/g,"").replace(/Ö/g,"O").replace(/ö/g,"o")
 .replace(/j/g,"c").replace(/J/g,"C").replace(/q/g,"k").replace(/Q/g,"K").replace(/x/g,"h").replace(/X/g,"H");
function speak(key,...args){
 if(!prefs.voice||!("speechSynthesis" in window))return;
 if(!voiceList.length)loadVoices();
 const lang=I18N.lang;
 let text=I18N.tIn(lang,key,...args).replace(/<[^>]+>/g,"").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu,"").trim();
 const u=new SpeechSynthesisUtterance();
 let v=findVoice(lang);
 if(lang==="uz"){const tr=!v&&findVoice("tr");if(tr){v=tr;text=uzForTurkish(text)}else text=uzOld(text)}
 u.text=text;
 u.lang=v?v.lang:lang==="uz"?"uz-UZ":"ru-RU";
 if(v)u.voice=v;
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
// The player stays connected to every broker it can reach and listens for the room on all of them.
// Messages go to the host through the best broker right now (connected, room announced, host online),
// so if one broker drops or the host is reachable only through another one, the player just switches.
let pending=null; // {type, resolve}
const P={code:null,pool:new Map(),hostPub:null,key:null,cid:null,pub:null,priv:null,closed:false,waiters:[]};
function playerClose(){
 P.pool.forEach(b=>{try{b.client.end(true)}catch{}});
 P.pool.clear();P.code=null;P.hostPub=null;P.key=null;P.closed=false;
 P.waiters.splice(0).forEach(w=>w());
}
function probe(){P.pool.forEach(b=>{if(b.client.connected)try{b.client.publish(topic(P.code,"q"),"1",{qos:0})}catch{}})}
async function setHostKey(pub){
 if(P.hostPub===pub&&P.key)return;
 const key=await derive(P.priv,pub);
 P.hostPub=pub;P.key=key;P.closed=false;
 P.waiters.splice(0).forEach(w=>w());
}
function openBroker(url){
 const code=P.code,b={url,client:null,hostPub:null,alive:null,ever:false};
 const kt=topic(code,"k"),at=topic(code,"a"),pt=topic(code,"p/"+P.cid);
 try{b.client=mqtt.connect(url,{clientId:"mf_"+randHex(8),clean:true,connectTimeout:8000,reconnectPeriod:4000,keepalive:30})}catch{return}
 const c=b.client;
 c.on("error",()=>{});
 c.on("connect",()=>{
  b.ever=true;
  c.subscribe([kt,at,pt],{qos:1},()=>{try{c.publish(topic(code,"q"),"1",{qos:0})}catch{}});
 });
 c.on("close",()=>{if(P.code===code)playerLink()});
 c.on("message",async(tp,payload)=>{
  if(P.code!==code)return;
  const txt=payload.toString();
  if(tp===kt){
   let pub=null;try{pub=JSON.parse(txt).pub}catch{}
   b.hostPub=pub;
   if(pub)await setHostKey(pub);
   else if(!payload.length&&![...P.pool.values()].some(x=>x.hostPub)){P.closed=true;P.waiters.splice(0).forEach(w=>w())}
   return playerLink();
  }
  if(tp===at){b.alive=txt==="1"?true:txt==="0"?false:null;return playerLink()}
  if(tp!==pt||!P.key)return;
  let msg;try{msg=await unseal(P.key,JSON.parse(txt))}catch{return}
  onPlayerMessage(msg);
 });
 P.pool.set(url,b);
}
// Best broker to reach the host now, or null.
function bestBroker(){
 let best=null,score=0;
 P.pool.forEach(b=>{
  if(!b.client.connected||!b.hostPub||b.hostPub!==P.hostPub)return;
  const s=b.alive===false?1:b.alive===true?3:2;
  if(s>score){score=s;best=b}
 });
 return best;
}
// Why the host can't be reached, as a translated message.
function linkProblem(){
 const bs=[...P.pool.values()];
 if(P.closed)return t("err_host_closed");
 if(!bs.some(b=>b.client.connected))return t(bs.some(b=>b.ever)?"err_net_lost":"err_net");
 if(!P.key)return t("err_room_missing",P.code);
 if(!bestBroker())return t("err_net_lost");
 if(bestBroker().alive===false)return t("err_host_away");
 return "";
}
// Shows the current link state on the player's screen.
function playerLink(){
 if(V.session?.kind!=="player"&&V.screen!=="join")return;
 if(V.screen==="player"&&V.me&&net.online)return;
 const e=linkProblem();
 if(V.screen==="player"&&!V.me&&e&&V.err!==e){V.err=e;render()}
}
// Opens (or reuses) the connections for a room and waits up to `ms` until the host's room is found.
function playerConnect(code,ms=15000){
 if(P.code!==code){
  playerClose();
  P.code=code;
 }
 return (async()=>{
  if(!P.priv){const keys=await genKeys();P.priv=keys.privateKey;P.pub=await exportPub(keys.publicKey);P.cid=randHex(10)}
  if(P.code!==code)throw new Error(t("err_generic"));
  if(!P.pool.size)BROKERS.forEach(openBroker);
  else{wakeNet()}
  startPlayerHeartbeat();
  const ready=()=>P.key&&bestBroker();
  if(ready())return true;
  await new Promise(res=>{
   const tm=setTimeout(done,ms),iv=setInterval(()=>{if(ready()||P.closed)done()},300);
   function done(){clearTimeout(tm);clearInterval(iv);res()}
   P.waiters.push(()=>{if(P.closed)done()});
  });
  if(ready())return true;
  throw new Error(linkProblem()||t("err_room_missing",code));
 })();
}
function playerSend(obj){
 const b=bestBroker();
 if(!b||!P.key)return false;
 const code=P.code;
 seal(P.key,obj).then(s=>{try{b.client.publish(topic(code,"h"),JSON.stringify({c:P.cid,pub:P.pub,...s}),{qos:1})}catch{}});
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
  if(playerPhase&&k!==playerPhase){beep(1);vibe(200)}
  playerPhase=k;
  playerAlerts();
  recordPlayerStats();
  render();
 }
 else if(msg.t==="kicked"){stopNet();setSession(null);V.screen="kicked";render()}
}
// A new announcement from the host or a reminder ("your turn") makes the phone ring once.
let seenNotice=null,seenNudge=null;
function playerAlerts(){
 const st=V.state,n=st.notice,nid=n?n.id:0,nudge=(V.secret&&V.secret.nudge)||0;
 if(seenNotice!==null&&nid&&nid!==seenNotice){beep(2);vibe([150,80,150]);toast("📢 "+n.text)}
 if(seenNudge!==null&&nudge>seenNudge){beep(2);vibe([300,120,300]);toast(t("nudge_got"))}
 seenNotice=nid;seenNudge=nudge;
}
function startPlayerHeartbeat(){
 clearInterval(heartbeat);
 heartbeat=setInterval(()=>{
  if(!P.code||V.session?.kind!=="player")return;
  if(!playerSend({t:"ping",token:V.session.token})||!net.online)probe();
  if(net.online&&Date.now()-lastHeard>ALIVE_MS){net.online=false;render()}
 },8000);
}
function request(msg,type){
 return new Promise(res=>{
  const tm=setTimeout(()=>{if(pending&&pending.type===type)pending=null;res({ok:false,error:linkProblem()||t("err_host_silent")})},12000);
  pending={type,resolve:r=>{clearTimeout(tm);res(r)}};
  if(!playerSend(msg)){clearTimeout(tm);pending=null;res({ok:false,error:linkProblem()||t("err_no_host_link")})}
 });
}
// Reconnects a saved player to their room. Keeps trying (listening on every broker) until the host is back;
// the player can also press "Try again" or leave.
let resumeRun=0;
async function playerResume(retry=3000){
 const s=V.session;if(!s||s.kind!=="player")return;
 const run=++resumeRun;
 const again=()=>setTimeout(()=>{if(run===resumeRun)playerResume(Math.min(retry*1.5,15000))},retry);
 try{await playerConnect(s.code)}catch(e){if(run!==resumeRun)return;V.err=e.message;render();return again()}
 if(run!==resumeRun)return;
 const r=await request({t:"resume",token:s.token},"joined");
 if(run!==resumeRun)return;
 if(r.ok){V.me={id:r.playerId,name:r.name};net.online=true;lastHeard=Date.now();V.err="";V.screen="player";render();return}
 if(r.code==="no_player"||r.code==="no_room"){stopNet();setSession(null);V.screen="join";V.err=t("err_not_in_room");return render()}
 V.err=errText(r);render();again();
}
function playerRetry(){V.err=t("connecting");render();wakeNet();playerResume()}
// Banner text for a player who lost the host during the game.
function playerBanner(){return (P.code&&linkProblem())||t("banner_player")}
const isHostPlayer=()=>V.session?.kind==="host"&&HR&&HR.hostPlayerId!==null;
const playerOps={
 async "player:join"(d){
  try{await playerConnect(d.code)}catch(e){playerClose();return {ok:false,error:e.message}}
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
 async "player:leave"(d){if(P.key)await request({t:"leave",token:d.token},"left");return ok()}
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
