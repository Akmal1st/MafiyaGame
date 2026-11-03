// User interface. State and networking live in net.js.

// ---------- rendering ----------
function render(){
 const off=!net.online&&(V.screen==="host"||V.screen==="player")?`<div class="banner">${t(V.screen==="host"?"banner_host":"banner_player")}</div>`:"";
 const screens={loading,home,join,player,host,kicked,stats};
 const y=scrollY;
 const langs=`<div class="lang">${I18N.LANGS.map(l=>`<button data-lang="${l}" class="${I18N.lang===l?"on":""}">${l.toUpperCase()}</button>`).join("")}</div>`;
 app.innerHTML=langs+off+(screens[V.screen]||home)();
 app.querySelectorAll("[data-lang]").forEach(b=>b.onclick=()=>{I18N.setLang(b.dataset.lang);V.err="";render()});
 bind[V.screen]?.();
 bindCommon();
 tickTimers();
 scrollTo(0,y);
}
const bind={};
const sub=(k,...a)=>`<p class="sub" style="text-align:left;margin:6px 0 10px">${t(k,...a)}</p>`;

function loading(){return `<h1>🎭 ${t("mafia")}</h1><p class="sub">${t("connecting")}</p>${V.err?`<p class="err center">${esc(V.err)}</p>`:""}<p class="sub"><a href="#" id="lhome">${t("to_home")}</a></p>`}
bind.loading=()=>{const l=$("lhome");if(l)l.onclick=e=>{e.preventDefault();goHome()}};

// ---------- home ----------
let installPrompt=null;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;if(V.screen==="home")render()});
const standalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone;
function home(){
 const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
 return `
 <h1>🎭 ${t("title")}</h1><p class="sub">${t("tagline")}</p>
 <div class="card"><b>${t("i_host")}</b>${sub("i_host_sub")}
  <button class="big" id="create">${t("create")}</button></div>
 <div class="card"><b>${t("i_player")}</b>${sub("i_player_sub")}
  <div class="row"><input id="code" class="code" maxlength="5" placeholder="${t("code_ph")}" autocomplete="off"><button id="go">${t("enter")}</button></div>
  <div class="err">${esc(V.err)}</div></div>
 <button class="sec big" id="stats">${t("stats_btn")}</button>
 ${!standalone()&&(installPrompt||ios)?`<div class="card mt">${installPrompt?`<button class="big" id="install">${t("install")}</button>`:`<b>${t("install")}</b>${sub("install_ios")}`}</div>`:""}
 <p class="sub mt"><a href="offline.html">${t("offline_link")}</a></p>`}
bind.home=()=>{
 $("create").onclick=async e=>{
  e.target.disabled=true;
  const r=await emit("host:create",{});
  if(!r.ok){V.err=errText(r);return render()}
  setSession({kind:"host",code:r.code,token:r.hostToken});
  history.replaceState(null,"",location.pathname);
  onHostState(r.state);V.err="";V.screen="host";render();
 };
 const go=()=>{const c=$("code").value.trim().toUpperCase();if(c.length<4)return;location.href=location.pathname+"?room="+encodeURIComponent(c)};
 $("go").onclick=go;$("code").onkeydown=e=>{if(e.key==="Enter")go()};
 $("stats").onclick=()=>{V.screen="stats";render()};
 const ins=$("install");if(ins)ins.onclick=async()=>{installPrompt.prompt();await installPrompt.userChoice.catch(()=>{});installPrompt=null;render()};
};

function join(){return `
 <h1>🎭 ${t("mafia")}</h1><p class="sub">${t("room_n",esc(urlRoom))}</p>
 <div class="card"><b>${t("your_name")}</b>
  <div class="row mt"><input id="nm" placeholder="${t("name_ph")}" maxlength="20" autocomplete="off"><button id="jn">${t("enter")}</button></div>
  <div class="err">${esc(V.err)}</div></div>
 <p class="sub"><a href="./">${t("to_home")}</a></p>`}
bind.join=()=>{
 const inp=$("nm");inp.focus();
 const j=async()=>{
  const name=inp.value.trim();if(!name)return;
  $("jn").disabled=true;
  const r=await emit("player:join",{code:urlRoom,name});
  if(!r.ok){V.err=errText(r);render();$("nm").value=name;return}
  setSession({kind:"player",code:urlRoom,token:r.token});
  V.me={id:r.playerId,name};V.secret=null;V.err="";V.screen="player";render();
 };
 $("jn").onclick=j;inp.onkeydown=e=>{if(e.key==="Enter")j()};
};

