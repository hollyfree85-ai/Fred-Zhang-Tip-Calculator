import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInAnonymously, setPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { getMessaging, getToken, isSupported as isMessagingSupported } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";
import { PUSH_VAPID_PUBLIC_KEY } from "./push-config.js";

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);

// V11.1 shared-link security: Owner, Manager, and Employee sessions live only in this tab.
const authSecurityReady=(async()=>{
  try{
    await setPersistence(auth,inMemoryPersistence);
    // Remove any account session left behind by older versions before this page is usable.
    if(auth.currentUser && !auth.currentUser.isAnonymous){
      await signOut(auth);
    }
  }catch(e){
    console.warn("Auth security init:",e);
  }
})();

const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, "us-central1");
const createUserAdmin = httpsCallable(functions, "createAppUser");
const deleteUserAdmin = httpsCallable(functions, "deleteAppUser");
const resendMoneyReadySms = httpsCallable(functions, "resendMoneyReadySms");
const registerPushDevice = httpsCallable(functions, "registerPushDevice");
const unregisterPushDevice = httpsCallable(functions, "unregisterPushDevice");
const saveTipCheckSheetApi = httpsCallable(functions, "saveTipCheckSheet");
const listTipCheckSheetsApi = httpsCallable(functions, "listTipCheckSheets");
const completeTipCheckSheetApi = httpsCallable(functions, "completeTipCheckSheet");
const deleteTipCheckSheetApi = httpsCallable(functions, "deleteTipCheckSheetAdmin");
const clearTipCheckSheetsApi = httpsCallable(functions, "clearTipCheckSheetsAdmin");
const createCashierUserApi = httpsCallable(functions, "createCashierUser");
const updateTipCheckRowApi = httpsCallable(functions, "updateTipCheckRow");
const reopenTipCheckSheetApi = httpsCallable(functions, "reopenTipCheckSheet");
let messagingInstance=null;

let currentUser = null;
let currentProfile = null;
window.__getCurrentRole=()=>String(currentProfile?.role||"");
window.__getCurrentProfile=()=>currentProfile ? {role:currentProfile.role,displayName:currentProfile.displayName||currentProfile.username||""} : null;
let eShift = "AM";
let unsubs = [];
let latestRows = [];
let knownPending = new Set();
let lastHourlyResult = null;
let currentHourlySubmissionId = null;
let currentHourlyReportId = null;
let latestHourlyReports = [];
let userNameByUid = {};
let boardUnsub=null;
let boardAudioCtx=null;
let boardKnownReady=new Set();
let boardMode=false;

// Realtime phone/tablet alerts while the web app is open.
let realtimeAlertCtx=null;
let realtimeAlertsEnabled=false;
let employeeKnownStatuses=new Map();
let staffFirstSnapshot=true;

// Global Money Ready watcher: survives login/logout and never clears the employee form.
let globalMoneyReadyUnsub=null;
let globalMoneyReadyInitialized=false;
let globalMoneyReadyKnown=new Set();
let globalDialogQueue=[];
let globalDialogShowing=false;
let globalAudioUnlocked=false;
let alertFirebaseApp=null;
let alertAuth=null;
let alertDb=null;

// Check Tip workflow
let latestTipCheckSheets=[];
let tipCheckEditId="";
let tipCheckPollTimer=null;



const EMPLOYEE_ROSTER = Object.freeze(["Adrieanna Walker", "Aida Gonzales", "Alainna Montalvo", "Angela Grizzad", "Ariana Garner", "Ashley Garcia", "Brandi Copeland", "Caitlin Dillon", "Christina Gurley", "Dorothy Makovicka", "Fred Zhang", "Hannah Dempsey", "Jesus Ovalle-Munoz", "Libby Lane", "Megan Meadows", "Megan Sisk", "Mia Burress", "Sara Swift", "Sarah Kibler"]);


const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[m]));

function todayLocal(){
  const d=new Date(), z=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function slugFor(username){
  return String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
}
function emailFor(username){
  return `${slugFor(username)}@juicytip.app`;
}
// Firebase requires passwords >= 6 characters. Employees still type only their PIN.
function employeeAuthPassword(pin){
  return `JT${String(pin).trim()}!!`;
}
function loginMsg(m){ $("loginMessage").textContent = m || ""; }

window.setLoginMode = function(mode){
  $("employeeLogin").classList.toggle("hidden", mode !== "employee");
  $("staffLogin").classList.toggle("hidden", mode !== "staff");
  $("employeeModeBtn").classList.toggle("on", mode === "employee");
  $("staffModeBtn").classList.toggle("on", mode === "staff");
  $("boardModeBtn")?.classList.remove("on");
  loginMsg("");
};


function populateRoster(){
  const options=EMPLOYEE_ROSTER.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  ["employeeUsername","signupName","hEmployee","sTipCheckEmployee"].forEach(id=>{
    const el=$(id); if(el) el.innerHTML=options;
  });
}
window.toggleSignup=function(show){
  $("signupPanel").classList.toggle("hidden",!show);
  loginMsg("");
};

window.employeeSignup=async function(){
  const name=$("signupName").value;
  const phone=$("signupPhone").value.trim();
  const pin=$("signupPin").value.trim();
  const pin2=$("signupPin2").value.trim();

  if(!EMPLOYEE_ROSTER.includes(name)){ alert("Select your name from the employee list."); return; }
  const phoneDigits=phone.replace(/\D/g,"");
  if(!/^\d{7,15}$/.test(phoneDigits)){ alert("Enter a valid mobile phone number."); return; }
  if(!/^\d{4}$/.test(pin)){ alert("PIN must be exactly 4 digits."); return; }
  if(pin!==pin2){ alert("PINs do not match."); return; }

  let secondaryApp=null;
  try{
    secondaryApp=initializeApp(FIREBASE_CONFIG,"employee-signup-"+Date.now());
    const secondaryAuth=getAuth(secondaryApp);
    const secondaryDb=getFirestore(secondaryApp);
    const email=emailFor(name);
    const authPassword=employeeAuthPassword(pin);

    let cred;
    try{
      cred=await createUserWithEmailAndPassword(secondaryAuth,email,authPassword);
    }catch(createErr){
      if(createErr.code==="auth/email-already-in-use"){
        cred=await signInWithEmailAndPassword(secondaryAuth,email,authPassword);
      }else{
        throw createErr;
      }
    }

    const uid=cred.user.uid;
    const profile={
      username:slugFor(name),
      displayName:name,
      phone:phoneDigits,
      role:"employee",
      active:false,
      approvalStatus:"pending",
      createdAt:serverTimestamp()
    };

    await setDoc(doc(secondaryDb,"users",uid),profile);
    await setDoc(doc(secondaryDb,"signupRequests",uid),{
      uid,
      displayName:name,
      username:slugFor(name),
      phone:phoneDigits,
      status:"pending",
      requestedAt:serverTimestamp()
    });

    await signOut(secondaryAuth);
    toggleSignup(false);
    $("signupPhone").value="";
    $("signupPin").value="";
    $("signupPin2").value="";
    alert("Sign up sent. Please wait for Manager approval.");
  }catch(e){
    console.error("Employee signup:",e);
    let msg=`Sign up failed: ${e.code || e.message}`;
    if(e.code==="auth/wrong-password" || e.code==="auth/invalid-credential"){
      msg="This employee account already exists with a different PIN. Ask Manager/Owner to remove or reset the old account.";
    }
    alert(msg);
  }finally{
    if(secondaryApp) try{await deleteApp(secondaryApp)}catch(e){}
  }
};



function moneyReadyRoleShouldSuppressGlobalDialog(){
  return boardMode || currentProfile?.role==="manager" || currentProfile?.role==="owner" || currentProfile?.role==="cashier";
}

window.playBundledMoneyReadyChime=async function playBundledMoneyReadyChime(){
  const audio=$("moneyReadyAudio");
  if(!audio) return false;
  try{
    audio.pause();
    audio.currentTime=0;
    audio.volume=1;
    await audio.play();
    const s=$("globalMoneyReadyAudioStatus");
    if(s) s.textContent="";
    return true;
  }catch(e){
    const s=$("globalMoneyReadyAudioStatus");
    if(s) s.textContent="Sound was blocked by the browser; the visual alert is still active.";
    return false;
  }
}

window.trySpeakGlobalMoneyReady=function trySpeakGlobalMoneyReady(name){
  if(!("speechSynthesis" in window)) return;
  try{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(`${String(name||"Employee").trim()}, your tip money is ready. Please come to the cashier.`);
    const voices=window.speechSynthesis.getVoices()||[];
    const english=voices.filter(v=>/^en[-_]/i.test(v.lang||""));
    const preferred=["Samantha","Ava","Victoria","Karen","Zira","Jenny","Aria","Emma","Michelle","Joanna"];
    let voice=null;
    for(const p of preferred){
      voice=english.find(v=>String(v.name||"").toLowerCase().includes(p.toLowerCase()));
      if(voice) break;
    }
    if(!voice) voice=english[0]||voices[0]||null;
    if(voice) u.voice=voice;
    u.lang=voice?.lang||"en-US";
    u.rate=.92; u.pitch=1.05; u.volume=1;
    window.speechSynthesis.speak(u);
  }catch(e){ console.warn("Global Money Ready speech:",e); }
}

function showNextGlobalMoneyReadyDialog(){
  if(globalDialogShowing || !globalDialogQueue.length) return;
  if(moneyReadyRoleShouldSuppressGlobalDialog()){
    globalDialogQueue=[];
    return;
  }

  globalDialogShowing=true;
  const item=globalDialogQueue[0];
  $("globalMoneyReadyName").textContent=item.employee||"Employee";
  const modal=$("globalMoneyReadyDialog");
  modal.classList.remove("hidden");
  modal.style.setProperty("display","flex","important");

  // Guaranteed visual dialog. Bundled WAV is primary audio, browser TTS is secondary.
  playBundledMoneyReadyChime();
  setTimeout(()=>trySpeakGlobalMoneyReady(item.employee),420);
}

function queueGlobalMoneyReadyDialog(item){
  if(moneyReadyRoleShouldSuppressGlobalDialog()) return;
  globalDialogQueue.push(item);
  showNextGlobalMoneyReadyDialog();
}

window.dismissGlobalMoneyReadyDialog=function(){
  const modal=$("globalMoneyReadyDialog");
  if(modal){
    modal.classList.add("hidden");
    modal.style.setProperty("display","none","important");
  }
  globalDialogQueue.shift();
  globalDialogShowing=false;
  setTimeout(showNextGlobalMoneyReadyDialog,120);
};

async function unlockGlobalMoneyReadyAudioFromGesture(){
  if(globalAudioUnlocked) return;
  const audio=$("moneyReadyAudio");
  if(!audio) return;
  try{
    audio.muted=true;
    audio.volume=0.01;
    await audio.play();
    audio.pause();
    audio.currentTime=0;
    audio.muted=false;
    audio.volume=1;
    globalAudioUnlocked=true;
  }catch(e){}
}
document.addEventListener("pointerdown",unlockGlobalMoneyReadyAudioFromGesture,{once:false,passive:true});
document.addEventListener("touchstart",unlockGlobalMoneyReadyAudioFromGesture,{once:false,passive:true});



window.testGlobalMoneyReadyDialog=function(){
  queueGlobalMoneyReadyDialog({employee:"Sarah Kibler",id:"test-"+Date.now(),announceNonce:Date.now()});
};

async function startGlobalMoneyReadyWatcher(){
  if(globalMoneyReadyUnsub) return;

  try{
    // IMPORTANT: use a completely separate Firebase app/auth session.
    // The old V12.3 watcher signed the PRIMARY auth in anonymously, which interfered
    // with Employee/Manager sessions and prevented reliable cross-screen alerts.
    alertFirebaseApp=alertFirebaseApp||initializeApp(FIREBASE_CONFIG,"money-ready-alerts");
    alertAuth=alertAuth||getAuth(alertFirebaseApp);
    alertDb=alertDb||getFirestore(alertFirebaseApp);

    await setPersistence(alertAuth,inMemoryPersistence);
    if(!alertAuth.currentUser){
      await signInAnonymously(alertAuth);
    }

    const q=query(collection(alertDb,"moneyReadyBoard"),limit(100));
    globalMoneyReadyUnsub=onSnapshot(q,snap=>{
      const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
      const liveIds=new Set(rows.map(r=>r.id));

      if(!globalMoneyReadyInitialized){
        rows.forEach(r=>globalMoneyReadyKnown.add(`${r.id}:${Number(r.announceNonce||r.createdAt?.seconds||0)}:${r.active}`));
        globalMoneyReadyInitialized=true;
        const el=$("globalAlertStatus");
        if(el) el.textContent="Money Ready realtime dialog: CONNECTED";
        return;
      }

      for(const r of rows){
        const token=`${r.id}:${Number(r.announceNonce||r.createdAt?.seconds||0)}:${r.active}`;
        const previousToken=globalMoneyReadyKnown.has(token);

        // Alert on a new document OR a new announceNonce.
        if(!previousToken && r.alert!==false){
          globalMoneyReadyKnown.add(token);
          queueGlobalMoneyReadyDialog(r);
        }
      }

      // Keep a compact set of current ids/tokens.
      if(globalMoneyReadyKnown.size>500){
        globalMoneyReadyKnown=new Set(rows.map(r=>`${r.id}:${Number(r.announceNonce||r.createdAt?.seconds||0)}:${r.active}`));
      }
    },e=>{
      console.error("Global Money Ready watcher:",e);
      const el=$("globalAlertStatus");
      if(el){
        el.textContent=`Money Ready realtime dialog: NOT CONNECTED (${e.code||e.message})`;
        el.style.color="#a61b1b";
      }
    });
  }catch(e){
    console.error("Start global Money Ready watcher:",e);
    const el=$("globalAlertStatus");
    if(el){
      el.textContent=`Money Ready realtime dialog: FAILED (${e.code||e.message})`;
      el.style.color="#a61b1b";
    }
  }
}

window.openServerRoomBoard=async function(){
  boardMode=true;
  $("loginView").classList.add("hidden");
  $("appView").classList.add("hidden");
  $("top").classList.add("hidden");
  $("serverRoomBoard").classList.remove("hidden");
  $("boardError").textContent="";
  if(localStorage.getItem("serverRoomBoardEnabled")==="1"){
    await enableServerRoomBoard(true);
  }
};
window.closeServerRoomBoard=async function(){
  boardMode=false;
  if(boardUnsub){try{boardUnsub()}catch(e){} boardUnsub=null;}
  $("serverRoomBoard").classList.add("hidden");
  $("loginView").classList.remove("hidden");
};
window.enableServerRoomBoard=async function(auto=false){
  try{
    await authSecurityReady;
    boardMode=true;
    $("boardError").textContent="";
    if(!auth.currentUser){
      await signInAnonymously(auth);
    }
    boardAudioCtx = boardAudioCtx || new (window.AudioContext||window.webkitAudioContext)();
    if(!auto && boardAudioCtx.state==="suspended") await boardAudioCtx.resume();
    localStorage.setItem("serverRoomBoardEnabled","1");
    $("boardSetup").classList.add("hidden");
    $("boardStatus").classList.remove("hidden");
    $("boardLiveInfo").textContent=`Connected as anonymous board • ${new Date().toLocaleTimeString()}`;
    listenMoneyReadyBoard();
  }catch(e){
    console.error("Enable board failed:",e);
    localStorage.removeItem("serverRoomBoardEnabled");
    $("boardSetup").classList.remove("hidden");
    $("boardStatus").classList.add("hidden");
    const msg=(e.code||e.message||String(e));
    $("boardError").textContent=`Board failed: ${msg}. In Firebase Authentication, Anonymous sign-in must be ENABLED.`;
    if(!auto) alert(`Server Room Board failed: ${msg}`);
  }
};

window.testServerRoomChime=async function(){
  try{
    boardAudioCtx = boardAudioCtx || new (window.AudioContext||window.webkitAudioContext)();
    if(boardAudioCtx.state==="suspended") await boardAudioCtx.resume();
    boardChime();
  }catch(e){ alert("Sound test failed: "+(e.message||e)); }
};

function boardChime(){
  if(!boardAudioCtx)return;
  const now=boardAudioCtx.currentTime;
  [659.25,783.99,987.77].forEach((freq,i)=>{
    const o=boardAudioCtx.createOscillator(), g=boardAudioCtx.createGain();
    o.frequency.value=freq; o.type="sine";
    g.gain.setValueAtTime(0.0001,now+i*.22);
    g.gain.exponentialRampToValueAtTime(.18,now+i*.22+.03);
    g.gain.exponentialRampToValueAtTime(.0001,now+i*.22+.45);
    o.connect(g);g.connect(boardAudioCtx.destination);
    o.start(now+i*.22);o.stop(now+i*.22+.5);
  });
}
let globalAnnouncementQueue=[];
let globalAnnouncementShowing=false;

if("speechSynthesis" in window){
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged=()=>window.speechSynthesis.getVoices();
}

function chooseMoneyReadyVoice(){
  if(!("speechSynthesis" in window)) return null;
  const voices=window.speechSynthesis.getVoices()||[];
  const english=voices.filter(v=>/^en[-_]/i.test(v.lang||""));

  // Prefer common natural-sounding English female voices when present.
  const preferredNames=[
    "Samantha","Ava","Victoria","Karen","Moira","Tessa","Susan",
    "Zira","Jenny","Aria","Emma","Michelle","Salli","Joanna","Kendra"
  ];

  for(const name of preferredNames){
    const v=english.find(x=>String(x.name||"").toLowerCase().includes(name.toLowerCase()));
    if(v) return v;
  }
  return english[0]||voices[0]||null;
}

function speakMoneyReadyAnnouncement(name){
  if(!("speechSynthesis" in window)) return;

  try{
    window.speechSynthesis.cancel();

    const employeeName=String(name||"Employee").trim();
    const text=`${employeeName}, please come to the cashier. Your tip money is ready.`;

    const utter=new SpeechSynthesisUtterance(text);
    const voice=chooseMoneyReadyVoice();
    if(voice) utter.voice=voice;
    utter.lang=voice?.lang||"en-US";
    utter.rate=0.90;
    utter.pitch=1.08;
    utter.volume=1.0;

    window.speechSynthesis.speak(utter);
  }catch(e){
    console.warn("Money Ready voice announcement:",e);
  }
}

function showMoneyReadyOverlay(name){
  globalAnnouncementQueue.push(name||"Employee");
  showNextMoneyReadyAnnouncement();
}
function showNextMoneyReadyAnnouncement(){
  if(globalAnnouncementShowing||!globalAnnouncementQueue.length)return;
  globalAnnouncementShowing=true;
  $("moneyReadyName").textContent=globalAnnouncementQueue[0];
  if($("moneyReadyQueueInfo")){
    $("moneyReadyQueueInfo").textContent=globalAnnouncementQueue.length>1
      ? `${globalAnnouncementQueue.length-1} more announcement(s) waiting`
      : "";
  }
  $("moneyReadyOverlay").classList.remove("hidden");
  boardChime();
  setTimeout(()=>speakMoneyReadyAnnouncement(globalAnnouncementQueue[0]),650);
}
window.dismissMoneyReadyOverlay=function(){
  $("moneyReadyOverlay").classList.add("hidden");
  globalAnnouncementQueue.shift();
  globalAnnouncementShowing=false;
  setTimeout(showNextMoneyReadyAnnouncement,200);
};
function listenMoneyReadyBoard(){
  if(boardUnsub){try{boardUnsub()}catch(e){}}
  let firstSnapshot=true;
  const q=query(collection(db,"moneyReadyBoard"),where("active","==",true),limit(100));
  boardUnsub=onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
    $("boardLiveInfo").textContent=`LIVE • ${rows.length} money-ready report(s) • ${new Date().toLocaleTimeString()}`;
    $("moneyReadyList").innerHTML=rows.length?rows.map(r=>`
      <div style="background:#0f243d;border:1px solid #28445f;border-radius:18px;padding:18px">
        <div style="font-size:12px;opacity:.7;letter-spacing:.12em">MONEY READY</div>
        <div style="font-size:30px;font-weight:1000;margin:8px 0">${esc(r.employee||"")}</div>
        <div style="font-size:18px;font-weight:700">Please come to Cashier</div>
      </div>`).join(""):'<div style="opacity:.65">No employees waiting for pickup.</div>';

    if(firstSnapshot){
      // Existing active reports should be visible immediately, but not blast a chime for every historical record.
      rows.forEach(r=>boardKnownReady.add(r.id));
      firstSnapshot=false;
      return;
    }
    for(const r of rows){
      if(!boardKnownReady.has(r.id)){
        boardKnownReady.add(r.id);
        showMoneyReadyOverlay(r.employee);
        break;
      }
    }
  },e=>{
    console.error("Money Ready board:",e);
    $("boardError").textContent=`Realtime board error: ${e.code||e.message}. Check Firestore rules and Anonymous Authentication.`;
    $("boardLiveInfo").textContent="NOT CONNECTED";
  });
}

