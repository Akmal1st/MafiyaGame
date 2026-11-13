// Run by hand: npm i --no-save aedes@0.51.3 ws@8.18.0 mqtt@5.10.4 playwright && node test/join.sim.js .
// (not part of npm test: it needs a browser and local brokers)
// Join robustness simulation: 3 local MQTT-over-WebSocket brokers + host/player pages in Chromium.
const http=require("http"),fs=require("fs"),path=require("path"),ws=require("ws");
const {chromium}=require("playwright");
const ROOT=process.argv[2];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function broker(port){
 const b={port,url:`ws://127.0.0.1:${port}`,up:false,socks:new Set()};
 b.start=()=>new Promise(res=>{
  b.aedes=require("aedes")();b.server=http.createServer();
  b.wss=new ws.WebSocketServer({server:b.server});
  b.wss.on("connection",(s,req)=>{b.socks.add(s);s.on("close",()=>b.socks.delete(s));b.aedes.handle(ws.createWebSocketStream(s),req)});
  b.server.listen(port,()=>{b.up=true;res()});
 });
 b.stop=()=>new Promise(res=>{b.socks.forEach(s=>s.terminate());b.wss.close();b.aedes.close();b.server.close(()=>{b.up=false;res()})});
 return b;
}
const B=[broker(18831),broker(18832),broker(18833)];
const types={".html":"text/html",".js":"text/javascript",".json":"application/json",".webmanifest":"application/json",".png":"image/png"};
const web=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split("?")[0]);if(p.endsWith("/"))p+="index.html";
 fs.readFile(path.join(ROOT,p),(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{"content-type":types[path.extname(p)]||"application/octet-stream"});r.end(d)})});
const SITE="http://127.0.0.1:18830/";
let browser,fails=0;
async function ctx(brokers){
 const c=await browser.newContext({serviceWorkers:"block"});
 await c.addInitScript(`window.MAFIA_MQTT=${JSON.stringify(brokers.map(b=>b.url))};localStorage.setItem("mafia:lang",JSON.stringify("ru"));`);
 return c;
}
const ev=(p,f,a)=>p.evaluate(f,a);
async function until(p,f,ms,label,arg){
 const t0=Date.now();
 while(Date.now()-t0<ms){try{if(await p.evaluate(f,arg))return Date.now()-t0}catch{}await sleep(250)}
 throw new Error("timeout: "+label);
}
async function check(name,fn){
 const t0=Date.now();
 try{await fn();console.log("PASS",name,((Date.now()-t0)/1000).toFixed(1)+"s")}catch(e){fails++;console.log("FAIL",name,e.message)}
}
async function newHost(brokers){
 const c=await ctx(brokers),p=await c.newPage();
 p.on("pageerror",e=>console.log("  host pageerror",e.message));
 await p.goto(SITE);
 await until(p,()=>V.screen==="home",10000,"home");
 const r=await ev(p,async()=>{const r=await emit("host:create",{});if(r.ok){setSession({kind:"host",code:r.code,token:r.hostToken});onHostState(r.state);V.screen="host";render()}return r});
 if(!r.ok)throw new Error("create failed "+JSON.stringify(r));
 return {c,p,code:r.code};
}
async function newPlayer(brokers,code,name,ms=25000){
 const c=await ctx(brokers),p=await c.newPage();
 p.on("pageerror",e=>console.log("  player pageerror",e.message));
 await p.goto(SITE+"?room="+code);
 await until(p,()=>V.screen==="join",10000,"join screen");
 await p.fill("#nm",name);await p.click("#jn");
 await until(p,()=>V.screen==="player"&&V.state&&V.me,ms,"joined "+name);
 return {c,p};
}
const names=h=>ev(h.p,()=>V.state.players.map(p=>p.name+(p.connected?"+":"-")));
(async()=>{
 await new Promise(r=>web.listen(18830,r));
 await B[0].start();await B[1].start();
 browser=await chromium.launch();
 let host;
 await check("host creates room while broker 3 is down",async()=>{host=await newHost(B);});
 await check("player on all brokers joins",async()=>{await newPlayer(B,host.code,"Ali")});
 await check("player who reaches only broker 3 joins once it comes up (host keeps retrying)",async()=>{
  const pr=newPlayer([B[2]],host.code,"Vali",40000);
  await sleep(3000);await B[2].start();
  await pr;
 });
 await check("broker forgot the retained room: player still finds it by asking",async()=>{
  const mqtt=require("mqtt");const c=mqtt.connect(B[1].url);
  await new Promise(r=>c.on("connect",r));
  await new Promise(r=>c.publish("mafiyagame/v1/"+host.code+"/k","",{retain:true,qos:1},r));c.end();
  await newPlayer([B[1]],host.code,"Gani");
 });
 let ali;
 await check("wrong code shows 'room not found' with the code",async()=>{
  const c=await ctx(B),p=await c.newPage();await p.goto(SITE+"?room=ZZZZZ");
  await until(p,()=>V.screen==="join",10000,"join");
  await p.fill("#nm","X");await p.click("#jn");
  await until(p,()=>V.err&&V.err.includes("ZZZZZ"),25000,"room missing error");
  console.log("  ",await ev(p,()=>V.err));await c.close();
 });
 await check("failover: player keeps playing when its broker dies",async()=>{
  ali=await newPlayer([B[0],B[1]],host.code,"Bobur");
  await B[0].stop();
  await sleep(12000);
  await ev(host.p,()=>emit("host:notice",{text:"salom"}));
  await until(ali.p,()=>V.state.notice&&V.state.notice.text==="salom",15000,"notice via broker 2");
  await B[0].start();
 });
 await check("host page closed: saved player sees 'host away', then reconnects when host returns",async()=>{
  console.log("   players:",(await names(host)).join(" "));
  await host.p.close();
  await sleep(1500);
  await ali.p.reload();
  await until(ali.p,()=>V.screen==="player"&&!V.state&&document.querySelector("#lretry"),30000,"loading screen with retry");
  console.log("  ",await ev(ali.p,()=>document.querySelector(".err").textContent));
  const hp=await host.c.newPage();host.p=hp;await hp.goto(SITE);
  await until(hp,()=>V.screen==="host"&&net.online,15000,"host restored");
  await until(ali.p,()=>V.state&&V.me&&net.online,30000,"player back in room");
 });
 await check("host closes room: stale player can leave with one tap",async()=>{
  await ev(host.p,()=>goHome());await sleep(1000);
  await ali.p.reload();
  await until(ali.p,()=>document.querySelector("#lhome")&&document.querySelector(".err"),30000,"error+leave button");
  console.log("  ",await ev(ali.p,()=>document.querySelector(".err").textContent));
  await ali.p.click("#lhome");
  await until(ali.p,()=>V.screen==="home"&&!V.session,5000,"home");
 });
 await browser.close();await Promise.all(B.filter(b=>b.up).map(b=>b.stop()));web.close();
 console.log(fails?`${fails} FAILED`:"ALL PASSED");process.exit(fails?1:0);
})();