function kicked(){return `<h1>🚪</h1><p class="sub">${t("kicked")}</p><button class="big" id="home">${t("to_home")}</button>`}
bind.kicked=()=>{$("home").onclick=goHome};

// ---------- stats ----------
function stats(){
 const s=loadStats(),g=s.games,m=s.mine;
 const sides={civ:0,maf:0,man:0};g.forEach(x=>{sides[x.winner]=(sides[x.winner]||0)+1});
 const by={};
 g.forEach(x=>x.players.forEach(p=>{if(p.bot)return;const r=by[p.name]||(by[p.name]={games:0,wins:0});r.games++;if(p.won)r.wins++}));
 const top=Object.entries(by).sort((a,b)=>b[1].wins-a[1].wins||b[1].games-a[1].games).slice(0,15);
 const mw=m.filter(x=>x.won).length,roles={};m.forEach(x=>{roles[x.role]=(roles[x.role]||0)+1});
 const pct=(a,b)=>b?Math.round(100*a/b)+"%":"—";
 return `<h1>${t("stats_btn")}</h1><p class="sub">${t("stats_sub")}</p>
 <div class="card"><b>${t("stats_mine")}</b>
  ${m.length?`<div class="chips mt"><span class="chip">${t("st_games")}: <b>${m.length}</b></span><span class="chip">${t("st_wins")}: <b>${mw}</b> (${pct(mw,m.length)})</span></div>
  <div class="chips mt">${Object.entries(roles).map(([k,n])=>`<span class="chip">${R[k]?R[k].e:""} ${roleName(k)}: <b>${n}</b></span>`).join("")}</div>`:`<p class="sub" style="margin:8px 0 0">${t("empty")}</p>`}</div>
 <div class="card"><b>${t("stats_hosted")}</b>
  ${g.length?`<div class="chips mt"><span class="chip">${t("st_games")}: <b>${g.length}</b></span><span class="chip">${t("win_civ")} <b>${sides.civ||0}</b></span><span class="chip">${t("win_maf")} <b>${sides.maf||0}</b></span><span class="chip">${t("win_man")} <b>${sides.man||0}</b></span></div>
  ${top.length?`<div class="mt"><b>${t("st_top")}</b>${top.map(([n,r],i)=>`<div class="pl"><span>${i+1}. ${esc(n)}</span><span class="sub" style="margin:0">${t("st_row",r.wins,r.games,pct(r.wins,r.games))}</span></div>`).join("")}</div>`:""}
  <div class="mt"><b>${t("st_recent")}</b>${g.slice(-5).reverse().map(x=>`<div class="lg">${new Date(x.ts).toLocaleString()} · ${t("win_"+x.winner)} · ${x.players.length} ${t("st_players")}</div>`).join("")}</div>`
  :`<p class="sub" style="margin:8px 0 0">${t("empty")}</p>`}</div>
 ${g.length||m.length?`<button class="sec big" id="clr">${t("st_clear")}</button>`:""}
 <button class="big mt" id="back">${t("to_home")}</button>`;
}
bind.stats=()=>{
 $("back").onclick=()=>{V.screen=V.session?(V.session.kind==="host"?"host":"player"):"home";render()};
 const c=$("clr");if(c)c.onclick=()=>{if(confirm(t("st_clear_q"))){store.del(STATS_KEY);render()}};
};