window.loginEmployee = async function(){
  ensureRealtimeAlertAudio();
  await authSecurityReady;
  const username = $("employeeUsername").value.trim();
  const pin = $("employeePin").value.trim();
  if(!username || !pin){ loginMsg("Enter username and PIN."); return; }
  try{
    loginMsg("Signing in...");
    await signInWithEmailAndPassword(auth, emailFor(username), employeeAuthPassword(pin));
  }catch(e){
    console.error("Employee login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};

window.loginStaff = async function(){
  ensureRealtimeAlertAudio();
  await authSecurityReady;
  const username = $("staffUsername").value.trim();
  const password = $("staffPassword").value;
  if(!username || !password){ loginMsg("Enter username and password."); return; }
  try{
    loginMsg("Signing in...");
    await signInWithEmailAndPassword(auth, emailFor(username), password);
  }catch(e){
    console.error("Staff login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};

function clearSharedDeviceLoginFields(){
  try{
    if($("employeePin")) $("employeePin").value="";
    if($("staffPassword")) $("staffPassword").value="";
    if($("signupPin")) $("signupPin").value="";
    if($("signupPin2")) $("signupPin2").value="";
    if($("signupPhone")) $("signupPhone").value="";
    if($("employeeUsername")) $("employeeUsername").selectedIndex=0;
    if($("staffUsername")) $("staffUsername").value="";
    if($("signupName")) $("signupName").selectedIndex=0;
    if($("signupPanel")) $("signupPanel").classList.add("hidden");
    loginMsg("");
  }catch(e){ console.warn("Clear shared-device login fields:",e); }
}

window.logout = async function(){
  try{
    clearSharedDeviceLoginFields();
    sessionStorage.clear();
    // Never keep an employee draft on a shared device after explicit logout.
    localStorage.removeItem(EMPLOYEE_DRAFT_KEY);
    clearListeners();
    await signOut(auth);
  }finally{
    currentUser=null;
    currentProfile=null;
    clearSharedDeviceLoginFields();
    if(!boardMode) hideApp();
  }
};

async function loadProfile(uid){
  const snap = await getDoc(doc(db,"users",uid));
  return snap.exists() ? snap.data() : null;
}
function clearListeners(){
  staffFirstSnapshot=true;
  knownPending=new Set();
  employeeKnownStatuses=new Map();

  unsubs.forEach(fn=>{ try{fn()}catch(e){} });
  unsubs=[];
  if(tipCheckPollTimer){ clearInterval(tipCheckPollTimer); tipCheckPollTimer=null; }
}
function hideApp(){
  $("loginView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  $("top").classList.add("hidden");
}
function showApp(){
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("top").classList.remove("hidden");
  $("whoText").textContent=currentProfile.displayName || currentProfile.username;
  $("rolePill").textContent=String(currentProfile.role).toUpperCase();

  const role=String(currentProfile.role||"");
  const emp=role==="employee";
  const cashier=role==="cashier";
  const owner=role==="owner";
  const manager=role==="manager";

  $("employeeApp").classList.toggle("hidden",!emp);
  $("staffApp").classList.toggle("hidden",emp);
  $("employeeBottom").classList.toggle("hidden",!emp);

  // Hard role isolation: employee must never see cashier/manager review controls.
  if(emp){
    $("staffApp").classList.add("hidden");
    document.querySelectorAll(".staffPanel").forEach(el=>el.classList.add("hidden"));
  }

  document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",!owner));
  document.querySelectorAll(".managerOwnerOnly").forEach(el=>el.classList.toggle("hidden",!(manager||owner)));
  document.querySelectorAll(".cashierOnly").forEach(el=>el.classList.toggle("hidden",!cashier));
  document.querySelectorAll(".tipReviewBlock").forEach(el=>el.classList.toggle("hidden",!(cashier||manager||owner)));

  if(emp){
    if($("eTipCheckEmployee")) $("eTipCheckEmployee").value=currentProfile.displayName||currentProfile.username||"";
    restoreEmployeeDraft();
    listenEmployee();
    listenTipCheckSheets();
    setEmployeeTab("shift");
  }else if(cashier){
    document.querySelectorAll("[data-stab]").forEach(b=>b.classList.toggle("hidden",!["tipCheck","setup"].includes(b.dataset.stab)));
    listenTipCheckSheets();
    document.querySelector('[data-stab="tipCheck"]')?.click();
  }else{
    document.querySelectorAll("[data-stab]").forEach(b=>b.classList.remove("hidden"));
    document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",!owner));
    listenStaff();
    listenTipCheckSheets();
  }
}
onAuthStateChanged(auth, async user=>{
  await authSecurityReady;
  // If this callback came from a stale persisted session that was just cleared, ignore it.
  if(user && !auth.currentUser) return;
  clearListeners();
  if(!user){
    currentUser=null; currentProfile=null;
    clearSharedDeviceLoginFields();
    if(!boardMode) hideApp();
    return;
  }
  if(user.isAnonymous){
    currentUser=user; currentProfile={role:"board",active:true,displayName:"Server Room Board"};
    if(boardMode) listenMoneyReadyBoard();
    return;
  }
  try{
    const profile=await loadProfile(user.uid);
    if(!profile){
      loginMsg("Account exists but no JUICY TIP profile was found.");
      await signOut(auth); return;
    }
    if(profile.role==="employee" && profile.approvalStatus==="pending"){
      loginMsg("Registration is waiting for Manager approval.");
      await signOut(auth); return;
    }
    if(profile.active===false){
      loginMsg("This account is disabled.");
      await signOut(auth); return;
    }
    currentUser=user;
    currentProfile=profile;
    loginMsg("");
    showApp();
  }catch(e){
    console.error("Profile load:",e);
    loginMsg(`Profile load failed: ${e.code || e.message}`);
    await signOut(auth);
  }
});

setTimeout(()=>startGlobalMoneyReadyWatcher(),50);


function isWeekendDate(dateStr){
  if(!dateStr)return false;
  const d=new Date(dateStr+"T12:00:00");
  const day=d.getDay();
  return day===0 || day===6;
}
function employeeAutoBusser(grand,totalAM,shift,dateStr){
  grand=Math.max(0,Number(grand)||0);
  totalAM=Math.max(0,Math.min(Number(totalAM)||0,grand));
  const weekend=isWeekendDate(dateStr);
  let amount=0, rate=0;
  if(weekend){
    amount=grand*0.015;
    rate=grand>0?0.015:0;
  }else if(shift==="PM"){
    amount=grand*0.015;
    rate=grand>0?0.015:0;
  }else if(shift==="AM"){
    amount=0; rate=0;
  }else if(["DOUBLE","LONG"].includes(shift)){
    amount=Math.max(0,grand-totalAM)*0.015;
    rate=grand>0?amount/grand:0;
  }
  return {amount,rate,weekend};
}
function updateEmployeeBusserPreview(){
  const box=$("employeeBusserPreview"), out=$("eBusserRate"), amt=$("eBusserAmount");
  if(!box||!out||!amt) return;
  const multi=["DOUBLE","LONG"].includes(eShift);
  box.classList.toggle("hidden",!multi);
  if(!multi){ out.textContent="0.00%"; amt.textContent="$0.00"; return; }
  const x=employeeAutoBusser($("eGrandTotal").value,$("eTotalAM").value,eShift,$("eDate").value);
  out.textContent=(x.rate*100).toFixed(2)+"%";
  amt.textContent="$"+x.amount.toFixed(2);
}
$("eGrandTotal").addEventListener("input",updateEmployeeBusserPreview);
$("eTotalAM").addEventListener("input",updateEmployeeBusserPreview);
$("eDate").addEventListener("change",updateEmployeeBusserPreview);


window.setEmployeeTab=function(name){
  const shift=name==="shift";
  $("employeeShiftContent")?.classList.toggle("hidden",!shift);
  $("employeeTipCheckContent")?.classList.toggle("hidden",shift);
  document.querySelectorAll("[data-etab]").forEach(b=>b.classList.toggle("on",b.dataset.etab===name));
  if(currentProfile?.role==="employee") $("employeeBottom")?.classList.toggle("hidden",!shift);
};
document.querySelectorAll("[data-etab]").forEach(btn=>btn.addEventListener("click",()=>setEmployeeTab(btn.dataset.etab)));


const TIP_TABLE_GROUPS=Object.freeze([
  ["A",["A1","A2","A3","A4"]],
  ["B",["B1","B2","B3"]],
  ["Bar",Array.from({length:12},(_,i)=>`Bar${i+1}`)],
  ["C",["C1","C2","C3","C4"]],
  ["D",["D1","D2","D3"]],
  ["E",["E1","E2","E3","E4","E5"]],
  ["H",["H1","H2","H3","H4"]],
  ["L",["L1","L2","L3","L4","L5","L6"]],
  ["M",["M1","M2"]],
  ["R",["R1","R2","R3","R4","R5","R6","R7"]]
]);
function tipTableOptions(selected=""){
  return `<option value="">Select Table</option>`+TIP_TABLE_GROUPS.map(([label,vals])=>
    `<optgroup label="${label}">${vals.map(v=>`<option value="${v}" ${v===selected?"selected":""}>${v}</option>`).join("")}</optgroup>`
  ).join("");
}

window.setEmployeeTab=function(name){
  const shift=name==="shift";
  $("employeeShiftContent")?.classList.toggle("hidden",!shift);
  $("employeeTipCheckContent")?.classList.toggle("hidden",shift);
  document.querySelectorAll("[data-etab]").forEach(b=>b.classList.toggle("on",b.dataset.etab===name));
  if(currentProfile?.role==="employee") $("employeeBottom")?.classList.toggle("hidden",!shift);
};
document.querySelectorAll("[data-etab]").forEach(btn=>btn.addEventListener("click",()=>setEmployeeTab(btn.dataset.etab)));

function renderTipEntryRows(tbodyId,prefix,rows=[]){
  const tbody=$(tbodyId); if(!tbody)return;
  tbody.innerHTML=Array.from({length:50},(_,i)=>{
    const r=rows[i]||{};
    return `<tr><td>${i+1}</td>
      <td><input id="${prefix}Check${i}" value="${esc(r.checkNumber||"")}" placeholder="Check #"></td>
      <td><select id="${prefix}Table${i}">${tipTableOptions(r.table||"")}</select></td>
      <td><input id="${prefix}Tip${i}" type="number" min="0" step=".01" inputmode="decimal" value="${Number(r.tip||0)||""}" placeholder="0.00"></td>
    </tr>`;
  }).join("");
}
function readTipEntryRows(prefix){
  const rows=[];
  for(let i=0;i<50;i++){
    const checkNumber=String($(`${prefix}Check${i}`)?.value||"").trim();
    const table=String($(`${prefix}Table${i}`)?.value||"").trim();
    const tip=Number($(`${prefix}Tip${i}`)?.value||0);
    if(checkNumber||table||tip>0) rows.push({line:i+1,checkNumber,table,tip:Number.isFinite(tip)?tip:0,result:""});
  }
  return rows;
}
function clearTipEntryRows(prefix){
  for(let i=0;i<50;i++){
    if($(`${prefix}Check${i}`)) $(`${prefix}Check${i}`).value="";
    if($(`${prefix}Table${i}`)) $(`${prefix}Table${i}`).value="";
    if($(`${prefix}Tip${i}`)) $(`${prefix}Tip${i}`).value="";
  }
}
renderTipEntryRows("eTipCheckRows","eTC");
renderTipEntryRows("sTipCheckRows","sTC");
if($("eTipCheckDate")) $("eTipCheckDate").value=todayLocal();
if($("sTipCheckDate")) $("sTipCheckDate").value=todayLocal();

window.clearEmployeeTipCheck=function(){ clearTipEntryRows("eTC"); if($("eTipCheckDate")) $("eTipCheckDate").value=todayLocal(); };
window.clearStaffTipCheckForm=function(){
  tipCheckEditId="";
  if($("staffTipCheckEditId")) $("staffTipCheckEditId").value="";
  if($("sTipCheckMode")) $("sTipCheckMode").value="NEW SHEET";
  if($("staffTipCheckSubmitBtn")) $("staffTipCheckSubmitBtn").textContent="Submit to Cashier";
  clearTipEntryRows("sTC");
  if($("sTipCheckDate")) $("sTipCheckDate").value=todayLocal();
};

// Employee shift UI
document.querySelectorAll("[data-eshift]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    eShift=btn.dataset.eshift;
    document.querySelectorAll("[data-eshift]").forEach(x=>x.classList.remove("on"));
    btn.classList.add("on");
    refreshClockMode();
  });
});
$("eBreakMode").addEventListener("change",refreshClockMode);

function refreshClockMode(){
  const multi=["DOUBLE","LONG"].includes(eShift);
  $("singleClock").classList.toggle("hidden",multi);
  $("longDoubleOptions").classList.toggle("hidden",!multi);
  $("totalAmWrap").classList.toggle("hidden",!multi);
  $("eBarAMWrap").classList.toggle("hidden",!(eShift==="AM"||multi));
  $("eBarPMWrap").classList.toggle("hidden",!(eShift==="PM"||multi));
  if(eShift==="AM") $("eBarPM").checked=false;
  if(eShift==="PM") $("eBarAM").checked=false;
  updateEmployeeBusserPreview();
  if(!multi){
    $("continuousClock").classList.add("hidden");
    $("doubleClock").classList.add("hidden");
    return;
  }
  const withBreak=$("eBreakMode").value==="with";
  $("continuousClock").classList.toggle("hidden",withBreak);
  $("doubleClock").classList.toggle("hidden",!withBreak);
}

document.querySelectorAll("[data-stab]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll("[data-stab]").forEach(x=>x.classList.remove("on"));
    btn.classList.add("on");
    document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
    $(btn.dataset.stab).classList.remove("hidden");
  });
});


const EMPLOYEE_DRAFT_KEY="fredTipEmployeeDraftV103";
function saveEmployeeDraft(){
  if(!currentProfile || currentProfile.role!=="employee") return;
  const ids=["eDate","ePosition","eBreakMode","eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut","eGrandTotal","eTotalAM","eMeal","eCash"];
  const d={shift:eShift,barAM:!!$("eBarAM")?.checked,barPM:!!$("eBarPM")?.checked};
  ids.forEach(id=>{if($(id))d[id]=$(id).value;});
  try{localStorage.setItem(EMPLOYEE_DRAFT_KEY,JSON.stringify(d));}catch(e){}
}
function restoreEmployeeDraft(){
  try{
    const d=JSON.parse(localStorage.getItem(EMPLOYEE_DRAFT_KEY)||"null");
    if(!d)return;
    Object.entries(d).forEach(([k,v])=>{
      if(k==="shift"||k==="barAM"||k==="barPM")return;
      if($(k))$(k).value=v;
    });
    if(d.shift)eShift=d.shift;
    if($("eBarAM"))$("eBarAM").checked=!!d.barAM;
    if($("eBarPM"))$("eBarPM").checked=!!d.barPM;
    document.querySelectorAll("[data-eshift]").forEach(b=>b.classList.toggle("on",b.dataset.eshift===eShift));
    refreshClockMode();
  }catch(e){}
}
document.addEventListener("input",e=>{if(e.target?.closest?.("#employeeApp"))saveEmployeeDraft();});
document.addEventListener("change",e=>{if(e.target?.closest?.("#employeeApp"))saveEmployeeDraft();});

function clockText(){
  if(["DOUBLE","LONG"].includes(eShift)){
    if($("eBreakMode").value==="with"){
      return `${$("eAmIn").value||"--"}–${$("eAmOut").value||"--"} / ${$("ePmIn").value||"--"}–${$("ePmOut").value||"--"}`;
    }
    return `${$("eContIn").value||"--"}–${$("eContOut").value||"--"}`;
  }
  return `${$("eIn").value||"--"}–${$("eOut").value||"--"}`;
}

window.clearEmployeeForm=function(){
  localStorage.removeItem(EMPLOYEE_DRAFT_KEY);
  try{
    ["eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut"].forEach(id=>{ const e=$(id); if(e)e.value=""; });
    ["eMeal","eCash","eGrandTotal","eTotalAM"].forEach(id=>{ const e=$(id); if(e)e.value="0"; });
    ["eBarAM","eBarPM"].forEach(id=>{ const e=$(id); if(e)e.checked=false; });
    if($("eDate")) $("eDate").value=todayLocal();
    if($("ePosition")) $("ePosition").value="Server";
    eShift="AM";
    document.querySelectorAll("[data-eshift]").forEach(b=>b.classList.toggle("on",b.dataset.eshift==="AM"));
    if($("eBreakMode")) $("eBreakMode").value="without";
    refreshClockMode();
    updateEmployeeBusserPreview();
    const first=$("eIn"); if(first) first.focus();
  }catch(e){
    console.error("Clear employee form:",e);
    alert("Could not clear the form. Please refresh once and try again.");
  }
};

async function writeAudit(action,submissionId,employee,details={}){
  if(!currentUser || !currentProfile) return;
  const ref=doc(collection(db,"auditLogs"));
  await setDoc(ref,{
    action,
    submissionId:submissionId||"",
    employee:employee||"",
    actorUid:currentUser.uid,
    actor:currentProfile.displayName||currentProfile.username,
    actorRole:currentProfile.role,
    details,
    createdAt:serverTimestamp()
  });
}

window.submitEmployee=async function(){
  const isMulti=["DOUBLE","LONG"].includes(eShift);
  const r={
    employeeUid:currentUser.uid,
    employee:currentProfile.displayName||currentProfile.username,
    date:$("eDate").value,
    position:$("ePosition").value,
    shift:eShift,
    breakMode:isMulti ? $("eBreakMode").value : "none",
    clock:clockText(),
    grandTotal:Number($("eGrandTotal").value)||0,
    totalAM:isMulti ? (Number($("eTotalAM").value)||0) : 0,
    barSalesAM:$("eBarAM").checked,
    barSalesPM:$("eBarPM").checked,
    meal:Number($("eMeal").value)||0,
    cashTip:Number($("eCash").value)||0,
    status:"pending",
    reviewedBy:"",
    reviewedAt:null,
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
  if(!r.date){ alert("Select date."); return; }
  try{
    const ref=doc(collection(db,"submissions"));
    await setDoc(ref,r);
    await writeAudit("employee_submit",ref.id,r.employee,{after:r});
    localStorage.removeItem(EMPLOYEE_DRAFT_KEY);
    clearEmployeeForm();
    alert("Employee submission sent. This shared tablet is now signed out.");
    try{
      localStorage.removeItem(EMPLOYEE_DRAFT_KEY);
      sessionStorage.clear();
      await signOut(auth);
    }catch(e){ console.warn("Post-submit logout:",e); }
  }catch(e){
    console.error(e);
    alert(`Submit failed: ${e.code || e.message}`);
  }
};


function employeeFinalReportHTML(r){
  const f=r.finalReport||{};
  const money=v=>"$"+Number(v||0).toFixed(2);
  const pct=v=>(Number(v||0)*100).toFixed(2)+"%";
  return `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
      <div>
        <h2 style="margin:0">My Final Tip Report</h2>
        <div class="small">${esc(r.date||"")} • ${esc(r.position||"")} • ${esc(r.shift||"")}</div>
      </div>
      <span class="status approved">MONEY READY</span>
    </div>
    <div class="notice good" style="margin-top:14px">
      <b>Money is ready. Please come to cashier.</b>
    </div>
    <div class="grid3" style="margin-top:14px">
      <div class="kpi"><span>Grand Total</span><b>${money(f.grandTotal ?? r.grandTotal)}</b></div>
      ${["DOUBLE","LONG"].includes(r.shift)?`<div class="kpi"><span>Total AM</span><b>${money(f.totalAM ?? r.totalAM)}</b></div>`:""}
      <div class="kpi"><span>Meal</span><b>${money(f.meal ?? r.meal)}</b></div>
      <div class="kpi"><span>Cash Tip</span><b>${money(f.cashTip ?? r.cashTip)}</b></div>
      <div class="kpi"><span>Busser Rate</span><b>${pct(f.busserRate)}</b></div>
      <div class="kpi"><span>Busser Tip Out</span><b>${money(f.busserTipOut)}</b></div>
      <div class="kpi"><span>Bar Tip Out</span><b>${money(f.barTipOut)}</b></div>
      <div class="kpi"><span>Hourly Adjustment</span><b>${money(f.adjustmentSalaryHourly)}</b></div>
      <div class="kpi"><span>TOTAL PAID OUT</span><b>${money(f.totalPaidOut)}</b></div>
    </div>
    <div class="actions" style="margin-top:14px">
      <button class="btn light" type="button" onclick="startNewEmployeeReport('${r.id}')">New Tip Report</button>
    </div>`;
}

window.startNewEmployeeReport=function(finalSubmissionId){
  sessionStorage.setItem("employeeFinalSeen:"+finalSubmissionId,"1");
  $("employeeReadyReport")?.classList.add("hidden");
  $("employeeEntryCard")?.classList.remove("hidden");
  $("employeeBottom")?.classList.remove("hidden");
  clearEmployeeForm();
};

function listenEmployee(){
  // Avoid composite-index requirement; sort client-side.
  const q=query(collection(db,"submissions"),where("employeeUid","==",currentUser.uid),limit(50));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    rows.sort((a,b)=>{
      const aa=a.createdAt?.seconds||0, bb=b.createdAt?.seconds||0;
      return bb-aa;
    });

    // Realtime employee-side alerts for Manager/Owner actions.
    for(const r of rows){
      const previous=employeeKnownStatuses.get(r.id);
      const current=String(r.status||"");
      if(previous && previous!==current){
        if(current==="money_ready"){
          realtimePhoneAlert(
            "Money Ready",
            "Your tip money is ready. Please come to cashier.",
            "money"
          );
        }else if(current==="hourly_pending" || current==="approved"){
          realtimePhoneAlert(
            "Tip Report Approved",
            "Manager approved your tip report and it is being processed.",
            "normal"
          );
        }else if(current==="rejected"){
          realtimePhoneAlert(
            "Tip Report Needs Attention",
            "Manager rejected your report. Please check with Manager.",
            "warning"
          );
        }
      }
      employeeKnownStatuses.set(r.id,current);
    }
    // Remove deleted IDs from local status memory.
    const liveIds=new Set(rows.map(r=>r.id));
    for(const id of [...employeeKnownStatuses.keys()]){
      if(!liveIds.has(id)) employeeKnownStatuses.delete(id);
    }

    const latestFinal=rows.find(r=>r.status==="money_ready");
    const finalBox=$("employeeReadyReport");
    const entry=$("employeeEntryCard");
    const bottom=$("employeeBottom");

    if(latestFinal && !sessionStorage.getItem("employeeFinalSeen:"+latestFinal.id)){
      if(finalBox){
        finalBox.innerHTML=employeeFinalReportHTML(latestFinal);
        finalBox.classList.remove("hidden");
      }
      entry?.classList.add("hidden");
      bottom?.classList.add("hidden");
    }else{
      finalBox?.classList.add("hidden");
      entry?.classList.remove("hidden");
      bottom?.classList.remove("hidden");
    }

    // Employee current list contains only items still in process.
    const active=rows.filter(r=>r.status!=="money_ready").slice(0,10);
    $("mySubmissions").innerHTML=active.length?active.map(r=>`
      <div style="padding:12px 0;border-bottom:1px solid #edf0f4;display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <b>${esc(r.date)} • ${esc(r.shift)}</b>
          <div class="small">${esc(r.clock)} • Grand ${fmtMoney(r.grandTotal)}
          ${["DOUBLE","LONG"].includes(r.shift)?` • AM ${fmtMoney(r.totalAM)}`:""}
          • Meal $${Number(r.meal||0).toFixed(2)} • Cash $${Number(r.cashTip||0).toFixed(2)}
          • <span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
        </div>
        <button class="btn red" type="button" onclick="deleteMySubmission('${r.id}')">Delete</button>
      </div>`).join(""):'<div class="small">No report currently in process.</div>';

    if(latestFinal && !sessionStorage.getItem("moneyReady:"+latestFinal.id)){
      sessionStorage.setItem("moneyReady:"+latestFinal.id,"1");
    }
  },e=>console.error("Employee listener:",e)));
}


