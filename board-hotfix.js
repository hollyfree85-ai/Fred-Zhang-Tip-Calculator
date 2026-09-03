import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, query, where, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);
let unsub=null, ctx=null, known=new Map(), initialized=false;

function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
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
  if($("moneyReadyQueueInfo"))$("moneyReadyQueueInfo").textContent=qAnnouncements.length>1?`${qAnnouncements.length-1} more announcement(s) waiting`:"";
  $("moneyReadyOverlay").classList.remove("hidden");
  chime();
}
function announce(name){qAnnouncements.push(name||"Employee");showNext();}
window.dismissMoneyReadyOverlay=()=>{
  $("moneyReadyOverlay").classList.add("hidden");
  qAnnouncements.shift();showing=false;setTimeout(showNext,200);
};
window.testServerRoomChime=()=>chime();

window.enableBoardHotfix=async function(){
  const err=$("boardError");
  try{
    if(err) err.textContent="Connecting...";
    if(!auth.currentUser) await signInAnonymously(auth);
    ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
    if(ctx.state==="suspended") await ctx.resume();
    $("boardSetup").classList.add("hidden");
    $("boardStatus").classList.remove("hidden");
    localStorage.setItem("serverRoomBoardEnabled","1");
    if(unsub) unsub();
    const q=query(collection(db,"moneyReadyBoard"),where("active","==",true),limit(100));
    unsub=onSnapshot(q,snap=>{
      const cutoff=Math.floor(Date.now()/1000)-86400;
      const rawRows=snap.docs.map(d=>({id:d.id,...d.data()}))
        .filter(r=>(r.createdAt?.seconds||Math.floor(Date.now()/1000))>=cutoff)
        .sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));

      const seenEmployees=new Set();
      const rows=rawRows.filter(r=>{
        const key=String(r.employee||"").trim().toLowerCase();
        if(!key) return true;
        if(seenEmployees.has(key)) return false;
        seenEmployees.add(key);
        return true;
      });
      $("boardLiveInfo").textContent=`LIVE • ${rows.length} money-ready report(s) • ${new Date().toLocaleTimeString()}`;
      $("moneyReadyList").innerHTML=rows.length?rows.map(r=>`
        <div style="background:#0f243d;border:1px solid #28445f;border-radius:18px;padding:18px">
          <div style="font-size:12px;opacity:.7;letter-spacing:.12em">MONEY READY</div>
          <div style="font-size:30px;font-weight:1000;margin:8px 0">${esc(r.employee||"")}</div>
          <div style="font-size:18px;font-weight:700">Please come to Cashier</div>
        </div>`).join(""):'<div style="opacity:.65">No employees waiting for pickup.</div>';

      const current=new Map(rows.map(r=>[r.id,Number(r.announceNonce||r.createdAt?.seconds||0)]));
      if(initialized){
        for(const r of rows){
          const token=Number(r.announceNonce||r.createdAt?.seconds||0);
          if(!known.has(r.id) || known.get(r.id)!==token){ announce(r.employee); break; }
        }
      }
      known=current; initialized=true;
      if(err) err.textContent="";
    },e=>{
      if(err) err.textContent=`Realtime error: ${e.code||e.message}`;
      $("boardLiveInfo").textContent="NOT CONNECTED";
    });
  }catch(e){
    if(err) err.textContent=`Board failed: ${e.code||e.message}`;
    alert(`Board failed: ${e.code||e.message}`);
  }
};