// ---------- shared pieces ----------
function roleTag(k){return k&&R[k]?`<span class="rtag" style="border-color:${R[k].c}">${R[k].e} ${roleName(k)}</span>`:""}
function playerList(st,opts={}){
 return st.players.map((p,i)=>{
  const meTag=V.me&&p.id===V.me.id?` <b>${t("you")}</b>`:"";
  const mark=opts.started?(p.dead?"💀 ":"🙂 "):(i+1)+". ";
  const role=opts.roles?roleTag(opts.roles(p.id)):roleTag(p.role);
  return `<div class="pl ${p.dead?"dead":""}"><span><span class="dot ${p.connected?"":"off"}"></span><span class="n">${mark}${esc(p.name)}</span>${p.host?" 👑":""}${meTag} ${role}</span>${opts.right?opts.right(p):""}</div>`;
 }).join("");
}
function qrSvg(text){try{const q=qrcode(0,"M");q.addData(text);q.make();return q.createSvgTag({cellSize:4,margin:0,scalable:true,alt:t("qr_alt")})}catch{return ""}}
function compChips(c){return c?ORDER.filter(k=>c[k]>0).map(k=>`<span class="chip">${R[k].e} ${roleName(k)}: <b>${c[k]}</b></span>`).join(""):""}
function stageTitle(g){return t(g.stage==="day"?"day_n":"night_n",g.round)}
function winText(w){return w==="civ"||w==="man"||w==="maf"?t("win_"+w):w}
// Log entries are stored as [stageKey, round, key, ...args] so they follow the chosen language.
function logText(l){return typeof l==="string"?l:`${t(l[0],l[1])}: ${t(l[2],...l.slice(3).map(a=>typeof a==="string"?esc(a):a))}`}
const pname=id=>(V.state?.players.find(p=>p.id===id)||{}).name||"?";

