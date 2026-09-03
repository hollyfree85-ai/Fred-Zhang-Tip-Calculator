import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, "us-central1");
const createUserAdmin = httpsCallable(functions, "createAppUser");
const deleteUserAdmin = httpsCallable(functions, "deleteAppUser");
const resendMoneyReadySms = httpsCallable(functions, "resendMoneyReadySms");

let currentUser = null;
let currentProfile = null;
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
  ["employeeUsername","signupName","hEmployee"].forEach(id=>{
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

window.logout = async function(){
  await signOut(auth);
};

async function loadProfile(uid){
  const snap = await getDoc(doc(db,"users",uid));
  return snap.exists() ? snap.data() : null;
}
function clearListeners(){
  unsubs.forEach(fn=>{ try{fn()}catch(e){} });
  unsubs=[];
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

  const emp=currentProfile.role==="employee";
  $("employeeApp").classList.toggle("hidden",!emp);
  $("staffApp").classList.toggle("hidden",emp);
  $("employeeBottom").classList.toggle("hidden",!emp);
  document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",currentProfile.role!=="owner"));

  if(emp){ restoreEmployeeDraft(); listenEmployee(); }
  else listenStaff();
}

onAuthStateChanged(auth, async user=>{
  clearListeners();
  if(!user){
    currentUser=null; currentProfile=null;
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
    alert("Submitted to Manager.");
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
      if(typeof Notification!=="undefined" && Notification.permission==="granted"){
        new Notification("Fred Zhang Tip Calculator",{body:"Money is ready. Please come to cashier.",icon:"icon-192.png"});
      }
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

function notifyManager(r){
  if(typeof Notification!=="undefined" && Notification.permission==="granted"){
    new Notification("New Employee Submission",{body:`${r.employee} — ${r.shift}`,icon:"icon-192.png"});
  }
}

function listenStaff(){
  const q=query(collection(db,"submissions"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    latestRows=rows;
    const pending=rows.filter(r=>r.status==="pending");
    for(const r of pending) if(!knownPending.has(r.id)) notifyManager(r);
    knownPending=new Set(pending.map(r=>r.id));
    renderStaff(rows);
  },e=>{
    console.error("Staff listener:",e);
    $("backendStatus").textContent=`Firestore error: ${e.code || e.message}`;
    $("backendStatus").className="notice danger";
  }));

  listenApprovals();
  listenHourlyReports();
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
  if(role==="manager" && secret.length<6){
    alert("Manager password must be at least 6 characters.");
    return;
  }

  try{
    const result=await createUserAdmin({username,role,secret});
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

function listenHistory(){
  if(currentProfile.role!=="owner") return;
  const q=query(collection(db,"auditLogs"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    $("historyBody").innerHTML=rows.length?rows.map(r=>{
      let time="";
      try{ time=r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString() : ""; }catch(e){}
      return `<tr>
        <td>${esc(time)}</td><td>${esc(r.actor||"")}</td><td>${esc(r.actorRole||"")}</td>
        <td>${esc(r.action||"")}</td><td>${esc(r.employee||"")}</td>
        <td>${esc(r.submissionId||"")}</td>
        <td>${esc(JSON.stringify(r.details||{}).slice(0,300))}</td>
      </tr>`;
    }).join(""):'<tr><td colspan="7">No history yet.</td></tr>';
  },e=>console.error("History listener:",e)));
}

window.requestNotify=async function(){
  if(!("Notification" in window)){ alert("Notifications not supported here."); return; }
  const p=await Notification.requestPermission();
  alert("Notification permission: "+p);
};




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
  $("hCardFee").value=Number(r.cardFee||0);
  $("hAmBar").value=r.barSalesAM?"yes":"no";
  $("hPmBar").value=r.barSalesPM?"yes":"no";
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
    "Bar Tip Out","Bar Tip Out Received","Total Before Meal","Cash Tip","Grand Total Tip","Hourly Rate","Hourly Minimum",
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
  for(const [label,value] of right){
    c+=pdfField(label,value,322,y);
    y-=35;
  }

  // Footer block matching the old report: very prominent paid out.
  c+="0.9 w 28 105 m 584 105 l S\n";
  c+="BT /F2 15 Tf 28 82 Td (TOTAL PAID OUT) Tj ET\n";
  c+=`BT /F2 30 Tf 28 48 Td (${pdfEscape(pdfMoney(r.totalPaidOut))}) Tj ET\n`;

  const status=String(r.status||"MONEY READY").toUpperCase();
  c+="BT /F2 13 Tf 322 82 Td (FINAL REPORT - MONEY READY) Tj ET\n";
  c+=`BT /F1 9.5 Tf 322 64 Td (Status: ${pdfEscape(status)}) Tj ET\n`;
  if(r.finalizedBy){
    c+=`BT /F1 9.5 Tf 322 49 Td (Finalized By: ${pdfEscape(r.finalizedBy)}) Tj ET\n`;
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
                <div class="small">${esc(r.position||"")} • MONEY READY</div>
              </div>
              <div class="actions">
                <button class="btn light" type="button" onclick="editHourlyReport('${r.id}')">Edit</button>
                <button class="btn light" type="button" onclick="republishMoneyReady('${r.id}')">Announce Again</button>
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
              ${String(r.position||"").toLowerCase()==="bartender"?`<div class="kpi"><span>Bar Tip Out Received</span><b>${fmtMoney(r.bartenderBarTipReceived)}</b></div>`:""}
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
  $("hCardFee").value=Number(r.cardFee||0);
  $("hCashTip").value=Number(r.cashTip||0);
  $("hAmBar").value=(r.barSalesAM||r.amBarSales)?"yes":"no";
  $("hPmBar").value=(r.barSalesPM||r.pmBarSales)?"yes":"no";
  syncHourlyShift();
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


function syncBartenderBarReceivedField(){
  const wrap=$("hBartenderBarReceivedWrap");
  if(!wrap) return;
  const isBartender=String($("hPosition")?.value||"").toLowerCase()==="bartender";
  wrap.classList.toggle("hidden",!isBartender);
  if(!isBartender && $("hBartenderBarReceived")) $("hBartenderBarReceived").value="";
}

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

  // Bartender receives server bar tip-outs as additional tip income.
  // The original V01 engine remains untouched; this is added after its normal calculation.
  const bartenderBarTipReceived=
    String($("hPosition").value||"").toLowerCase()==="bartender"
      ? Number($("hBartenderBarReceived")?.value||0)
      : 0;

  if(bartenderBarTipReceived>0){
    lastHourlyResult.bartenderBarTipReceived=bartenderBarTipReceived;
    lastHourlyResult.grandTotalTip=Number(lastHourlyResult.grandTotalTip||0)+bartenderBarTipReceived;
    lastHourlyResult.totalBeforeMeal=Number(lastHourlyResult.totalBeforeMeal||0)+bartenderBarTipReceived;
    lastHourlyResult.grandTotalAfterAdjustment=Number(lastHourlyResult.grandTotalAfterAdjustment||0)+bartenderBarTipReceived;
    lastHourlyResult.totalPaidOut=Number(lastHourlyResult.totalPaidOut||0)+bartenderBarTipReceived;
  }else{
    lastHourlyResult.bartenderBarTipReceived=0;
  }

  const r=lastHourlyResult;
  const m=fmtMoney, p=fmtPct;
  $("hrHours").textContent=r.totalHoursWork==null?"—":Number(r.totalHoursWork).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  $("hrGrandTotal").textContent=m(r.grandTotal);
  $("hrTotalAM").textContent=m(r.totalAM);
  $("hrTotalPM").textContent=m(r.totalPM);
  $("hrTotalTips").textContent=m(r.totalTips);
  $("hrCardFee").textContent=m(r.cardFee);
  $("hrPaidTip").textContent=m(r.paidTip);
  $("hrBusserRate").textContent=p(r.busserRate);
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
        await setDoc(doc(db,"moneyReadyBoard",currentHourlySubmissionId),{
          employee:r.employee||"",
          submissionId:currentHourlySubmissionId,
          reportId:ref.id,
          message:"Money is ready. Please come to cashier.",
          active:true,
          createdAt:serverTimestamp(),
          finalizedBy:currentProfile.displayName||currentProfile.username
        });
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