window.deleteMySubmission=async function(id){
  if(currentProfile?.role!=="employee"){
    alert("Employee account required.");
    return;
  }

  try{
    const ref=doc(db,"submissions",id);
    const snap=await getDoc(ref);

    if(!snap.exists()){
      alert("This report no longer exists.");
      return;
    }

    const before=snap.data();

    if(before.employeeUid!==currentUser.uid){
      alert("You can only delete your own report.");
      return;
    }

    if(before.status==="money_ready"){
      alert("A finalized Money Ready report cannot be deleted by Employee. Please contact Manager/Owner.");
      return;
    }

    const label=`${before.date||""} • ${before.shift||""}`;
    if(!confirm(`Delete your report?\n\n${label}\n\nThis removes only this report. It does NOT delete your employee account.`)) return;

    await deleteDoc(ref);

    try{
      await writeAudit("employee_delete_own_submission",id,before.employee||currentProfile.displayName||"",{before});
    }catch(e){
      console.warn("Audit log skipped after employee delete:",e);
    }

    alert("Your report was deleted.");
  }catch(e){
    alert(`Delete failed: ${e.code||e.message}`);
  }
};


function ensureRealtimeAlertAudio(){
  try{
    realtimeAlertCtx=realtimeAlertCtx||new (window.AudioContext||window.webkitAudioContext)();
    if(realtimeAlertCtx.state==="suspended") realtimeAlertCtx.resume();
    realtimeAlertsEnabled=true;
    return true;
  }catch(e){
    console.warn("Realtime alert audio:",e);
    return false;
  }
}

function realtimeAlertSound(kind="normal"){
  if(!realtimeAlertCtx || realtimeAlertCtx.state!=="running") return;
  const now=realtimeAlertCtx.currentTime;
  const notes=kind==="money"
    ? [784,988,1175,1319]
    : kind==="warning"
      ? [523,392,523]
      : [659,784,988];

  notes.forEach((freq,i)=>{
    const o=realtimeAlertCtx.createOscillator();
    const g=realtimeAlertCtx.createGain();
    o.type="sine";
    o.frequency.value=freq;
    const t=now+i*.16;
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(.22,t+.025);
    g.gain.exponentialRampToValueAtTime(.0001,t+.38);
    o.connect(g);
    g.connect(realtimeAlertCtx.destination);
    o.start(t);
    o.stop(t+.42);
  });
}

function realtimePhoneAlert(title,body,kind="normal"){
  // Vibration works on supported Android Chrome/PWA devices.
  try{
    if(navigator.vibrate){
      navigator.vibrate(kind==="money"
        ? [250,120,250,120,500]
        : kind==="warning"
          ? [400,150,400]
          : [220,100,220]);
    }
  }catch(e){}

  realtimeAlertSound(kind);

  if(typeof Notification!=="undefined" && Notification.permission==="granted"){
    try{
      new Notification(title,{
        body,
        icon:"icon-192.png",
        badge:"icon-192.png",
        tag:title+":"+body,
        renotify:true,
        vibrate:kind==="money"?[250,120,250,120,500]:[220,100,220]
      });
    }catch(e){ console.warn("Notification:",e); }
  }
}


function pushDeviceId(){
  let id=localStorage.getItem("fzPushDeviceId");
  if(!id){
    id=(crypto?.randomUUID?.()||("dev-"+Date.now()+"-"+Math.random().toString(36).slice(2)));
    localStorage.setItem("fzPushDeviceId",id);
  }
  return id;
}

function pushDeviceLabel(){
  const ua=navigator.userAgent||"";
  if(/iPhone/i.test(ua)) return "iPhone";
  if(/iPad/i.test(ua)) return "iPad";
  if(/Android/i.test(ua)) return "Android";
  if(/Windows/i.test(ua)) return "Windows";
  if(/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  return "Web Browser";
}

async function enableBackgroundPush(){
  if(!currentUser || currentUser.isAnonymous || !currentProfile){
    throw new Error("Please login as Employee, Manager, or Owner first.");
  }

  if(PUSH_VAPID_PUBLIC_KEY.includes("PASTE_WEB_PUSH")){
    throw new Error("Web Push VAPID public key has not been configured yet.");
  }

  if(!("Notification" in window) || !("serviceWorker" in navigator)){
    throw new Error("This browser does not support Web Push notifications.");
  }

  const supported=await isMessagingSupported();
  if(!supported) throw new Error("Firebase Messaging is not supported on this browser/device.");

  let permission=Notification.permission;
  if(permission!=="granted"){
    permission=await Notification.requestPermission();
  }
  if(permission!=="granted"){
    throw new Error("Notification permission was not granted.");
  }

  const swReg=await navigator.serviceWorker.register("./service-worker.js");
  await navigator.serviceWorker.ready;

  messagingInstance=messagingInstance||getMessaging(firebaseApp);
  const token=await getToken(messagingInstance,{
    vapidKey:PUSH_VAPID_PUBLIC_KEY,
    serviceWorkerRegistration:swReg
  });
  if(!token) throw new Error("Firebase did not return a push token.");

  await registerPushDevice({
    token,
    deviceId:pushDeviceId(),
    deviceLabel:pushDeviceLabel(),
    userAgent:(navigator.userAgent||"").slice(0,300)
  });

  localStorage.setItem("fzBackgroundPushEnabled","1");
  return true;
}

window.requestNotify=async function(){
  ensureRealtimeAlertAudio();
  try{
    await enableBackgroundPush();

    try{ navigator.vibrate?.([180,80,180]); }catch(e){}
    realtimeAlertSound("normal");

    alert(
      "Background notifications are enabled on this device.\n\n"+
      "Push alerts can arrive when the app is in the background or the phone is locked."
    );
  }catch(e){
    console.error("Background push:",e);
    alert("Background notification setup failed: "+(e.message||e));
  }
};
function notifyManager(r){
  realtimePhoneAlert(
    "New Tip Report Submitted",
    `${r.employee} — ${r.shift}. Please review.`,
    "normal"
  );
}



function tipCheckStatusLabel(status){ return status==="cashier_completed"?"CASHIER COMPLETED":"WAITING CASHIER"; }
function tipResultLabel(v){
  return v==="done"?"Done":v==="no_signature"?"No Signature":v==="ticket_not_found"?"Ticket Not Found":"Not Checked";
}
function tipIssueCount(sheet){
  return (sheet.rows||[]).filter(r=>r.result && r.result!=="done").length;
}
function resultBadge(result){
  const label=tipResultLabel(result);
  const cls=result==="done"?"approved":result?"rejected":"pending";
  return `<span class="status ${cls}">${label}</span>`;
}

window.submitEmployeeTipCheck=async function(){
  if(currentProfile?.role!=="employee"){alert("Employee login required.");return;}
  const rows=readTipEntryRows("eTC"), date=$("eTipCheckDate")?.value||todayLocal();
  if(!rows.length){alert("Enter at least one Check Number / Table / Tip line.");return;}
  try{
    await saveTipCheckSheetApi({date,rows});
    clearEmployeeTipCheck();
    await loadTipCheckSheets();
    alert("Check Tip sheet submitted to Cashier.");
  }catch(e){alert(`Check Tip submit failed: ${e.message||e.code}`);}
};

window.submitStaffTipCheck=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||"")){alert("Manager/Owner only.");return;}
  const employeeName=$("sTipCheckEmployee")?.value||"", date=$("sTipCheckDate")?.value||todayLocal(), rows=readTipEntryRows("sTC");
  if(!employeeName){alert("Select an employee.");return;}
  if(!rows.length){alert("Enter at least one Check Number / Table / Tip line.");return;}
  try{
    await saveTipCheckSheetApi({sheetId:tipCheckEditId||"",date,employeeName,rows});
    clearStaffTipCheckForm();
    await loadTipCheckSheets();
    alert(tipCheckEditId?"Check Tip sheet updated.":"Check Tip sheet submitted to Cashier.");
  }catch(e){alert(`Check Tip save failed: ${e.message||e.code}`);}
};