function timerCard(st){
 const tm=st.game&&st.game.timer;
 if(!tm||!st.started)return "";
 return `<div class="card timer"><div class="row" style="justify-content:space-between;align-items:center"><b>⏱ ${t("tm_"+tm.label)}</b><span class="tmr-val">${fmt(tm.left)}</span></div>
  <div class="tmr-track"><div class="tmr-bar" data-total="${tm.total}"></div></div></div>`;
}
// What happened last night / at the last vote, for everyone.
function newsCard(st){
 const n=st.game.news;if(!n||!st.started||st.game.winner)return "";
 const who=id=>{const p=st.players.find(x=>x.id===id);return p?`<b>${esc(p.name)}</b>${p.role?" "+roleTag(p.role):""}`:"?"};
 let txt;
 if(n.k==="night")txt=n.died.length?t("news_died",n.died.map(who).join(", ")):t("news_nobody");
 else txt=n.pardoned!=null?t("news_pardoned",who(n.pardoned)):n.out!=null?t("news_out",who(n.out)):n.tie?t("news_tie"):t("news_no_exile");
 return `<div class="card news">${n.k==="night"?"🌅":"⚖️"} ${txt}</div>`;
}
function winnerCard(st,extra=""){
 if(!st.game.winner)return "";
 return `<div class="card center" style="border-color:var(--ac)"><b style="font-size:22px">${winText(st.game.winner)}</b>${extra}</div>`;
}
function chatCard(list,canWrite){
 if(!list)return "";
 return `<div class="card"><b>${t("chat_title")}</b><div class="sub" style="text-align:left;margin:4px 0 6px">${t("chat_sub")}</div>
  <div class="chat">${list.length?list.map(m=>`<div class="msg"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join(""):`<div class="sub" style="text-align:left;margin:0">${t("empty")}</div>`}</div>
  ${canWrite?`<div class="row mt"><input id="chatin" maxlength="200" placeholder="${t("chat_ph")}" autocomplete="off"><button id="chatsend">➤</button></div>`:""}</div>`;
}

// ---------- player view (also used by the host who plays) ----------
const ACT_ORDER=["vote","jd","mk","dn","dt","dc","mn","sn","ms"];
function actionBlocks(sec,day){
 const acts=sec.actions||{};
 return ACT_ORDER.filter(k=>acts[k]&&(day?(k==="vote"||k==="jd"):(k!=="vote"&&k!=="jd"))).map(k=>{
  const cur=sec.picks?.[k];
  const [title,hint]=t("act_"+k);
  return `<div class="act"><b>${title}</b>${hint?`<div class="sub" style="text-align:left;margin:2px 0 0">${hint}</div>`:""}
   <div class="targets">${acts[k].map(id=>`<button class="${cur===id?"on":"sec"}" data-act="${k}" data-t="${id}">${cur===id?"✅ ":""}${esc(pname(id))}</button>`).join("")}</div>
   <div class="sub" style="text-align:left;margin:0">${cur!==undefined?t("your_pick",esc(pname(cur))):t("not_picked")}</div></div>`}).join("")+(V.err?`<div class="err">${esc(V.err)}</div>`:"");
}
function playerGame(st,sec,me){
 const N=st.players.length,meP=st.players.find(p=>p.id===me?.id),meDead=meP?.dead,night=st.game.stage==="night",over=!!st.game.winner;
 let roleHtml=`<p class="sub" style="margin:0">${t("no_role_yet")}</p>`;
 if(sec){
  const r=R[sec.role];
  let extra="";
  if(isMafia(sec.role))extra=sec.team.length?`<div class="team">${t("your_team")}: <b>${sec.team.map(x=>esc(x.name)+(x.role==="don"?" 🎩":"")).join(", ")}</b></div>`:`<div class="team">${t("alone_mafia")}</div>`;
  if(sec.knows.length)extra+=`<div class="team">${t(sec.role==="ast"?"knows_det":"knows_doc")}: <b>${sec.knows.map(x=>esc(x.name)).join(", ")}</b></div>`;
  if(sec.teamPicks&&sec.teamPicks.length)extra+=`<div class="team">${t("team_picks")}: ${sec.teamPicks.map(x=>`<b>${esc(pname(x.id))}</b> → ${esc(pname(x.target))}`).join(", ")}</div>`;
  if(sec.notes&&sec.notes.length)extra+=`<div class="team" style="text-align:left"><b>${t("your_results")}</b>${sec.notes.map(n=>`<div class="lg">${esc(typeof n==="string"?n:n.k==="blocked"?t("nt_blocked",n.r):t("nt_"+n.k,n.r,n.n,n.v))}</div>`).join("")}</div>`;
  const nightActs=night?actionBlocks(sec,false):"";
  const noAct=night&&!meDead&&!over&&!nightActs?`<p class="sub mt">${t("no_action")}</p>`:"";
  roleHtml=V.showRole||over
   ?`<div class="role">${r.e}</div><div class="rname" style="color:${r.c}">${roleName(sec.role)}</div><div class="rdesc">${roleDesc(sec.role)}</div>${extra}${nightActs}${noAct}${over?"":`<button class="sec big mt" id="tg">${t("hide_role")}</button>`}`
   :`<div class="role">🂠</div><p class="sub">${t("nobody_looks")}${night&&!over?"<br>"+t("night_open"):""}</p><button class="big" id="tg">${t("show_role")}</button>`;
 }
 const vote=sec&&!night&&!over?actionBlocks(sec,true):"";
 return `
  <h1>${stageTitle(st.game)}</h1><p class="sub">${t("room_me",esc(st.code),esc(me?.name||""))}</p>
  ${winnerCard(st)}
  ${timerCard(st)}
  ${newsCard(st)}
  ${meDead&&!over?`<div class="card center"><b>${t("you_out")}</b><p class="sub" style="margin:6px 0 0">${t("you_out_sub")}</p></div>`:""}
  ${vote?`<div class="card">${vote}</div>`:""}
  <div class="card center" style="padding:20px 16px">${roleHtml}</div>
  ${sec&&sec.chat?chatCard(sec.chat,true):""}
  <div class="card"><b>${t("alive_n",st.players.filter(p=>!p.dead).length,N)}</b>${playerList(st,{started:true})}</div>`;
}
function bindPlayerGame(){
 const tg=$("tg");if(tg)tg.onclick=()=>{V.showRole=!V.showRole;render()};
 app.querySelectorAll("[data-act]").forEach(b=>b.onclick=async()=>{
  const sec=V.session.kind==="host"?rs.secretFor(HR,HR.hostPlayerId):V.secret;
  const kind=b.dataset.act,tg2=+b.dataset.t,cur=sec?.picks?.[kind];
  app.querySelectorAll(`[data-act="${kind}"]`).forEach(x=>x.disabled=true);
  const r=await emit("player:act",{kind,target:cur===tg2?null:tg2});
  if(!r.ok){V.err=errText(r);render()}else V.err="";
 });
 const send=async()=>{
  const inp=$("chatin");if(!inp||!inp.value.trim())return;
  const text=inp.value;inp.value="";
  const r=await emit("player:chat",{text});
  if(!r.ok){V.err=errText(r)}
  render();
 };
 const cs=$("chatsend");if(cs)cs.onclick=send;
 const ci=$("chatin");if(ci)ci.onkeydown=e=>{if(e.key==="Enter")send()};
}

function player(){
 const st=V.state;if(!st)return loading();
 if(!st.started){return `
  <h1>${t("lobby_title",esc(st.code))}</h1><p class="sub">${t("joined_as",esc(V.me?.name||""))}</p>
  <div class="card center"><b>${t("waiting")}</b><p class="sub" style="margin:6px 0 0">${t("waiting_sub")}</p></div>
  <div class="card"><b>${t("players_n",st.players.length)}</b>${playerList(st)}</div>
  ${st.comp?`<div class="card"><b>${t("roles_in_game")}</b><div class="chips mt">${compChips(st.comp)}</div></div>`:""}
  <button class="sec big" id="leave">${t("leave_room")}</button>`}
 return playerGame(st,V.secret,V.me)+`<p class="sub"><a href="#" id="quit">${t("quit_game")}</a></p>`;
}
bind.player=()=>{
 bindPlayerGame();
 const q=$("quit");if(q)q.onclick=e=>{e.preventDefault();if(confirm(t("confirm_quit")))goHome()};
 const lv=$("leave");if(lv)lv.onclick=async()=>{
  if(!confirm(t("confirm_leave")))return;
  await emit("player:leave",{code:V.session.code,token:V.session.token});goHome();
 };
};

// ---------- host ----------
const H=(ev,d={})=>emit(ev,{...d}).then(r=>{if(!r.ok){V.err=errText(r,MIN_PLAYERS);render()}else if(V.err){V.err="";render()}return r});
function host(){
 const st=V.state;if(!st)return loading();
 if(!st.started)return hostLobby(st);
 if(st.fullSettings.auto&&st.hostPlayerId!==null)return hostPlaying(st);
 return hostGame(st);
}
function settingsCard(st){
 const s=st.fullSettings,N=st.players.length;
 const counter=k=>`<div class="pl"><span>${R[k].e} ${roleName(k)}</span><span><button class="sec cnt" data-k="${k}" data-d="-1">−</button> <b class="cntv">${s.counts[k]||0}</b> <button class="cnt" data-k="${k}" data-d="1">+</button></span></div>`;
 const secOpt=(id,val,list)=>`<select id="${id}">${list.map(v=>`<option value="${v}" ${v===val?"selected":""}>${fmt(v*1000)}</option>`).join("")}</select>`;
 const hp=st.players.find(p=>p.id===st.hostPlayerId);
 return `<div class="card"><b>${t("set_title")}</b>
  <div class="row mt"><button class="${s.mode==="auto"?"":"sec"}" id="m-auto" style="flex:1">${t("set_auto")}</button><button class="${s.mode==="custom"?"":"sec"}" id="m-custom" style="flex:1">${t("set_custom")}</button></div>
  ${s.mode==="custom"?`<div class="mt">${ORDER.filter(k=>k!=="civ").map(counter).join("")}<div class="pl"><span>${R.civ.e} ${roleName("civ")}</span><b>${st.comp?st.comp.civ:"—"}</b></div></div>`:sub("set_auto_sub")}
  ${st.compError&&st.compError!=="few"?`<div class="err">${t("err_"+st.compError)}</div>`:""}
  <label class="chk mt"><input type="checkbox" id="reveal" ${s.reveal?"checked":""}> ${t("set_reveal")}</label>
  <label class="chk"><input type="checkbox" id="auto" ${s.auto?"checked":""}> ${t("set_autohost")}</label>
  ${s.auto?`<div class="sub" style="text-align:left;margin:4px 0 8px">${t("set_autohost_sub")}</div>
   <div class="row"><label class="fl" style="flex:1">${t("set_night_t")}${secOpt("t-night",s.timers.night,[30,45,60,90,120])}</label><label class="fl" style="flex:1">${t("set_day_t")}${secOpt("t-day",s.timers.day,[60,120,180,240,300])}</label></div>
   <div class="mt"><b>${t("set_iplay")}</b>${sub("set_iplay_sub")}
   <div class="row"><input id="hpname" maxlength="20" placeholder="${t("name_ph")}" value="${hp?esc(hp.name):""}" autocomplete="off"><button id="hpsave">${hp?"✓":t("enter")}</button>${hp?`<button class="sec" id="hpdel">✕</button>`:""}</div></div>`:""}
 </div>`;
}
function hostLobby(st){
 const N=st.players.length,ok=N>=MIN_PLAYERS&&!st.compError,link=inviteLink(st.code);
 return `
 <h1>${t("you_host")}</h1><p class="sub">${t("you_host_sub")}</p>
 <div class="card center">
  <div class="sub" style="margin:0">${t("room_code")}</div><div class="bigcode">${esc(st.code)}</div>
  <div class="qr">${qrSvg(link)}</div>
  <div class="link" id="lnk">${esc(link)}</div>
  <div class="row"><button class="sec" id="copy" style="flex:1">${t("copy")}</button>${navigator.share?`<button id="share" style="flex:1">${t("share")}</button>`:""}</div>
 </div>
 <div class="card"><b>${t("players_n",N)}</b>${N?playerList(st,{right:p=>p.host?"":`<button class="x" data-kick="${p.id}" title="${t("remove")}">✕</button>`}):`<p class="sub" style="margin:10px 0 0">${t("nobody_yet",MIN_PLAYERS)}</p>`}</div>
 <div class="card"><button class="sec big" id="addbot">${t("add_bot")}</button><p class="sub" style="margin:8px 0 0">${t("bots_hint")}</p></div>
 ${settingsCard(st)}
 <div class="card"><b>${t("roles_in_game")}</b>${st.comp?`<div class="chips mt">${compChips(st.comp)}</div>`:`<p class="sub" style="margin:10px 0 0">${N<MIN_PLAYERS?t("need_more",MIN_PLAYERS-N):t("err_"+st.compError)}</p>`}</div>
 <div class="err">${esc(V.err)}</div>
 <button class="big" id="start" ${ok?"":"disabled"}>${t("start")}</button>
 <button class="sec big mt" id="close">${t("close_room")}</button>`;
}
bind.host=()=>{
 const st=V.state;if(!st)return;
 if(st.started)return st.fullSettings.auto&&st.hostPlayerId!==null?bindHostPlaying(st):bindHostGame(st);
 const link=inviteLink(st.code);
 $("copy").onclick=async e=>{
  try{await navigator.clipboard.writeText(link);e.target.textContent=t("copied")}
  catch{getSelection().selectAllChildren($("lnk"));e.target.textContent=t("selected_copy")}
 };
 const sh=$("share");if(sh)sh.onclick=()=>navigator.share({title:t("mafia"),text:t("share_text",st.code),url:link}).catch(()=>{});
 app.querySelectorAll("[data-kick]").forEach(b=>b.onclick=()=>{
  const p=st.players.find(x=>x.id===+b.dataset.kick);
  if(confirm(t("confirm_kick",p?p.name:"?")))H("host:kick",{playerId:+b.dataset.kick});
 });
 $("addbot").onclick=()=>H("host:addbot");
 const s=st.fullSettings;
 $("m-auto").onclick=()=>H("host:settings",{mode:"auto"});
 $("m-custom").onclick=()=>H("host:settings",{mode:"custom"});
 app.querySelectorAll(".cnt").forEach(b=>b.onclick=()=>H("host:settings",{counts:{[b.dataset.k]:(s.counts[b.dataset.k]||0)+ +b.dataset.d}}));
 $("reveal").onchange=e=>H("host:settings",{reveal:e.target.checked});
 $("auto").onchange=e=>{H("host:settings",{auto:e.target.checked});if(!e.target.checked&&st.hostPlayerId!==null)H("host:hostplayer",{name:null})};
 const tn=$("t-night");if(tn)tn.onchange=()=>H("host:settings",{timers:{night:+tn.value,day:s.timers.day}});
 const td=$("t-day");if(td)td.onchange=()=>H("host:settings",{timers:{night:s.timers.night,day:+td.value}});
 const hs=$("hpsave");if(hs)hs.onclick=()=>{const v=$("hpname").value.trim();if(v)H("host:hostplayer",{name:v}).then(r=>{if(r.ok)V.me={id:HR.hostPlayerId,name:v}})};
 const hd=$("hpdel");if(hd)hd.onclick=()=>H("host:hostplayer",{name:null});
 $("start").onclick=async e=>{
  if(!confirm(t("confirm_start",st.players.length)))return;
  e.target.disabled=true;V.showRole=false;
  await H("host:start");
 };
 $("close").onclick=()=>{if(confirm(t("confirm_close")))goHome()};
};

// Host who plays: sees only their own role, the game runs itself.
function hostPlaying(st){
 const me=st.players.find(p=>p.id===st.hostPlayerId);
 V.me={id:me.id,name:me.name};
 const sec=rs.secretFor(HR,st.hostPlayerId);
 return playerGame(st,sec,me)+autoCard(st);
}
function autoCard(st){
 return `<div class="card"><b>${t("auto_title")}</b>${sub("auto_sub")}
  ${st.game.winner?`<button class="big" id="again">${t("new_game")}</button>`:`<button class="sec big" id="skip">${t("auto_skip")}</button>`}
  ${prefsRow()}
  <p class="sub" style="text-align:left;margin:10px 0">${t("room_link",esc(inviteLink(st.code)))}</p>
  <button class="sec big" id="reset">${t("back_lobby")}</button><button class="sec big mt" id="close">${t("close_room")}</button></div>`;
}
function prefsRow(){return `<div class="row mt"><button class="sec sm" id="pv" style="flex:1">${prefs.voice?"🔊":"🔇"} ${t("voice")}</button><button class="sec sm" id="ps" style="flex:1">${prefs.sound?"🔔":"🔕"} ${t("sound")}</button></div>`}
function bindHostCommon(){
 const sk=$("skip");if(sk)sk.onclick=()=>{if(confirm(t("auto_skip_q")))(HR.game.stage==="night"?H("host:night"):H("host:vote"))};
 const ag=$("again");if(ag)ag.onclick=()=>H("host:reset");
 const rs_=$("reset");if(rs_)rs_.onclick=()=>{if(confirm(t("confirm_reset")))H("host:reset")};
 const cl=$("close");if(cl)cl.onclick=()=>{if(confirm(t("confirm_close")))goHome()};
}
function bindHostPlaying(){bindPlayerGame();bindHostCommon()}

// Host as moderator: sees everything and resolves phases.
const roleOf=id=>V.state.roles.find(r=>r.id===id)?.role;
const nameOf=id=>V.state.players.find(p=>p.id===id)?.name||"?";
const aliveIds=()=>V.state.players.filter(p=>!p.dead).map(p=>p.id);
const aliveRole=k=>aliveIds().find(id=>roleOf(id)===k);
function opts(sel,phone){return `<option value="">${phone!=null?t("by_phone",esc(nameOf(phone))):t("nobody")}</option>`+aliveIds().map(i=>`<option value="${i}" ${String(i)===String(sel)?"selected":""}>${esc(nameOf(i))}</option>`).join("")}
function timerButtons(st){
 const day=st.game.stage==="day",b=(label,s,txt)=>`<button class="sec sm tmb" data-l="${label}" data-s="${s}">${txt}</button>`;
 return `<div class="card"><b>${t("timer")}</b><div class="tbtns mt">
  ${day?b("disc",60,t("tb_disc",1))+b("disc",120,t("tb_disc",2))+b("disc",180,t("tb_disc",3))+b("speech",30,t("tb_speech",30))+b("speech",60,t("tb_speech",60)):b("night",30,t("tb_night",30))+b("night",60,t("tb_night",60))}
  ${st.game.timer?`<button class="sm tmb" data-s="0">⏹ ${t("tb_stop")}</button>`:""}</div></div>`;
}
function hostGame(st){
 const a=aliveIds(),w=st.game.winner,night=st.game.stage==="night",picks=rs.pickList(HR);
 let h=`<h1>${stageTitle(st.game)}</h1><p class="sub">${t("host_title",esc(st.code),a.length,st.players.length)}${st.fullSettings.auto?" · "+t("auto_on"):""}</p>`;
 h+=winnerCard(st,`<button class="big mt" id="again">${t("new_game")}</button>`);
 h+=timerCard(st);
 h+=newsCard(st);
 h+=`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><b>${t("players")}</b><button class="sec sm" id="tr">${t(G.showRoles?"hide_roles":"show_roles")}</button></div>`
  +playerList(st,{started:true,roles:id=>G.showRoles||w?roleOf(id):null,right:p=>`<button class="x tg" data-i="${p.id}" style="font-size:14px">${t(p.dead?"revive":"out")}</button>`})+`</div>`;
 if(!w)h+=timerButtons(st);
 if(!w&&night){
  const who=k=>{const l=picks.filter(x=>x.kind===k);return `<div class="picks">${l.length?l.map(x=>`📱 ${esc(nameOf(x.id))} → <b>${esc(nameOf(x.target))}</b>`).join(" · "):t("not_picked_yet")}</div>`};
  const f=(k,s)=>s?`<label class="fl">${t("f_"+k)}<select data-k="${k}">${opts(G.night[k]??"",rs.phoneChoice(HR,k))}</select></label>${who(k)}`:"";
  const actors=a.filter(i=>rs.requiredActions(HR,i).length),done=actors.filter(i=>rs.requiredActions(HR,i).every(k=>picks.some(x=>x.id===i&&x.kind===k)));
  const has=k=>aliveRole(k)!==undefined;
  h+=`<div class="card"><b>${t("night_actions")}</b><div class="sub" style="text-align:left;margin:4px 0 0">${t("night_progress",done.length,actors.length)}</div>`
   +f("dn",has("don"))+f("mk",a.some(i=>isMafia(roleOf(i))))+f("mn",has("man"))+f("dc",has("doc")||has("nurse"))+f("ms",has("mis"))+f("dt",has("det")||has("ast"))+f("sn",has("sn")&&!st.used.sniper)
   +`<button class="big" id="en" style="margin-top:14px">${t("end_night")}</button></div>`;
 }else if(!w){
  const vp=picks.filter(x=>x.kind==="vote"),jd=picks.find(x=>x.kind==="jd");
  h+=`<div class="card"><b>${t("voting")}</b><div class="sub" style="text-align:left;margin:4px 0 0">${t("vote_progress",vp.length,a.length)}</div>`
   +(vp.length?`<div class="picks">${vp.map(x=>`📱 ${esc(nameOf(x.id))} → <b>${esc(nameOf(x.target))}</b>`).join(" · ")}</div>`:"")
   +(jd?`<div class="picks">⚖️ ${t("judge_pick",esc(nameOf(jd.target)))}</div>`:"")
   +a.map(i=>`<div class="pl"><span>${esc(nameOf(i))}</span><span><button class="sec vb" data-i="${i}" data-d="-1" style="padding:4px 14px">−</button> <b style="display:inline-block;min-width:28px;text-align:center">${totalVotes(i)}</b> <button class="vb" data-i="${i}" data-d="1" style="padding:4px 14px">+</button></span></div>`).join("")
   +`<button class="big" id="ev" style="margin-top:14px">${t("end_vote")}</button><button class="sec big" id="sk" style="margin-top:8px">${t("no_exile")}</button></div>`;
 }
 if(st.chat.length)h+=chatCard(st.chat,false);
 h+=`<div class="card"><b>${t("log")}</b> <span class="sub">${t("log_host_only")}</span>`+(st.log.length?st.log.slice().reverse().map(l=>`<div class="lg">${logText(l)}</div>`).join(""):`<p class="sub" style="margin:8px 0 0;text-align:left">${t("empty")}</p>`)+`</div>`
  +`<div class="card"><b>${t("host_menu")}</b>${prefsRow()}<p class="sub" style="text-align:left;margin:10px 0">${t("room_link",esc(inviteLink(st.code)))}</p>`
  +`<button class="sec big" id="reset">${t("back_lobby")}</button><button class="sec big mt" id="close">${t("close_room")}</button></div>`;
 return h;
}
function bindHostGame(st){
 bindHostCommon();
 $("tr").onclick=()=>{G.showRoles=!G.showRoles;saveG();render()};
 app.querySelectorAll("select[data-k]").forEach(s=>s.onchange=()=>{G.night[s.dataset.k]=s.value;saveG()});
 app.querySelectorAll(".tg").forEach(b=>b.onclick=()=>{const i=+b.dataset.i;H("host:dead",{id:i,dead:!st.players.find(p=>p.id===i).dead})});
 app.querySelectorAll(".vb").forEach(b=>b.onclick=()=>{const i=+b.dataset.i,ph=rs.voteTally(HR)[i]||0;G.votes[i]=Math.max(-ph,(G.votes[i]||0)+ +b.dataset.d);saveG();render()});
 app.querySelectorAll(".tmb").forEach(b=>b.onclick=()=>H("host:timer",{label:b.dataset.l,seconds:+b.dataset.s}));
 const en=$("en");if(en)en.onclick=()=>H("host:night");
 const ev=$("ev");if(ev)ev.onclick=()=>H("host:vote",{skip:false});
 const sk=$("sk");if(sk)sk.onclick=()=>H("host:vote",{skip:true});
}
// Buttons that exist on several screens.
function bindCommon(){
 const pv=$("pv");if(pv)pv.onclick=()=>{prefs.voice=!prefs.voice;savePrefs();if(prefs.voice)speak("voice_on");render()};
 const ps=$("ps");if(ps)ps.onclick=()=>{prefs.sound=!prefs.sound;savePrefs();beep(1);render()};
}

boot();
