import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, query, where, limit, onSnapshot, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);

const BOARD_EXPIRE_MS=30*60*1000;
let unsub=null, ctx=null, known=new Map(), initialized=false;
let latestBoardRows=[];
let expiryTimer=null;

function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
function toMillis(v){
  try{
    if(!v) return 0;
    if(typeof v.toMillis==="function") return v.toMillis();
    if(typeof v.toDate==="function") return v.toDate().getTime();
    if(typeof v.seconds==="number") return v.seconds*1000;
    return new Date(v).getTime()||0;
  }catch(e){return 0;}
}


let boardVoiceUnlocked=false;
let boardVoicesReady=false;

function warmBoardVoices(){
  if(!("speechSynthesis" in window)) return;
  const load=()=>{
    const voices=window.speechSynthesis.getVoices()||[];
    boardVoicesReady=voices.length>0;
  };
  load();
  window.speechSynthesis.onvoiceschanged=load;
}

function unlockBoardVoice(){
  if(!("speechSynthesis" in window)) return false;
  try{
    warmBoardVoices();

    // Browsers may block later speech unless speech synthesis has first been
    // started from a direct user gesture. The Enable Board button provides that gesture.
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance("Voice alerts enabled.");
    u.lang="en-US";
    u.volume=0.85;
    u.rate=1.0;
    u.pitch=1.0;
    const v=chooseBoardVoice();
    if(v) u.voice=v;
    window.speechSynthesis.speak(u);
    boardVoiceUnlocked=true;
    localStorage.setItem("serverRoomVoiceEnabled","1");
    return true;
  }catch(e){
    console.warn("Voice unlock:",e);
    return false;
  }
}

function chooseBoardVoice(){
  if(!("speechSynthesis" in window)) return null;
  const voices=window.speechSynthesis.getVoices()||[];
  const english=voices.filter(v=>/^en[-_]/i.test(v.lang||""));
  const preferred=["Samantha","Ava","Victoria","Karen","Zira","Jenny","Aria","Emma","Michelle","Salli","Joanna"];
  for(const name of preferred){
    const v=english.find(x=>String(x.name||"").toLowerCase().includes(name.toLowerCase()));
    if(v) return v;
  }
  return english[0]||voices[0]||null;
}

function speakBoardMoneyReady(name){
  if(!("speechSynthesis" in window)) return;

  const doSpeak=()=>{
    try{
      window.speechSynthesis.cancel();
      const employee=String(name||"Employee").trim();
      const u=new SpeechSynthesisUtterance(`${employee}, please come to the cashier. Your tip money is ready.`);
      const v=chooseBoardVoice();
      if(v) u.voice=v;
      u.lang=v?.lang||"en-US";
      u.rate=.90;
      u.pitch=1.08;
      u.volume=1;

      u.onerror=(e)=>{
        console.warn("Board speech error:",e);
        const err=document.getElementById("boardError");
        if(err) err.textContent=`Voice error: ${e.error||"speech failed"}`;
      };

      window.speechSynthesis.speak(u);
    }catch(e){
      console.warn("Board speech:",e);
    }
  };

  // Voice lists can load asynchronously in Chrome/Windows.
  if((window.speechSynthesis.getVoices()||[]).length){
    doSpeak();
  }else{
    warmBoardVoices();
    setTimeout(doSpeak,500);
  }
}

function chime(){
  ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
  if(ctx.state==="suspended") ctx.resume();
  const now=ctx.currentTime;
  [659.25,783.99,987.77].forEach((f,i)=>{
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.frequency.value=f;o.type="sine";
    g.gain.setValueAtTime(.0001,now+i*.2);
    g.gain.exponentialRampToValueAtTime(.2,now+i*.2+.03);
    g.gain.exponentialRampToValueAtTime(.0001,now+i*.2+.5);
    o.connect(g);g.connect(ctx.destination);o.start(now+i*.2);o.stop(now+i*.2+.55);
  });
}
let qAnnouncements=[],showing=false;
function showNext(){
  if(showing||!qAnnouncements.length)return;
  showing=true;
  $("moneyReadyName").textContent=qAnnouncements[0]||"Employee";
  if($("moneyReadyQueueInfo")) $("moneyReadyQueueInfo").textContent=qAnnouncements.length>1?`${qAnnouncements.length-1} more announcement(s) waiting`:"";
  $("moneyReadyOverlay").classList.remove("hidden");
  chime();
  setTimeout(()=>speakBoardMoneyReady(qAnnouncements[0]),650);
}
function announce(name){qAnnouncements.push(name||"Employee");showNext();}
window.dismissMoneyReadyOverlay=()=>{
  $("moneyReadyOverlay").classList.add("hidden");
  qAnnouncements.shift();showing=false;setTimeout(showNext,200);
};
window.testServerRoomChime=()=>chime();