function renderEmployeeTipCheckStatus(){
  const el=$("employeeTipCheckStatus"); if(!el || currentProfile?.role!=="employee")return;

  const grouped=new Map();
  latestTipCheckSheets.forEach(sheet=>{
    const date=sheet.date||"";
    if(!grouped.has(date)) grouped.set(date,[]);
    grouped.get(date).push(sheet);
  });

  const groups=[...grouped.entries()]
    .sort((a,b)=>String(b[0]).localeCompare(String(a[0])))
    .slice(0,10);

  el.innerHTML=groups.length?groups.map(([date,sheets])=>{
    // Only real sheets with active ticket rows determine Employee completion.
    // Old/stale empty sheets must not keep a completed date stuck on WAITING CASHIER.
    const activeSheets=sheets.filter(s=>Array.isArray(s.rows) && s.rows.length>0);
    const allRows=[];
    activeSheets.forEach(s=>(s.rows||[]).forEach(r=>allRows.push(r)));

    const totalTip=allRows.reduce((sum,r)=>sum+Number(r.tip||0),0);
    const doneRows=allRows.filter(r=>r.result==="done");
    const noSigRows=allRows.filter(r=>r.result==="no_signature");
    const notFoundRows=allRows.filter(r=>r.result==="ticket_not_found");
    const approvedTip=doneRows.reduce((sum,r)=>sum+Number(r.tip||0),0);
    const allCompleted=activeSheets.length>0 && activeSheets.every(s=>s.status==="cashier_completed");
    const issueCount=noSigRows.length+notFoundRows.length;

    if(!activeSheets.length) return "";
    return `<div class="tip-check-sheet">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <b style="font-size:20px">${esc(date)}</b>
        <span class="status ${allCompleted?"approved":"pending"}">${allCompleted?"CASHIER COMPLETED":"WAITING CASHIER"}</span>
      </div>

      <div class="small" style="margin-top:5px">
        ${allRows.length} ticket(s) • Submitted ${fmtMoney(totalTip)} • Approved ${fmtMoney(approvedTip)}
      </div>

      ${allCompleted?`
        <div class="notice ${issueCount?"warning":"good"}" style="margin-top:10px">
          <b>Cashier has uploaded your tips into the system. Please check.</b>
          <div style="margin-top:5px">
            Done: ${doneRows.length} • No Signature: ${noSigRows.length} • Ticket Not Found: ${notFoundRows.length}
          </div>
        </div>

        <div class="tablewrap" style="margin-top:10px"><table>
          <thead><tr><th>#</th><th>Check Number</th><th>Table</th><th>Tip</th><th>Cashier Result</th></tr></thead>
          <tbody>${allRows.map((x,i)=>`<tr class="${x.result&&x.result!=="done"?"tip-check-row-problem":""}">
            <td>${i+1}</td>
            <td>${esc(x.checkNumber||"")}</td>
            <td>${esc(x.table||"")}</td>
            <td>${fmtMoney(x.tip||0)}</td>
            <td>${resultBadge(x.result)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      `:""}
    </div>`;
  }).join(""):'<div class="small">No Check Tip sheets yet.</div>';
}

function cashierSheetHtml(r){
  const activeRows=Array.isArray(r.rows)?r.rows:[];
  const completed=r.status==="cashier_completed";
  const canEdit=["cashier","manager","owner"].includes(currentProfile?.role||"");
  return `<div class="tip-check-sheet" data-cashier-sheet="${r.id}">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
      <div><b style="font-size:18px">${esc(r.employeeName||"")}</b>
        <div class="small">${esc(r.date||"")} • ${activeRows.length} line(s) • Total ${fmtMoney(r.totalTip||0)}${r.cashierBy?` • Last Cashier: ${esc(r.cashierBy)}`:""}</div>
      </div>
      <span class="status ${completed?"approved":"pending"}">${tipCheckStatusLabel(r.status)}</span>
    </div>
    <div class="tablewrap" style="margin-top:10px"><table>
      <thead><tr><th>#</th><th>Check Number</th><th>Table</th><th>Tip</th><th>Cashier Result</th>${canEdit?"<th>Actions</th>":""}</tr></thead>
      <tbody>${activeRows.map((x,i)=>`<tr class="${x.result&&x.result!=="done"?"tip-check-row-problem":""}">
        <td>${x.line||i+1}</td><td>${esc(x.checkNumber||"")}</td><td>${esc(x.table||"")}</td><td>${fmtMoney(x.tip||0)}</td>
        <td><select class="cashier-line-result" data-index="${i}">
          <option value="">Select Result</option>
          <option value="done" ${x.result==="done"?"selected":""}>Done</option>
          <option value="no_signature" ${x.result==="no_signature"?"selected":""}>No Signature</option>
          <option value="ticket_not_found" ${x.result==="ticket_not_found"?"selected":""}>Ticket Not Found</option>
        </select></td>
        ${canEdit?`<td><button class="btn light" type="button" onclick="saveTipCheckRow('${r.id}',${i})">Save Row</button>
        <button class="btn red" type="button" onclick="deleteTipCheckRow('${r.id}',${i})">Delete Row</button></td>`:""}
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="notice" style="margin-top:10px">${completed
      ? "This completed report remains in Cashier history for later review. You may correct a row and save it again."
      : "Every row must have one result: Done, No Signature, or Ticket Not Found."}</div>
    <div class="actions" style="margin-top:10px">
      ${!completed?`<button class="btn green" type="button" onclick="submitCashierTipCheck('${r.id}')">Submit Completed Checklist</button>`:""}
      ${completed?`<button class="btn light" type="button" onclick="reopenTipCheckSheet('${r.id}')">Reopen for Review</button>`:""}
      ${["manager","owner"].includes(currentProfile?.role||"")?`<button class="btn red" type="button" onclick="deleteTipCheckSheet('${r.id}')">Delete Report</button>`:""}
    </div>
  </div>`;
}
function renderCashierTipCheckQueue(){
  const el=$("cashierTipCheckQueue"); if(!el || !["cashier","manager","owner"].includes(currentProfile?.role||""))return;
  const sheets=latestTipCheckSheets;
  el.innerHTML=sheets.length?sheets.map(cashierSheetHtml).join(""):'<div class="notice good">No Check Tip sheets yet.</div>';
}
window.submitCashierTipCheck=async function(id){
  if(!["cashier","manager","owner"].includes(currentProfile?.role||"")){alert("Cashier/Manager/Owner login required.");return;}
  const sheet=latestTipCheckSheets.find(r=>r.id===id); if(!sheet)return;
  const wrap=document.querySelector(`[data-cashier-sheet="${id}"]`);
  const selects=[...(wrap?.querySelectorAll(".cashier-line-result")||[])];
  if(!selects.length){alert("No active lines.");return;}
  const results=selects.map(s=>s.value);
  if(results.some(v=>!v)){alert("Please select Done, No Signature, or Ticket Not Found for every row.");return;}
  try{
    await completeTipCheckSheetApi({sheetId:id,results});
    await loadTipCheckSheets();
    alert("Checklist submitted. Employee will receive the completed results.");
  }catch(e){alert(`Cashier submit failed: ${e.message||e.code}`);}
};



window.completeGroupedTipCheck=async function(sheetIds){
  if(!["cashier","manager","owner"].includes(currentProfile?.role||"")){
    alert("Cashier/Manager/Owner login required.");
    return false;
  }
  const ids=[...new Set((sheetIds||[]).map(String).filter(Boolean))];
  if(!ids.length){alert("No Check Tip report found.");return false;}

  const target=ids.map(id=>latestTipCheckSheets.find(s=>String(s.id)===id)).filter(Boolean);
  if(!target.length){alert("No Check Tip report found.");return false;}

  for(const sheet of target){
    const results=(sheet.rows||[]).map(r=>r.result||"");
    if(!results.length){alert("No active ticket lines.");return false;}
    if(results.some(v=>!v)){
      alert("Every ticket must be Saved as Done, No Signature, or Ticket Not Found before completing the checklist.");
      return false;
    }
  }

  try{
    for(const sheet of target){
      if(sheet.status!=="cashier_completed"){
        const results=(sheet.rows||[]).map(r=>r.result||"");
        await completeTipCheckSheetApi({sheetId:sheet.id,results});
      }
    }
    await loadTipCheckSheets();
    return true;
  }catch(e){
    alert(`Cashier submit failed: ${e.message||e.code}`);
    return false;
  }
};

window.saveTipCheckRow=async function(sheetId,rowIndex,resultOverride=""){
  if(!["cashier","manager","owner"].includes(currentProfile?.role||""))return false;
  let result=String(resultOverride||"").trim();
  if(!result){
    const wrap=document.querySelector(`[data-cashier-sheet="${sheetId}"]`);
    const sel=wrap?.querySelector(`.cashier-line-result[data-index="${rowIndex}"]`);
    result=sel?.value||"";
  }
  if(!result){alert("Select Done, No Signature, or Ticket Not Found.");return false;}
  try{
    await updateTipCheckRowApi({sheetId,rowIndex:Number(rowIndex),result,deleteRow:false});
    await loadTipCheckSheets();
    return true;
  }catch(e){
    alert(`Row update failed: ${e.message||e.code}`);
    return false;
  }
};
window.deleteTipCheckRow=async function(sheetId,rowIndex){
  if(!["cashier","manager","owner"].includes(currentProfile?.role||""))return;
  if(!confirm("Delete this tip row?"))return;
  try{
    await updateTipCheckRowApi({sheetId,rowIndex,deleteRow:true});
    await loadTipCheckSheets();
  }catch(e){alert(`Delete row failed: ${e.message||e.code}`);}
};
window.reopenTipCheckSheet=async function(sheetId){
  if(!["cashier","manager","owner"].includes(currentProfile?.role||""))return;
  if(!confirm("Reopen this completed report for another review?"))return;
  try{
    await reopenTipCheckSheetApi({sheetId});
    await loadTipCheckSheets();
  }catch(e){alert(`Reopen failed: ${e.message||e.code}`);}
};

function renderOwnerTipCheckRecords(){
  const el=$("ownerTipCheckRecords"); if(!el || currentProfile?.role!=="owner")return;
  el.innerHTML=latestTipCheckSheets.length?latestTipCheckSheets.map(r=>{
    const issues=tipIssueCount(r);
    return `<div class="tip-check-sheet">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div>
        <b style="font-size:18px">${esc(r.employeeName||"")}</b>
        <div class="small">${esc(r.date||"")} • ${tipCheckStatusLabel(r.status)} • ${Number(r.rowCount||r.rows?.length||0)} lines • ${fmtMoney(r.totalTip||0)}${r.status==="cashier_completed"?` • ${issues} issue(s)`:""}</div>
        <div class="small">Submitted by ${esc(r.submittedByName||"")} (${esc(r.submittedByRole||"")})${r.cashierBy?` • Cashier: ${esc(r.cashierBy)}`:""}</div>
      </div><div class="actions">
        <button class="btn light" type="button" onclick="editTipCheckSheet('${r.id}')">Edit</button>
        <button class="btn red" type="button" onclick="deleteTipCheckSheet('${r.id}')">Delete</button>
      </div></div>
      ${r.status==="cashier_completed"?`<div class="tablewrap" style="margin-top:8px"><table>
        <thead><tr><th>#</th><th>Check Number</th><th>Table</th><th>Tip</th><th>Cashier Result</th></tr></thead>
        <tbody>${(r.rows||[]).map((x,i)=>`<tr class="${x.result&&x.result!=="done"?"tip-check-row-problem":""}">
          <td>${i+1}</td><td>${esc(x.checkNumber||"")}</td><td>${esc(x.table||"")}</td><td>${fmtMoney(x.tip||0)}</td><td>${resultBadge(x.result)}</td>
        </tr>`).join("")}</tbody></table></div>`:""}
    </div>`;
  }).join(""):'<div class="small">No Check Tip records.</div>';
}

window.editTipCheckSheet=function(id){
  if(currentProfile?.role!=="owner")return;
  const r=latestTipCheckSheets.find(x=>x.id===id); if(!r)return;
  tipCheckEditId=id;
  $("staffTipCheckEditId").value=id;
  $("sTipCheckMode").value="EDIT EXISTING";
  $("sTipCheckDate").value=r.date||todayLocal();
  $("sTipCheckEmployee").value=r.employeeName||"";
  renderTipEntryRows("sTipCheckRows","sTC",r.rows||[]);
  $("staffTipCheckSubmitBtn").textContent="Save Changes";
  document.querySelector('[data-stab="tipCheck"]')?.click();
  $("tipCheckManagerBlock")?.scrollIntoView({behavior:"smooth",block:"start"});
};
window.deleteTipCheckSheet=async function(id){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  if(!confirm("Delete this Check Tip sheet?"))return;
  try{await deleteTipCheckSheetApi({sheetId:id});await loadTipCheckSheets();}catch(e){alert(`Delete failed: ${e.message||e.code}`);}
};
window.clearAllTipCheckSheets=async function(){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  if(!confirm(`CLEAR ALL CHECK TIP RECORDS?\n\nDelete ${latestTipCheckSheets.length} record(s)?`))return;
  try{await clearTipCheckSheetsApi({});await loadTipCheckSheets();alert("All Check Tip records cleared.");}catch(e){alert(`Clear All failed: ${e.message||e.code}`);}
};

function tipCheckExportRows(){
  const out=[];
  latestTipCheckSheets.forEach(s=>(s.rows||[]).forEach(r=>out.push({
    date:s.date||"",employee:s.employeeName||"",status:tipCheckStatusLabel(s.status),
    checkNumber:r.checkNumber||"",table:r.table||"",tip:Number(r.tip||0),
    cashierResult:tipResultLabel(r.result),cashier:s.cashierBy||"",submittedBy:s.submittedByName||""
  })));
  return out;
}
function tipCheckXlsBlob(){
  const rows=tipCheckExportRows(),escXml=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const headers=["Date","Employee","Status","Check Number","Table","Tip","Cashier Result","Cashier","Submitted By"];
  const xmlRows=[headers,...rows.map(r=>[r.date,r.employee,r.status,r.checkNumber,r.table,Number(r.tip||0).toFixed(2),r.cashierResult,r.cashier,r.submittedBy])]
    .map(row=>`<Row>${row.map(v=>`<Cell ss:StyleID="Arial14"><Data ss:Type="String">${escXml(v)}</Data></Cell>`).join("")}</Row>`).join("");
  return new Blob([`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Arial14"><Font ss:FontName="Arial" ss:Size="14"/></Style></Styles><Worksheet ss:Name="Check Tip"><Table>${xmlRows}</Table></Worksheet></Workbook>`],{type:"application/vnd.ms-excel"});
}
window.downloadTipCheckXls=function(){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  downloadBlob(tipCheckXlsBlob(),`Fred_Zhang_Check_Tip_${todayLocal()}.xls`);
};

function tipCheckPdfPageContent(sheet,pageRows,pageIndex,pageCount,sheetIndex,sheetCount){
  let c="";
  c+=`BT /F2 18 Tf 28 758 Td (FRED ZHANG TIP CALCULATOR - CHECK TIP REPORT) Tj ET\n`;
  c+=`BT /F1 14 Tf 28 733 Td (Date: ${pdfEscape(sheet.date||"")}   Employee: ${pdfEscape(sheet.employeeName||"")}) Tj ET\n`;
  c+=`BT /F1 14 Tf 28 711 Td (Status: ${pdfEscape(tipCheckStatusLabel(sheet.status))}   Cashier: ${pdfEscape(sheet.cashierBy||"-")}) Tj ET\n`;
  c+="0.8 w 28 695 m 584 695 l S\n";
  c+="BT /F2 14 Tf 28 674 Td (#) Tj ET\nBT /F2 14 Tf 65 674 Td (Check Number) Tj ET\nBT /F2 14 Tf 230 674 Td (Table) Tj ET\nBT /F2 14 Tf 315 674 Td (Tip) Tj ET\nBT /F2 14 Tf 400 674 Td (Cashier Result) Tj ET\n";
  let y=650;
  for(const item of pageRows){
    const {r,i}=item;
    c+=`BT /F1 14 Tf 28 ${y} Td (${i+1}) Tj ET\n`;
    c+=`BT /F1 14 Tf 65 ${y} Td (${pdfEscape(r.checkNumber||"")}) Tj ET\n`;
    c+=`BT /F1 14 Tf 230 ${y} Td (${pdfEscape(r.table||"")}) Tj ET\n`;
    c+=`BT /F1 14 Tf 315 ${y} Td (${pdfEscape(fmtMoney(r.tip||0))}) Tj ET\n`;
    c+=`BT /F1 14 Tf 400 ${y} Td (${pdfEscape(tipResultLabel(r.result))}) Tj ET\n`;
    y-=23;
  }
  c+=`BT /F1 11 Tf 28 28 Td (Sheet ${sheetIndex+1}/${sheetCount} - Page ${pageIndex+1}/${pageCount} | Generated ${pdfEscape(new Date().toLocaleString())}) Tj ET\n`;
  return c;
}
function tipCheckPdfBlob(){
  const pages=[];
  latestTipCheckSheets.forEach((sheet,sheetIndex)=>{
    const indexed=(sheet.rows||[]).map((r,i)=>({r,i}));
    const chunks=[];
    for(let i=0;i<indexed.length;i+=24)chunks.push(indexed.slice(i,i+24));
    if(!chunks.length)chunks.push([]);
    chunks.forEach((rows,pageIndex)=>pages.push({sheet,rows,pageIndex,pageCount:chunks.length,sheetIndex,sheetCount:latestTipCheckSheets.length}));
  });
  const n=pages.length,font1=3+n*2,font2=font1+1,objects=[],kids=[];
  objects[1]="<< /Type /Catalog /Pages 2 0 R >>";
  for(let i=0;i<n;i++){
    const pageObj=3+i*2,contentObj=pageObj+1;kids.push(`${pageObj} 0 R`);
    const p=pages[i];
    const content=tipCheckPdfPageContent(p.sheet,p.rows,p.pageIndex,p.pageCount,p.sheetIndex,p.sheetCount);
    objects[pageObj]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj]=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  objects[2]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  objects[font1]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[font2]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  let pdf="%PDF-1.4\n",offsets=[0];
  for(let i=1;i<=font2;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=pdf.length;pdf+=`xref\n0 ${font2+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=font2;i++)pdf+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
  pdf+=`trailer\n<< /Size ${font2+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf],{type:"application/pdf"});
}
window.downloadTipCheckPdf=function(){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  downloadBlob(tipCheckPdfBlob(),`Fred_Zhang_Check_Tip_${todayLocal()}.pdf`);
};

async function loadTipCheckSheets(){
  if(!currentUser || currentUser.isAnonymous || !currentProfile)return;
  try{
    const res=await listTipCheckSheetsApi({});
    latestTipCheckSheets=Array.isArray(res.data?.rows)?res.data.rows:[];
    renderEmployeeTipCheckStatus();
    renderCashierTipCheckQueue();
    renderOwnerTipCheckRecords();
  }catch(e){
    console.error("Check Tip load:",e);
  }
}
function listenTipCheckSheets(){
  loadTipCheckSheets();
  if(tipCheckPollTimer)clearInterval(tipCheckPollTimer);
  tipCheckPollTimer=setInterval(loadTipCheckSheets,8000);
}

function listenStaff(){
  const q=query(collection(db,"submissions"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    latestRows=rows;
    const pending=rows.filter(r=>r.status==="pending");
    if(staffFirstSnapshot){
      knownPending=new Set(pending.map(r=>r.id));
      staffFirstSnapshot=false;
    }else{
      for(const r of pending){
        if(!knownPending.has(r.id)) notifyManager(r);
      }
      knownPending=new Set(pending.map(r=>r.id));
    }
    renderStaff(rows);
  },e=>{
    console.error("Staff listener:",e);
    $("backendStatus").textContent=`Firestore error: ${e.code || e.message}`;
    $("backendStatus").className="notice danger";
  }));

  listenApprovals();
  listenHourlyReports();
  populateBartenderServerDropdowns();
  if(currentProfile.role==="owner"){
    listenUsers();
    listenHistory();
  }
  $("backendStatus").textContent="FIREBASE / FIRESTORE ONLINE — shared realtime database active.";
  $("backendStatus").className="notice good";
}

function renderStaff(a){
  const p=a.filter(r=>r.status==="pending");
  $("pendingBadge").textContent=p.length;
  $("pendingList").innerHTML=p.length?p.map(r=>`
    <div class="card" style="box-shadow:none">
      <b>${esc(r.employee)} — ${esc(r.shift)}</b>
      <div class="small">${esc(r.date)} • ${esc(r.position)} • ${esc(r.clock)} • ${
        r.breakMode==="with"?"With Break":r.breakMode==="without"?"Without Break":"N/A"
      }</div>
      <div class="small" style="margin:6px 0">Grand ${fmtMoney(r.grandTotal)}
        ${["DOUBLE","LONG"].includes(r.shift)?` • Total AM ${fmtMoney(r.totalAM)}`:""}
        • Meal $${Number(r.meal||0).toFixed(2)} • Cash Tip $${Number(r.cashTip||0).toFixed(2)}
      </div>
      <div class="actions">
        <button class="btn green" onclick="review('${r.id}','approved')">Review / Approve</button>
        <button class="btn light" onclick="editSubmission('${r.id}')">Edit</button>
        <button class="btn red" onclick="review('${r.id}','rejected')">Reject</button>
        <button class="btn red" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div>
    </div>`).join(""):'<div class="notice good">No pending submissions.</div>';

  const ap=a;
  $("reportBody").innerHTML=ap.length?ap.map(r=>`
    <tr>
      <td>${esc(r.date)}</td><td>${esc(r.employee)}</td><td>${esc(r.position)}</td><td>${esc(r.shift)}</td>
      <td>${r.breakMode==="with"?"With Break":r.breakMode==="without"?"Without Break":"N/A"}</td>
      <td>${esc(r.clock)}</td>
      <td>${fmtMoney(r.grandTotal)}</td>
      <td>${["DOUBLE","LONG"].includes(r.shift)?"$"+Number(r.totalAM||0).toFixed(2):"—"}</td>
      <td>${esc(employeeBarText(r))}</td>
      <td>$${Number(r.meal||0).toFixed(2)}</td><td>$${Number(r.cashTip||0).toFixed(2)}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${esc(r.reviewedBy||"")}</td>
      <td><div class="actions">
        <button class="btn light" style="padding:6px 8px" onclick="editSubmission('${r.id}')">${r.status==="pending"?"Review / Edit":"Edit"}</button>
        <button class="btn red" style="padding:6px 8px" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div></td>
    </tr>`).join(""):'<tr><td colspan="13">No reviewed records.</td></tr>';

  renderHourlyQueue(a);
}

window.review=async function(id,status){
  if(status==="approved"){
    document.querySelector('[data-stab="report"]')?.click();
    setTimeout(()=>editSubmission(id),100);
    return;
  }
  try{
    const ref=doc(db,"submissions",id);
    const beforeSnap=await getDoc(ref);
    const before=beforeSnap.exists()?beforeSnap.data():null;
    await updateDoc(ref,{
      status:"rejected",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
    await writeAudit("reject",id,before?.employee||"",{before,after:{status:"rejected"}});
  }catch(e){ alert(`Update failed: ${e.code || e.message}`); }
};


function listenApprovals(){
  const q=query(collection(db,"signupRequests"),where("status","==","pending"),limit(100));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    $("approvalBadge").textContent=rows.length;
    $("approvalList").innerHTML=rows.length?rows.map(r=>`
      <div class="approval-card">
        <b>${esc(r.displayName)}</b>
        <div class="small">Phone: ${esc(r.phone||"")} • Username: ${esc(r.username||"")}</div>
        <div class="actions" style="margin-top:10px">
          <button class="btn green" onclick="approveEmployee('${r.uid}')">Approve</button>
          <button class="btn red" onclick="rejectEmployee('${r.uid}')">Reject</button>
        </div>
      </div>`).join(""):'<div class="notice good">No pending employee sign ups.</div>';
  },e=>console.error("Approvals listener:",e)));
}

window.approveEmployee=async function(uid){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  try{
    const uref=doc(db,"users",uid), rref=doc(db,"signupRequests",uid);
    const us=await getDoc(uref);
    if(!us.exists()){ alert("Employee profile not found."); return; }
    const before=us.data();
    await updateDoc(uref,{
      active:true,
      approvalStatus:"approved",
      approvedBy:currentProfile.displayName||currentProfile.username,
      approvedAt:serverTimestamp()
    });
    await updateDoc(rref,{
      status:"approved",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp()
    });
    await writeAudit("employee_signup_approved",uid,before.displayName||"",{before,after:{active:true,approvalStatus:"approved"}});
  }catch(e){ alert(`Approve failed: ${e.code || e.message}`); }
};

window.rejectEmployee=async function(uid){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Reject this employee sign up?")) return;
  try{
    const uref=doc(db,"users",uid), rref=doc(db,"signupRequests",uid);
    const us=await getDoc(uref);
    const before=us.exists()?us.data():null;
    if(us.exists()) await updateDoc(uref,{active:false,approvalStatus:"rejected"});
    await updateDoc(rref,{
      status:"rejected",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp()
    });
    await writeAudit("employee_signup_rejected",uid,before?.displayName||"",{before});
  }catch(e){ alert(`Reject failed: ${e.code || e.message}`); }
};

function listenUsers(){
  unsubs.push(onSnapshot(collection(db,"users"),snap=>{
    const a=snap.docs.map(d=>({uid:d.id,...d.data()}))
      .sort((a,b)=>(a.username||"").localeCompare(b.username||""));
    userNameByUid=Object.fromEntries(a.map(u=>[u.uid,u.displayName||u.username||""]));
    $("userList").innerHTML=a.map(u=>{
      const active = u.active !== false;
      const status = active
        ? '<span class="status approved">ACTIVE</span>'
        : '<span class="status rejected">DISABLED</span>';
      const action = u.role==="owner" ? "" : `
        <div class="actions" style="justify-content:flex-end">
          ${active
            ? `<button class="btn red" style="padding:7px 10px" onclick="setUserActive('${u.uid}',false)">Disable</button>`
            : `<button class="btn green" style="padding:7px 10px" onclick="setUserActive('${u.uid}',true)">Enable</button>`}
          <button class="btn red" style="padding:7px 10px;background:#7f1d1d;color:white" onclick="deleteAppUser(\'${u.uid}\')">Delete</button>
        </div>`;
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:9px 0">
        <div>
          <b>${esc(u.displayName||u.username)}</b>
          <div class="small">${esc(u.role)} • ${esc(u.username)} • ${status}</div>
        </div>
        ${action}
      </div>`;
    }).join("");
  },e=>console.error("Users listener:",e)));
}


window.deleteAppUser=async function(uid){
  if(currentProfile.role!=="owner") return;
  const username=userNameByUid[uid]||"this user";
  if(!confirm(`DELETE ${username} completely?\n\nThis removes Firebase Authentication + app profile + signup request. This cannot be undone.`)) return;
  try{
    const result=await deleteUserAdmin({uid});
    if(result?.data?.ok){
      alert("User deleted completely.");
    }else{
      alert("Delete request completed.");
    }
  }catch(e){
    console.error("Admin delete user:",e);
    alert(`Delete failed: ${e.message || e.code || "unknown error"}`);
  }
};

window.createUserByOwner=async function(){
  if(currentProfile.role!=="owner") return;
  const username=$("uName").value.trim();
  const role=$("uRole").value;
  const secret=$("uPass").value.trim();

  if(!username || !secret){
    alert("Username and PIN/password required.");
    return;
  }
  if(role==="employee" && !/^\d{4}$/.test(secret)){
    alert("Employee PIN must be exactly 4 digits.");
    return;
  }
  if((role==="manager" || role==="cashier") && secret.length<6){
    alert(`${role==="cashier"?"Cashier":"Manager"} password must be at least 6 characters.`);
    return;
  }

  try{
    const result=role==="cashier"
      ? await createCashierUserApi({username,secret})
      : await createUserAdmin({username,role,secret});
    $("uName").value="";
    $("uPass").value="";
    alert(`Created ${role}: ${result.data.displayName}`);
  }catch(e){
    console.error("Admin create user:",e);
    alert(`Create user failed: ${e.message || e.code || "unknown error"}`);
  }
};

window.setUserActive=async function(uid,active){
  if(currentProfile.role!=="owner") return;
  const verb = active ? "enable" : "disable";
  if(!confirm(`${verb.charAt(0).toUpperCase()+verb.slice(1)} this user?`)) return;
  try{
    const ref=doc(db,"users",uid);
    const s=await getDoc(ref);
    if(!s.exists()){ alert("User profile not found."); return; }
    const before=s.data();
    await updateDoc(ref,{active:!!active});
    try{
      await writeAudit(active ? "user_enable" : "user_disable",uid,before?.displayName||before?.username||"",{
        before,
        after:{active:!!active}
      });
    }catch(auditErr){
      console.warn("Status changed, audit log failed:",auditErr);
    }
    alert(`User ${active ? "enabled" : "disabled"} successfully.`);
  }catch(e){
    console.error("User status:",e);
    alert(`User status failed: ${e.code || e.message}`);
  }
};

window.openAddSubmission=function(){
  $("mId").value="";
  $("editTitle").textContent="Add Submission";
  $("mEmployee").value="";
  $("mDate").value=todayLocal();
  $("mPosition").value="Server";
  $("mShift").value="AM";
  $("mBreakMode").value="none";
  $("mClock").value="";
  $("mGrandTotal").value=0;
  $("mTotalAM").value=0;
  $("mPaidTip").value=0;
  $("mMeal").value=0;
  $("mCash").value=0;
  $("editModal").classList.remove("hidden");
};
window.closeEditModal=function(){ $("editModal").classList.add("hidden"); };

window.editSubmission=function(id){
  const r=latestRows.find(x=>x.id===id);
  if(!r) return;
  $("mId").value=id;
  $("editTitle").textContent="Edit Submission";
  $("mEmployee").value=r.employee||"";
  $("mDate").value=r.date||todayLocal();
  $("mPosition").value=r.position||"Server";
  $("mShift").value=r.shift||"AM";
  $("mBreakMode").value=r.breakMode||"none";
  $("mClock").value=r.clock||"";
  $("mGrandTotal").value=r.grandTotal||0;
  $("mTotalAM").value=r.totalAM||0;
  $("mPaidTip").value=r.paidTip||0;
  $("mMeal").value=r.meal||0;
  $("mCash").value=r.cashTip||0;
  $("editModal").classList.remove("hidden");
};

window.saveStaffSubmission=async function(){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  const id=$("mId").value.trim();
  const payload={
    employee:$("mEmployee").value.trim(),
    date:$("mDate").value,
    position:$("mPosition").value,
    shift:$("mShift").value,
    breakMode:$("mBreakMode").value,
    clock:$("mClock").value.trim(),
    grandTotal:Number($("mGrandTotal").value)||0,
    totalAM:Number($("mTotalAM").value)||0,
    paidTip:Number($("mPaidTip").value)||0,
    barSalesAM:(latestRows.find(x=>x.id===id)?.barSalesAM)||false,
    barSalesPM:(latestRows.find(x=>x.id===id)?.barSalesPM)||false,
    meal:Number($("mMeal").value)||0,
    cashTip:Number($("mCash").value)||0,
    status:"hourly_pending",
    hourlyStatus:"waiting_manager",
    reviewedBy:currentProfile.displayName||currentProfile.username,
    reviewedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
  if(!payload.employee || !payload.date){ alert("Employee and date required."); return; }

  try{
    let targetId=id;
    if(id){
      const ref=doc(db,"submissions",id);
      const s=await getDoc(ref);
      const before=s.exists()?s.data():null;
      // Preserve employeeUid from original record by updating only manager-review fields.
      await updateDoc(ref,payload);
      await writeAudit("manager_review_to_hourly",id,payload.employee,{before,after:payload});
    }else{
      const ref=doc(collection(db,"submissions"));
      targetId=ref.id;
      const full={...payload,employeeUid:"",createdAt:serverTimestamp()};
      await setDoc(ref,full);
      await writeAudit("manager_add_to_hourly",ref.id,payload.employee,{after:full});
    }
    closeEditModal();
    setTimeout(()=>{
      document.querySelector('[data-stab="hourly"]')?.click();
      setTimeout(()=>window.loadSubmissionToHourly?.(targetId),150);
    },100);
  }catch(e){ alert(`Save failed: ${e.code || e.message}`); }
};

window.deleteSubmission=async function(id){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Delete this submission?")) return;
  try{
    const ref=doc(db,"submissions",id);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await deleteDoc(ref);
    await writeAudit("delete",id,before?.employee||"",{before});
  }catch(e){ alert(`Delete failed: ${e.code || e.message}`); }
};


const HISTORY_UNDO_MS=3*24*60*60*1000;

function tsMillis(v){
  try{
    if(!v) return 0;
    if(typeof v.toMillis==="function") return v.toMillis();
    if(typeof v.toDate==="function") return v.toDate().getTime();
    if(v instanceof Date) return v.getTime();
    if(typeof v.seconds==="number") return v.seconds*1000;
    const n=new Date(v).getTime();
    return Number.isFinite(n)?n:0;
  }catch(e){ return 0; }
}

function historyTime(v){
  const ms=tsMillis(v);
  return ms?new Date(ms).toLocaleString():"";
}


window.deleteAllHistory=async function(){
  if(currentProfile?.role!=="owner"){
    alert("Owner only.");
    return;
  }

  try{
    const qSnap=await getDocs(query(collection(db,"auditLogs"),orderBy("createdAt","desc"),limit(500)));
    const rows=qSnap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>!r.deletedAt);

    if(!rows.length){
      alert("No active history to delete.");
      return;
    }

    if(!confirm(`DELETE ALL OWNER CHANGE HISTORY?\n\n${rows.length} history entries will move to Recently Deleted.\nYou can Undo All for 3 days.`)) return;

    const purgeAfter=new Date(Date.now()+HISTORY_UNDO_MS);

    for(const r of rows){
      await updateDoc(doc(db,"auditLogs",r.id),{
        deletedAt:serverTimestamp(),
        deletedBy:currentProfile.displayName||currentProfile.username||"Owner",
        purgeAfter
      });
    }

    alert(`Delete All complete. ${rows.length} history entries moved to Recently Deleted.`);
  }catch(e){
    console.error("History Delete All:",e);
    alert(`History Delete All failed: ${e.code||e.message}`);
  }
};
window.undoAllHistory=async function(){
  if(currentProfile?.role!=="owner"){
    alert("Owner only.");
    return;
  }

  try{
    const qSnap=await getDocs(query(collection(db,"auditLogs"),orderBy("createdAt","desc"),limit(500)));
    const rows=qSnap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>!!r.deletedAt);

    const restorable=rows.filter(r=>{
      const purgeAt=tsMillis(r.purgeAfter) || (tsMillis(r.deletedAt)+HISTORY_UNDO_MS);
      return !purgeAt || purgeAt>Date.now();
    });

    if(!restorable.length){
      alert("Nothing available to Undo.");
      return;
    }

    if(!confirm(`UNDO ALL DELETED HISTORY?\n\nRestore ${restorable.length} history entries?`)) return;

    for(const r of restorable){
      await updateDoc(doc(db,"auditLogs",r.id),{
        deletedAt:null,
        deletedBy:"",
        purgeAfter:null,
        restoredAt:serverTimestamp(),
        restoredBy:currentProfile.displayName||currentProfile.username||"Owner"
      });
    }

    alert(`Undo All complete. Restored ${restorable.length} history entries.`);
  }catch(e){
    console.error("History Undo All:",e);
    alert(`History Undo All failed: ${e.code||e.message}`);
  }
};
async function purgeExpiredHistory(rows){
  if(currentProfile?.role!=="owner") return;
  const now=Date.now();
  const expired=rows.filter(r=>{
    if(!r.deletedAt) return false;
    const purgeAt=tsMillis(r.purgeAfter) || (tsMillis(r.deletedAt)+HISTORY_UNDO_MS);
    return purgeAt>0 && purgeAt<=now;
  });
  for(const r of expired){
    try{ await deleteDoc(doc(db,"auditLogs",r.id)); }
    catch(e){ console.warn("History permanent cleanup:",r.id,e); }
  }
}

function listenHistory(){
  if(currentProfile.role!=="owner") return;
  const q=query(collection(db,"auditLogs"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,async snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));

    // Permanently purge soft-deleted history after the 3-day Undo window.
    await purgeExpiredHistory(rows);

    const active=rows.filter(r=>!r.deletedAt);
    const trash=rows.filter(r=>!!r.deletedAt).filter(r=>{
      const purgeAt=tsMillis(r.purgeAfter) || (tsMillis(r.deletedAt)+HISTORY_UNDO_MS);
      return !purgeAt || purgeAt>Date.now();
    });

    $("historyBody").innerHTML=active.length?active.map(r=>{
      const time=historyTime(r.createdAt);
      return `<tr>
        <td>${esc(time)}</td><td>${esc(r.actor||"")}</td><td>${esc(r.actorRole||"")}</td>
        <td>${esc(r.action||"")}</td><td>${esc(r.employee||"")}</td>
        <td>${esc(r.submissionId||"")}</td>
        <td>${esc(JSON.stringify(r.details||{}).slice(0,300))}</td>
      </tr>`;
    }).join(""):'<tr><td colspan="7">No active history.</td></tr>';

    $("historyTrashBody").innerHTML=trash.length?trash.map(r=>{
      const purgeAt=tsMillis(r.purgeAfter) || (tsMillis(r.deletedAt)+HISTORY_UNDO_MS);
      return `<tr>
        <td>${esc(historyTime(r.deletedAt))}</td>
        <td>${esc(historyTime(r.createdAt))}</td>
        <td>${esc(r.actor||"")}</td>
        <td>${esc(r.action||"")}</td>
        <td>${esc(r.employee||"")}</td>
        <td>${esc(purgeAt?new Date(purgeAt).toLocaleString():"")}</td>
      </tr>`;
    }).join(""):'<tr><td colspan="6">Recently Deleted is empty.</td></tr>';
  },e=>console.error("History listener:",e)));
}






window.deleteHourlyQueueSubmission=async function(id){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  const r=latestRows.find(x=>x.id===id);
  const label=r?`${r.employee} • ${r.date} • ${r.shift}`:"this report";
  if(!confirm(`DELETE duplicate report?\n\n${label}\n\nThis removes this submission from Hourly Adjustment queue. It does NOT delete the employee account.`)) return;
  try{
    const ref=doc(db,"submissions",id);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await deleteDoc(ref);
    await writeAudit("hourly_queue_duplicate_delete",id,before?.employee||"",{before});
  }catch(e){ alert(`Delete failed: ${e.code||e.message}`); }
};

function parseClockParts(r){
  const text=String(r.clock||"").replaceAll("–","-");
  const pairs=text.split("/").map(s=>s.trim());
  if(pairs.length>1){
    const a=pairs[0].split("-").map(s=>s.trim());
    const p=pairs[1].split("-").map(s=>s.trim());
    return {amIn:a[0]||"",amOut:a[1]||"",pmIn:p[0]||"",pmOut:p[1]||""};
  }
  const one=pairs[0].split("-").map(s=>s.trim());
  return {in:one[0]||"",out:one[1]||""};
}

function renderHourlyQueue(rows){
  const el=$("hourlyQueue"); if(!el) return;
  const q=rows.filter(r=>["hourly_pending","approved"].includes(r.status));
  el.innerHTML=q.length?q.map(r=>`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:10px 0">
      <div>
        <b>${esc(r.employee)} — ${esc(r.shift)}</b>
        <div class="small">${esc(r.date)} • ${esc(r.clock)} • Grand ${fmtMoney(r.grandTotal)} • Meal $${Number(r.meal||0).toFixed(2)} • Cash $${Number(r.cashTip||0).toFixed(2)}</div>
      </div>
      <div class="actions">
        <button class="btn green" onclick="loadSubmissionToHourly('${r.id}')">Open in Hourly</button>
        <button class="btn red" onclick="deleteHourlyQueueSubmission('${r.id}')">Delete</button>
      </div>
    </div>`).join(""):'<div class="notice good">No approved employee data waiting.</div>';
}

window.loadSubmissionToHourly=function(id){
  const r=latestRows.find(x=>x.id===id);
  if(!r) return;
  currentHourlySubmissionId=id;
  currentHourlyReportId=null;
  $("hDate").value=r.date||todayLocal();
  $("hEmployee").value=r.employee||"";
  $("hPosition").value=r.position||"Server";
  $("hShift").value=(r.shift==="LONG"?"DOUBLE":r.shift||"AM");
  $("hMeal").value=Number(r.meal||0);
  $("hGrandTotal").value=Number(r.grandTotal||0);
  $("hTotalAM").value=Number(r.totalAM||0);
  $("hCashTip").value=Number(r.cashTip||0);
  $("hPaidTip").value=Number(r.paidTip||0);
  $("hCardFee").value=Number(r.payCardTipFee ?? r.cardFee ?? 0);
  $("hAmBar").value=r.barSalesAM?"yes":"no";
  $("hPmBar").value=r.barSalesPM?"yes":"no";
  for(let i=1;i<=9;i++){
    if($(`hBtServerName${i}`)) $(`hBtServerName${i}`).value="";
    if($(`hBtServerGrand${i}`)) $(`hBtServerGrand${i}`).value="";
  }
  if($("hBartenderShiftType")) $("hBartenderShiftType").value="AM";
  if($("hBtPrevAMInput")) $("hBtPrevAMInput").value="";
  if($("hBtPrev24Input")) $("hBtPrev24Input").value="";
  syncHourlyShift();
  const c=parseClockParts(r);
  if($("hShift").value==="DOUBLE"){
    $("hAmIn").value=c.amIn||c.in||"";
    $("hAmOut").value=c.amOut||"";
    $("hPmIn").value=c.pmIn||"";
    $("hPmOut").value=c.pmOut||c.out||"";
  }else{
    $("hIn").value=c.in||"";
    $("hOut").value=c.out||"";
  }
  $("hourlyResult").classList.add("hidden");
  window.scrollTo({top:$("hourly").offsetTop-10,behavior:"smooth"});
};



function reportRowsForExport(){
  return latestHourlyReports.map(r=>({
    id:r.id||"",
    date:r.date||"",
    employee:r.employee||"",
    position:r.position||"",
    shift:r.shift||"",
    busserAM:r.busserAM==="N/A"?"-":(r.busserAM||"-"),
    hourInAM:r.hourInAM||r.hours?.hourInAM||"",
    hourOutAM:r.hourOutAM||r.hours?.hourOutAM||"",
    hourInPM:r.hourInPM||r.hours?.hourInPM||"",
    hourOutPM:r.hourOutPM||r.hours?.hourOutPM||"",
    hourIn:r.hourIn||r.hours?.hourIn||"",
    hourOut:r.hourOut||r.hours?.hourOut||"",
    totalHoursWork:Number(r.totalHoursWork??r.totalHours??0),
    grandTotal:Number(r.grandTotal||0),
    totalAM:Number(r.totalAM||0),
    totalPM:Number(r.totalPM||0),
    totalTips:Number(r.totalTips||0),
    payCardTipFee:Number(r.payCardTipFee??r.cardFee??0),
    paidTip:Number(r.paidTip||0),
    busserRate:Number(r.busserRate||0),
    busserTipOut:Number(r.busserTipOut||0),
    amBarSales:Boolean(r.amBarSales??r.barSalesAM),
    amBarTip:Number(r.amBarTipOut??r.barTipAM??0),
    pmBarSales:Boolean(r.pmBarSales??r.barSalesPM),
    pmBarTip:Number(r.pmBarTipOut??r.barTipPM??0),
    barTipOut:Number(r.barTipOut||0),
    bartenderShiftType:r.bartenderShiftType||"",
    bartenderServerGrandTotalSummary:Number(r.bartenderServerGrandTotalSummary||0),
    bartenderGrossBarTipOut:Number(r.bartenderGrossBarTipOut||0),
    bartenderLessAM:Number(r.bartenderLessAM||0),
    bartenderLess24:Number(r.bartenderLess24||0),
    bartenderBarTipReceived:Number(r.bartenderBarTipReceived||0),
    totalBeforeMeal:Number(r.totalBeforeMeal||0),
    cashTip:Number(r.cashTip||0),
    grandTotalTip:Number(r.grandTotalTip||0),
    hourlyRate:Number(r.hourlyRate||0),
    hourlyMinimum:Number(r.hourlyMinimum||0),
    adjustmentSalaryHourly:Number(r.adjustmentSalaryHourly||0),
    adjustmentDecision:String(r.adjustmentDecision||"NO ADJUSTMENT").toUpperCase(),
    grandTotalAfterAdjustment:Number(r.grandTotalAfterAdjustment||0),
    meal:Number(r.meal||0),
    totalPaidOut:Number(r.totalPaidOut||0),
    status:"MONEY READY",
    signatureStatus:r.signatureStatus||r.employeeSignatureStatus||"",
    signedAt:r.signedAt||r.employeeSignedAt||"",
    pickupSignature:r.pickupSignature||null,
    pickedUpBy:r.employee||"",
    pickedUpProcessedBy:r.pickedUpProcessedBy||"",
    pickedUpAt:r.pickedUpAt||null,
    finalizedBy:r.updatedBy||r.createdBy||r.finalizedBy||"",
    createdAt:r.createdAt||null
  }));
}

function xlsEscape(v){
  return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function xlsCellString(v,style=""){
  return `<Cell${style?` ss:StyleID="${style}"`:""}><Data ss:Type="String">${xlsEscape(v)}</Data></Cell>`;
}
function xlsCellNumber(v,style="Number2"){
  const n=Number(v||0);
  return `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${Number.isFinite(n)?n:0}</Data></Cell>`;
}

function xlsBlob(rows){
  const header=[
    "Date","Name","Position","Shift","Busser AM",
    "Hour In AM","Hour Out AM","Hour In PM","Hour Out PM","Total Hours Work",
    "Grand Total","Total AM","Total PM","Total Tips","Pay Card Tip Fee","Paid Tip",
    "Busser Rate %","Busser Tip Out","AM Bar Sales","AM Bar Tip","PM Bar Sales","PM Bar Tip",
    "Bar Tip Out","Bartender Shift","Server Sales Summary","Gross @ 0.6%","Less Bartender AM","Less Bartender 2-4","Bar Tip Out Received","Total Before Meal","Cash Tip","Grand Total Tip","Hourly Rate","Hourly Minimum",
    "Adjustment Salary Hourly","Adjustment Decision","Grand Total After Adjustment","Meal",
    "Total Paid Out","Signature Status","Signed At","Status","Finalized By"
  ];

  const widths=[
    95,170,105,90,165,
    100,100,100,100,115,
    110,105,105,105,120,105,
    105,110,100,105,100,105,
    105,135,125,105,120,100,115,
    145,160,150,95,
    125,125,180,115,150
  ];

  const cols=widths.map(w=>`<Column ss:AutoFitWidth="0" ss:Width="${w}"/>`).join("");
  const headerRow=`<Row ss:StyleID="Header" ss:Height="34">${header.map(h=>xlsCellString(h)).join("")}</Row>`;

  const dataRows=rows.map(r=>{
    const shift=String(r.shift||"").toUpperCase();
    const isDouble=shift==="DOUBLE"||shift==="LONG";
    const amIn=isDouble?r.hourInAM:(shift==="AM"?r.hourIn:"");
    const amOut=isDouble?r.hourOutAM:(shift==="AM"?r.hourOut:"");
    const pmIn=isDouble?r.hourInPM:(shift==="PM"?r.hourIn:"");
    const pmOut=isDouble?r.hourOutPM:(shift==="PM"?r.hourOut:"");

    const sigStatus=r.signatureStatus||r.employeeSignatureStatus||"";
    const signedAt=r.signedAt||r.employeeSignedAt||"";

    return `<Row ss:Height="27">${
      [
        xlsCellString(r.date,"Body"),
        xlsCellString(r.employee,"Body"),
        xlsCellString(r.position,"Body"),
        xlsCellString(r.shift,"Body"),
        xlsCellString(r.busserAM||"-","Body"),
        xlsCellString(amIn,"Body"),
        xlsCellString(amOut,"Body"),
        xlsCellString(pmIn,"Body"),
        xlsCellString(pmOut,"Body"),
        xlsCellNumber(r.totalHoursWork,"Number14"),
        xlsCellNumber(r.grandTotal,"Money14"),
        xlsCellNumber(r.totalAM,"Money14"),
        xlsCellNumber(r.totalPM,"Money14"),
        xlsCellNumber(r.totalTips,"Money14"),
        xlsCellNumber(r.payCardTipFee,"Money14"),
        xlsCellNumber(r.paidTip,"Money14"),
        xlsCellNumber(r.busserRate,"Rate14"),
        xlsCellNumber(r.busserTipOut,"Money14"),
        xlsCellString(r.amBarSales?"YES":"NO","Body"),
        xlsCellNumber(r.amBarTip,"Money14"),
        xlsCellString(r.pmBarSales?"YES":"NO","Body"),
        xlsCellNumber(r.pmBarTip,"Money14"),
        xlsCellNumber(r.barTipOut,"Money14"),
        xlsCellString((r.bartenderShiftType||"").replace("2PM_4PM","2 PM - 4 PM"),"Body"),
        xlsCellNumber(r.bartenderServerGrandTotalSummary,"Money14"),
        xlsCellNumber(r.bartenderGrossBarTipOut,"Money14"),
        xlsCellNumber(r.bartenderLessAM,"Money14"),
        xlsCellNumber(r.bartenderLess24,"Money14"),
        xlsCellNumber(r.bartenderBarTipReceived,"Money14"),
        xlsCellNumber(r.totalBeforeMeal,"Money14"),
        xlsCellNumber(r.cashTip,"Money14"),
        xlsCellNumber(r.grandTotalTip,"Money14"),
        xlsCellNumber(r.hourlyRate,"Money14"),
        xlsCellNumber(r.hourlyMinimum,"Money14"),
        xlsCellNumber(r.adjustmentSalaryHourly,"Money14"),
        xlsCellString(r.adjustmentDecision==="NONE"?"NO ADJUSTMENT":r.adjustmentDecision,"Body"),
        xlsCellNumber(r.grandTotalAfterAdjustment,"Money14"),
        xlsCellNumber(r.meal,"Money14"),
        xlsCellNumber(r.totalPaidOut,"MoneyBold14"),
        xlsCellString(sigStatus,"Body"),
        xlsCellString(signedAt,"Body"),
        xlsCellString(r.status,"Body"),
        xlsCellString(r.finalizedBy,"Body")
      ].join("")
    }</Row>`;
  }).join("");

  const xml=`<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Arial" ss:Size="14"/>
  </Style>
  <Style ss:ID="Body">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Arial" ss:Size="14"/>
  </Style>
  <Style ss:ID="Header">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#9FB3D1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8D4E6"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8D4E6"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8D4E6"/>
   </Borders>
   <Font ss:FontName="Arial" ss:Size="14" ss:Bold="1" ss:Color="#10213C"/>
   <Interior ss:Color="#DCE8FF" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Number14"><Font ss:FontName="Arial" ss:Size="14"/><NumberFormat ss:Format="0.00"/></Style>
  <Style ss:ID="Rate14"><Font ss:FontName="Arial" ss:Size="14"/><NumberFormat ss:Format="0.000"/></Style>
  <Style ss:ID="Money14"><Font ss:FontName="Arial" ss:Size="14"/><NumberFormat ss:Format="$#,##0.00;[Red]-$#,##0.00"/></Style>
  <Style ss:ID="MoneyBold14"><Font ss:FontName="Arial" ss:Size="14" ss:Bold="1"/><NumberFormat ss:Format="$#,##0.00;[Red]-$#,##0.00"/></Style>
 </Styles>

 <Worksheet ss:Name="Daily Report">
  <Table>${cols}${headerRow}${dataRows}</Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
   <Selected/><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;

  return new Blob([xml],{type:"application/vnd.ms-excel"});
}


function pdfEscape(s){
  return String(s??"")
    .normalize("NFKD").replace(/[^\x20-\x7E]/g," ")
    .replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
}
function pdfMoney(v){
  const n=Number(v||0);
  const sign=n<0?"-$ ":"$ ";
  return sign+Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function pdfRate(v){
  return Number(v||0).toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})+"%";
}
function pdfBool(v){ return v?"YES":"NO"; }

function pdfField(label,value,x,y){
  return `BT /F1 9.5 Tf ${x} ${y} Td (${pdfEscape(label)}) Tj ET\n`+
         `BT /F2 14 Tf ${x} ${y-15} Td (${pdfEscape(value)}) Tj ET\n`;
}


function pdfSignatureCommands(signature,x,y,w,h){
  const strokes=signature?.strokes;
  if(!Array.isArray(strokes) || !strokes.length) return "";
  let c="0.8 w\n";
  for(const rawStroke of strokes){
    const stroke=Array.isArray(rawStroke) ? rawStroke : (Array.isArray(rawStroke?.points)?rawStroke.points:[]);
    if(stroke.length<2) continue;
    const pts=stroke.map(p=>({
      x:x+Math.max(0,Math.min(1,Number(p.x||0)))*w,
      y:y+(1-Math.max(0,Math.min(1,Number(p.y||0))))*h
    }));
    c+=`${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} m\n`;
    for(let i=1;i<pts.length;i++){
      c+=`${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)} l\n`;
    }
    c+="S\n";
  }
  return c;
}

function pdfReportContent(r,index,total){
  const shift=String(r.shift||"").toUpperCase();
  const isDouble=shift==="DOUBLE"||shift==="LONG";

  const amIn=isDouble?r.hourInAM:(shift==="AM"?r.hourIn:"-");
  const amOut=isDouble?r.hourOutAM:(shift==="AM"?r.hourOut:"-");
  const pmIn=isDouble?r.hourInPM:(shift==="PM"?r.hourIn:"-");
  const pmOut=isDouble?r.hourOutPM:(shift==="PM"?r.hourOut:"-");

  const left=[
    ["Date",r.date||"-"],
    ["Employee",r.employee||"-"],
    ["Position",r.position||"-"],
    ["Shift",r.shift||"-"],
    ["Busser AM",r.busserAM||"-"],
    ["Hour In AM",amIn||"-"],
    ["Hour Out AM",amOut||"-"],
    ["Hour In PM",pmIn||"-"],
    ["Hour Out PM",pmOut||"-"],
    ["Total Hours",Number(r.totalHoursWork||0).toFixed(2)],
    ["Grand Total",pdfMoney(r.grandTotal)],
    ["Total AM",pdfMoney(r.totalAM)],
    ["Total PM",pdfMoney(r.totalPM)],
    ["Total Tips",pdfMoney(r.totalTips)],
    ["Pay Card Tip Fee",pdfMoney(r.payCardTipFee)],
    ["Paid Tip",pdfMoney(r.paidTip)],
    ["Busser Rate",pdfRate(r.busserRate)]
  ];

  const right=[
    ["Busser Tip Out",pdfMoney(r.busserTipOut)],
    ["AM Bar Sales",pdfBool(r.amBarSales)],
    ["AM Bar Tip",pdfMoney(r.amBarTip)],
    ["PM Bar Sales",pdfBool(r.pmBarSales)],
    ["PM Bar Tip",pdfMoney(r.pmBarTip)],
    ["Bar Tip Out",pdfMoney(r.barTipOut)],
    ["Bartender Shift",String(r.bartenderShiftType||"").replace("2PM_4PM","2 PM - 4 PM")],
    ["Server Sales Summary",pdfMoney(r.bartenderServerGrandTotalSummary)],
    ["Gross @ 0.6%",pdfMoney(r.bartenderGrossBarTipOut)],
    ["Less Bartender AM",pdfMoney(r.bartenderLessAM)],
    ["Less Bartender 2-4",pdfMoney(r.bartenderLess24)],
    ["Bar Tip Out Received",pdfMoney(r.bartenderBarTipReceived)],
    ["Total Before Meal",pdfMoney(r.totalBeforeMeal)],
    ["Cash Tip",pdfMoney(r.cashTip)],
    ["Grand Total Tip",pdfMoney(r.grandTotalTip)],
    ["Hourly Rate",pdfMoney(r.hourlyRate)],
    ["Hourly Minimum",pdfMoney(r.hourlyMinimum)],
    ["Adjustment Salary Hourly",pdfMoney(r.adjustmentSalaryHourly)],
    ["Adjustment Decision",r.adjustmentDecision==="NONE"?"NO ADJUSTMENT":r.adjustmentDecision],
    ["Grand Total After Adjustment",pdfMoney(r.grandTotalAfterAdjustment)],
    ["Meal",pdfMoney(r.meal)],
    ["TOTAL PAID OUT",pdfMoney(r.totalPaidOut)]
  ];

  let c="";
  // Original report-style header.
  c+="BT /F2 19 Tf 28 758 Td (TIP CALCULATOR BY FRED ZHANG - EMPLOYEE REPORT) Tj ET\n";
  c+=`BT /F1 10 Tf 28 739 Td (Report ${index+1} of ${total}) Tj ET\n`;
  c+="0.9 w 28 725 m 584 725 l S\n";

  // Two-column report body, larger and more readable.
  let y=702;
  for(const [label,value] of left){
    c+=pdfField(label,value,28,y);
    y-=35;
  }

  y=702;
  const rightStep=right.length>18?24:35;
  for(const [label,value] of right){
    c+=pdfField(label,value,322,y);
    y-=rightStep;
  }

  // Footer: isolated status block and signature area with no overlapping text.
  c+="0.9 w 28 118 m 584 118 l S\n";

  c+="BT /F2 15 Tf 28 95 Td (TOTAL PAID OUT) Tj ET\n";
  c+=`BT /F2 28 Tf 28 58 Td (${pdfEscape(pdfMoney(r.totalPaidOut))}) Tj ET\n`;

  const status=String(r.status||"MONEY READY").toUpperCase();
  c+="BT /F2 10.5 Tf 300 98 Td (FINAL REPORT - MONEY READY) Tj ET\n";
  c+=`BT /F1 8.5 Tf 300 82 Td (Status: ${pdfEscape(status)}) Tj ET\n`;
  if(r.finalizedBy){
    c+=`BT /F1 8.5 Tf 300 68 Td (Finalized By: ${pdfEscape(r.finalizedBy)}) Tj ET\n`;
  }

  // Employee is the person who actually picked up and signed for the money.
  const receivedBy=r.employee||"";
  if(receivedBy){
    c+=`BT /F1 8.5 Tf 300 54 Td (Picked Up By Employee: ${pdfEscape(receivedBy)}) Tj ET\n`;
  }

  c+="BT /F2 8.5 Tf 450 101 Td (EMPLOYEE SIGNATURE) Tj ET\n";
  c+="0.7 w 450 45 m 580 45 l 580 92 l 450 92 l 450 45 l S\n";
  c+=pdfSignatureCommands(r.pickupSignature,454,49,122,39);

  if(Array.isArray(r.pickupSignature?.strokes) && r.pickupSignature.strokes.length){
    c+="BT /F1 7.5 Tf 450 34 Td (Signature Status: SIGNED) Tj ET\n";
  }

  c+=`BT /F1 8 Tf 28 20 Td (Generated ${pdfEscape(new Date().toLocaleString())} | Page ${index+1}) Tj ET\n`;
  return c;
}

function simplePdfBlob(rows){
  const n=rows.length;
  const font1=3+n*2;
  const font2=font1+1;
  const objects=[];
  const kids=[];

  objects[1]="<< /Type /Catalog /Pages 2 0 R >>";

  for(let i=0;i<n;i++){
    const pageObj=3+i*2;
    const contentObj=pageObj+1;
    kids.push(`${pageObj} 0 R`);

    const content=pdfReportContent(rows[i],i,n);

    objects[pageObj]=
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `+
      `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> `+
      `/Contents ${contentObj} 0 R >>`;

    objects[contentObj]=
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }

  objects[2]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;

  // Helvetica / Helvetica-Bold are standard PDF sans-serif fonts and visually
  // match Arial closely without shipping any font file.
  objects[font1]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[font2]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  const maxObj=font2;
  let pdf="%PDF-1.4\n";
  const offsets=[0];

  for(let i=1;i<=maxObj;i++){
    offsets[i]=pdf.length;
    pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xref=pdf.length;
  pdf+=`xref\n0 ${maxObj+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=maxObj;i++){
    pdf+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
  }

  pdf+=`trailer\n<< /Size ${maxObj+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf],{type:"application/pdf"});
}

async function shareReportFile(blob,filename,target){
  const file=new File([blob],filename,{type:blob.type});
  if(navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
    try{
      await navigator.share({
        files:[file],
        title:"Fred Zhang Tip Calculator Report",
        text: target==="whatsapp" ? "Tip report — please send via WhatsApp." : "Tip report — please send via email."
      });
      return;
    }catch(e){
      if(e.name==="AbortError") return;
      console.warn("Share files fallback:",e);
    }
  }
  // Desktop fallback: download actual file. Browsers do not permit silent attachment
  // to WhatsApp Web or email; user can attach the downloaded file.
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  alert(`Report downloaded as ${filename}. On this browser, automatic file attachment to ${target==="whatsapp"?"WhatsApp":"email"} is blocked; attach the downloaded file.`);
}

function downloadBlob(blob,filename){
  const a=document.createElement("a");
  const url=URL.createObjectURL(blob);
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
window.downloadAllReportsXls=function(){
  const rows=reportRowsForExport(); if(!rows.length){alert("No final reports to download.");return;}
  downloadBlob(xlsBlob(rows),`Fred_Zhang_Final_Daily_Report_${todayLocal()}.xls`);
};
window.downloadAllReportsPdf=function(){
  const rows=reportRowsForExport(); if(!rows.length){alert("No final reports to download.");return;}
  downloadBlob(simplePdfBlob(rows),`Fred_Zhang_Final_Daily_Report_${todayLocal()}.pdf`);
};

window.shareAllReportsXls=async function(target){
  const rows=reportRowsForExport(); if(!rows.length){alert("No final reports to send.");return;}
  await shareReportFile(xlsBlob(rows),`Fred_Zhang_Tip_Report_${todayLocal()}.xls`,target);
};
window.shareAllReportsPdf=async function(target){
  const rows=reportRowsForExport(); if(!rows.length){alert("No final reports to send.");return;}
  await shareReportFile(simplePdfBlob(rows),`Fred_Zhang_Tip_Report_${todayLocal()}.pdf`,target);
};




function finalGroupId(name){
  return "finalName_"+Array.from(new TextEncoder().encode(name))
    .map(b=>b.toString(16).padStart(2,"0")).join("");
}

function syncOwnerFinalControls(){
  const b=$("clearAllFinalBtn");
  if(b) b.classList.toggle("hidden", currentProfile?.role!=="owner");
}

window.clearAllFinalDailyReports=async function(){
  if(currentProfile?.role!=="owner"){
    alert("Owner only.");
    return;
  }
  if(!latestHourlyReports.length){
    alert("No Final Daily Reports to clear.");
    return;
  }
  if(!confirm(`CLEAR ALL FINAL DAILY REPORTS?\n\nDelete ${latestHourlyReports.length} finalized report(s)?\n\nOWNER ONLY — this cannot be undone.`)) return;

  try{
    const rows=[...latestHourlyReports];
    for(const r of rows){
      await deleteDoc(doc(db,"hourlyReports",r.id));
      if(r.sourceSubmissionId){
        try{
          await updateDoc(doc(db,"submissions",r.sourceSubmissionId),{
            status:"archived",
            hourlyStatus:"cleared_by_owner",
            hourlyReportId:"",
            updatedAt:serverTimestamp()
          });
        }catch(e){console.warn(e);}
        try{ await deleteDoc(doc(db,"moneyReadyBoard",r.sourceSubmissionId)); }catch(e){console.warn(e);}
      }
    }
    try{ await writeAudit("final_daily_clear_all","ALL","",{count:rows.length}); }catch(e){}
    alert("Final Daily Report cleared.");
  }catch(e){
    alert(`Clear All failed: ${e.code||e.message}`);
  }
};




let pendingPickup=null;
let pickupSignatureStrokes=[];
let pickupDrawing=false;
let pickupCurrentStroke=null;

function pickupCanvas(){
  return $("pickupSignatureCanvas");
}
function pickupCanvasPoint(evt){
  const c=pickupCanvas();
  const rect=c.getBoundingClientRect();
  const clientX=evt.touches?.[0]?.clientX ?? evt.clientX;
  const clientY=evt.touches?.[0]?.clientY ?? evt.clientY;
  return {
    x:Math.max(0,Math.min(1,(clientX-rect.left)/rect.width)),
    y:Math.max(0,Math.min(1,(clientY-rect.top)/rect.height))
  };
}
function redrawPickupSignature(){
  const c=pickupCanvas();
  if(!c) return;
  const ctx=c.getContext("2d");
  ctx.clearRect(0,0,c.width,c.height);
  ctx.lineWidth=3;
  ctx.lineCap="round";
  ctx.lineJoin="round";
  ctx.strokeStyle="#10213c";
  pickupSignatureStrokes.forEach(stroke=>{
    if(!stroke?.length) return;
    ctx.beginPath();
    stroke.forEach((p,i)=>{
      const x=p.x*c.width, y=p.y*c.height;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  });
}
function initPickupSignatureCanvas(){
  const c=pickupCanvas();
  if(!c || c.dataset.ready==="1") return;
  c.dataset.ready="1";

  const startDraw=e=>{
    e.preventDefault();
    pickupDrawing=true;
    pickupCurrentStroke=[pickupCanvasPoint(e)];
    pickupSignatureStrokes.push(pickupCurrentStroke);
    redrawPickupSignature();
  };
  const moveDraw=e=>{
    if(!pickupDrawing) return;
    e.preventDefault();
    pickupCurrentStroke.push(pickupCanvasPoint(e));
    redrawPickupSignature();
  };
  const endDraw=e=>{
    if(!pickupDrawing) return;
    e?.preventDefault?.();
    pickupDrawing=false;
    pickupCurrentStroke=null;
  };

  c.addEventListener("pointerdown",startDraw);
  c.addEventListener("pointermove",moveDraw);
  window.addEventListener("pointerup",endDraw);
  c.addEventListener("touchstart",startDraw,{passive:false});
  c.addEventListener("touchmove",moveDraw,{passive:false});
  c.addEventListener("touchend",endDraw,{passive:false});
}

window.clearPickupSignature=function(){
  pickupSignatureStrokes=[];
  redrawPickupSignature();
};

window.cancelPickupSignature=function(){
  pendingPickup=null;
  pickupSignatureStrokes=[];
  const m=$("pickupSignatureModal");
  if(m){ m.classList.add("hidden"); m.style.setProperty("display","none","important"); }
};

window.markMoneyPickedUp=function(reportId,submissionId,employee){
  if(!["manager","owner"].includes(currentProfile?.role||"")){
    alert("Manager/Owner only.");
    return;
  }

  const modal=$("pickupSignatureModal");
  const employeeLabel=$("pickupSignatureEmployee");
  if(!modal || !employeeLabel){
    alert("Pickup signature screen failed to load. Please refresh this build.");
    return;
  }

  pendingPickup={reportId,submissionId,employee};
  pickupSignatureStrokes=[];
  employeeLabel.textContent=`Employee: ${employee||""}`;
  modal.classList.remove("hidden");
  modal.style.setProperty("display","flex","important");
  modal.style.visibility="visible";
  modal.style.opacity="1";
  initPickupSignatureCanvas();
  setTimeout(()=>{
    redrawPickupSignature();
    pickupCanvas()?.scrollIntoView?.({block:"center",behavior:"smooth"});
  },50);
};

window.submitPickupSignature=async function(){
  if(!pendingPickup) return;

  const pointCount=pickupSignatureStrokes.reduce((n,s)=>n+(s?.length||0),0);
  if(pointCount<4){
    alert("Please sign before submitting Picked Up.");
    return;
  }

  const {reportId,submissionId,employee}=pendingPickup;

  try{
    // Remove every board item matching this employee/report/submission.
    const boardSnap=await getDocs(query(collection(db,"moneyReadyBoard"),limit(100)));
    const employeeKey=String(employee||"").trim().toLowerCase();
    const matches=boardSnap.docs.filter(d=>{
      const r=d.data()||{};
      return d.id===submissionId
        || d.id===reportId
        || String(r.submissionId||"")===String(submissionId||"")
        || String(r.reportId||"")===String(reportId||"")
        || (employeeKey && String(r.employee||"").trim().toLowerCase()===employeeKey);
    });

    for(const d of matches){
      await deleteDoc(doc(db,"moneyReadyBoard",d.id));
    }

    const signaturePayload={
      // Firestore-safe shape: no array directly inside another array.
      strokes:pickupSignatureStrokes.map(stroke=>({
        points:(stroke||[]).map(p=>({x:Number(p.x||0),y:Number(p.y||0)}))
      })),
      signedAtLocal:new Date().toISOString()
    };

    if(submissionId){
      try{
        await updateDoc(doc(db,"submissions",submissionId),{
          pickupStatus:"picked_up",
          pickedUpAt:serverTimestamp(),
          pickedUpBy:employee||"",
          pickedUpProcessedBy:currentProfile.displayName||currentProfile.username,
          pickupSignature:signaturePayload,
          updatedAt:serverTimestamp()
        });
      }catch(e){ console.warn("Submission pickup update:",e); }
    }

    if(reportId){
      await updateDoc(doc(db,"hourlyReports",reportId),{
        pickupStatus:"picked_up",
        pickedUpAt:serverTimestamp(),
        pickedUpBy:employee||"",
        pickedUpProcessedBy:currentProfile.displayName||currentProfile.username,
        pickupSignature:signaturePayload,
        signatureStatus:"SIGNED"
      });
    }

    try{
      await writeAudit("money_picked_up_signed",reportId||submissionId||"",employee||"",{
        submissionId:submissionId||"",
        deletedBoardDocs:matches.length,
        signaturePoints:pointCount
      });
    }catch(e){}

    const pickupModal=$("pickupSignatureModal");
    if(pickupModal){ pickupModal.classList.add("hidden"); pickupModal.style.setProperty("display","none","important"); }
    pendingPickup=null;
    pickupSignatureStrokes=[];

    alert(`Picked Up complete. Signature saved. Removed ${matches.length} Server Room board item(s).`);
  }catch(e){
    console.error("Picked Up:",e);
    alert(`Picked Up failed: ${e.code||e.message}`);
  }
};

function renderFinalDailyByName(){
  syncOwnerFinalControls();
  const el=$("finalDailyByName");
  if(!el) return;

  const rows=[...latestHourlyReports].sort((a,b)=>{
    const n=(a.employee||"").localeCompare(b.employee||"");
    return n || String(b.date||"").localeCompare(String(a.date||""));
  });

  if(!rows.length){
    el.innerHTML='<div class="notice">No finalized reports yet.</div>';
    return;
  }

  const groups={};
  rows.forEach(r=>{
    const name=r.employee||"Unknown Employee";
    (groups[name]||(groups[name]=[])).push(r);
  });

  el.innerHTML=Object.entries(groups).map(([name,list])=>`
    <div class="final-name-card">
      <button class="final-name-row" type="button" onclick="toggleFinalEmployee('${encodeURIComponent(name)}')">
        <div>
          <div style="font-size:22px;font-weight:1000">${esc(name)}</div>
          <div class="small">${list.length} report${list.length===1?"":"s"} • Latest ${esc(list[0]?.date||"")}</div>
        </div>
        <div style="font-size:24px">▾</div>
      </button>
      <div id="${finalGroupId(name)}" class="final-detail hidden">
        ${list.map(r=>`
          <article style="border-top:1px solid #edf0f4;padding:16px 0">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
              <div>
                <b style="font-size:18px">${esc(r.date||"")} • ${esc(r.shift||"")}</b>
                <div class="small">${esc(r.position||"")} • MONEY READY ${Array.isArray(r.pickupSignature?.strokes)&&r.pickupSignature.strokes.length?"• Pickup Signature: SIGNED":""}</div>
              </div>
              <div class="actions">
                <button class="btn light" type="button" onclick="editHourlyReport('${r.id}')">Edit</button>
                <button class="btn light" type="button" onclick="window.republishMoneyReady('${r.id}')">Announce Again</button>
                <button class="btn light" type="button"
                  onclick="window.markMoneyPickedUp('${r.id}','${r.sourceSubmissionId||""}',this.dataset.employee)"
                  data-employee="${esc(r.employee||"")}">Picked Up</button>
                <button class="btn light" type="button" onclick="resendReportSms('${r.sourceSubmissionId||""}')">SMS Report</button>
                <button class="btn red" type="button" onclick="deleteHourlyReport('${r.id}')">Delete</button>
              </div>
            </div>
            <div class="grid3" style="margin-top:12px">
              <div class="kpi"><span>Grand Total</span><b>${fmtMoney(r.grandTotal)}</b></div>
              <div class="kpi"><span>Total AM</span><b>${fmtMoney(r.totalAM)}</b></div>
              <div class="kpi"><span>Total PM</span><b>${fmtMoney(r.totalPM)}</b></div>
              <div class="kpi"><span>Total Tips</span><b>${fmtMoney(r.totalTips)}</b></div>
              <div class="kpi"><span>Paid Tip</span><b>${fmtMoney(r.paidTip)}</b></div>
              <div class="kpi"><span>Busser Rate</span><b>${fmtPct(r.busserRate)}</b></div>
              <div class="kpi"><span>Busser Tip Out</span><b>${fmtMoney(r.busserTipOut)}</b></div>
              <div class="kpi"><span>Bar Tip Out</span><b>${fmtMoney(r.barTipOut)}</b></div>
              ${String(r.position||"").toLowerCase()==="bartender"?`
              <div class="kpi"><span>Bartender Shift</span><b>${esc((r.bartenderShiftType||"").replace("2PM_4PM","2 PM - 4 PM"))}</b></div>
              <div class="kpi"><span>Server Sales Summary</span><b>${fmtMoney(r.bartenderServerGrandTotalSummary)}</b></div>
              <div class="kpi"><span>Gross @ 0.6%</span><b>${fmtMoney(r.bartenderGrossBarTipOut)}</b></div>
              <div class="kpi"><span>Less Bartender AM</span><b>${fmtMoney(r.bartenderLessAM)}</b></div>
              <div class="kpi"><span>Less Bartender 2-4</span><b>${fmtMoney(r.bartenderLess24)}</b></div>
              <div class="kpi"><span>Bar Tip Out Received</span><b>${fmtMoney(r.bartenderBarTipReceived)}</b></div>`:""}
              <div class="kpi"><span>Meal</span><b>${fmtMoney(r.meal)}</b></div>
              <div class="kpi"><span>Hourly Adjustment</span><b>${fmtMoney(r.adjustmentSalaryHourly)}</b></div>
              <div class="kpi"><span>TOTAL PAID OUT</span><b>${fmtMoney(r.totalPaidOut)}</b></div>
            </div>
          </article>`).join("")}
      </div>
    </div>`).join("");
}

window.toggleFinalEmployee=function(encodedName){
  const name=decodeURIComponent(encodedName);
  const el=$(finalGroupId(name));
  if(el) el.classList.toggle("hidden");
};


window.openStaffTab=function(name){
  const btn=document.querySelector(`[data-stab="${name}"]`);
  if(btn) btn.click();
};

function listenHourlyReports(){
  const q=query(collection(db,"hourlyReports"),orderBy("createdAt","desc"),limit(200));
  unsubs.push(onSnapshot(q,snap=>{
    latestHourlyReports=snap.docs.map(d=>({id:d.id,...d.data()}));
    renderFinalDailyByName();
    const legacy=$("hourlyReportsList");
    if(legacy){
      legacy.innerHTML="";
      legacy.classList.add("hidden");
    }
  },e=>console.error("Hourly reports:",e)));
}



window.republishMoneyReady=async function(reportId){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  const r=latestHourlyReports.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}
  const submissionId=r.sourceSubmissionId||reportId;
  try{
    await setDoc(doc(db,"moneyReadyBoard",submissionId),{
      employee:r.employee||"",
      submissionId:r.sourceSubmissionId||"",
      reportId:r.id,
      message:"Money is ready. Please come to cashier.",
      active:true,
      createdAt:serverTimestamp(),
      finalizedBy:currentProfile.displayName||currentProfile.username,
      announceNonce:Date.now()
    },{merge:true});
    alert(`${r.employee||"Employee"} sent to Server Room Board.`);
  }catch(e){
    alert(`Board publish failed: ${e.code||e.message}. Publish the V10.1 Firestore rules.`);
  }
};

window.resendReportSms=async function(submissionId){
  if(!submissionId){alert("This report is not linked to an employee submission.");return;}
  try{
    const result=await resendMoneyReadySms({submissionId});
    if(result?.data?.ok) alert(`SMS sent to ${result.data.phoneMasked||"employee"}.`);
  }catch(e){
    alert(`SMS failed: ${e.message||e.code}. Check Twilio setup.`);
  }
};

window.editHourlyReport=function(id){
  const r=latestHourlyReports.find(x=>x.id===id); if(!r) return;
  currentHourlyReportId=id;
  currentHourlySubmissionId=r.sourceSubmissionId||null;
  $("hDate").value=r.date||todayLocal();
  $("hEmployee").value=r.employee||"";
  $("hPosition").value=r.position||"Server";
  $("hShift").value=r.shift||"AM";
  $("hBusserAM").value=r.busserAM||"WITH";
  $("hMeal").value=Number(r.meal||0);
  $("hGrandTotal").value=Number(r.grandTotal||0);
  $("hTotalAM").value=Number(r.totalAM||0);
  $("hPaidTip").value=Number(r.paidTip||0);
  $("hCardFee").value=Number(r.payCardTipFee ?? r.cardFee ?? 0);
  $("hCashTip").value=Number(r.cashTip||0);
  $("hAmBar").value=(r.barSalesAM||r.amBarSales)?"yes":"no";
  $("hPmBar").value=(r.barSalesPM||r.pmBarSales)?"yes":"no";
  syncHourlyShift();
  if(String(r.position||"").toLowerCase()==="bartender"){
    if($("hBartenderShiftType")) $("hBartenderShiftType").value=r.bartenderShiftType||"AM";
    if($("hBtPrevAMInput")) $("hBtPrevAMInput").value=Number(r.bartenderPreviousAMInput||r.bartenderLessAM||0)||"";
    if($("hBtPrev24Input")) $("hBtPrev24Input").value=Number(r.bartenderPrevious24Input||r.bartenderLess24||0)||"";
    const entries=Array.isArray(r.bartenderServerEntries)?r.bartenderServerEntries:[];
    for(let i=1;i<=9;i++){
      const e=entries.find(x=>Number(x.slot)===i)||entries[i-1]||{};
      if($(`hBtServerName${i}`)){
        const sel=$(`hBtServerName${i}`);
        const savedName=e.name||"";
        if(savedName && !Array.from(sel.options).some(o=>o.value===savedName)){
          const opt=document.createElement("option");
          opt.value=savedName;
          opt.textContent=savedName;
          sel.appendChild(opt);
        }
        sel.value=savedName;
      }
      if($(`hBtServerGrand${i}`)) $(`hBtServerGrand${i}`).value=Number(e.grandTotal||0)||"";
    }
    calculateBartenderBarTipOut();
  }
  const hrs=r.hours||{};
  $("hIn").value=hrs.hourIn||"";
  $("hOut").value=hrs.hourOut||"";
  $("hAmIn").value=hrs.hourInAM||"";
  $("hAmOut").value=hrs.hourOutAM||"";
  $("hPmIn").value=hrs.hourInPM||"";
  $("hPmOut").value=hrs.hourOutPM||"";
  document.querySelector('[data-stab="hourly"]')?.click();
};

window.deleteHourlyReport=async function(id){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Delete this final hourly report?")) return;
  try{
    const ref=doc(db,"hourlyReports",id);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await deleteDoc(ref);
    if(before?.sourceSubmissionId){
      await updateDoc(doc(db,"submissions",before.sourceSubmissionId),{
        status:"hourly_pending",
        hourlyStatus:"waiting_manager",
        hourlyReportId:"",
        updatedAt:serverTimestamp()
      });
    }
    await writeAudit("hourly_report_delete",id,before?.employee||"",{before});
  }catch(e){ alert(`Delete report failed: ${e.code||e.message}`); }
};


function applyAutomaticBusserRule(){
  const date=$("hDate").value, shift=$("hShift").value;
  const weekend=isWeekendDate(date);
  if(shift==="AM"){
    $("hBusserAM").value=weekend?"WITH":"WITHOUT";
  }else if(shift==="DOUBLE"){
    $("hBusserAM").value=weekend?"WITH":"WITHOUT";
  }else{
    $("hBusserAM").value="WITHOUT";
  }
}

function syncHourlyShift(){
  const shift=$("hShift").value;
  const dbl=shift==="DOUBLE";
  $("hSingleClock").classList.toggle("hidden",dbl);
  $("hDoubleClock").classList.toggle("hidden",!dbl);
  $("hTotalAMWrap").classList.toggle("hidden",!dbl);
  const busser=$("hBusserAM")?.closest("div");
  if(busser) busser.classList.toggle("hidden",shift==="PM" || $("hPosition").value==="Bartender");
  const am=$("hAmBar")?.closest("div"), pm=$("hPmBar")?.closest("div");
  if(am) am.classList.toggle("hidden",!(shift==="AM"||dbl));
  if(pm) pm.classList.toggle("hidden",!(shift==="PM"||dbl));
  applyAutomaticBusserRule();
  syncBartenderBarReceivedField();
}
$("hShift").addEventListener("change",syncHourlyShift);
$("hPosition").addEventListener("change",syncHourlyShift);
$("hDate").addEventListener("change",applyAutomaticBusserRule);





function populateBartenderServerDropdowns(){
  const names=[...EMPLOYEE_ROSTER].sort((a,b)=>a.localeCompare(b));
  const options=names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join("");

  for(let i=1;i<=9;i++){
    const sel=$(`hBtServerName${i}`);
    if(!sel) continue;

    const previous=sel.value||"";
    // Populate once only. Rebuilding a native SELECT while it is open causes
    // the "must click quickly" problem on Chrome/tablets.
    if(sel.dataset.rosterLoaded!=="1"){
      sel.innerHTML=`<option value="">Select Server ${i}</option>${options}`;
      sel.dataset.rosterLoaded="1";
    }

    if(previous){
      if(!Array.from(sel.options).some(o=>o.value===previous)){
        const opt=document.createElement("option");
        opt.value=previous;
        opt.textContent=previous;
        sel.appendChild(opt);
      }
      sel.value=previous;
    }
  }
}

function bartenderServerEntries(){
  const out=[];
  for(let i=1;i<=9;i++){
    const name=String($(`hBtServerName${i}`)?.value||"").trim();
    const grandTotal=Number($(`hBtServerGrand${i}`)?.value||0);
    out.push({slot:i,name,grandTotal:Number.isFinite(grandTotal)?grandTotal:0});
  }
  return out;
}

function previousBartenderReceived(date,type){
  const matches=(latestHourlyReports||[])
    .filter(r=>String(r.position||"").toLowerCase()==="bartender")
    .filter(r=>String(r.date||"")===String(date||""))
    .filter(r=>{
      const bt=String(r.bartenderShiftType||"");
      if(bt===type) return true;
      // Compatibility with older finalized bartender reports that did not yet save bartenderShiftType.
      if(!bt && type==="AM" && String(r.shift||"").toUpperCase()==="AM") return true;
      return false;
    })
    .sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  return Number(matches[0]?.bartenderBarTipReceived||0);
}

window.calculateBartenderBarTipOut=function calculateBartenderBarTipOut(){
  const isBartender=String($("hPosition")?.value||"").toLowerCase()==="bartender";
  if(!isBartender) return {
    bartenderShiftType:"",serverEntries:[],serverGrandTotalSummary:0,
    grossBarTipOut:0,lessBartenderAM:0,lessBartender24:0,bartenderBarTipReceived:0
  };

  const type=$("hBartenderShiftType")?.value||"AM";
  const date=$("hDate")?.value||"";
  const serverEntries=bartenderServerEntries();
  const summary=serverEntries.reduce((s,r)=>s+Number(r.grandTotal||0),0);
  const gross=summary*0.006;

  const lessAM=type==="AM" ? 0 : Number($("hBtPrevAMInput")?.value||0);
  const less24=type==="PM" ? Number($("hBtPrev24Input")?.value||0) : 0;

  if($("hBtPrevAMWrap")) $("hBtPrevAMWrap").classList.toggle("hidden",type==="AM");
  if($("hBtPrev24Wrap")) $("hBtPrev24Wrap").classList.toggle("hidden",type!=="PM");

  let finalReceived=type==="AM" ? gross
    : type==="2PM_4PM" ? gross-lessAM
    : gross-lessAM-less24;

  finalReceived=Math.max(0,finalReceived);

  if($("hBtServerSummary")) $("hBtServerSummary").textContent=fmtMoney(summary);
  if($("hBtGross")) $("hBtGross").textContent=fmtMoney(gross);
  if($("hBtLessAM")) $("hBtLessAM").textContent=fmtMoney(lessAM);
  if($("hBtLess24")) $("hBtLess24").textContent=fmtMoney(less24);
  if($("hBtFinal")) $("hBtFinal").textContent=fmtMoney(finalReceived);
  if($("hBartenderBarReceived")) $("hBartenderBarReceived").value=finalReceived.toFixed(2);
  if($("hBtFormulaCheck")){
    const label=type==="AM"
      ? `${fmtMoney(summary)} × 0.6% = ${fmtMoney(finalReceived)}`
      : type==="2PM_4PM"
        ? `${fmtMoney(summary)} × 0.6% = ${fmtMoney(gross)} − Bartender AM ${fmtMoney(lessAM)} = ${fmtMoney(finalReceived)}`
        : `${fmtMoney(summary)} × 0.6% = ${fmtMoney(gross)} − Bartender AM ${fmtMoney(lessAM)} − Bartender 2-4 ${fmtMoney(less24)} = ${fmtMoney(finalReceived)}`;
    $("hBtFormulaCheck").textContent=label;
  }

  return {
    bartenderShiftType:type,
    serverEntries,
    serverGrandTotalSummary:summary,
    grossBarTipOut:gross,
    lessBartenderAM:lessAM,
    lessBartender24:less24,
    bartenderPreviousAMInput:lessAM,
    bartenderPrevious24Input:less24,
    bartenderBarTipReceived:finalReceived
  };
}

function syncBartenderBarReceivedField(){
  const wrap=$("hBartenderBarReceivedWrap");
  if(!wrap) return;
  const isBartender=String($("hPosition")?.value||"").toLowerCase()==="bartender";
  wrap.classList.toggle("hidden",!isBartender);
  if(isBartender) populateBartenderServerDropdowns();
  if(!isBartender){
    if($("hBartenderBarReceived")) $("hBartenderBarReceived").value="0";
    return;
  }
  calculateBartenderBarTipOut();
}


$("hBartenderShiftType")?.addEventListener("change",window.calculateBartenderBarTipOut);
for(let i=1;i<=9;i++){
  $(`hBtServerGrand${i}`)?.addEventListener("input",window.calculateBartenderBarTipOut);
  $(`hBtServerName${i}`)?.addEventListener("change",window.calculateBartenderBarTipOut);
}

// Extra delegated listener makes the bartender calculation reliable on shared tablets/Chrome,
// even if a field was rebuilt or restored after initial page load.
document.addEventListener("input",e=>{
  if(/^hBtServerGrand[1-9]$/.test(e.target?.id||"")) window.calculateBartenderBarTipOut();
});
document.addEventListener("change",e=>{
  const id=e.target?.id||"";
  if(id==="hBartenderShiftType" || /^hBtServerName[1-9]$/.test(id)) window.calculateBartenderBarTipOut();
});
$("hBtPrevAMInput")?.addEventListener("input",window.calculateBartenderBarTipOut);
$("hBtPrev24Input")?.addEventListener("input",window.calculateBartenderBarTipOut);

window.calculateHourlyV01=function(){
  const L=window.FredTipCalculatorLogic;
  if(!L){ alert("Hourly Adjustment V01 calculation engine is unavailable."); return null; }
  const shift=$("hShift").value;
  const hours=shift==="DOUBLE" ? {
    hourInAM:$("hAmIn").value,
    hourOutAM:$("hAmOut").value,
    hourInPM:$("hPmIn").value,
    hourOutPM:$("hPmOut").value
  } : {
    hourIn:$("hIn").value,
    hourOut:$("hOut").value
  };
  lastHourlyResult=L.calculateReport({
    date:$("hDate").value,
    employee:$("hEmployee").value,
    position:$("hPosition").value,
    shift,
    busserAM:$("hBusserAM").value,
    hours,
    grandTotal:$("hGrandTotal").value,
    totalAM:$("hTotalAM").value,
    paidTip:$("hPaidTip").value,
    cardFee:$("hCardFee").value,
    cashTip:$("hCashTip").value,
    meal:$("hMeal").value,
    amBarSales:$("hAmBar").value==="yes",
    pmBarSales:$("hPmBar").value==="yes"
  });

  // Bartender Bar Tip Out Received: Fred's AM / 2 PM-4 PM / PM formula.
  const bt=calculateBartenderBarTipOut();
  const bartenderBarTipReceived=
    String($("hPosition").value||"").toLowerCase()==="bartender"
      ? Number(bt.bartenderBarTipReceived||0)
      : 0;

  lastHourlyResult.bartenderShiftType=bt.bartenderShiftType||"";
  lastHourlyResult.bartenderServerEntries=bt.serverEntries||[];
  lastHourlyResult.bartenderServerGrandTotalSummary=Number(bt.serverGrandTotalSummary||0);
  lastHourlyResult.bartenderGrossBarTipOut=Number(bt.grossBarTipOut||0);
  lastHourlyResult.bartenderLessAM=Number(bt.lessBartenderAM||0);
  lastHourlyResult.bartenderLess24=Number(bt.lessBartender24||0);
  lastHourlyResult.bartenderPreviousAMInput=Number(bt.bartenderPreviousAMInput||0);
  lastHourlyResult.bartenderPrevious24Input=Number(bt.bartenderPrevious24Input||0);
  lastHourlyResult.bartenderBarTipReceived=bartenderBarTipReceived;

  if(bartenderBarTipReceived>0){
    // Added to bartender payout. Cash Tip is still excluded from TOTAL PAID OUT.
    lastHourlyResult.grandTotalTip=Number(lastHourlyResult.grandTotalTip||0)+bartenderBarTipReceived;
    lastHourlyResult.totalBeforeMeal=Number(lastHourlyResult.totalBeforeMeal||0)+bartenderBarTipReceived;
    lastHourlyResult.grandTotalAfterAdjustment=Number(lastHourlyResult.grandTotalAfterAdjustment||0)+bartenderBarTipReceived;
    lastHourlyResult.totalPaidOut=Number(lastHourlyResult.totalPaidOut||0)+bartenderBarTipReceived;
  }

  // Pay Card Tip Fee: manager input is authoritative.
  // This avoids legacy V01 naming differences (cardFee vs payCardTipFee).
  const enteredCardFee=Number($("hCardFee")?.value||0);
  lastHourlyResult.cardFee=enteredCardFee;
  lastHourlyResult.payCardTipFee=enteredCardFee;

  const r=lastHourlyResult;
  const m=fmtMoney, p=fmtPct;
  $("hrHours").textContent=r.totalHoursWork==null?"—":Number(r.totalHoursWork).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  $("hrGrandTotal").textContent=m(r.grandTotal);
  $("hrTotalAM").textContent=m(r.totalAM);
  $("hrTotalPM").textContent=m(r.totalPM);
  $("hrTotalTips").textContent=m(r.totalTips);
  $("hrCardFee").textContent=m(Number($("hCardFee")?.value||0));
  $("hrPaidTip").textContent=m(r.paidTip);
  $("hrBusserRate").textContent=`${Number(r.busserRate||0).toFixed(2)}%`;
  $("hrBusserTip").textContent=m(r.busserTipOut);
  $("hrBarAM").textContent=m(r.barTipAM);
  $("hrBarPM").textContent=m(r.barTipPM);
  $("hrBarOut").textContent=m(r.barTipOut);
  let bartenderReceivedLine=$("hrBartenderReceivedLine");
  if(String(r.position||"").toLowerCase()==="bartender"){
    if(!bartenderReceivedLine){
      bartenderReceivedLine=document.createElement("div");
      bartenderReceivedLine.id="hrBartenderReceivedLine";
      bartenderReceivedLine.innerHTML='Bar Tip Out Received <b id="hrBartenderReceived"></b>';
      $("hrBarOut").parentElement.insertAdjacentElement("afterend",bartenderReceivedLine);
    }
    $("hrBartenderReceived").textContent=m(r.bartenderBarTipReceived);
    bartenderReceivedLine.classList.remove("hidden");
  }else if(bartenderReceivedLine){
    bartenderReceivedLine.classList.add("hidden");
  }
  $("hrBeforeMeal").textContent=m(r.totalBeforeMeal);
  $("hrCashTip").textContent=m(r.cashTip);
  $("hrGrandTip").textContent=m(r.grandTotalTip);
  $("hrHourlyRate").textContent=m(r.hourlyRate);
  $("hrMinimum").textContent=m(r.hourlyMinimum);
  $("hrAdjustment").textContent=m(r.adjustmentSalaryHourly);
  $("hrAfter").textContent=m(r.grandTotalAfterAdjustment);
  $("hrMeal").textContent=m(r.meal);
  $("hrPaidOut").textContent=m(r.totalPaidOut);
  $("hourlyResult").classList.remove("hidden");
  return r;
};

window.saveHourlyV01=async function(){
  const r=calculateHourlyV01();
  if(!r) return;
  try{
    let ref;
    if(currentHourlyReportId){
      ref=doc(db,"hourlyReports",currentHourlyReportId);
      await updateDoc(ref,{
        ...r,
        sourceSubmissionId:currentHourlySubmissionId||"",
        status:"money_ready",
        updatedAt:serverTimestamp(),
        updatedBy:currentProfile.displayName||currentProfile.username
      });
    }else{
      ref=doc(collection(db,"hourlyReports"));
      await setDoc(ref,{
        ...r,
        sourceSubmissionId:currentHourlySubmissionId||"",
        status:"money_ready",
        createdAt:serverTimestamp(),
        createdByUid:currentUser.uid,
        createdBy:currentProfile.displayName||currentProfile.username
      });
    }

    if(currentHourlySubmissionId){
      await updateDoc(doc(db,"submissions",currentHourlySubmissionId),{
        status:"money_ready",
        hourlyStatus:"finalized",
        hourlyReportId:ref.id,
        finalReport:{
          grandTotal:Number(r.grandTotal||0),
          totalAM:Number(r.totalAM||0),
          totalPM:Number(r.totalPM||0),
          meal:Number(r.meal||0),
          cashTip:Number(r.cashTip||0),
          paidTip:Number(r.paidTip||0),
          busserRate:Number(r.busserRate||0),
          busserTipOut:Number(r.busserTipOut||0),
          barTipOut:Number(r.barTipOut||0),
    bartenderBarTipReceived:Number(r.bartenderBarTipReceived||0),
          grandTotalTip:Number(r.grandTotalTip||0),
          hourlyRate:Number(r.hourlyRate||0),
          hourlyMinimum:Number(r.hourlyMinimum||0),
          adjustmentSalaryHourly:Number(r.adjustmentSalaryHourly||0),
          grandTotalAfterAdjustment:Number(r.grandTotalAfterAdjustment||0),
          totalPaidOut:Number(r.totalPaidOut||0)
        },
        finalizedBy:currentProfile.displayName||currentProfile.username,
        finalizedAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });
    }

    // Optional actions must NOT cause Final Submit to fail.
    try{
      await writeAudit(currentHourlyReportId?"hourly_report_edit":"hourly_final_money_ready",
        ref.id,r.employee,{after:r,sourceSubmissionId:currentHourlySubmissionId||""});
    }catch(e){ console.warn("Audit log skipped:",e); }

    if(currentHourlySubmissionId){
      try{
        const moneyReadyRef=doc(db,"moneyReadyBoard",currentHourlySubmissionId);
        await setDoc(moneyReadyRef,{
          employee:r.employee||"",
          submissionId:currentHourlySubmissionId,
          reportId:ref.id,
          message:"Your tip money is ready. Please come to the cashier.",
          alert:true,
          active:false,
          announceNonce:Date.now(),
          createdAt:serverTimestamp(),
          finalizedBy:currentProfile.displayName||currentProfile.username
        });

        // Global dialogs on logged-out / Employee screens are published first.
        await new Promise(resolve=>setTimeout(resolve,1200));
        await updateDoc(moneyReadyRef,{active:true,boardActivatedAt:serverTimestamp()});
      }catch(e){ console.warn("Money Ready board write skipped:",e); }
    }

    alert("Final approved. Report moved to Final Daily Report. Employee status: MONEY READY.");
    openStaffTab("finalDaily");
    currentHourlyReportId=null;
    currentHourlySubmissionId=null;
  }catch(e){
    console.error("Final submit failed:",e);
    alert(`Final Submit failed: ${e.code || e.message}`);
  }
};

window.exportCSV=function(){
  const rows=[
    ["Date","Employee","Position","Shift","Break","Clock","Grand Total","Total AM","Meal","Cash Tip","Status","Reviewed By"],
    ...latestRows.map(r=>[
      r.date,r.employee,r.position,r.shift,r.breakMode||"none",r.clock,
      r.grandTotal||0,r.totalAM||0,r.meal||0,r.cashTip||0,r.status,r.reviewedBy||""
    ])
  ];
  const csv=rows.map(row=>row.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  const a=document.createElement("a");
  a.href=url; a.download="Juicy_Tip_Report.csv"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};

$("eDate").value=todayLocal();
$("hDate").value=todayLocal();
populateRoster();
refreshClockMode();
syncHourlyShift();

// V9.2 employee input improvements
function fz24(id){
 const e=document.getElementById(id); if(!e)return;
 e.addEventListener("input",()=>{let d=e.value.replace(/\D/g,"").slice(0,4);e.value=d.length>2?d.slice(0,2)+":"+d.slice(2):d;});
}
["eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut"].forEach(fz24);
["eGrandTotal","eTotalAM","eMeal","eCash"].forEach(id=>{
 const e=document.getElementById(id); if(e)e.addEventListener("focus",()=>{if(Number(e.value)===0)setTimeout(()=>e.select(),0);});
});

// V9.3 workflow: approve -> hourly queue -> final money ready; final report edit/delete; fixed app user delete.

// V9.4: employee Paid Tip field added; Total AM remains conditional for DOUBLE/LONG; formulas unchanged.

// V9.5: employee live busser % for DOUBLE/LONG; Manager Review/Report submit routes same record into Hourly; final save triggers money_ready notification. V01 formulas unchanged.

// V9.6: Paid Tip removed from employee; shift-sensitive WITH BAR AM/PM; Hourly result/report restored to V01-style fields and original FredTipCalculatorLogic engine.

// V9.7: robust Employee Clear; finalized manager hourly calculation becomes employee-only final report with MONEY READY status.

// V9.8: Server Room Money Ready Board + anonymous kiosk mode + automatic weekday/weekend busser rules.


function fmtMoney(v){
  return "$ " + Number(v||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtPct(v){
  return (Number(v||0)*100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+"%";
}
function selectZeroOnFocus(el){
  if(!el) return;
  el.addEventListener("focus",()=>{
    const raw=String(el.value??"").trim();
    if(raw==="" || Number(raw)===0) setTimeout(()=>el.select(),0);
  });
  el.addEventListener("click",()=>{
    const raw=String(el.value??"").trim();
    if(raw!=="" && Number(raw)===0) setTimeout(()=>el.select(),0);
  });
}
["hGrandTotal","hTotalAM","hPaidTip","hCardFee","hCashTip","hMeal",
 "mGrandTotal","mTotalAM","mPaidTip","mMeal","mCash",
 "eGrandTotal","eTotalAM","eMeal","eCash"].forEach(id=>selectZeroOnFocus($(id)));

// V9.9: Hourly queue duplicate delete; XLS/PDF sharing; automatic Money Ready SMS backend support.

// V10.0: polished Hourly V01 UI, comma/space currency formatting, zero overwrite inputs, Final Daily Report, robust final submit.

// V10.1: persistent Server Room Board, visible diagnostics, test chime, announce-again from Final Daily Report.

// V10.3: separate Final Daily Report grouped by employee; draft autosave; queued global Money Ready overlays.

// V10.4 FINAL: Final Daily Report is its own staff tab, grouped by employee; owner-only Clear All; final submit opens that tab.

// V10.5: PDF rebuilt in legacy Fred Zhang one-employee-per-page report layout; XLS rebuilt as styled Excel XML matching legacy Daily Report columns. Busser Rate export fixed (1.500%, not 150%).

// V10.7 REPORT STYLE: original Fred Zhang report layout restored; main PDF values 14pt; Excel Arial 14; network-first code cache.

// V10.8: Employee can delete only their own non-final submission from Current / Pending Report.

document.addEventListener("change",e=>{
  if(e.target?.id==="hPosition") syncBartenderBarReceivedField();
});

// V10.9: Bartender-only Bar Tip Out Received is additional tip income and is included in final totals/reports.

// V11.0 shared-tablet security and Money Ready cleanup.

// V11.1: ALL authenticated roles use memory-only auth. Refresh/new tab/new window/shared link always requires fresh login.

// V11.2: History soft delete + 3-day Undo/purge; Server Room cards auto-expire after 30 minutes.

// V11.3: Owner History Delete All/Undo All; Picked Up deletes all matching board docs; board documents are physically deleted after 30 minutes.

// V11.3.1: fixed missing getDocs import for Picked Up and History Delete All/Undo All.

// V11.4: bartender AM / 2PM-4PM / PM server 1-9 Grand Total calculator using Fred formula at 0.6%; cash tip remains excluded from payout.

// V11.5: Picked Up opens employee signature pad; signature strokes are stored and rendered into Final Report PDF.

// V11.6: Bartender Server 1-9 names are dropdowns populated from active Employee accounts.

// V11.6.1 fresh filename: forces Pickup Signature handler to load without stale app.js cache.

// V11.6.2: Firestore-safe pickup signature storage + PDF signature rendering + bartender PDF spacing fix.

// V11.7: full employee roster dropdown, stable select behavior, Firestore-safe pickup signature, clean PDF signature layout.

// V11.7.1: PDF footer no-overlap; Picked Up By is the employee signer; processor retained separately.

// V11.7.2: Picked Up By in PDF/report is always the employee whose tip report is being processed.

// V11.8: reliable bartender 2-4/PM live calculation + explicit calculate button + formula check.

// V11.9: Bartender previous AM and 2-4 tip-outs are manually entered by Manager; formulas use all server Grand Totals × 0.6%.

// V12.0: bidirectional realtime sound/vibration/browser alerts for Employee <-> Manager/Owner while app is open.

// V12.1: female-preferred English voice announcement for Money Ready in Server Room.

// V12.1.1: browser voice warm-up/unlock support.

// V12.1.2: delegated Picked Up / Announce Again buttons and defensive signature modal opening.

window.__pickupBuild="12.1.4";
console.log("Pickup signature build 12.1.4 loaded", typeof window.markMoneyPickedUp);

// V12.1.4 clean rebuild from V12.1.2: direct Picked Up call, intact modal HTML.

// V12.2: server-room audio session controls are handled by board-hotfix.js.

setTimeout(()=>startGlobalMoneyReadyWatcher(),250);

// V12.3: global Money Ready dialog on logged-out/employee views; bundled WAV chime; alert first, board activates after 900ms.

// V12.4: separate anonymous Firebase alert session; primary Employee/Manager auth untouched; reliable global dialog token.

// V12.4.1: Pay Card Tip Fee display/save normalization fix (V01 engine returns payCardTipFee).

// V12.4.2: Pay Card Tip Fee hard fix. hCardFee input is authoritative for display/save.

// V12.4.3: Busser Rate display fix only. 1.20 now renders as 1.20%, Busser Tip Out formula unchanged.

// V13.0 PUSH STAGING: background FCM registration layer; stable V12.4.3 logic preserved.

// V13.2: Check Tip workflow for Employee, Manager/Owner, Cashier, and Owner reporting.

// V13.2.1: Quick Board table dropdown + cashier row results + callable-based Check Tip security fix.

// V13.2.2: completed cashier reports persist; Cashier/Manager/Owner per-row review/edit/delete/reopen.

window.__getTipCheckSheets=()=>latestTipCheckSheets; window.__refreshTipCheckSheets=()=>loadTipCheckSheets();

// V13.3.1: Employee Check Tip status grouped by date.

// V13.3.2: unified review Save accepts selected result directly.

// V13.3.3 grouped checklist completion support

// V13.3.4: hard role isolation + shared-device logout security.

// V13.3.5: employee completed status ignores stale empty Check Tip sheets.