async function purgeExpiredBoardDocs(){
  const now=Date.now();
  const expired=latestBoardRows.filter(r=>{
    const created=toMillis(r.createdAt)||now;
    return (now-created)>=BOARD_EXPIRE_MS;
  });
  for(const r of expired){
    try{ await deleteDoc(doc(db,"moneyReadyBoard",r.id)); }
    catch(e){ console.warn("Board 30-minute cleanup:",r.id,e); }
  }
}

function currentVisibleRows(){
  const now=Date.now();
  const raw=latestBoardRows
    .filter(r=>{
      const created=toMillis(r.createdAt)||now;
      return (now-created)<BOARD_EXPIRE_MS;
    })
    .sort((a,b)=>toMillis(b.createdAt)-toMillis(a.createdAt));

  // Only one card per employee.
  const seen=new Set();
  return raw.filter(r=>{
    const key=String(r.employee||"").trim().toLowerCase();
    if(!key) return true;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderBoard(checkAnnouncements=false){
  const rows=currentVisibleRows();
  if($("boardLiveInfo")){
    $("boardLiveInfo").textContent=`LIVE • ${rows.length} employee(s) waiting • Auto-remove after 30 min • ${new Date().toLocaleTimeString()}`;
  }
  if($("moneyReadyList")){
    $("moneyReadyList").innerHTML=rows.length?rows.map(r=>{
      const created=toMillis(r.createdAt)||Date.now();
      const expiresAt=created+BOARD_EXPIRE_MS;
      const mins=Math.max(0,Math.ceil((expiresAt-Date.now())/60000));
      return `<div style="background:#0f243d;border:1px solid #28445f;border-radius:18px;padding:18px">
        <div style="font-size:12px;opacity:.7;letter-spacing:.12em">MONEY READY</div>
        <div style="font-size:30px;font-weight:1000;margin:8px 0">${esc(r.employee||"")}</div>
        <div style="font-size:18px;font-weight:700">Please come to Cashier</div>
        <div style="font-size:12px;opacity:.65;margin-top:8px">Auto-removes in about ${mins} min</div>
      </div>`;
    }).join(""):'<div style="opacity:.65">No employees waiting for pickup.</div>';
  }

  const current=new Map(rows.map(r=>[r.id,Number(r.announceNonce||toMillis(r.createdAt)||0)]));
  if(checkAnnouncements && initialized){
    for(const r of rows){
      const token=Number(r.announceNonce||toMillis(r.createdAt)||0);
      if(!known.has(r.id) || known.get(r.id)!==token){
        announce(r.employee);
        break;
      }
    }
  }
  known=current;
  initialized=true;
}

window.enableBoardHotfix=async function(){
  const err=$("boardError");
  try{
    unlockBoardVoice();
    if(err) err.textContent="Connecting...";
    if(!auth.currentUser) await signInAnonymously(auth);
    ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
    if(ctx.state==="suspended") await ctx.resume();
    $("boardSetup").classList.add("hidden");
    $("boardStatus").classList.remove("hidden");
    localStorage.setItem("serverRoomBoardEnabled","1");

    if(unsub) unsub();
    if(expiryTimer) clearInterval(expiryTimer);

    const q=query(collection(db,"moneyReadyBoard"),where("active","==",true),limit(100));
    unsub=onSnapshot(q,snap=>{
      latestBoardRows=snap.docs.map(d=>({id:d.id,...d.data()}));
      purgeExpiredBoardDocs();
      renderBoard(true);
      if(err) err.textContent="";
    },e=>{
      if(err) err.textContent=`Realtime error: ${e.code||e.message}`;
      $("boardLiveInfo").textContent="NOT CONNECTED";
    });

    // Even if Firestore has no new snapshot, cards disappear automatically at 30 minutes.
    expiryTimer=setInterval(()=>{ purgeExpiredBoardDocs(); renderBoard(false); },15000);

  }catch(e){
    if(err) err.textContent=`Board failed: ${e.code||e.message}`;
    alert(`Board failed: ${e.code||e.message}`);
  }
};

window.testBoardVoice=function(){
  unlockBoardVoice();
  setTimeout(()=>speakBoardMoneyReady("Sarah Kibler"),500);
};
