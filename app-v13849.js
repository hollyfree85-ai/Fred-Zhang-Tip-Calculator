
// V13.8.24-P16 — reusable Show Password checkbox for all password/PIN inputs.
window.togglePasswordVisibility=function(inputId,show){
  const el=document.getElementById(inputId);
  if(!el)return;
  el.type=show?"text":"password";
};

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {getAuth, initializeAuth, signInWithCustomToken, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInAnonymously, setPersistence, inMemoryPersistence, reauthenticateWithCredential, EmailAuthProvider, updatePassword, browserLocalPersistence, browserSessionPersistence} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {getFirestore, doc, getDoc, getDocs, getDocFromServer, getDocsFromServer, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, onSnapshot, serverTimestamp, writeBatch, runTransaction} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { getMessaging, getToken, isSupported as isMessagingSupported } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";
import { PUSH_VAPID_PUBLIC_KEY } from "./push-config.js";

const firebaseApp = initializeApp(FIREBASE_CONFIG);

// ES1.8: normal authentication belongs to the current browser tab/session.
// A temporary LOCAL bridge is retained only for the existing Android PassPRNT
// callback, which may reopen a separate browser activity. No passwords are stored.
const PASS_PRNT_RETURN_PARAM="fzPassPrntReturn";
const PASS_PRNT_BRIDGE_KEY="fzPassPrntSessionBridgeV1";
function readPassPrntReturnBridge(){
  try{
    const url=new URL(window.location.href);
    let data=null;
    const raw=localStorage.getItem(PASS_PRNT_BRIDGE_KEY);
    if(raw){
      try{data=JSON.parse(raw);}catch(_){data=null;}
    }
    // Fallback to the callback URL itself. This matters on Android when PassPRNT
    // reopens the PWA/browser in a fresh activity before localStorage is visible.
    if(!data && url.searchParams.get(PASS_PRNT_RETURN_PARAM)==="1"){
      data={
        dailyReport:true,
        role:String(url.searchParams.get("fzPrntRole")||""),
        reportId:String(url.searchParams.get("fzPrntReport")||""),
        date:String(url.searchParams.get("fzPrntDate")||""),
        expiresAt:Number(url.searchParams.get("fzPrntExpires")||0)
      };
    }
    const expiresAt=Number(data?.expiresAt||0);
    const role=String(data?.role||"");
    if(!data?.dailyReport || !["manager","owner"].includes(role) || !expiresAt || expiresAt<Date.now()){
      localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);
      return null;
    }
    return data;
  }catch(e){
    try{localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);}catch(_){}
    return null;
  }
}
function cleanPassPrntCallbackUrl(){
  try{
    const url=new URL(window.location.href);
    url.searchParams.delete(PASS_PRNT_RETURN_PARAM);
    url.searchParams.delete("fzPrntRole");
    url.searchParams.delete("fzPrntReport");
    url.searchParams.delete("fzPrntDate");
    url.searchParams.delete("fzPrntExpires");
    url.searchParams.delete("passprnt_code");
    url.searchParams.delete("passprnt_message");
    history.replaceState(history.state,"",url.pathname+url.search+url.hash);
  }catch(e){}
}
const passPrntReturnBridge=readPassPrntReturnBridge();

// Explicit SESSION initialization does not adopt old, indefinitely persisted
// LOCAL credentials on an ordinary fresh launch. A valid print bridge is the
// sole exception; the restored user is validated and moved back to SESSION.
const auth=initializeAuth(firebaseApp,{persistence:passPrntReturnBridge?browserLocalPersistence:browserSessionPersistence});
let es18LoginAttemptRole=null;
const authSecurityReady=(async()=>{
  try{
    if(typeof auth.authStateReady==='function')await auth.authStateReady();
    await setPersistence(auth,passPrntReturnBridge?browserLocalPersistence:browserSessionPersistence);
    if(passPrntReturnBridge)cleanPassPrntCallbackUrl();
  }catch(e){console.warn('Session initialization:',e);}
})();
async function es18PasswordSignIn(email,password){
  await authSecurityReady;
  await setPersistence(auth,browserSessionPersistence);
  es18LoginAttemptRole=String(fzLoginRole||'');
  try{return await signInWithEmailAndPassword(auth,email,password);}
  catch(e){es18LoginAttemptRole=null;throw e;}
}

const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, "us-central1");
const createUserAdmin = httpsCallable(functions, "createAppUser");
const employeeLoginOptionsApi=httpsCallable(functions,"listEmployeeLoginOptionsV1");
const resetAppCredentialApi=httpsCallable(functions,"ownerResetAppCredentialV1");
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
// Named short shifts retain their identity in drafts and final reports.
const SHIFT_EARLY='10:45 - 14:00',SHIFT_MIDDLE='14:00 - 16:00';
const TIP_SHIFTS=['AM','PM','DOUBLE','LONG',SHIFT_EARLY,SHIFT_MIDDLE];
function isShortShift(shift){return shift===SHIFT_EARLY || shift===SHIFT_MIDDLE;}
function isEarlyShift(shift){return shift==='AM' || isShortShift(shift);}
function shortShiftTimes(shift){return shift===SHIFT_EARLY?['10:45','14:00']:shift===SHIFT_MIDDLE?['14:00','16:00']:null;}
function shortShiftFormTimes(shift,inId='hIn',outId='hOut'){
  const times=shortShiftTimes(shift);if(!times)return;
  [inId,outId].forEach((id,i)=>{if($(id) && !String($(id).value||'').trim())$(id).value=times[i];});
}
function howSyncShortShiftBusserForm(){
  if(!isShortShift($('hShift')?.value) || String($('hPosition')?.value||'').toLowerCase()==='bartender')return;
  const choice=isWeekendDate($('hDate')?.value)?'WITH':'WITHOUT';
  howSetSilent('hBusserAM',choice);hourlyWizardState.busserAM=choice;
}
function shortShiftDraftTimes(d){
  const times=shortShiftTimes(d.values?.hShift);if(!times)return;
  ['hIn','hOut'].forEach((id,i)=>{if(!String(d.values?.[id]||'').trim())hv1SetValue(d,id,times[i]);});
}

let unsubs = [];
let latestRows = [];
let knownPending = new Set();
let lastHourlyResult = null;
let currentHourlySubmissionId = null;
let currentHourlyReportId = null;
let latestHourlyReports = [];
let userNameByUid = {};
let latestUsers = [];
let employeePhoneDirectory=new Map();
let employeePhoneDirectoryLoadedAt=0;
let historicalAccountAutoSyncStarted=false;

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
let latestDeletedItems=[];
let tipCheckEditId="";
let tipCheckPollTimer=null;



const EMPLOYEE_ROSTER = Object.freeze(["Adrieanna Walker", "Aida Gonzales", "Alainna Montalvo", "Angela Grizzad", "Ariana Garner", "Ashley Garcia", "Brandi Copeland", "Caitlin Dillon", "Christina Gurley", "Cynthia Risner", "Dorothy Makovicka", "Fred Zhang", "Hannah Dempsey", "Jesus Ovalle-Munoz", "Katelyn Ramsey", "Libby Lane", "Megan Meadows", "Megan Sisk", "Mia Burress", "Mia Gibson", "Ruwini Rathnayaka", "Sara Swift", "Sarah Kibler", "Sasha Safitri", "Shaniya Scott", "T'Aljah Boyd", "Vidya Caroline"]);

const RECOVERED_EMPLOYEE_PHONES = Object.freeze({"Adrieanna Walker":"9382181403","Aida Gonzales":"2567555902","Alainna Montalvo":"2563211032","Angela Grizzad":"2569455956","Ariana Garner":"2569539676","Ashley Garcia":"2568366171","Brandi Copeland":"2565596641","Caitlin Dillon":"2568933734","Christina Gurley":"2564796386","Cynthia Risner":"2566795133","Dorothy Makovicka":"2566985722","Fred Zhang":"9098718416","Hanif Fitroh":"8502389020","Hannah Dempsey":"9316522095","Jesus Ovalle-Munoz":"7028329771","Katelyn Ramsey":"2055229939","Libby Lane":"2565728615","Megan Meadows":"9314922850","Megan Sisk":"2562867040","Mia Burress":"8646140631","Mia Gibson":"12563615765","Rizky Santoso":"18502380977","Ruwini Rathnayaka":"2566521938","Sara Swift":"2565052238","Sarah Kibler":"5105891306","Sasha Safitri":"3347132951","T'Aijah Boyd":"2565518870","Vidya Caroline":"8187494818","Shaniya Scott":"13147042742","T'Aljah Boyd":"2565518870"});

const ANGELA_WORK_PROFILES=Object.freeze([
  Object.freeze({name:"Angela Bar",position:"Bartender",personName:"Angela Grizzad"}),
  Object.freeze({name:"Angela Server",position:"Server",personName:"Angela Grizzad"})
]);
const WORK_PROFILES=Object.freeze([
  ...ANGELA_WORK_PROFILES,
  Object.freeze({name:"Caitlin Bar",position:"Bartender",personName:"Caitlin Dillon"})
]);
const accountEmployeeRoster=new Map();
function employeeWorkProfile(name){
  const key=slugFor(name);
  const known=WORK_PROFILES.find(p=>slugFor(p.name)===key);
  if(known)return known;
  const account=accountEmployeeRoster.get(normalizeEmployeeNameKey(name));
  return account && ["Server","Bartender"].includes(account.workPosition)
    ? {name:account.displayName,position:account.workPosition,personName:account.personName||account.displayName}:null;
}
function applyWorkProfilePosition(name=$("hEmployee")?.value){
  const profile=employeeWorkProfile(name);
  if(profile){howSetSilent("hPosition",profile.position);hourlyWizardState.position=profile.position;}
  return profile;
}
function applyEmployeeWorkProfile(){
  const profile=employeeWorkProfile(currentProfile?.displayName||currentProfile?.username);
  if($("ePosition")){$("ePosition").disabled=!!profile;if(profile)$("ePosition").value=profile.position;}
}

const dynamicEmployeeRoster=new Set([...EMPLOYEE_ROSTER,...ANGELA_WORK_PROFILES.map(p=>p.name)]);
function getEmployeeRoster(){
  const names=new Map([...dynamicEmployeeRoster].filter(Boolean).map(n=>[normalizeEmployeeNameKey(n),n]));
  for(const [key,u] of accountEmployeeRoster)if(!names.has(key))names.set(key,u.displayName);
  return [...names.values()].sort((a,b)=>a.localeCompare(b));
}
function syncEmployeeAccountRoster(users){
  accountEmployeeRoster.clear();
  for(const u of users||[]){
    if(String(u.role||'').toLowerCase()!=='employee' || u.active===false
      || String(u.approvalStatus||'').toLowerCase()!=='approved')continue;
    const name=String(u.displayName||u.username||'').trim().replace(/\s+/g,' ');
    if(name)accountEmployeeRoster.set(normalizeEmployeeNameKey(name),{...u,displayName:name});
  }
  employeeLoginDirectory=[...accountEmployeeRoster.values()].map(u=>({displayName:u.displayName,username:u.username||u.displayName})).sort((a,b)=>a.displayName.localeCompare(b.displayName));
  populateRoster();populateBartenderServerDropdowns();hv1RenderRoster(true);
}
async function refreshEmployeeAccountRoster(){
  try{
    const snap=await getDocs(query(collection(db,"users"),limit(500)));
    syncEmployeeAccountRoster(snap.docs.map(d=>({uid:d.id,...d.data()})));
  }catch(e){console.warn("Employee roster refresh:",e);}
}
function addDynamicEmployeeName(name){
  const clean=String(name||"").trim().replace(/\s+/g," ");
  if(clean) dynamicEmployeeRoster.add(clean);
}
function removeDynamicEmployeeName(name){
  const clean=String(name||"").trim().replace(/\s+/g," ");
  if(clean && !EMPLOYEE_ROSTER.includes(clean) && !Object.prototype.hasOwnProperty.call(RECOVERED_EMPLOYEE_PHONES,clean)){
    dynamicEmployeeRoster.delete(clean);
  }
}




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
function loginMsg(m){
  $("loginMessage").textContent = m || "";
  // ES1.8.1: show login progress/errors beside the button, not below the fold.
  const inline=$("fz18BiometricStatus");if(inline)inline.textContent=m||"";
}

let fzLoginRole="employee";
// Restore only the role that initiated the one-time PassPRNT callback.
if(passPrntReturnBridge?.role && ["manager","owner"].includes(String(passPrntReturnBridge.role))){
  fzLoginRole=String(passPrntReturnBridge.role);
}
let hostCashierRequested=false;
window.setLoginMode = function(mode,roleHint=""){
  fzLoginRole=mode==="staff"?(roleHint||"manager"):mode;
  document.body.dataset.loginRole=fzLoginRole;
  $("employeeLogin")?.classList.toggle("hidden", mode !== "employee");
  $("staffLogin")?.classList.toggle("hidden", mode !== "staff");
  $("hourlyV1Login")?.classList.toggle("hidden", mode !== "hourlyv1");
  $("hostCashierLogin")?.classList.toggle("hidden", mode !== "hostcashier");
  ["employeeModeBtn","managerModeBtn","ownerModeBtn","hourlyV1ModeBtn","hostCashierModeBtn","boardModeBtn"].forEach(id=>$(id)?.classList.remove("on"));
  if(mode==="employee"){ $("employeeModeBtn")?.classList.add("on");window.refreshEmployeeLoginOptions?.();}
  if(mode==="hourlyv1") $("hourlyV1ModeBtn")?.classList.add("on");
  if(mode==="hostcashier") $("hostCashierModeBtn")?.classList.add("on");
  if(mode==="staff"){
    const role=roleHint||"manager";
    $(`${role}ModeBtn`)?.classList.add("on");
    if($("staffLoginTitle"))$("staffLoginTitle").textContent=role==="owner"?"Owner Login":"Manager Login";
    if($("staffLoginHint"))$("staffLoginHint").textContent=role==="owner"?"Full owner access after authentication.":"Manager tools and employee approvals.";
  }
  loginMsg("");
};


function bindEnterLogin(inputId,action){
  const el=$(inputId);
  if(!el || el.dataset.enterLoginBound==="1")return;
  el.dataset.enterLoginBound="1";
  el.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();action();}});
}
setTimeout(()=>{
  bindEnterLogin("employeePin",()=>window.loginEmployee?.());
  bindEnterLogin("staffPassword",()=>window.loginStaff?.());
  bindEnterLogin("hourlyV1Password",()=>window.loginHourlyV1Workspace?.());
  bindEnterLogin("hostCashierPassword",()=>window.loginHostCashierWorkspace?.());
},0);

let employeeLoginDirectory=null,employeeLoginRefresh=null;
function populateEmployeeLoginOptions(){
  const el=$('employeeUsername');if(!el)return;
  const current=el.value;
  const rows=employeeLoginDirectory===null?getEmployeeRoster().map(name=>({displayName:name,username:name})):employeeLoginDirectory;
  el.innerHTML=rows.map(u=>`<option value="${esc(u.username)}">${esc(u.displayName)}</option>`).join('');
  const match=rows.find(u=>u.username===current || u.displayName===current);
  if(match)el.value=match.username;
}
window.refreshEmployeeLoginOptions=async function(){
  if(employeeLoginRefresh)return employeeLoginRefresh;
  const status=$('employeeLoginRosterStatus');if(status)status.textContent='Refreshing employee names…';
  employeeLoginRefresh=(async()=>{
    try{
      const result=await employeeLoginOptionsApi({});
      if(!Array.isArray(result?.data?.employees))throw new Error('Employee directory unavailable.');
      employeeLoginDirectory=result.data.employees.filter(u=>typeof u.username==='string' && u.username && typeof u.displayName==='string').map(u=>({username:u.username,displayName:u.displayName}));
      populateEmployeeLoginOptions();if(status)status.textContent='Employee names updated.';
      return true;
    }catch(e){
      if(status)status.textContent='Could not refresh names. You can enter your account username below.';
      return false;
    }finally{employeeLoginRefresh=null;}
  })();return employeeLoginRefresh;
};
function populateRoster(){
  populateEmployeeLoginOptions();
  const names=getEmployeeRoster();
  ["signupName","hEmployee","sTipCheckEmployee"].forEach(id=>{
    const el=$(id); if(!el)return;
    const current=el.value;
    el.innerHTML=names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
    if(names.includes(current))el.value=current;
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

  if(!getEmployeeRoster().includes(name)){ alert("Select your name from the employee list."); return; }
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

window.playBundledMoneyReadyChime=async function playBundledMoneyReadyChime(){ return false;
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

window.trySpeakGlobalMoneyReady=function trySpeakGlobalMoneyReady(name){ return;
  if(!("speechSynthesis" in window)) return;
  try{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(`${String(name||"Employee").trim()}, your tip money is ready. Please see the Manager on Duty.`);
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

function boardChime(){ return;
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

function speakMoneyReadyAnnouncement(name){ return;
  if(!("speechSynthesis" in window)) return;

  try{
    window.speechSynthesis.cancel();

    const employeeName=String(name||"Employee").trim();
    const text=`${employeeName}, please see the Manager on Duty. Your tip money is ready.`;

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
        <div style="font-size:18px;font-weight:700">Please see the Manager on Duty</div>
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
  fzLoginRole="employee";
  
  ensureRealtimeAlertAudio();
  await authSecurityReady;
  const selected = $("employeeUsername").value.trim();
  const username = employeeLoginDirectory?.find(u=>u.username===selected || u.displayName===selected)?.username || selected;
  const pin = $("employeePin").value.trim();
  if(!username || !pin){ loginMsg("Enter username and PIN."); return; }
  try{
    loginMsg("Signing in...");
    await es18PasswordSignIn(emailFor(username), employeeAuthPassword(pin));
  }catch(e){
    console.error("Employee login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};



let hourlyV1Requested=!!passPrntReturnBridge?.dailyReport;
let hourlyV1Mode=false;
let hv1EditingEmployee="";
let hv1LoadingEmployee=false;
let hourlyAdjustmentChoice=null;
const HV1_STORAGE_PREFIX="fz_hv1_batch_";
const HV1_BACKING_IDS=["hDate","hEmployee","hPosition","hShift","hBusserAM","hIn","hOut","hAmIn","hAmOut","hPmIn","hPmOut","hGrandTotal","hTotalAM","hPaidTip","hCardFee","hCashTip","hMeal","hAmBar","hPmBar","hBartenderShiftType","hBartenderBarReceived","hBtPrevAMInput","hBtPrev24Input"];

function hv1DateValue(){return $('hv1Date')?.value||todayLocal()}
function hv1Key(){return HV1_STORAGE_PREFIX+hv1DateValue()}
function hv1CloudDocId(date=hv1DateValue()){return String(date||todayLocal())}
function hv1Load(){try{return JSON.parse(localStorage.getItem(hv1Key())||'{"team":[],"drafts":{}}')}catch(e){return {team:[],drafts:{}}}}
function hv1SetCloudStatus(text,state=""){
  const el=$('hv1CloudStatus'); if(!el)return;
  el.textContent=text; el.dataset.state=state;
}
let hv1CloudWriteQueue=Promise.resolve();
async function hv1CloudSave(s,workDate=hv1DateValue()){
  if(!currentUser || !["manager","owner"].includes(currentProfile?.role||""))return false;
  const date=workDate;
  s=JSON.parse(JSON.stringify(s));
  try{
    hv1SetCloudStatus("Draft backup: saving…","saving");
    const payload={
      date,
      team:Array.isArray(s.team)?s.team:[],
      drafts:s.drafts||{},
      bar:s.bar||{},
      barManual:s.barManual||{},
      trash:s.trash||null,
      removedEmployees:s.removedEmployees||{},
      updatedAt:serverTimestamp(),
      updatedByUid:currentUser.uid,
      updatedBy:currentProfile.displayName||currentProfile.username||""
    };
    const write=hv1CloudWriteQueue.catch(()=>{}).then(()=>setDoc(doc(db,"hourlyV1Batches",hv1CloudDocId(date)),payload));
    hv1CloudWriteQueue=write;
    await write;
    hv1SetCloudStatus("Draft + BAR backup: SAVED TO CLOUD","ok");
    return true;
  }catch(e){
    console.warn("Tip Calculation cloud save:",e);
    hv1SetCloudStatus("Draft backup: LOCAL ONLY — Firestore rule needed","warn");
    return false;
  }
}
function hv1Save(s){
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  hv1CloudSave(JSON.parse(JSON.stringify(s))).catch(()=>{});
}
async function hv1CloudRestore(){
  if(!currentUser || !["manager","owner"].includes(currentProfile?.role||""))return hv1Load();
  const date=hv1DateValue();
  try{
    hv1SetCloudStatus("Draft backup: loading…","saving");
    const snap=await getDoc(doc(db,"hourlyV1Batches",hv1CloudDocId(date)));
    if(!snap.exists()){hv1SetCloudStatus("Draft backup: no cloud draft yet","ok");return hv1Load();}
    if(date!==hv1DateValue())return hv1Load();
    const cloud=snap.data()||{},local=hv1Load();
    const merged={
      team:Array.isArray(cloud.team)?cloud.team:[],
      drafts:{...(cloud.drafts||{})},
      bar:JSON.parse(JSON.stringify(cloud.bar||local.bar||{})),
      barManual:{...(local.barManual||{}),...(cloud.barManual||{})},
      trash:cloud.trash||local.trash||null,
      removedEmployees:{...(local.removedEmployees||{}),...(cloud.removedEmployees||{})}
    };
    for(const [name,d] of Object.entries(local.drafts||{})){
      const cd=merged.drafts[name];
      if(!cd || Number(d.savedAt||0)>Number(cd.savedAt||0)) merged.drafts[name]=d;
    }
    merged.team=[...new Set([...(merged.team||[]),...(local.team||[])])];
    for(const [name,removed] of Object.entries(merged.removedEmployees||{})){
      if(removed?.removedAt && Number(removed.restoredAt||0)<Number(removed.removedAt)){
        merged.team=merged.team.filter(n=>n!==name);
        delete merged.drafts[name];
      }
    }

    // Merge local BAR entries without throwing away cloud values.
    for(const key of ['AM','2PM_4PM','PM']){
      merged.bar[key]=merged.bar[key]||{bartender:'',entries:{}};
      merged.bar[key].entries=merged.bar[key].entries||{};
      const localBar=local.bar?.[key]||{};
      if(!merged.bar[key].bartender && localBar.bartender) merged.bar[key].bartender=localBar.bartender;
      for(const [name,val] of Object.entries(localBar.entries||{})){
        if(merged.bar[key].entries[name]===undefined || merged.bar[key].entries[name]===''){
          merged.bar[key].entries[name]=val;
        }
      }
    }

    localStorage.setItem(hv1Key(),JSON.stringify(merged));
    hv1SetCloudStatus("Draft + BAR backup: RESTORED / SYNCED","ok");
    return merged;
  }catch(e){
    console.warn("Tip Calculation cloud restore:",e);
    hv1SetCloudStatus("Draft backup: using local copy","warn");
    return hv1Load();
  }
}
function hv1BlankDraft(name){
  const profile=employeeWorkProfile(name);
  return {employee:name,date:hv1DateValue(),values:profile?{hEmployee:name,hPosition:profile.position}:{},entered:profile?{hPosition:true}:{},skippedPages:[],savedAt:0,finalized:false};
}
function hv1Draft(name){const s=hv1Load();return s.drafts?.[name]||hv1BlankDraft(name)}
// A work account is its full employee name, never its first name, phone,
// personName, or the manager UID used to enter the report.
function hourlyReportBelongsTo(r,name,date){
  return !!r && !!name && !!date
    && normalizeEmployeeNameKey(r.employee)===normalizeEmployeeNameKey(name)
    && String(r.date||'')===String(date);
}
function hv1DetachReportLink(d){
  d.hourlyReportId='';d.sourceSubmissionId='';d.finalized=false;
  delete d.editHydratedFromFinalV13811;
  delete d.finalizedAt;
  d.reportLinkRepairedV13828=true;
}
function hv1SetValue(d,key,value,entered=true){d.values=d.values||{};d.entered=d.entered||{};d.values[key]=value;if(entered)d.entered[key]=true}
function hv1VisibleValue(id){const el=$(id);return el?String(el.value??''):''}
function hv1CapturePage(markSkipped=false){
  if(hourlyFinalSaveInProgress || hv1LoadingEmployee || !hv1EditingEmployee)return;
  applyWorkProfilePosition(hv1EditingEmployee);
  const s=hv1Load();s.drafts=s.drafts||{};const d=s.drafts[hv1EditingEmployee]||hv1BlankDraft(hv1EditingEmployee);
  const salesBefore={hGrandTotal:d.values?.hGrandTotal,hTotalAM:d.values?.hTotalAM};
  d.date=$('hv1Date')?.value||todayLocal(); d.page=hourlyWizardStep; d.savedAt=Date.now();
  d.hourlyWizardState=JSON.parse(JSON.stringify(hourlyWizardState));
  if(hourlyAdjustmentChoice && hourlyReportBelongsTo(hourlyAdjustmentChoice,hv1EditingEmployee,d.date)
    && hourlyAdjustmentChoice.reportId===String(currentHourlyReportId||'')){
    d.hourlyAdjustmentChoice={...hourlyAdjustmentChoice};
  }
  d.howBartenderState=JSON.parse(JSON.stringify(howBartenderState));
  if(markSkipped){d.skippedPages=d.skippedPages||[];if(!d.skippedPages.includes(hourlyWizardStep))d.skippedPages.push(hourlyWizardStep)}
  else d.skippedPages=(d.skippedPages||[]).filter(x=>x!==hourlyWizardStep);

  if(hourlyWizardStep===1){hv1SetValue(d,'hDate',d.date);hv1SetValue(d,'hEmployee',hv1EditingEmployee);hv1SetValue(d,'hPosition',hourlyWizardState.position);hv1SetValue(d,'hShift',hourlyWizardState.shift);shortShiftDraftTimes(d);}
  if(hourlyWizardStep===2){
    if(hourlyWizardState.shift==='DOUBLE'){
      [['hAmIn','howAmIn'],['hAmOut','howAmOut'],['hPmIn','howPmIn'],['hPmOut','howPmOut']].forEach(([k,id])=>{const v=hv1VisibleValue(id);if(v!==''){hv1SetValue(d,k,v);howSetSilent(k,v);}});
    }else{[['hIn','howIn'],['hOut','howOut']].forEach(([k,id])=>{const v=hv1VisibleValue(id);if(v!==''){hv1SetValue(d,k,v);howSetSilent(k,v);}});}
  }
  if(hourlyWizardStep===3){hv1SetValue(d,'hBusserAM',hourlyWizardState.busserAM);}
  if(hourlyWizardStep===4){[['hGrandTotal','howGrand'],['hTotalAM','howTotalAM']].forEach(([k,id])=>{const el=$(id);if(el&&String(el.value).trim()!==''){const v=String(el.value).trim();hv1SetValue(d,k,v);howSetSilent(k,v);}});}
  if(hourlyWizardStep===5){[['hPaidTip','howPaid'],['hCardFee','howCardFee'],['hCashTip','howCash'],['hMeal','howMeal']].forEach(([k,id])=>{const el=$(id);if(el&&String(el.value).trim()!==''){const v=String(el.value).trim();hv1SetValue(d,k,v);howSetSilent(k,v);}});}
  if(hourlyWizardStep===6){
    if(hourlyWizardState.position==='Bartender'){captureHowBartenderDom();d.howBartenderState=JSON.parse(JSON.stringify(howBartenderState));d.entered.bartender=true;}
    else{
      const amv=$('howAmBar')?.checked?'yes':'no',pmv=$('howPmBar')?.checked?'yes':'no';
      hv1SetValue(d,'hAmBar',amv);hv1SetValue(d,'hPmBar',pmv);
      howSetSilent('hAmBar',amv);howSetSilent('hPmBar',pmv);
    }
  }
  if(hourlyWizardStep===7){
    [['hGrandTotal','howGrand'],['hTotalAM','howTotalAM'],['hPaidTip','howPaid'],['hCardFee','howCardFee'],['hCashTip','howCash'],['hMeal','howMeal']].forEach(([k,id])=>{
      const el=$(id); if(el){const v=String(el.value??'').trim();hv1SetValue(d,k,v===''?'0':v);howSetSilent(k,v===''?'0':v);}
    });
    if(hourlyWizardState.position!=='Bartender'){
      if($('howAmBar')){const v=$('howAmBar').checked?'yes':'no';hv1SetValue(d,'hAmBar',v);howSetSilent('hAmBar',v);}
      if($('howPmBar')){const v=$('howPmBar').checked?'yes':'no';hv1SetValue(d,'hPmBar',v);howSetSilent('hPmBar',v);}
    }
  }
  s.drafts[hv1EditingEmployee]=d;
  const editedSales=[4,7].includes(hourlyWizardStep)
    ? Object.keys(salesBefore).filter(k=>String(salesBefore[k]??'')!==String(d.values?.[k]??'')) : [];
  if([6,7].includes(hourlyWizardStep))hv1SyncBarChoices(s,hv1EditingEmployee);
  hv1SyncServerDraftToBar(s,hv1EditingEmployee,editedSales);
  hv1ApplyBarAutomation(s);
  hv1Save(s);
  howSyncLongBusserForm();howSyncShortShiftBusserForm();
}

async function hv1HydrateDraftFromFinalReport(name){
  const date=hv1DateValue(),storageKey=HV1_STORAGE_PREFIX+date;
  const state=hv1Load();
  const d=state.drafts?.[name]||hv1BlankDraft(name);
  if(!d?.hourlyReportId)return d;

  try{
    const snap=await getDoc(doc(db,"hourlyReports",d.hourlyReportId));
    const r=snap.exists()?snap.data():null;
    // Recheck old hydrated drafts too: two cards may carry the same stale ID.
    if(!hourlyReportBelongsTo(r,name,date)){
      const staleId=d.hourlyReportId;
      latestHourlyReports=latestHourlyReports.filter(row=>row.id!==staleId);
      if(r)latestHourlyReports.push({...r,id:staleId});
      hv1DetachReportLink(d);
      const latest=JSON.parse(localStorage.getItem(storageKey)||'{}');
      latest.drafts ||= {};latest.drafts[name]=d;
      localStorage.setItem(storageKey,JSON.stringify(latest));
      return d;
    }
    // Preserve later autosaved edits, including intentional zero values.
    if(d.editHydratedFromFinalV13811)return d;
    const hours={...r,...(r.hours||{})};
    d.values=d.values||{};
    d.entered=d.entered||{};

    const put=(k,v)=>{
      if(v===undefined||v===null)return;
      d.values[k]=String(v);
      d.entered[k]=true;
    };

    // On first edit of an already-finalized report, the finalized Firestore
    // record is the source of truth. This repairs old V1 drafts that reopened
    // with $0.00 / blank Paid Tip, Grand Total, Card Fee, Meal, etc.
    put("hDate",r.date||d.date||hv1DateValue());
    put("hEmployee",r.employee||name);
    put("hPosition",r.position||"Server");
    put("hShift",r.shift||"AM");
    put("hGrandTotal",r.grandTotal??0);
    if(["DOUBLE","LONG"].includes(String(r.shift||"").toUpperCase())) put("hTotalAM",r.totalAM??0);
    put("hPaidTip",r.paidTip??0);
    put("hCardFee",r.payCardTipFee??r.cardFee??0);
    put("hCashTip",r.cashTip??0);
    put("hMeal",r.meal??0);

    const shift=String(r.shift||"").toUpperCase();
    if(shift==="DOUBLE"){
      put("hAmIn",hours.hourInAM||hours.amIn||"");
      put("hAmOut",hours.hourOutAM||hours.amOut||"");
      put("hPmIn",hours.hourInPM||hours.pmIn||"");
      put("hPmOut",hours.hourOutPM||hours.pmOut||"");
    }else{
      put("hIn",hours.hourIn||hours.hourInAM||hours.in||"");
      put("hOut",hours.hourOut||hours.hourOutAM||hours.out||"");
    }

    d.hourlyWizardState={
      position:r.position||d.hourlyWizardState?.position||"Server",
      shift:r.shift||d.hourlyWizardState?.shift||"AM",
      busserAM:d.values.hBusserAM||d.hourlyWizardState?.busserAM||"WITHOUT"
    };
    d.editHydratedFromFinalV13811=true;
    d.savedAt=Date.now();
    const latest=JSON.parse(localStorage.getItem(storageKey)||'{}');
    latest.drafts ||= {};latest.drafts[name]=d;
    localStorage.setItem(storageKey,JSON.stringify(latest));
    await hv1CloudSave(JSON.parse(JSON.stringify(latest)),date);
    return d;
  }catch(e){
    console.warn("Hydrate finalized V1 draft:",e);
    return d;
  }
}

function hv1ApplyDraft(name){
  const longState=hv1Load();
  const repaired=hv1ReconcileFinalReports(longState);
  const salesSynced=hv1SyncBarSalesToDraft(longState,name);
  if(hv1SyncLongBusserDraft(longState,name)||repaired||salesSynced)localStorage.setItem(hv1Key(),JSON.stringify(longState));
  const d=hv1Draft(name); currentHourlyReportId=d.hourlyReportId||null;currentHourlySubmissionId=d.sourceSubmissionId||null;
  hourlyAdjustmentChoice=d.hourlyAdjustmentChoice||null;
  // Clear backing fields first. Blank means NOT ENTERED; explicit 0 stays 0.
  ['hIn','hOut','hAmIn','hAmOut','hPmIn','hPmOut','hGrandTotal','hTotalAM','hPaidTip','hCardFee','hCashTip','hMeal','hBtPrevAMInput','hBtPrev24Input'].forEach(id=>{if($(id))$(id).value=''});
  if($('hDate'))$('hDate').value=d.date||$('hv1Date').value;if($('hEmployee'))$('hEmployee').value=name;
  Object.entries(d.values||{}).forEach(([id,v])=>{if($(id))$(id).value=v;howSetSilent(id,v)});
  if(d.barAuto){
    const amChoice=d.entered?.hAmBar ? String(d.values?.hAmBar||'no') : (Number(d.barAuto.amGT||0)>0?'yes':'no');
    const pmChoice=d.entered?.hPmBar ? String(d.values?.hPmBar||'no') : ((d.barAuto.valid24||d.barAuto.validPM)?'yes':'no');
    howSetSilent('hAmBar',amChoice);
    howSetSilent('hPmBar',pmChoice);
  }
  hourlyWizardState=d.hourlyWizardState||{position:d.values?.hPosition||'Server',shift:d.values?.hShift||'AM',busserAM:d.values?.hBusserAM||'WITHOUT'};
  if(d.howBartenderState)howBartenderState=d.howBartenderState;else resetHowBartenderState();
  howSetSilent('hEmployee',name);howSetSilent('hDate',d.date||$('hv1Date').value);howSetSilent('hPosition',hourlyWizardState.position||'Server');howSetSilent('hShift',hourlyWizardState.shift||'AM');howSetSilent('hBusserAM',hourlyWizardState.busserAM||'WITHOUT');
  applyWorkProfilePosition(name);
  hourlyWizardStep=Math.max(1,Math.min(7,Number(d.page||1)));renderHourlyWizard();setTimeout(hv1PatchWizard,0);
}

let hv1AutosaveTimer=null;

function hv1VisibleDraftValue(d,key){
  const v=d?.values?.[key];
  return v===undefined||v===null ? "" : String(v);
}

function hv1PatchWizard(){
  if(!hourlyV1Mode||!hv1EditingEmployee||!document.body.classList.contains("hourly-v1-editing"))return;
  const wizard=$("hourlyOriginalWizard");
  if(!wizard)return;
  const d=hv1Draft(hv1EditingEmployee);

  // Restore visible fields directly from the employee draft.
  // This is intentionally separate from the legacy backing inputs so an edit
  // can never reopen with blank Paid Tip/Card Fee/Cash Tip/Meal values.
  const map={
    howDate:"hDate", howIn:"hIn", howOut:"hOut",
    howAmIn:"hAmIn", howAmOut:"hAmOut", howPmIn:"hPmIn", howPmOut:"hPmOut",
    howGrand:"hGrandTotal", howTotalAM:"hTotalAM",
    howPaid:"hPaidTip", howCardFee:"hCardFee", howCash:"hCashTip", howMeal:"hMeal"
  };
  Object.entries(map).forEach(([visibleId,key])=>{
    const el=$(visibleId);
    if(!el)return;
    const saved=hv1VisibleDraftValue(d,key);
    if(saved!=="" && String(el.value??"")!==saved) el.value=saved;
  });

  if(hourlyWizardStep===4)updateHowSalesPreview();

  // Always-visible V1 quick navigation.
  let nav=$("hv1QuickNav");
  if(!nav){
    nav=document.createElement("div");
    nav.id="hv1QuickNav";
    nav.className="hv1-quick-nav";
    nav.innerHTML=`
      <button class="btn light" type="button" onclick="hv1SavePage()">SAVE &amp; BACK TO TEAM BOARD</button>
      <button class="btn light" type="button" onclick="hv1JumpPage(4)">SALES</button>
      <button class="btn light" type="button" onclick="hv1JumpPage(5)">TIPS</button>
      <button class="btn dark" type="button" onclick="hv1GoBarFromEmployee()">BAR</button>
      <button class="btn gold" type="button" onclick="hv1SaveStay()">SAVE</button>`;
    wizard.prepend(nav);
  }

  // Autosave every editable field. No need to press Back/Next first.
  wizard.querySelectorAll("input,select,textarea").forEach(el=>{
    if(el.dataset.hv1AutosaveBound==="1")return;
    el.dataset.hv1AutosaveBound="1";
    const save=()=>{
      clearTimeout(hv1AutosaveTimer);
      hv1AutosaveTimer=setTimeout(()=>{
        try{
          captureHourlyWizard();
          hv1CapturePage(false);
          const note=$("hv1AutosaveNote");
          if(note)note.textContent="Saved";
        }catch(e){console.warn("V1 autosave:",e)}
      },120);
    };
    el.addEventListener("input",save);
    el.addEventListener("change",save);
  });

  if(!$("hv1AutosaveNote")){
    const note=document.createElement("div");
    note.id="hv1AutosaveNote";
    note.className="hv1-autosave-note";
    note.textContent="Auto-save ON";
    nav?.appendChild(note);
  }
}


window.hv1JumpPage=function(page){
  try{
    captureHourlyWizard();
    hv1CapturePage(false);
  }catch(e){console.warn("Save before page jump:",e)}
  hourlyWizardStep=Math.max(1,Math.min(7,Number(page)||1));
  const s=hv1Load(),d=s.drafts?.[hv1EditingEmployee];
  if(d){d.page=hourlyWizardStep;d.savedAt=Date.now();s.drafts[hv1EditingEmployee]=d;hv1Save(s);}
  renderHourlyWizard();
  window.scrollTo(0,0);
};

window.hv1SaveStay=function(){
  try{
    captureHourlyWizard();
    hv1CapturePage(false);
    const note=$("hv1AutosaveNote");
    if(note)note.textContent="Saved to draft";
  }catch(e){
    console.error("V1 Save:",e);
    alert("Save failed: "+(e.message||e));
  }
};

window.hv1GoBarFromEmployee=function(){
  try{
    captureHourlyWizard();
    hv1CapturePage(false);
  }catch(e){console.warn("Save before BAR:",e)}
  document.body.classList.remove("hourly-v1-editing");
  $("hourly")?.classList.add("hidden");
  $("hourlyV1Workspace")?.classList.remove("hidden");
  $("hv1Setup")?.classList.add("hidden");
  $("hv1BoardBox")?.classList.add("hidden");
  window.hv1OpenBarCenter();
  window.scrollTo(0,0);
};

function hv1FinalReportFor(name,date){
  const identity=String(name||'').trim().toLowerCase();
  return latestHourlyReports.filter(r=>String(r.employee||'').trim().toLowerCase()===identity
    && String(r.date||'')===String(date||'')
    && !['draft','pending','rejected','deleted','void'].includes(String(r.status||'').toLowerCase()))
    .sort((a,b)=>(b.updatedAt?.seconds||b.createdAt?.seconds||0)-(a.updatedAt?.seconds||a.createdAt?.seconds||0))[0]||null;
}
function hv1ReconcileFinalReports(s,date=hv1DateValue()){
  let changed=false;
  s.drafts ||= {};
  for(const name of s.team||[]){
    const d=s.drafts[name]||hv1BlankDraft(name);
    const linked=latestHourlyReports.find(row=>row.id===d.hourlyReportId);
    if(linked && !hourlyReportBelongsTo(linked,name,date)){
      hv1DetachReportLink(d);s.drafts[name]=d;changed=true;
    }
    const r=hv1FinalReportFor(name,date);
    if(!r)continue;
    if(!d.finalized || !d.hourlyReportId){
      d.finalized=true;d.hourlyReportId=r.id;d.date=date;
      d.sourceSubmissionId=r.sourceSubmissionId||'';
      d.finalStatusRecovered=true;s.drafts[name]=d;changed=true;
    }
  }
  return changed;
}
function hv1Status(d,name=d?.employee,date=d?.date||hv1DateValue()){
  if(hv1FinalReportFor(name,date) || d?.finalized)return 'COMPLETED';
  if(d?.savedAt)return 'IN PROGRESS';
  return 'NOT STARTED';
}

function hv1RenderRoster(preserveSelection=false){
  const host=$('hv1Roster');if(!host)return;
  const boxes=[...host.querySelectorAll('input[type=checkbox]')];
  const selected=new Set(preserveSelection && host.dataset.rosterDate===hv1DateValue() && boxes.length
    ? boxes.filter(x=>x.checked).map(x=>x.value):hv1Load().team||[]);
  host.innerHTML=getEmployeeRoster().map(n=>`<label class="hv1-check"><input type="checkbox" value="${esc(n)}" ${selected.has(n)?'checked':''}><span>${esc(n)}</span></label>`).join('');
  host.dataset.rosterDate=hv1DateValue();
}
function hv1RenderCards(){const host=$('hv1Cards'),s=hv1Load();if(hv1ReconcileFinalReports(s))localStorage.setItem(hv1Key(),JSON.stringify(s));if(!host)return;host.innerHTML=(s.team||[]).map(n=>{const d=s.drafts?.[n]||hv1BlankDraft(n),st=hv1Status(d,n,hv1DateValue()),cls=st==='COMPLETED'?'final':st==='IN PROGRESS'?'progress':'';const entered=Object.keys(d.entered||{}).length;const editNote=st==='COMPLETED'?'<br><b>Tap to EDIT finalized report</b>':'';return `<div class="hv1-card-wrap"><button class="hv1-card ${cls}" type="button" data-hv1-open-employee="${encodeURIComponent(n)}"><span class="hv1-status">${st}</span><h4>${esc(n)}</h4><div class="hv1-meta">${d.values?.hShift?`Shift: ${esc(d.values.hShift)}`:'Shift not selected'}<br>${entered} field/group(s) saved${(d.skippedPages||[]).length?` • ${(d.skippedPages||[]).length} page(s) skipped`:''}${editNote}</div></button><button class="hv1-card-restore" type="button" title="Restore ${esc(n)} from finalized report" data-hv1-restore-employee="${encodeURIComponent(n)}">↻</button><button class="hv1-card-delete" type="button" title="Delete ${esc(n)} from this team — password required" data-hv1-delete-employee="${encodeURIComponent(n)}">×</button></div>`}).join('')}
async function hv1Enter(){hourlyV1Mode=true;document.body.classList.add('hourly-v1-mode');document.body.classList.remove('hourly-workspace-mode','hourly-v1-editing');$('hourly')?.classList.add('hidden');document.querySelectorAll('.staffPanel').forEach(x=>x.classList.add('hidden'));$('hourlyV1Workspace')?.classList.remove('hidden');if($('hv1Date')&&!$('hv1Date').value)$('hv1Date').value=todayLocal();await hv1CloudRestore();await refreshEmployeeAccountRoster();await loadDeletedItems();hv1RenderRoster();const s=hv1Load();$('hv1Setup')?.classList.toggle('hidden',!!s.team?.length);$('hv1BoardBox')?.classList.toggle('hidden',!s.team?.length);if(s.team?.length)hv1RenderCards();hv1RenderRecovery()}
window.hv1SelectAll=function(){document.querySelectorAll('#hv1Roster input[type=checkbox]').forEach(x=>x.checked=true)};
window.hv1CreateBoard=async function(){
  const team=[...document.querySelectorAll('#hv1Roster input:checked')].map(x=>x.value);
  if(!team.length){alert('Select at least one employee.');return}
  const s=hv1Load();
  s.team=team; for(const name of team){if(s.removedEmployees?.[name])s.removedEmployees[name].restoredAt=Date.now();}
  s.drafts=s.drafts||{};
  team.forEach(n=>{if(!s.drafts[n])s.drafts[n]=hv1BlankDraft(n)});
  // Save local immediately, then WAIT for cloud backup to finish.
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  const cloudOk=await hv1CloudSave(JSON.parse(JSON.stringify(s)));
  $('hv1Setup').classList.add('hidden');
  $('hv1BoardBox').classList.remove('hidden');
  hv1RenderCards();
  if(!cloudOk)hv1SetCloudStatus('Team saved locally. Tap Sync Now before leaving this date.','warn');
};

window.hv1EditTeam=function(){$('hv1BoardBox').classList.add('hidden');$('hv1Setup').classList.remove('hidden');hv1RenderRoster()};

// LONG: sales through 4 PM are the no-busser portion on Mon–Fri.
// The BAR checkpoint remains 2–4; it must never be copied into BAR AM.
function hv1SyncLongBusserDraft(s,name){
  const d=s.drafts?.[name];
  if(!d || hv1DraftShift(d)!=="LONG" || hv1DraftRole(d)==="bartender")return false;
  d.values ||= {};d.entered ||= {};d.hourlyWizardState ||= {};
  const date=d.values.hDate||d.date||hv1DateValue();
  const choice=isWeekendDate(date)?"WITH":"WITHOUT";
  d.values.hBusserAM=choice;d.entered.hBusserAM=true;
  d.hourlyWizardState.busserAM=choice;
  d.hourlyWizardState.shift="LONG";
  d.hourlyWizardState.position=d.values.hPosition||"Server";
  const entries=s.bar?.["2PM_4PM"]?.entries||{};
  if(Object.prototype.hasOwnProperty.call(entries,name)){
    const raw=String(entries[name]??"").trim();
    d.values.hTotalAM=raw;d.entered.hTotalAM=raw!=="";
    d.longBusserSalesSource="BAR_2_4";
  }else if(d.longBusserSalesSource==="BAR_2_4"){
    d.values.hTotalAM="";d.entered.hTotalAM=false;
  }
  // LONG starts at 2 PM. Its early sales belong to the 2–4 BAR checkpoint.
  d.values.hAmBar="no";d.entered.hAmBar=true;
  return true;
}

function howSyncLongBusserForm(){
  if($("hShift")?.value!=="LONG" || String($("hPosition")?.value||"").toLowerCase()==="bartender")return;
  const date=$("hDate")?.value||hv1DateValue(),name=$("hEmployee")?.value||hv1EditingEmployee;
  const choice=isWeekendDate(date)?"WITH":"WITHOUT";
  howSetSilent("hBusserAM",choice);
  if(hourlyWizardState.shift==="LONG")hourlyWizardState.busserAM=choice;
  let state;try{state=JSON.parse(localStorage.getItem(HV1_STORAGE_PREFIX+date)||"{}")}catch{state={}}
  const entries=state.bar?.["2PM_4PM"]?.entries||{};
  const linked=Object.prototype.hasOwnProperty.call(entries,name);
  const stale=state.drafts?.[name]?.longBusserSalesSource==="BAR_2_4";
  if(linked || stale){
    const raw=linked?String(entries[name]??"").trim():"";
    howSetSilent("hTotalAM",raw);
    const field=$("howTotalAM");
    if(field){field.value=raw;field.readOnly=linked;field.title=linked?"Synced from BAR 2–4. Edit the sales in BAR Center.":"";}
  }
  howSetSilent("hAmBar","no");
}

// Owner bulk entry edits the same dated employee drafts and BAR checkpoints.
let ownerTableSession=null,ownerTableRequest=0,ownerTableSaving=false;
const OWNER_TABLE_MONEY={grand:'hGrandTotal',totalAM:'hTotalAM',paid:'hPaidTip',cardFee:'hCardFee',cash:'hCashTip',meal:'hMeal'};
const OWNER_TABLE_GROUPS={shift:'Shift',clock:'Clock In / Out',sales:'Sales',paid:'Paid Tip',cardFee:'Pay Card Tip Fee',cash:'Cash Tip',meal:'Meal'};
const OWNER_TABLE_CLOCKS=['clockIn','clockOut','clockIn2','clockOut2'];
function ownerTableAllowed(){return !!currentUser && currentProfile?.role==='owner';}
function ownerTableStatus(message){if($('ownerTableStatus'))$('ownerTableStatus').textContent=message;}
function ownerTableRow(s,name){
  const d=s.drafts?.[name]||{},v=d.values||{},shift=hv1DraftShift(d);
  const role=hv1DraftRole(d)==='bartender'?'Bartender':'Server';
  const row={name,shift,role,grand:v.hGrandTotal??'',totalAM:v.hTotalAM??'',total24:s.bar?.['2PM_4PM']?.entries?.[name]??'',paid:v.hPaidTip??'',cardFee:v.hCardFee??'',cash:v.hCashTip??'',meal:v.hMeal??''};
  if(shift===SHIFT_EARLY || shift===SHIFT_MIDDLE)row.totalAM=row.grand;
  if(shift==='AM')row.totalAM=s.bar?.AM?.entries?.[name]??(s.bar?.['2PM_4PM']?.bartender?'':row.grand);
  if(shift==='LONG')row.totalAM=s.bar?.AM?.entries?.[name]??'';
  for(const [field,key] of [['barAM','AM'],['bar24','2PM_4PM'],['barPM','PM']]){
    const explicit=s.bar?.[key]?.excluded?.[name];
    row[field]=role==='Server' && !hv1BarExcluded(key,s,name) && (explicit===false || hv1BarNumber(s.bar?.[key]?.entries?.[name])>0);
  }
  row.clockIn=v[shift==='DOUBLE'?'hAmIn':'hIn']??'';row.clockOut=v[shift==='DOUBLE'?'hAmOut':'hOut']??'';
  row.clockIn2=v.hPmIn??'';row.clockOut2=v.hPmOut??'';
  row.received=Object.fromEntries(['AM','2PM_4PM','PM'].map(key=>[key,role==='Bartender' && s.bar?.[key]?.bartender===name?hv1BarReceived(key,s):0]));
  return row;
}
function ownerTableLinked24(row){return row.shift===SHIFT_MIDDLE || (row.shift==='AM' && !!ownerTableSession?.bartender24);}
function ownerTableFormatClock(value){
  const text=String(value??'');
  return /^\d{4}$/.test(text)?text.slice(0,2)+':'+text.slice(2):text;
}
function ownerTableInputChanged(el){
  if(OWNER_TABLE_CLOCKS.includes(el.dataset.ownerTableField)){
    const next=ownerTableFormatClock(el.value);
    if(next!==el.value){
      const start=el.selectionStart,end=el.selectionEnd;
      el.value=next;
      if(start!==null && end!==null && typeof el.setSelectionRange==='function')el.setSelectionRange(start+(start>2?1:0),end+(end>2?1:0));
    }
  }
  ownerTableEdit(decodeURIComponent(el.dataset.employee||''),el.dataset.ownerTableField,el.type==='checkbox'?el.checked:el.value);
}
function ownerTableEdit(name,field,value){
  const session=ownerTableSession;
  if(!ownerTableAllowed() || !session || session.uid!==currentUser.uid || ownerTableSaving)return;
  const row=session.rows.find(r=>r.name===name);if(!row)return;
  const allowed=['shift',...OWNER_TABLE_CLOCKS,...Object.keys(OWNER_TABLE_MONEY),'total24','barAM','bar24','barPM'];
  if(!allowed.includes(field) || (row.role==='Bartender' && ['barAM','bar24','barPM'].includes(field)))return;
  if(['grand','totalAM','total24'].includes(field) && !ownerTableSalesEnabled(row,field))return;
  if(['clockIn2','clockOut2'].includes(field) && row.shift!=='DOUBLE')return;
  if(OWNER_TABLE_CLOCKS.includes(field))value=ownerTableFormatClock(value);
  const changed=session.dirty[name] ||= {};
  row[field]=value;changed[field]=value;
  if(field==='shift'){const times=shortShiftTimes(value);if(times){for(const [key,t] of [['clockIn',times[0]],['clockOut',times[1]]])if(!row[key]){row[key]=t;changed[key]=t;}}}
  if(row.role==='Server'){
    if(field==='totalAM' && (row.shift==='AM'||row.shift===SHIFT_EARLY) && !ownerTableLinked24(row)){row.grand=value;changed.grand=value;}
    if(field==='grand' && ownerTableLinked24(row)){row.total24=value;changed.total24=value;}
    if(field==='total24' && ownerTableLinked24(row)){row.grand=value;changed.grand=value;}
    if((row.shift==='AM' && !ownerTableLinked24(row)) || isShortShift(row.shift))row.totalAM=row.grand;
  }
  if(field==='shift')ownerTableRender();
  else document.querySelectorAll('[data-owner-table-field]').forEach(el=>{
    if(decodeURIComponent(el.dataset.employee||'')!==name || el.dataset.ownerTableField===field || el.type==='checkbox')return;
    const k=el.dataset.ownerTableField;if(k in row)el.value=String(row[k]??'');
  });
  ownerTableStatus('Unsaved changes — press Save Table.');
}
function ownerTableSalesEnabled(row,field){
  if(!TIP_SHIFTS.includes(row.shift))return false;
  if(field==='grand')return true;
  if(field==='total24')return row.role==='Server' && (['DOUBLE','LONG'].includes(row.shift) || (row.shift==='AM' && !!ownerTableSession?.bartender24));
  if(row.role==='Bartender')return ['DOUBLE','LONG'].includes(row.shift);
  return ['AM','DOUBLE','LONG'].includes(row.shift);
}
window.ownerTableSelectGroup=function(group){
  const session=ownerTableSession;
  if(!ownerTableAllowed() || !session || session.uid!==currentUser.uid || ownerTableSaving || !Object.hasOwn(OWNER_TABLE_GROUPS,group))return;
  session.group=group;ownerTableRender();
};
window.ownerTableSelectSales=function(field){
  if(!ownerTableAllowed() || !ownerTableSession || ownerTableSession.uid!==currentUser.uid || ownerTableSaving || !['grand','totalAM','total24'].includes(field))return;
  ownerTableSession.salesField=field;ownerTableRender();
};
function ownerTableResetHorizontalScroll(){
  const scroller=$('ownerTableScroll');
  if(scroller)scroller.scrollLeft=0;
}
window.addEventListener('resize',ownerTableResetHorizontalScroll);
window.addEventListener('orientationchange',ownerTableResetHorizontalScroll);
function ownerTableRender(){
  const session=ownerTableSession,host=$('ownerTableBody');if(!host || !session || !ownerTableAllowed())return;
  ownerTableResetHorizontalScroll();
  const group=session.group ||= 'shift',salesField=session.salesField ||= 'grand';
  const labels={grand:'Grand Total ($)',totalAM:'Total AM ($)',total24:'Total 2–4 ($)',paid:'Paid Tip ($)',cardFee:'Pay Card Tip Fee ($)',cash:'Cash Tip ($)',meal:'Meal ($)'};
  $('ownerTableGroups').innerHTML=Object.entries(OWNER_TABLE_GROUPS).map(([key,label])=>`<button class="btn ${group===key?'green':'light'}" type="button" aria-pressed="${group===key}" onclick="ownerTableSelectGroup('${key}')">${label}</button>`).join('');
  $('ownerTableSalesGroups').innerHTML=group==='sales'?['grand','totalAM','total24'].map(key=>`<button class="btn ${salesField===key?'dark':'light'}" type="button" aria-pressed="${salesField===key}" onclick="ownerTableSelectSales('${key}')">${labels[key]}</button>`).join(''):'';
  $('ownerTablePeriods').textContent=group==='sales'?['AM','2PM_4PM','PM'].map((key,i)=>['BAR AM','BAR 2–4','BAR PM'][i]+': '+(session.bartenders?.[key]||'Not selected')).join(' · '):'';
  $('ownerTablePeriods').classList.toggle('hidden',group!=='sales');
  const note=group==='sales'?'Cumulative sales: Total 2–4 includes Total AM. Grand Total includes both. Grey fields do not apply to this shift.':group==='clock'?'Type 4 digits: 2100 → 21:00. Use 24-hour time. Double Shift has two clock-in/out pairs.':'Fill this column for everyone, then Save Table. You can switch sections without losing your edits.';
  $('ownerTableHelp').textContent=note;
  $('ownerTableHead').innerHTML=`<tr><th scope="col">Employee</th><th scope="col">${group==='sales'?labels[salesField]:OWNER_TABLE_GROUPS[group]}</th></tr>`;
  host.innerHTML=session.rows.map(row=>{
    const employee=encodeURIComponent(row.name),server=row.role==='Server';
    const input=(key,label,type='number',disabled=false)=>`<input type="${type}" ${type==='number'?'min="0" step="0.01" inputmode="decimal" placeholder="0.00"':'inputmode="numeric" placeholder="HH:MM" maxlength="5" pattern="[0-2][0-9]:[0-5][0-9]"'} data-owner-table-field="${key}" data-employee="${employee}" value="${esc(row[key]??'')}" aria-label="${esc(row.name)} ${label}" ${disabled?'disabled':''}>`;
    let cell='';
    if(group==='shift')cell=`<select data-owner-table-field="shift" data-employee="${employee}" aria-label="${esc(row.name)} Shift"><option value="">Select shift</option>${TIP_SHIFTS.map(v=>`<option value="${v}" ${row.shift===v?'selected':''}>${v==='LONG'?'Long Shift':v==='DOUBLE'?'Double Shift':v}</option>`).join('')}</select>`;
    else if(group==='clock')cell=`<div class="owner-clock-grid">${[['clockIn','Clock In 1'],['clockOut','Clock Out 1'],...(row.shift==='DOUBLE'?[['clockIn2','Clock In 2'],['clockOut2','Clock Out 2']]:[])].map(([key,label])=>`<label>${label}${input(key,label,'text',!row.shift)}</label>`).join('')}</div>`;
    else if(group==='sales' && salesField==='grand' && server && row.shift==='AM' && session.bartender24){
      // AM servers have two cumulative checkpoints when a 2–4 bartender is assigned.
      // Editing total24 already mirrors Grand Total through ownerTableEdit.
      cell=[['totalAM','Total AM ($)','barAM','AM'],['total24','Total 2–4 ($) · includes AM','bar24','2–4']].map(([field,label,barField,period])=>
        `<div><label><b>${label}</b>${input(field,label)}</label><label class="owner-inline-check"><input type="checkbox" data-owner-table-field="${barField}" data-employee="${employee}" ${row[barField]?'checked':''} aria-label="${esc(row.name)} BAR Sales ${period}">BAR Sales ${period}</label></div>`
      ).join('')+'<small>Total 2–4 becomes this employee’s Grand Total. Do not add Total AM again.</small>';
    }
    else if(group==='sales'){
      const enabled=ownerTableSalesEnabled(row,salesField);
      cell=input(salesField,labels[salesField],'number',!enabled);
      const key={grand:'PM',totalAM:'AM',total24:'2PM_4PM'}[salesField];
      const short=key==='2PM_4PM'?'2–4':key;
      if(!enabled)cell+='<small>Not editable for this shift</small>';
      if(!server)cell+=`<div class="owner-received">Received ${short}: <b>${fmtMoney(row.received?.[key]||0)}</b></div>`;
      else {
        const barField=salesField==='grand'?(row.shift===SHIFT_MIDDLE?'bar24':row.shift==='AM'?(session.bartender24?'bar24':'barAM'):row.shift===SHIFT_EARLY?'barAM':'barPM'):salesField==='totalAM'?'barAM':'bar24';
        const barLabel={barAM:'AM',bar24:'2–4',barPM:'PM'}[barField];
        cell+=`<label class="owner-inline-check"><input type="checkbox" data-owner-table-field="${barField}" data-employee="${employee}" ${row[barField]?'checked':''} ${!enabled?'disabled':''} aria-label="${esc(row.name)} BAR Sales ${barLabel}">BAR Sales ${barLabel}</label>`;
      }
    }else cell=input(group,labels[group]);
    return `<tr><th scope="row"><b>${esc(row.name)}</b><small>${row.role}${row.shift?' · '+esc(row.shift):''}</small></th><td>${cell}</td></tr>`;
  }).join('') || '<tr><td colspan="2">No employees selected. Use Employee Board to create today’s team first.</td></tr>';
  document.querySelectorAll('[data-owner-table-field]').forEach(el=>el.addEventListener(el.type==='checkbox'||el.tagName==='SELECT'?'change':'input',()=>ownerTableInputChanged(el)));
}
function ownerTableBuildBatch(source,session){
  const s=JSON.parse(JSON.stringify(source));hv1EnsureBarState(s);s.drafts ||= {};
  if(!!s.bar['2PM_4PM'].bartender!==session.bartender24)throw new Error('The 2–4 bartender assignment changed. Reopen the table before saving.');
  for(const [name,changes] of Object.entries(session.dirty)){
    if(!s.team?.includes(name))throw new Error(name+' is no longer on this team. Reopen the table.');
    const row=session.rows.find(r=>r.name===name);if(!row)throw new Error('Employee row missing.');
    const d=s.drafts[name] ||= hv1BlankDraft(name);
    if(!TIP_SHIFTS.includes(row.shift))throw new Error('Select a shift for '+name+'.');
    if(row.role!==(hv1DraftRole(d)==='bartender'?'Bartender':'Server'))throw new Error(name+' changed position. Reopen the table.');
    const v=d.values ||= {};d.entered ||= {};
    for(const key of [...Object.keys(OWNER_TABLE_MONEY),'total24']){
      if(!(key in changes))continue;
      const value=String(row[key]??'').trim();
      if(value!=='' && (!/^\d+(?:\.\d{0,2})?$/.test(value) || !Number.isFinite(Number(value))))throw new Error(name+': '+key+' must be a positive amount or zero, with up to 2 decimals.');
    }
    hv1SetValue(d,'hEmployee',name);hv1SetValue(d,'hDate',session.date);
    hv1SetValue(d,'hPosition',row.role);hv1SetValue(d,'hShift',row.shift);shortShiftDraftTimes(d);
    d.hourlyWizardState={...(d.hourlyWizardState||{}),position:row.role,shift:row.shift};
    const clockMap=row.shift==='DOUBLE'?{clockIn:'hAmIn',clockOut:'hAmOut',clockIn2:'hPmIn',clockOut2:'hPmOut'}:{clockIn:'hIn',clockOut:'hOut'};
    for(const [key,field] of Object.entries(clockMap)){
      if(!(key in changes) && !('shift' in changes))continue;
      const value=String(row[key]??'').trim();
      if(value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error(name+': '+key+' must use 24-hour time HH:MM.');
      v[field]=value;d.entered[field]=value!=='';
    }
    const setMoney=(field,value)=>{v[field]=String(value??'').trim();d.entered[field]=v[field]!=='';};
    for(const [key,field] of Object.entries(OWNER_TABLE_MONEY)){
      if(!(key in changes))continue;
      if(key==='totalAM' && (row.shift==='LONG' && row.role==='Server' || !['DOUBLE','LONG'].includes(row.shift)))continue;
      setMoney(field,row[key]);
    }
    if(row.role==='Server'){
      const written=new Set();
      const write=(key,value)=>{s.bar[key].entries[name]=String(value??'').trim();s.barManual ||= {};s.barManual[name] ||= {};s.barManual[name][key]=true;written.add(key);};
      if('grand' in changes)write(hv1BarSalesFieldMap(row.shift,s,name).hGrandTotal,row.grand);
      if('totalAM' in changes && ['AM','DOUBLE','LONG',SHIFT_EARLY].includes(row.shift))write('AM',row.totalAM);
      if('total24' in changes)write('2PM_4PM',row.total24);
      for(const [key,field] of [['AM','barAM'],['2PM_4PM','bar24'],['PM','barPM']]){
        if(field in changes || written.has(key)){
          s.bar[key].excluded ||= {};s.bar[key].excluded[name]=!row[field];
        }
      }
      const amKey=row.shift==='AM'?hv1BarSalesFieldMap(row.shift,s,name).hGrandTotal:'AM';
      if(row.shift!=='LONG' && row.shift!==SHIFT_MIDDLE)hv1SetValue(d,'hAmBar',hv1BarExcluded(amKey,s,name)?'no':'yes');
      hv1SetValue(d,'hPmBar',hv1BarExcluded(row.shift===SHIFT_MIDDLE?'2PM_4PM':'PM',s,name)?'no':'yes');
      hv1SyncBarSalesToDraft(s,name);hv1SyncLongBusserDraft(s,name);
    }
    d.employee=name;d.date=session.date;d.savedAt=Date.now();
    // First open hydrated the final report. Subsequent table edits are drafts,
    // and must survive reopening without the older final replacing their values.
    d.editHydratedFromFinalV13811=true;
  }
  hv1ApplyBarAutomation(s);return s;
}
window.ownerTableOpen=async function(){
  if(!ownerTableAllowed()){alert('Owner only.');return;}
  if(ownerTableSaving)return;
  if(ownerTableSession && Object.keys(ownerTableSession.dirty).length && !confirm('Discard unsaved table changes and reload?'))return;
  ownerTableSession=null;
  const token=++ownerTableRequest,uid=currentUser.uid;
  if(document.body.classList.contains('hourly-v1-editing')){captureHourlyWizard();hv1CapturePage(false);}
  hv1EditingEmployee='';clearTimeout(hv1AutosaveTimer);
  if(!$('hv1Date').value)$('hv1Date').value=todayLocal();
  const date=hv1DateValue();ownerTableStatus('Loading employee drafts…');
  $('fzRoleHome')?.classList.add('hidden');$('staffApp')?.classList.remove('hidden');
  $('hourlyV1Workspace')?.classList.add('hidden');
  document.body.classList.remove('hourly-v1-mode','hourly-v1-editing','hourly-v1-small-report','hourly-workspace-mode','small-report-fullscreen');
  document.documentElement.classList.remove('small-report-fullscreen');
  document.querySelectorAll('.staffPanel').forEach(el=>el.classList.add('hidden'));
  $('ownerSalesTable')?.classList.remove('hidden');$('ownerTableBody').innerHTML='';
  await hv1CloudRestore();
  const initial=hv1Load();
  for(const name of initial.team||[]){
    if(token!==ownerTableRequest || !ownerTableAllowed() || currentUser.uid!==uid || hv1DateValue()!==date)return;
    if(initial.drafts?.[name]?.hourlyReportId)await hv1HydrateDraftFromFinalReport(name);
  }
  if(token!==ownerTableRequest || !ownerTableAllowed() || currentUser.uid!==uid || hv1DateValue()!==date)return;
  const state=hv1Load();hv1EnsureBarState(state);hv1ApplyBarAutomation(state);
  ownerTableSession={date,uid,bartender24:!!state.bar['2PM_4PM'].bartender,bartenders:Object.fromEntries(['AM','2PM_4PM','PM'].map(key=>[key,state.bar[key].bartender])),rows:(state.team||[]).map(name=>ownerTableRow(state,name)),dirty:{}};
  $('ownerTableDate').value=date;ownerTableRender();ownerTableStatus('Ready. Changes are saved with Save Table.');
  window.scrollTo(0,0);
};
window.ownerTableDateChanged=async function(){
  if(!ownerTableAllowed() || ownerTableSaving)return;
  const date=$('ownerTableDate').value;
  if(!date){$('ownerTableDate').value=ownerTableSession?.date||hv1DateValue();return;}
  if(ownerTableSession && Object.keys(ownerTableSession.dirty).length && !confirm('Discard unsaved changes and change date?')){$('ownerTableDate').value=ownerTableSession.date;return;}
  ownerTableSession=null;$('hv1Date').value=date;await window.ownerTableOpen();
};
window.ownerTableSave=async function(back=false){
  if(!ownerTableAllowed()){alert('Owner only.');return false;}
  const session=ownerTableSession;
  if(ownerTableSaving || !session || session.uid!==currentUser.uid)return false;
  if(session.date!==hv1DateValue()){ownerTableStatus('Work date changed. Reopen the table.');return false;}
  let state;
  try{state=ownerTableBuildBatch(hv1Load(),session);}catch(e){ownerTableStatus(e.message);return false;}
  ownerTableSaving=true;$('ownerTableDate').disabled=true;
  document.querySelectorAll('#ownerSalesTable button, #ownerSalesTable input, #ownerSalesTable select').forEach(el=>el.disabled=true);
  const uid=currentUser.uid;
  try{
    localStorage.setItem(HV1_STORAGE_PREFIX+session.date,JSON.stringify(state));
    ownerTableStatus('Saving employee drafts and BAR…');
    const saved=await hv1CloudSave(state,session.date);
    if(!ownerTableAllowed() || currentUser.uid!==uid || ownerTableSession!==session)return false;
    if(!saved){ownerTableStatus('Saved on this device only. Cloud sync failed — press Save Table to retry.');return false;}
    session.dirty={};session.rows=(state.team||[]).map(name=>ownerTableRow(state,name));
    ownerTableStatus('Saved to Employee Board and BAR.');hv1RenderCards();
    if(back){ownerTableSession=null;await window.fzOpenTipCalculation();}
    return true;
  }catch(e){ownerTableStatus('Could not save: '+(e.message||e));return false;}
  finally{
    ownerTableSaving=false;
    document.querySelectorAll('#ownerSalesTable button').forEach(el=>el.disabled=false);
    $('ownerTableDate').disabled=false;
    if(ownerTableSession===session)ownerTableRender();
  }
};
window.ownerTableBack=async function(){
  if(!ownerTableAllowed() || ownerTableSaving)return;
  if(ownerTableSession && Object.keys(ownerTableSession.dirty).length && !confirm('Leave without saving these table changes?'))return;
  ownerTableSession=null;++ownerTableRequest;await window.fzOpenTipCalculation();
};

function hv1BarSalesFieldMap(shift,s={},name=''){
  if(shift===SHIFT_EARLY)return {hGrandTotal:'AM'};
  if(shift===SHIFT_MIDDLE)return {hGrandTotal:'2PM_4PM'};
  // AM follows the assigned 2–4 bartender, not whether a sales entry exists.
  // LONG still uses 2–4 sales even without a dedicated 2–4 bartender.
  if(shift==='AM')return {hGrandTotal:String(s.bar?.['2PM_4PM']?.bartender||'').trim()!==''?'2PM_4PM':'AM'};
  if(shift==='PM')return {hGrandTotal:'PM'};
  if(shift==='DOUBLE')return {hTotalAM:'AM',hGrandTotal:'PM'};
  if(shift==='LONG')return {hTotalAM:'2PM_4PM',hGrandTotal:'PM'};
  return {};
}
function hv1SyncBarSalesToDraft(s,name){
  const d=s.drafts?.[name];
  if(!d || hv1DraftRole(d)==='bartender')return false;
  d.values ||= {};d.entered ||= {};d.barSalesLinks ||= {};
  const fields=hv1BarSalesFieldMap(hv1DraftShift(d),s,name);
  let changed=false;
  for(const [field,link] of Object.entries(d.barSalesLinks)){
    if(fields[field]!==link.checkpoint){
      // A prior AM total is not a full-day total after switching to DOUBLE.
      if(String(d.values[field]??'')===link.value){d.values[field]='';d.entered[field]=false;}
      delete d.barSalesLinks[field];changed=true;
    }
  }
  for(const [field,checkpoint] of Object.entries(fields)){
    const entries=s.bar?.[checkpoint]?.entries||{};
    if(!Object.prototype.hasOwnProperty.call(entries,name)){
      if(d.barSalesLinks[field]){delete d.barSalesLinks[field];changed=true;}
      continue;
    }
    // Preserve explicit zero and blank. Invalid text stays visible for the
    // existing validation; it must not silently become a financial zero.
    const value=String(entries[name]??'').trim();
    const link=d.barSalesLinks[field];
    if(String(d.values[field]??'')!==value || d.entered[field]!==!!value
      || link?.checkpoint!==checkpoint || link?.value!==value){
      d.values[field]=value;d.entered[field]=value!=='';
      d.barSalesLinks[field]={checkpoint,value};changed=true;
    }
  }
  if(changed)d.savedAt=Date.now();
  return changed;
}

function hv1SyncServerDraftToBar(s,name,editedSales=[]){
  hv1EnsureBarState(s);
  const d=s.drafts?.[name];
  if(!d || hv1DraftRole(d)==="bartender")return;

  // Only a sales field actually edited by the manager may replace its linked
  // BAR value. Saving hours, tips or another employee never overwrites it.
  const fieldMap=hv1BarSalesFieldMap(hv1DraftShift(d),s,name);
  for(const field of editedSales){
    const link=d.barSalesLinks?.[field];
    if(link && link.checkpoint===fieldMap[field]){
      s.bar[link.checkpoint].entries[name]=String(d.values?.[field]??'').trim();
      s.barManual ||= {};s.barManual[name] ||= {};s.barManual[name][link.checkpoint]=true;
    }
  }
  hv1SyncBarSalesToDraft(s,name);

  hv1SyncLongBusserDraft(s,name);
  const manual=s.barManual?.[name]||{};
  const shift=hv1DraftShift(d);
  const grand=Math.max(0,Number(d.values?.hGrandTotal||0));
  const totalAM=Math.max(0,Number(d.values?.hTotalAM||0));
  const amOn=String(d.values?.hAmBar||"no")==="yes";
  const pmOn=String(d.values?.hPmBar||"no")==="yes";

  // AM-only: use 2–4 when its bartender is assigned, otherwise AM. Corrections go back to the
  // selected source, so a full 2–4 total cannot overwrite the earlier AM value.
  // PM-only: BAR PM Grand Total = employee Grand Total.
  // DOUBLE: BAR AM = Total AM; BAR PM = cumulative/full Grand Total.
  // DOUBLE keeps its separate, manually entered BAR 2–4 checkpoint.
  if(isShortShift(shift)){
    const checkpoint=shift===SHIFT_EARLY?'AM':'2PM_4PM';
    const enabled=shift===SHIFT_EARLY?amOn:pmOn;
    if(enabled && grand>0 && !manual[checkpoint])s.bar[checkpoint].entries[name]=String(grand);
  }else if(shift==="AM"){
    const checkpoint=hv1BarSalesFieldMap(shift,s,name).hGrandTotal;
    if(amOn && grand>0){if(!manual[checkpoint])s.bar[checkpoint].entries[name]=String(grand)}
    else if(amOn && !manual[checkpoint])delete s.bar[checkpoint].entries[name];
    {if(!manual.PM)delete s.bar.PM.entries[name]};
  }else if(shift==="PM"){
    if(pmOn && grand>0){if(!manual.PM)s.bar.PM.entries[name]=String(grand)}
    else if(pmOn && !manual.PM)delete s.bar.PM.entries[name];
    {if(!manual.AM)delete s.bar.AM.entries[name]};
  }else if(shift==="DOUBLE"){
    if(amOn && totalAM>0){if(!manual.AM)s.bar.AM.entries[name]=String(totalAM)}
    else if(amOn && !manual.AM)delete s.bar.AM.entries[name];
    if(pmOn && grand>0){if(!manual.PM)s.bar.PM.entries[name]=String(grand)}
    else if(pmOn && !manual.PM)delete s.bar.PM.entries[name];
  }else if(shift==="LONG"){
    // Remove only a prior automatically generated AM mirror. Manual BAR values stay intact.
    if(!manual.AM)delete s.bar.AM.entries[name];
    if(pmOn && grand>0){if(!manual.PM)s.bar.PM.entries[name]=String(grand)}
    else if(pmOn && !manual.PM)delete s.bar.PM.entries[name];
  }
}

function hv1SyncBarEntryToServerDraft(s,key,name,value){
  s.drafts ||= {};
  const d=s.drafts[name]||hv1BlankDraft(name);
  if(hv1DraftRole(d)==="bartender")return;
  s.drafts[name]=d;
  d.values=d.values||{};
  d.entered=d.entered||{};
  const choices=Object.fromEntries(['AM','2PM_4PM','PM'].map(cp=>[cp,hv1BarExcluded(cp,s,name)]));
  const n=Math.max(0,Number(value)||0);
  const has=String(value??"").trim()!=="" && n>0;
  const shift=hv1DraftShift(d);

  if(key==="AM"){
    const has24=shift==='AM' && Number(s.bar?.['2PM_4PM']?.entries?.[name]||0)>0;
    d.values.hAmBar=(has||has24)?"yes":"no";
    if(shift==="DOUBLE"){
      d.values.hTotalAM=has?String(n):d.values.hTotalAM||"";
      if(has)d.entered.hTotalAM=true;
    }
  }

  if(key==="PM"){
    const has24=Number(s.bar?.["2PM_4PM"]?.entries?.[name]||0)>0;
    d.values.hPmBar=(has||has24)?"yes":"no";
    if(["PM","DOUBLE","LONG"].includes(shift) && has){
      d.values.hGrandTotal=String(n);
      d.entered.hGrandTotal=true;
    }
  }

  if(key==="2PM_4PM"){
    if(shift==='AM'){
      const hasAM=Number(s.bar?.AM?.entries?.[name]||0)>0;
      d.values.hAmBar=(has||hasAM)?'yes':'no';
    }
    const hasPM=Number(s.bar?.PM?.entries?.[name]||0)>0;
    d.values.hPmBar=(has||hasPM)?"yes":"no";
  }

  for(const cp of ['AM','2PM_4PM','PM']){
    if(choices[cp]){
      s.bar[cp].excluded ||= {};s.bar[cp].excluded[name]=true;
      const field=hv1BarChoiceField(cp,s,name);
      if(field)hv1SetValue(d,field,'no');
    }
  }
  hv1SyncBarSalesToDraft(s,name);
  hv1SyncLongBusserDraft(s,name);
  d.savedAt=Date.now();
  s.drafts[name]=d;
}

function hv1EnsureBarState(s){
  s.bar=s.bar||{};
  for(const key of ['AM','2PM_4PM','PM']){
    s.bar[key]=s.bar[key]||{bartender:'',entries:{}};
    s.bar[key].entries=s.bar[key].entries||{};
  }
  return s.bar;
}
function hv1BarRecipient(key,s){
  const assigned=String(s?.bar?.[key]?.bartender||'');
  if(assigned || key!=='2PM_4PM')return assigned;
  const am=String(s?.bar?.AM?.bartender||'');
  if(!am)return '';
  // An explicitly EARLY-only bartender stops at 2 PM; never extend that shift.
  const shift=hv1DraftShift(s?.drafts?.[am]);
  return shift===SHIFT_EARLY?'':am;
}
function hv1DraftRole(d){return String(employeeWorkProfile(d?.employee||d?.values?.hEmployee)?.position||d?.values?.hPosition||d?.hourlyWizardState?.position||'').toLowerCase()}
function hv1DraftShift(d){return String(d?.values?.hShift||d?.hourlyWizardState?.shift||'').toUpperCase()}
function hv1ServerNamesForCheckpoint(key,s){
  const bartenders=new Set(Object.values(hv1EnsureBarState(s)).map(x=>x.bartender).filter(Boolean));
  // P22 MANUAL BAR ENTRY:
  // Every employee selected on Today's Team is available in BAR AM / 2-4 / PM.
  // Shift does NOT have to be entered first. This restores the fast workflow:
  // choose today's team once, then type each server's cumulative Grand Total
  // directly in the appropriate BAR checkpoint.
  return (s.team||[]).filter(name=>{
    if(bartenders.has(name))return false;
    const d=s.drafts?.[name]||{};
    if(hv1DraftRole(d)==='bartender')return false;
    return true;
  });
}

function hv1BartenderOptions(selected,s){
  const names=(s.team||[]).filter(name=>employeeWorkProfile(name)?.position!=="Server");
  return `<option value="">Select bartender</option>`+names.map(n=>`<option value="${esc(n)}" ${n===selected?'selected':''}>${esc(n)}</option>`).join('');
}
function hv1BarNumber(value){
  const n=Number(value);
  return Number.isFinite(n) && n>0 ? n : 0;
}

function hv1RawServerBarFees(name,s){
  const bar=s.bar||{};
  const amGT=hv1BarNumber(bar.AM?.entries?.[name]);
  const gt24=hv1BarNumber(bar['2PM_4PM']?.entries?.[name]);
  const pmGT=hv1BarNumber(bar.PM?.entries?.[name]);
  const amFee=howRoundCent(amGT*0.006);
  const valid24=gt24>0 && gt24>=amGT;
  const fee24=valid24?Math.max(0,howRoundCent(gt24*0.006)-amFee):0;
  const previousCumulative=valid24?gt24:amGT;
  const validPM=pmGT>0 && pmGT>=previousCumulative;
  const pmFee=validPM?Math.max(0,howRoundCent(pmGT*0.006)-amFee-fee24):0;
  return {amGT,gt24,pmGT,amFee,fee24,pmFee,
    totalFee:howRoundCent(amFee+fee24+pmFee),valid24,validPM};
}

// Sales checkpoints stay intact. Exclusion waives only this period's fee;
// earlier cumulative sales still bound later periods (no fee redistribution).
function hv1BarChoiceField(key,s,name){
  const shift=hv1DraftShift(s.drafts?.[name]);
  if(shift===SHIFT_MIDDLE)return key==='2PM_4PM'?'hPmBar':'';
  if(shift===SHIFT_EARLY)return key==='AM'?'hAmBar':'';
  if(key==='AM')return shift==='LONG' || (shift==='AM' && s.bar?.['2PM_4PM']?.bartender)?'':'hAmBar';
  if(key==='PM')return 'hPmBar';
  return shift==='AM' && s.bar?.['2PM_4PM']?.bartender?'hAmBar':'';
}
function hv1BarExcluded(key,s,name){
  const explicit=s.bar?.[key]?.excluded?.[name];
  if(typeof explicit==='boolean')return explicit;
  const d=s.drafts?.[name],field=hv1BarChoiceField(key,s,name);
  return !!(field && d?.entered?.[field] && d.values?.[field]==='no');
}
function hv1SyncBarChoices(s,name){
  hv1EnsureBarState(s);
  const d=s.drafts?.[name];
  if(!d || hv1DraftRole(d)==='bartender')return;
  const shift=hv1DraftShift(d);
  const pairs=shift===SHIFT_MIDDLE?[['hPmBar','2PM_4PM']]:[['hAmBar',shift==='AM'?hv1BarSalesFieldMap(shift,s,name).hGrandTotal:'AM'],['hPmBar','PM']];
  for(const [field,key] of pairs){
    if(field==='hAmBar' && shift==='LONG')continue;
    if(!d.entered?.[field])continue;
    s.bar[key].excluded ||= {};
    s.bar[key].excluded[name]=d.values?.[field]!=='yes';
  }
}
function hv1ServerBarFees(name,s){
  const f=hv1RawServerBarFees(name,s);
  const amFee=hv1BarExcluded('AM',s,name)?0:f.amFee;
  const fee24=hv1BarExcluded('2PM_4PM',s,name)?0:f.fee24;
  const pmFee=hv1BarExcluded('PM',s,name)?0:f.pmFee;
  return {...f,amFee,fee24,pmFee,totalFee:howRoundCent(amFee+fee24+pmFee)};
}
function hv1SetBarExcluded(key,name,excluded){
  if(!['AM','2PM_4PM','PM'].includes(key))return;
  const s=hv1Load();hv1EnsureBarState(s);
  if(!hv1ServerNamesForCheckpoint(key,s).includes(name))return;
  s.bar[key].excluded ||= {};s.bar[key].excluded[name]=!!excluded;
  s.drafts ||= {};const d=s.drafts[name] ||= hv1BlankDraft(name);
  const field=hv1BarChoiceField(key,s,name);
  // AM-only cards use the final applicable AM checkpoint as their control.
  const mapped=hv1DraftShift(d)!=='AM' || key!=='AM' || !s.bar['2PM_4PM'].bartender;
  if(field && mapped)hv1SetValue(d,field,excluded?'no':'yes');
  hv1ApplyBarAutomation(s);hv1Save(s);hv1RenderBarCenter();
}

function hv1ServerBarPeriodFee(key,name,s){
  const f=hv1ServerBarFees(name,s);
  return key==='AM'?f.amFee:key==='2PM_4PM'?f.fee24:f.pmFee;
}

function hv1BarCheckpointTotals(key,s){
  let summary=0,gross=0,lessAM=0,less24=0,finalReceived=0;
  const ignored=[];
  for(const name of hv1ServerNamesForCheckpoint(key,s)){
    if(hv1BarExcluded(key,s,name))continue;
    const f=hv1RawServerBarFees(name,s);
    const current=key==='AM'?f.amGT:key==='2PM_4PM'?f.gt24:f.pmGT;
    const valid=key==='AM'?current>0:key==='2PM_4PM'?f.valid24:f.validPM;
    // A blank or decreasing checkpoint is pending, never a negative charge.
    // Crucially, a different server's earlier fee is never subtracted here.
    if(!valid){if(current>0)ignored.push(name);continue;}
    summary+=current;
    gross+=howRoundCent(current*0.006);
    if(key!=='AM')lessAM+=f.amFee;
    if(key==='PM')less24+=f.fee24;
    finalReceived+=key==='AM'?f.amFee:key==='2PM_4PM'?f.fee24:f.pmFee;
  }
  return {checkpoint:key,summary:howRoundCent(summary),gross:howRoundCent(gross),lessAM:howRoundCent(lessAM),less24:howRoundCent(less24),finalReceived:howRoundCent(finalReceived),ignored};
}

function hv1BarFormKey(d){
  // Numeric zero and an empty input are equivalent for the form comparison.
  return JSON.stringify({
    servers:(d.servers||[]).map(r=>[String(r.name||'').trim(),hv1BarNumber(r.grandTotal)]),
    previousAM:hv1BarNumber(d.previousAM),previous24:hv1BarNumber(d.previous24)
  });
}

function hv1ServerBarCalculationValues(name){
  const s=hv1Load(),d=s.drafts?.[name];
  if(!d?.barAuto)return null;
  // Calculate the current form, even when Calculate is tapped before autosave.
  // This is an in-memory copy; it does not write/delete database records.
  if(String($('hEmployee')?.value||'')===name){
    d.values=d.values||{};
    const editedSales=['hGrandTotal','hTotalAM'].filter(k=>$(k) && String(d.values[k]??'')!==String($(k).value??''));
    ['hGrandTotal','hTotalAM','hAmBar','hPmBar'].forEach(k=>{
      if($(k))d.values[k]=String($(k).value??'');
    });
    hv1SyncBarChoices(s,name);
    hv1SyncServerDraftToBar(s,name,editedSales);
  }
  return hv1ServerBarFees(name,s);
}


function hv1BarGross(key,s){
  return hv1BarCheckpointTotals(key,s).gross;
}

function hv1BarReceived(key,s){
  return hv1BarCheckpointTotals(key,s).finalReceived;
}

function hv1BarCheckpointLabel(key){return key==='AM'?'BAR AM':key==='2PM_4PM'?'BAR 2–4':'BAR PM'}
function hv1BarCardHtml(key,s){
  const bar=hv1EnsureBarState(s)[key],names=hv1ServerNamesForCheckpoint(key,s);
  const gross=hv1BarGross(key,s),received=hv1BarReceived(key,s);
  const formula=key==='AM'
    ? 'All Server Grand Total × 0.6%'
    : key==='2PM_4PM'
      ? 'All Server Grand Total × 0.6% − BAR AM received'
      : (hv1BarReceived('2PM_4PM',s)>0
          ? 'All Server Grand Total × 0.6% − BAR AM received − BAR 2–4 received'
          : 'All Server Grand Total × 0.6% − BAR AM received (2–4 optional / not used)');
  return `<h4>${hv1BarCheckpointLabel(key)}</h4>
    <div class="formula">${formula}</div><div class="notice">Check No Bar Sales to exclude this employee from this period’s tip out. Sales stay saved; other periods keep their existing calculation.</div>
    ${key==='2PM_4PM'?'<div class="notice">AM servers: with a 2–4 bartender selected, these sales become your Grand Total. Without a 2–4 bartender, your Grand Total follows BAR AM. LONG servers: these are sales through 4 PM, excluded from busser on Monday–Friday. Saturday/Sunday busser applies to the full day.</div>':''}
    <div class="hv1-bar-bartender"><label>Bartender</label><select data-hv1-bar-bartender="${key}">${hv1BartenderOptions(bar.bartender,s)}</select></div>
    <div class="hv1-bar-row head"><div>Server</div><div>Cumulative Sales</div><div>This Period Fee</div></div>
    ${names.length?names.map(name=>{
      const v=bar.entries?.[name]??'';
      return `<div class="hv1-bar-row"><div><b>${esc(name)}</b><label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px"><input type="checkbox" style="width:20px;min-width:20px;height:20px;margin:0" data-hv1-bar-excluded="${key}" data-employee="${encodeURIComponent(name)}" ${hv1BarExcluded(key,s,name)?'checked':''} aria-label="No Bar Sales — ${esc(name)} — ${hv1BarCheckpointLabel(key)}">No Bar Sales</label></div><input type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" data-hv1-bar-gt="${key}" data-employee="${encodeURIComponent(name)}" value="${v===''?'':esc(v)}"><div class="hv1-bar-fee" data-hv1-fee="${key}" data-employee="${encodeURIComponent(name)}">${fmtMoney(hv1ServerBarPeriodFee(key,name,s))}</div></div>`;
    }).join(''):'<div class="notice">No server with this shift is set yet.</div>'}
    <div class="hv1-bar-metrics">
      <div class="hv1-bar-metric"><span>Gross 0.6%</span><b data-hv1-gross="${key}">${fmtMoney(gross)}</b></div>
      <div class="hv1-bar-metric"><span>Server Count</span><b>${names.length}</b></div>
      <div class="hv1-bar-metric hv1-bar-received"><span>BAR TIP OUT RECEIVED</span><b data-hv1-received="${key}">${fmtMoney(received)}</b></div>
    </div>`;
}

function hv1UpdateBarLive(key,name,value){
  const state=hv1Load(); hv1EnsureBarState(state);
  state.bar[key].entries[name]=String(value??"");
  state.barManual ||= {}; state.barManual[name] ||= {}; state.barManual[name][key]=true;
  hv1SyncBarEntryToServerDraft(state,key,name,value);
  hv1ApplyBarAutomation(state);
  localStorage.setItem(hv1Key(),JSON.stringify(state));
  hv1CloudSave(JSON.parse(JSON.stringify(state))).catch(()=>{});

  document.querySelectorAll('[data-hv1-fee]').forEach(el=>{
    let emp="";try{emp=decodeURIComponent(el.dataset.employee||"")}catch(e){emp=el.dataset.employee||""}
    if(emp)el.textContent=fmtMoney(hv1ServerBarPeriodFee(el.dataset.hv1Fee,emp,state));
  });
  for(const k of ["AM","2PM_4PM","PM"]){
    const grossEl=document.querySelector(`[data-hv1-gross="${k}"]`);
    const recEl=document.querySelector(`[data-hv1-received="${k}"]`);
    if(grossEl)grossEl.textContent=fmtMoney(hv1BarGross(k,state));
    if(recEl)recEl.textContent=fmtMoney(hv1BarReceived(k,state));
  }
  hv1RenderBarSummaryOnly(state);
}

function hv1RenderBarSummaryOnly(state=hv1Load()){
  const host=$("hv1BarServerTotals"); if(!host)return;
  const allServers=[...new Set(["AM","2PM_4PM","PM"].flatMap(k=>hv1ServerNamesForCheckpoint(k,state)))].sort((a,b)=>a.localeCompare(b));
  host.innerHTML=`<h4>Server Bar Tip Out Summary</h4>
    <div class="hv1-bar-total-row head"><div>Server</div><div>AM Fee</div><div>2–4 Fee</div><div>PM Fee</div><div>Total Bar Tip Out</div></div>
    ${allServers.map(name=>{
      const f=hv1ServerBarFees(name,state);
      const am=f.amFee,p24=f.fee24,pm=f.pmFee;
      return `<div class="hv1-bar-total-row"><b>${esc(name)}</b><span>${fmtMoney(am)}</span><span>${fmtMoney(p24)}</span><span>${fmtMoney(pm)}</span><b>${fmtMoney(am+p24+pm)}</b></div>`;
    }).join("")||'<div class="notice">No server bar entries yet.</div>'}`;
}

function hv1RenderBarCenter(){
  const s=hv1Load();hv1EnsureBarState(s);
  if($('hv1BarAM'))$('hv1BarAM').innerHTML=hv1BarCardHtml('AM',s);
  if($('hv1Bar24'))$('hv1Bar24').innerHTML=hv1BarCardHtml('2PM_4PM',s);
  if($('hv1BarPM'))$('hv1BarPM').innerHTML=hv1BarCardHtml('PM',s);

  hv1RenderBarSummaryOnly(s);

  document.querySelectorAll('[data-hv1-bar-gt]').forEach(inp=>{
    inp.addEventListener('focus',()=>{ if(String(inp.value||'').trim()==='0') setTimeout(()=>inp.select(),0); });
    inp.addEventListener('input',()=>{
      const key=inp.dataset.hv1BarGt;let name='';try{name=decodeURIComponent(inp.dataset.employee||'')}catch(e){name=inp.dataset.employee||''}
      hv1UpdateBarLive(key,name,inp.value);
    });
  });
  document.querySelectorAll('[data-hv1-bar-excluded]').forEach(box=>box.addEventListener('change',()=>{
    let name='';try{name=decodeURIComponent(box.dataset.employee||'')}catch(e){return}
    hv1SetBarExcluded(box.dataset.hv1BarExcluded,name,box.checked);
  }));
  document.querySelectorAll('[data-hv1-bar-bartender]').forEach(sel=>sel.addEventListener('change',()=>{
    const state=hv1Load();hv1EnsureBarState(state);
    state.bar[sel.dataset.hv1BarBartender].bartender=sel.value||'';
    hv1ApplyBarAutomation(state);
    localStorage.setItem(hv1Key(),JSON.stringify(state));
    hv1CloudSave(JSON.parse(JSON.stringify(state))).catch(()=>{});
    hv1RenderBarCenter();
  }));
}
function hv1ApplyBarAutomation(s){
  const bar=hv1EnsureBarState(s);
  s.drafts=s.drafts||{};

  // Server side: total Bar Tip Out = sum of cumulative checkpoint differences.
  for(const name of s.team||[]){
    const d=s.drafts[name]||hv1BlankDraft(name);
    if(hv1DraftRole(d)==='bartender')continue;
    s.drafts[name]=d;
    hv1SyncBarSalesToDraft(s,name);
    hv1SyncLongBusserDraft(s,name);
    if(hv1DraftShift(d)==='LONG' && !s.barManual?.[name]?.AM)delete bar.AM.entries[name];
    const {amGT,gt24,pmGT,amFee,fee24,pmFee,totalFee,valid24,validPM}=hv1ServerBarFees(name,s);
    d.barAuto={amGT,gt24,pmGT,amFee,fee24,pmFee,totalFee,valid24,validPM,updatedAt:Date.now()};
    d.values=d.values||{};d.entered=d.entered||{};

    // Auto-suggest the checkbox only until the manager has explicitly changed it.
    // Once the manager unchecks it, BAR automation must NOT force it back on.
    if(!d.entered.hAmBar) d.values.hAmBar=(amGT>0 || (hv1DraftShift(d)==='AM' && gt24>0))?'yes':'no';
    if(!d.entered.hPmBar) d.values.hPmBar=(valid24||validPM)?'yes':'no';
    s.drafts[name]=d;
  }

  const receivedAM=hv1BarReceived('AM',s);
  const received24=hv1BarReceived('2PM_4PM',s);
  const receivedPM=hv1BarReceived('PM',s);

  // Bartender side: inject the existing Step-6 formula state, unchanged.
  const checkpointInfo=[
    ['AM',receivedAM,0,0],
    ['2PM_4PM',received24,receivedAM,0],
    ['PM',receivedPM,receivedAM,received24]
  ];
  for(const [key,received,prevAM,prev24] of checkpointInfo){
    const bartender=hv1BarRecipient(key,s);
    if(!bartender)continue;
    // Do not replace the AM manual form with an empty inherited checkpoint.
    if(key==='2PM_4PM'&&!bar[key].bartender&&received===0)continue;
    const d=s.drafts[bartender]||hv1BlankDraft(bartender);
    d.values=d.values||{};d.entered=d.entered||{};
    d.values.hPosition='Bartender';d.entered.hPosition=true;
    d.hourlyWizardState=d.hourlyWizardState||{};
    d.hourlyWizardState.position='Bartender';
    const state=d.howBartenderState||{
      checkpoint:key,
      AM:newHowBartenderCheckpoint(),
      '2PM_4PM':newHowBartenderCheckpoint(),
      PM:newHowBartenderCheckpoint()
    };
    state.checkpoint=key;
    for(const cp of ['AM','2PM_4PM','PM']) if(!state[cp])state[cp]=newHowBartenderCheckpoint();
    const serverNames=hv1ServerNamesForCheckpoint(key,s).filter(name=>!hv1BarExcluded(key,s,name));
    state[key].servers=Array.from({length:9},(_,i)=>{
      const name=serverNames[i]||'';
      return {name,grandTotal:name?String(bar[key].entries?.[name]||''):''};
    });
    const period=hv1BarCheckpointTotals(key,s);
    state[key].previousAM=key==='AM'?'':String(period.lessAM);
    state[key].previous24=key==='PM'?String(period.less24):'';
    // Retain the exact current-period result through Step 6, Calculate and Save.
    // Manual form edits invalidate this snapshot and use the existing manual formula.
    state[key].barCenterCalculation={
      ...period,
      inputKey:hv1BarFormKey(state[key]),
      serverEntries:serverNames.map((name,i)=>({slot:i+1,name,
        grandTotal:hv1BarNumber(bar[key].entries?.[name])}))
    };
    d.howBartenderState=state;
    d.barAutoReceived={checkpoint:key,received,previousAM:prevAM,previous24:prev24,updatedAt:Date.now()};
    d.savedAt=Date.now();
    s.drafts[bartender]=d;
  }
}

window.hv1OpenBarCenter=function(){
  const s=hv1Load();hv1EnsureBarState(s);hv1ApplyBarAutomation(s);hv1Save(s);
  $('hv1BoardBox')?.classList.add('hidden');$('hv1Setup')?.classList.add('hidden');$('hv1BarBox')?.classList.remove('hidden');
  hv1RenderBarCenter();
};
window.hv1BackFromBar=async function(){return window.hv1ReturnToTeamBoard();};
function hv1LegacyBackFromBar(){
  const s=hv1Load();hv1ApplyBarAutomation(s);hv1Save(s);
  $('hv1BarBox')?.classList.add('hidden');$('hv1BoardBox')?.classList.remove('hidden');hv1RenderCards();hv1RenderRecovery();
};
window.hv1SaveBarCenter=async function(){
  const s=hv1Load();
  hv1ApplyBarAutomation(s);
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  hv1RenderBarCenter();

  const cloudOk=await hv1CloudSave(JSON.parse(JSON.stringify(s)));
  if(cloudOk){
    alert('BAR calculations SAVED TO CLOUD and pushed to server/bartender cards.');
  }else{
    alert('BAR calculations are saved on this device, but cloud backup failed. Do not log out until Sync Now succeeds.');
  }
};


let hv1PasswordResolve=null;

function hv1RenderRecovery(){
  const box=$('hv1RecoveryBox'),text=$('hv1RecoveryText');
  if(!box)return;
  const s=hv1Load(),trash=s.trash;
  const isOwner=currentProfile?.role==='owner';
  if(!trash){
    box.classList.add('hidden');
    return;
  }
  const when=trash.clearedAt?new Date(Number(trash.clearedAt)).toLocaleString():'';
  const scope=trash.scope==='bar'?'BAR data':'TEAM BOARD data';
  if(text)text.textContent=`${scope} cleared by ${trash.clearedBy||'staff'}${when?` • ${when}`:''}. ${isOwner?'You can Undo or Delete Permanent.':'Only Owner can restore or permanently delete.'}`;
  box.classList.remove('hidden');
  box.querySelectorAll('.ownerOnly').forEach(el=>el.classList.toggle('hidden',!isOwner));
}

function hv1PasswordPrompt(title,text){
  return new Promise(resolve=>{
    hv1PasswordResolve=resolve;
    if($('hv1PasswordTitle'))$('hv1PasswordTitle').textContent=title||'Confirm Password';
    if($('hv1PasswordText'))$('hv1PasswordText').textContent=text||'Enter your current password.';
    if($('hv1ActionPassword'))$('hv1ActionPassword').value='';
    if($('hv1ActionShowPassword'))$('hv1ActionShowPassword').checked=false;
    if($('hv1ActionPassword'))$('hv1ActionPassword').type='password';
    if($('hv1PasswordError'))$('hv1PasswordError').textContent='';
    $('hv1PasswordModal')?.classList.remove('hidden');
    setTimeout(()=>$('hv1ActionPassword')?.focus(),50);
  });
}
window.hv1CancelPassword=function(){
  $('hv1PasswordModal')?.classList.add('hidden');
  const r=hv1PasswordResolve; hv1PasswordResolve=null;
  if(r)r(false);
};
window.hv1SubmitPassword=async function(){
  const pass=String($('hv1ActionPassword')?.value||'');
  if(!pass){if($('hv1PasswordError'))$('hv1PasswordError').textContent='Enter your password.';return;}
  try{
    if(!currentUser?.email)throw new Error('Password re-authentication is unavailable for this account.');
    const cred=EmailAuthProvider.credential(currentUser.email,pass);
    await reauthenticateWithCredential(currentUser,cred);
    $('hv1PasswordModal')?.classList.add('hidden');
    const r=hv1PasswordResolve; hv1PasswordResolve=null;
    if(r)r(true);
  }catch(e){
    console.error('Password confirmation:',e);
    if($('hv1PasswordError'))$('hv1PasswordError').textContent='Password incorrect. Try again.';
  }
};

async function hv1RequireStaffPassword(title,text){
  if(!['manager','owner'].includes(currentProfile?.role||'')){alert('Manager / Owner only.');return false;}
  return await hv1PasswordPrompt(title,text);
}

async function requireCurrentAccountPassword(title,text,allowedRoles=["manager","owner"]){
  const role=String(currentProfile?.role||"");
  if(!allowedRoles.includes(role)){alert("You are not authorized for this delete action.");return false;}
  return await hv1PasswordPrompt(
    title||"Confirm Delete",
    text||`Enter the password for the ${role.toUpperCase()} account currently logged in.`
  );
}
function deletedItemArchiveId(type,id){
  return `${String(type||"item").replace(/[^a-z0-9_-]/gi,"_")}_${String(id||Date.now()).replace(/[^a-z0-9_-]/gi,"_")}`;
}
async function archiveDeletedItem({itemType,itemId,label,date="",employeeName="",employeeUid="",snapshot={},sourceCollection=""}){
  if(!currentUser||!currentProfile)return "";
  const archiveId=deletedItemArchiveId(itemType,itemId);
  await setDoc(doc(db,"deletedItems",archiveId),{
    itemType:String(itemType||"item"),
    itemId:String(itemId||""),
    label:String(label||itemType||"Deleted item"),
    date:String(date||""),
    employeeName:String(employeeName||""),
    employeeUid:String(employeeUid||""),
    sourceCollection:String(sourceCollection||""),
    snapshot:JSON.parse(JSON.stringify(snapshot||{})),
    deletedByUid:currentUser.uid,
    deletedBy:currentProfile.displayName||currentProfile.username||"",
    deletedByRole:currentProfile.role||"",
    deletedAt:serverTimestamp()
  });
  return archiveId;
}

function hv1ClearBarAutomationFromDrafts(s){
  for(const d of Object.values(s.drafts||{})){
    if(!d)continue;
    delete d.barAuto;
    delete d.barAutoReceived;
    delete d.barSalesLinks;
    if(d.values){
      delete d.values.hAmBar;
      delete d.values.hPmBar;
    }
    if(d.entered){
      delete d.entered.hAmBar;
      delete d.entered.hPmBar;
      delete d.entered.bartender;
    }
    if(d.howBartenderState){
      delete d.howBartenderState;
    }
  }
}

window.hv1ClearAllTeam=async function(){
  const s=hv1Load();
  if(!(s.team||[]).length && !Object.keys(s.drafts||{}).length){alert('No Team Board data to clear.');return;}
  const ok=await hv1RequireStaffPassword(
    'Clear All Team Board',
    'Enter your current password. This moves the current Team Board, employee drafts, and BAR data to recoverable Recently Cleared. Final Daily Report rows are NOT deleted yet.'
  );
  if(!ok)return;

  const date=hv1DateValue();
  s.trash={
    scope:'team',
    date,
    clearedAt:Date.now(),
    clearedBy:currentProfile.displayName||currentProfile.username||'',
    clearedByUid:currentUser.uid,
    snapshot:{
      team:JSON.parse(JSON.stringify(s.team||[])),
      drafts:JSON.parse(JSON.stringify(s.drafts||{})),
      bar:JSON.parse(JSON.stringify(s.bar||{}))
    }
  };
  s.team=[]; s.drafts={}; s.bar={};
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  const cloudOk=await hv1CloudSave(JSON.parse(JSON.stringify(s)));
  $('hv1BoardBox')?.classList.add('hidden');
  $('hv1BarBox')?.classList.add('hidden');
  $('hv1Setup')?.classList.remove('hidden');
  hv1RenderRoster(); hv1RenderRecovery();
  alert(cloudOk?'Team Board cleared. Owner can Undo Clear All.':'Team Board cleared locally. Cloud backup failed — use Sync Now before logout.');
};

window.hv1ClearAllBar=async function(){
  const s=hv1Load(); hv1EnsureBarState(s);
  const hasBar=Object.values(s.bar||{}).some(x=>x?.bartender || Object.values(x?.entries||{}).some(v=>String(v||'').trim()!==''));
  if(!hasBar){alert('No BAR data to clear.');return;}
  const ok=await hv1RequireStaffPassword(
    'Clear All BAR',
    'Enter your current password. This clears BAR AM / BAR 2–4 / BAR PM bartender selections and Grand Totals, but keeps the Team Board.'
  );
  if(!ok)return;

  s.trash={
    scope:'bar',
    date:hv1DateValue(),
    clearedAt:Date.now(),
    clearedBy:currentProfile.displayName||currentProfile.username||'',
    clearedByUid:currentUser.uid,
    snapshot:{bar:JSON.parse(JSON.stringify(s.bar||{}))}
  };
  s.bar={};
  hv1ClearBarAutomationFromDrafts(s);
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  const cloudOk=await hv1CloudSave(JSON.parse(JSON.stringify(s)));
  hv1RenderBarCenter(); hv1RenderRecovery();
  alert(cloudOk?'BAR cleared. Owner can Undo Clear All.':'BAR cleared locally. Cloud backup failed — do not logout until Sync Now succeeds.');
};

window.hv1UndoClearAll=async function(){
  if(currentProfile?.role!=='owner'){alert('Owner only.');return;}
  const s=hv1Load(),trash=s.trash;
  if(!trash){alert('Nothing to undo.');return;}
  const ok=await hv1RequireStaffPassword(
    'Undo Clear All',
    `Restore the ${trash.scope==='bar'?'BAR data':'Team Board'} cleared by ${trash.clearedBy||'staff'}?`
  );
  if(!ok)return;

  if(trash.scope==='team'){
    s.team=JSON.parse(JSON.stringify(trash.snapshot?.team||[]));
    s.drafts=JSON.parse(JSON.stringify(trash.snapshot?.drafts||{}));
    s.bar=JSON.parse(JSON.stringify(trash.snapshot?.bar||{}));
  }else if(trash.scope==='bar'){
    s.bar=JSON.parse(JSON.stringify(trash.snapshot?.bar||{}));
    hv1ApplyBarAutomation(s);
  }
  s.trash=null;
  localStorage.setItem(hv1Key(),JSON.stringify(s));
  await hv1CloudSave(JSON.parse(JSON.stringify(s)));
  hv1RenderRoster();
  $('hv1Setup')?.classList.toggle('hidden',!!(s.team||[]).length);
  $('hv1BoardBox')?.classList.toggle('hidden',!(s.team||[]).length);
  $('hv1BarBox')?.classList.add('hidden');
  hv1RenderCards(); hv1RenderRecovery();
  alert('Clear All undone. Data restored.');
};

window.hv1PermanentDelete=async function(){
  if(currentProfile?.role!=='owner'){alert('Owner only.');return;}
  const s=hv1Load(),trash=s.trash;
  if(!trash){alert('Nothing in Recently Cleared.');return;}
  const scope=trash.scope||'team';
  const ok=await hv1RequireStaffPassword(
    'DELETE PERMANENT',
    scope==='team'
      ? `This permanently deletes the cleared Team Board AND all finalized Daily Report / hourlyReports rows for ${trash.date||hv1DateValue()}. This cannot be undone.`
      : 'This permanently deletes the cleared BAR backup. The Team Board and finalized reports remain.'
  );
  if(!ok)return;

  if(scope==='team'){
    const date=trash.date||hv1DateValue();
    const snap=await getDocs(query(collection(db,'hourlyReports'),where('date','==',date)));
    for(let i=0;i<snap.docs.length;i+=400){
      const batch=writeBatch(db);
      snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));
      await batch.commit();
    }
    s.trash=null;
    localStorage.removeItem(hv1Key());
    try{await deleteDoc(doc(db,'hourlyV1Batches',hv1CloudDocId(date)))}catch(e){console.warn('Delete V1 batch doc:',e)}
    $('hv1RecoveryBox')?.classList.add('hidden');
    $('hv1BoardBox')?.classList.add('hidden');
    $('hv1BarBox')?.classList.add('hidden');
    $('hv1Setup')?.classList.remove('hidden');
    hv1RenderRoster();
    alert(`${snap.docs.length} finalized report(s) and the cleared Team Board were permanently deleted.`);
  }else{
    s.trash=null;
    localStorage.setItem(hv1Key(),JSON.stringify(s));
    await hv1CloudSave(JSON.parse(JSON.stringify(s)));
    hv1RenderRecovery();
    alert('Cleared BAR backup permanently deleted.');
  }
};

window.hv1SyncNow=async function(){
  const ok=await hv1CloudSave(hv1Load());
  alert(ok?'Tip Calculation draft/team synced to Firebase.':'Cloud sync is blocked. Local draft is still saved on this device.');
};
window.hv1DeleteTeam=async function(){return window.hv1ClearAllTeam();};
window.hv1DeleteEmployee=async function(name){
  try{name=decodeURIComponent(name)}catch(e){}
  const date=$('hv1Date')?.value||todayLocal();
  const state=hv1Load();
  if(!(state.team||[]).includes(name)){
    alert(`${name} is not on this team.`);
    return;
  }

  const draft=state.drafts?.[name]||{};
  const hasProgress=!!draft.savedAt || Object.keys(draft.entered||{}).length>0;
  const role=String(currentProfile?.role||"").toLowerCase();
  const roleLabel=role==="owner"?"OWNER":"MANAGER";

  const ok=await hv1RequireStaffPassword(
    `Delete ${name}`,
    `${roleLabel} password required. Enter the password for the account currently logged in as ${currentProfile?.displayName||currentProfile?.username||roleLabel}. This removes ${name} from the Team Board for ${date}${hasProgress?" and removes the current draft/progress":""}. Finalized Daily Report / hourlyReports records are NOT deleted.`
  );
  if(!ok)return;

  try{
    await archiveDeletedItem({
      itemType:"team_employee",
      itemId:`${date}_${name}`,
      label:`Team Board • ${name} • ${date}`,
      date,
      employeeName:name,
      snapshot:{draft:JSON.parse(JSON.stringify(draft)),date,name},
      sourceCollection:"hourlyV1Batches"
    });
  }catch(e){alert("Delete cancelled: a recoverable backup could not be saved. "+(e.code||e.message));return;}

  state.removedEmployees=state.removedEmployees||{};
  state.removedEmployees[name]={
    date,
    removedAt:Date.now(),
    removedBy:currentProfile?.displayName||currentProfile?.username||"",
    removedByUid:currentUser?.uid||"",
    draft:JSON.parse(JSON.stringify(draft))
  };

  state.team=(state.team||[]).filter(n=>n!==name);
  if(state.drafts) delete state.drafts[name];
  hv1Save(state);
  await hv1CloudSave(JSON.parse(JSON.stringify(state)));

  if(hv1EditingEmployee===name) hv1EditingEmployee='';
  await loadDeletedItems();fzRenderRemovedCards();

  if(!state.team.length){
    $('hv1BoardBox')?.classList.add('hidden');
    $('hv1Setup')?.classList.remove('hidden');
    if($('hv1Cards')) $('hv1Cards').innerHTML='';
    hv1RenderRoster();
  }else{
    hv1RenderCards();
  }
};


function hv1DraftFromFinalizedReport(r,name,date){
  const d=hv1BlankDraft(name);
  d.date=date||r.date||hv1DateValue();
  d.values={}; d.entered={};
  const put=(k,v)=>{if(v===undefined||v===null)return;d.values[k]=String(v);d.entered[k]=true;};

  put("hDate",d.date); put("hEmployee",name); put("hPosition",r.position||"Server"); put("hShift",r.shift||"AM");
  put("hGrandTotal",r.grandTotal??0);
  if(["DOUBLE","LONG"].includes(String(r.shift||"").toUpperCase()))put("hTotalAM",r.totalAM??0);
  put("hPaidTip",r.paidTip??0); put("hCardFee",r.payCardTipFee??r.cardFee??0); put("hCashTip",r.cashTip??0); put("hMeal",r.meal??0);

  const hours={...r,...(r.hours||{})};
  const shift=String(r.shift||"").toUpperCase();
  if(shift==="DOUBLE"){
    put("hAmIn",hours.hourInAM||hours.amIn||""); put("hAmOut",hours.hourOutAM||hours.amOut||"");
    put("hPmIn",hours.hourInPM||hours.pmIn||""); put("hPmOut",hours.hourOutPM||hours.pmOut||"");
  }else{
    put("hIn",hours.hourIn||hours.hourInAM||hours.in||"");
    put("hOut",hours.hourOut||hours.hourOutAM||hours.out||"");
  }

  if(r.amBarSales!==undefined)put("hAmBar",r.amBarSales===true||String(r.amBarSales).toUpperCase()==="YES"?"yes":"no");
  if(r.pmBarSales!==undefined)put("hPmBar",r.pmBarSales===true||String(r.pmBarSales).toUpperCase()==="YES"?"yes":"no");

  d.hourlyWizardState={
    position:r.position||"Server",
    shift:r.shift||"AM",
    busserAM:String(r.busserAM||r.busserAMStatus||"WITHOUT").toUpperCase()==="WITH"?"WITH":"WITHOUT"
  };
  put("hBusserAM",d.hourlyWizardState.busserAM);

  d.hourlyReportId=r.id||"";
  d.sourceSubmissionId=r.sourceSubmissionId||"";
  d.page=7; d.savedAt=Date.now(); d.finalized=true; d.editHydratedFromFinalV13811=true; d.recoveredFromFinal=true;
  return d;
}

async function hv1FindFinalizedReport(name,date){
  let rows=(latestHourlyReports||[]).filter(r=>String(r.date||"")===date && String(r.employee||"")===name);
  if(!rows.length){
    try{
      const snap=await getDocs(query(collection(db,"hourlyReports"),where("date","==",date),limit(300)));
      rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>String(r.employee||"")===name);
    }catch(e){console.warn("Find finalized report:",e);}
  }
  rows.sort((a,b)=>(b.updatedAt?.seconds||b.createdAt?.seconds||0)-(a.updatedAt?.seconds||a.createdAt?.seconds||0));
  return rows[0]||null;
}

window.hv1RestoreEmployeeFinal=async function(name){
  try{name=decodeURIComponent(name)}catch(e){}
  const date=$('hv1Date')?.value||todayLocal();
  const role=String(currentProfile?.role||"").toLowerCase();
  const roleLabel=role==="owner"?"OWNER":"MANAGER";

  const ok=await hv1RequireStaffPassword(
    `Restore ${name}`,
    `${roleLabel} password required. This will replace the current Team Board draft for ${name} on ${date} with the latest FINALIZED report saved for that employee/date.`
  );
  if(!ok)return;

  let recoveredReport=await hv1FindFinalizedReport(name,date);

  if(!recoveredReport){alert(`No finalized report found for ${name} on ${date}.`);return;}

  const state=hv1Load();
  state.team=state.team||[]; state.drafts=state.drafts||{};
  if(!state.team.includes(name))state.team.push(name);
  state.drafts[name]=hv1DraftFromFinalizedReport(recoveredReport,name,date);
  hv1Save(state);
  await hv1CloudSave(JSON.parse(JSON.stringify(state)));
  hv1RenderRoster();
  $('hv1Setup')?.classList.add('hidden');
  $('hv1BoardBox')?.classList.remove('hidden');
  hv1RenderCards();

  alert(`${name} restored from ${date}. Grand Total: ${fmtMoney(recoveredReport.grandTotal||0)} | Paid Tip: ${fmtMoney(recoveredReport.paidTip||0)} | Cash Tip: ${fmtMoney(recoveredReport.cashTip||0)}`);
};

window.hv1DateChanged=async function(){hourlyV1Mode=true;$('hv1BarBox')?.classList.add('hidden');await hv1CloudRestore();hv1RenderRoster();const s=hv1Load();$('hv1Setup').classList.toggle('hidden',!!s.team?.length);$('hv1BoardBox').classList.toggle('hidden',!s.team?.length);if(s.team?.length)hv1RenderCards();hv1RenderRecovery()};

// V13.8.24-P16 reliable team-card click handling (desktop/tablet/mobile).
document.addEventListener("click",e=>{
  const restore=e.target.closest?.("[data-hv1-restore-employee]");
  if(restore){
    e.preventDefault(); e.stopPropagation();
    window.hv1RestoreEmployeeFinal(restore.dataset.hv1RestoreEmployee);
    return;
  }
  const del=e.target.closest?.("[data-hv1-delete-employee]");
  if(del){
    e.preventDefault(); e.stopPropagation();
    window.hv1DeleteEmployee(del.dataset.hv1DeleteEmployee);
    return;
  }
  const card=e.target.closest?.("[data-hv1-open-employee]");
  if(card){
    e.preventDefault();
    window.hv1OpenEmployee(card.dataset.hv1OpenEmployee);
  }
});

let hv1OpenRequest=0;
window.hv1OpenEmployee=async function(name){
  if(hourlyFinalSaveInProgress){alert("Final report is saving. Please wait.");return;}
  clearTimeout(hv1AutosaveTimer);
  try{name=decodeURIComponent(name)}catch(e){}
  const request=++hv1OpenRequest,date=hv1DateValue();
  hv1LoadingEmployee=true;
  hv1EditingEmployee=name;
  currentHourlyReportId=null;currentHourlySubmissionId=null;
  document.body.classList.add('hourly-v1-mode','hourly-v1-editing');
  document.querySelectorAll('.staffPanel').forEach(x=>x.classList.add('hidden'));
  $('hourlyV1Workspace')?.classList.add('hidden');
  $('hourly')?.classList.remove('hidden');

  try{
    await hv1HydrateDraftFromFinalReport(name);
    if(request!==hv1OpenRequest || name!==hv1EditingEmployee || date!==hv1DateValue())return;
    hv1ApplyDraft(name);
    requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
  }finally{if(request===hv1OpenRequest)hv1LoadingEmployee=false;}
};
window.hv1BackToBoard=function(){return window.hv1SavePage();};
function hv1LegacyBackToBoard(){
  try{captureHourlyWizard()}catch(e){}
  hv1CapturePage(false);
  document.body.classList.remove('hourly-v1-editing');
  $('hourly')?.classList.add('hidden');
  $('hourlyV1Workspace')?.classList.remove('hidden');
  hv1RenderCards();
  requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
};
window.hv1SkipPage=function(){hv1CapturePage(true);if(hourlyWizardStep<7)hourlyWizardStep++;renderHourlyWizard();setTimeout(hv1PatchWizard,0)};
window.hv1SavePage=async function(){
  if(hv1LoadingEmployee){alert("Employee report is loading. Please wait.");return;}
  if(hourlyFinalSaveInProgress){alert("Final report is saving. Please wait.");return;}
  clearTimeout(hv1AutosaveTimer);
  try{captureHourlyWizard()}catch(e){}
  hv1CapturePage(false);
  const saved=await hv1CloudSave(JSON.parse(JSON.stringify(hv1Load())));
  if(!saved){alert("Saved on this device. Cloud sync failed; your draft remains open.");return;}
  hv1EditingEmployee='';
  document.body.classList.remove('hourly-v1-editing');
  document.body.classList.add('hourly-v1-mode');
  $('hourly')?.classList.add('hidden');
  $('hv1Setup')?.classList.add('hidden');
  $('hv1BoardBox')?.classList.remove('hidden');
  $('hourlyV1Workspace')?.classList.remove('hidden');
  hv1RenderCards();
  window.scrollTo(0,0);
};

let hv1SmallReportHome=null;
function hv1MoveSmallReportIntoV1(){
  const report=$('smallReport'),mount=$('hv1SmallReportMount');
  if(!report||!mount)return;
  if(!hv1SmallReportHome)hv1SmallReportHome={parent:report.parentNode,next:report.nextSibling};
  if(report.parentNode!==mount)mount.appendChild(report);
  report.classList.remove('hidden');
}
function hv1RestoreSmallReportHome(){
  const report=$('smallReport');
  if(!report||!hv1SmallReportHome?.parent)return;
  if(report.parentNode!==hv1SmallReportHome.parent){
    if(hv1SmallReportHome.next&&hv1SmallReportHome.next.parentNode===hv1SmallReportHome.parent)hv1SmallReportHome.parent.insertBefore(report,hv1SmallReportHome.next);
    else hv1SmallReportHome.parent.appendChild(report);
  }
}
window.hv1OpenSmallReport=function(){
  hourlyV1Mode=true;
  document.body.classList.add('hourly-v1-mode','hourly-v1-small-report');
  document.body.classList.remove('hourly-v1-editing','hourly-workspace-mode');
  $('hourly')?.classList.add('hidden');
  $('hourlyV1Workspace')?.classList.remove('hidden');
  $('hv1Setup')?.classList.add('hidden');
  $('hv1BoardBox')?.classList.add('hidden');
  $('hv1BarBox')?.classList.add('hidden');
  $('hv1SmallReportBox')?.classList.remove('hidden');
  hv1MoveSmallReportIntoV1();
  renderSmallReport();
  window.scrollTo(0,0);
};
window.hv1CloseSmallReport=function(){
  document.body.classList.remove('hourly-v1-small-report');
  $('smallReport')?.classList.add('hidden');
  hv1RestoreSmallReportHome();
  $('hv1SmallReportBox')?.classList.add('hidden');
  const s=hv1Load();
  $('hv1Setup')?.classList.toggle('hidden',!!(s.team||[]).length);
  $('hv1BoardBox')?.classList.toggle('hidden',!(s.team||[]).length);
  if((s.team||[]).length)hv1RenderCards();
  hv1RenderRecovery();
  window.scrollTo(0,0);
};
window.hv1OpenBarCenterFromReport=function(){
  $('smallReport')?.classList.add('hidden');
  hv1RestoreSmallReportHome();
  $('hv1SmallReportBox')?.classList.add('hidden');
  document.body.classList.remove('hourly-v1-small-report');
  window.hv1OpenBarCenter();
};

function hv1MissingFields(){const d=hv1Draft(hv1EditingEmployee),e=d.entered||{},v=d.values||{},missing=[];if(!v.hPosition)missing.push('Position');if(!v.hShift)missing.push('Shift');const sh=v.hShift||hourlyWizardState.shift;if(sh==='DOUBLE'){['hAmIn','hAmOut','hPmIn','hPmOut'].forEach(k=>{if(!e[k])missing.push(k.replace('h',''))})}else{if(!e.hIn)missing.push('Clock In');if(!e.hOut)missing.push('Clock Out')}['hGrandTotal','hPaidTip','hCardFee','hCashTip','hMeal'].forEach(k=>{if(!e[k])missing.push(k.replace('h',''))});return missing}
async function hv1MarkFinal(reportId="",sourceSubmissionId="",employee=hv1EditingEmployee,date=hv1DateValue()){
  if(!employee || !reportId)return false;
  clearTimeout(hv1AutosaveTimer);
  const key=HV1_STORAGE_PREFIX+date;
  let s;try{s=JSON.parse(localStorage.getItem(key)||'{"team":[],"drafts":{}}')}catch{s={team:[],drafts:{}}}
  s.drafts ||= {};
  const d=s.drafts[employee]||{...hv1BlankDraft(employee),date};
  Object.assign(d,{finalized:true,hourlyReportId:reportId,sourceSubmissionId:sourceSubmissionId||'',finalizedAt:Date.now(),savedAt:Date.now()});
  s.drafts[employee]=d;
  localStorage.setItem(key,JSON.stringify(s));
  const cloudOk=await hv1CloudSave(JSON.parse(JSON.stringify(s)),date);
  if(date===hv1DateValue() && employee===hv1EditingEmployee){
    hv1EditingEmployee='';
    document.body.classList.remove('hourly-v1-editing','hourly-v1-small-report');
    document.body.classList.add('hourly-v1-mode');
    $('smallReport')?.classList.add('hidden');$('hourly')?.classList.add('hidden');
    $('hv1BarBox')?.classList.add('hidden');$('hv1SmallReportBox')?.classList.add('hidden');
    $('hv1BoardBox')?.classList.remove('hidden');$('hourlyV1Workspace')?.classList.remove('hidden');
    hv1RenderCards();window.scrollTo(0,0);
  }
  return cloudOk;
}

const HV1_REMEMBER_KEY='fz_hv1_remember',HV1_USERNAME_KEY='fz_hv1_username';
function loadHourlyV1Remember(){try{const r=localStorage.getItem(HV1_REMEMBER_KEY)==='1';if($('hourlyV1RememberMe'))$('hourlyV1RememberMe').checked=r;if(r&&$('hourlyV1Username'))$('hourlyV1Username').value=localStorage.getItem(HV1_USERNAME_KEY)||''}catch(e){}}
window.loginHourlyV1Workspace=async function(){fzLoginRole="hourlyv1";ensureRealtimeAlertAudio();await authSecurityReady;const username=String($('hourlyV1Username')?.value||'').trim(),password=String($('hourlyV1Password')?.value||'');if(!username||!password){loginMsg('Enter Manager / Owner username and password.');return}const remember=!!$('hourlyV1RememberMe')?.checked;try{await setPersistence(auth,browserSessionPersistence)}catch(e){}try{if(remember){localStorage.setItem(HV1_REMEMBER_KEY,'1');localStorage.setItem(HV1_USERNAME_KEY,username)}else{localStorage.removeItem(HV1_REMEMBER_KEY);localStorage.removeItem(HV1_USERNAME_KEY)}}catch(e){}hourlyV1Requested=true;hourlyWorkspaceRequested=false;try{loginMsg('Signing in...');await es18PasswordSignIn(emailFor(username),password)}catch(e){hourlyV1Requested=false;loginMsg(`Login failed: ${e.code||'invalid-login'}`)}};
setTimeout(loadHourlyV1Remember,0);

let hourlyWorkspaceRequested=false;
let hourlyWorkspaceMode=false;

function applyHourlyWorkspaceMode(on){
  hourlyWorkspaceMode=!!on;
  document.body.classList.toggle("hourly-workspace-mode",hourlyWorkspaceMode);
  $("hourlyWorkspaceNav")?.classList.toggle("hidden",!hourlyWorkspaceMode);
}

window.openHourlyWorkspacePanel=function(name){
  // V13.8.24-P16A: Hourly V01 is no longer an isolated sub-app.
  // It opens the complete Manager/Owner dashboard and defaults to Tip Calculation.
  hourlyWorkspaceRequested=false;
  applyHourlyWorkspaceMode(false);
  document.querySelectorAll("[data-stab]").forEach(b=>b.classList.remove("hidden"));
  document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",currentProfile?.role!=="owner"));
  openStaffTab(name==="smallReport"?"hourly":(name||"hourly"));
};

window.leaveHourlyWorkspace=function(){
  hourlyWorkspaceRequested=false;
  applyHourlyWorkspaceMode(false);
  document.querySelectorAll("[data-stab]").forEach(b=>b.classList.remove("hidden"));
  document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",currentProfile?.role!=="owner"));
  openStaffTab("hourly");
};


const HOURLY_REMEMBER_KEY="fz_hourly_remember";
const HOURLY_USERNAME_KEY="fz_hourly_username";

function loadHourlyRememberPreference(){
  try{
    const remember=localStorage.getItem(HOURLY_REMEMBER_KEY)==="1";
    if($("hourlyRememberMe")) $("hourlyRememberMe").checked=remember;
    if(remember && $("hourlyUsername")){
      $("hourlyUsername").value=localStorage.getItem(HOURLY_USERNAME_KEY)||"";
    }
  }catch(e){}
}

async function applyHourlyRememberPreference(){
  const remember=!!$("hourlyRememberMe")?.checked;
  try{
    await setPersistence(auth,browserSessionPersistence);
  }catch(e){console.warn("Hourly auth persistence:",e);}
  try{
    if(remember){
      localStorage.setItem(HOURLY_REMEMBER_KEY,"1");
      localStorage.setItem(HOURLY_USERNAME_KEY,String($("hourlyUsername")?.value||"").trim());
    }else{
      localStorage.removeItem(HOURLY_REMEMBER_KEY);
      localStorage.removeItem(HOURLY_USERNAME_KEY);
    }
  }catch(e){}
}

window.loginHourlyWorkspace=function(){ setLoginMode("staff"); loginMsg("Hourly V01 was removed. Use Manager / Owner / Cashier or Tip Calculation."); };


const STAFF_REMEMBER_KEY="fz_staff_remember";
const STAFF_USERNAME_KEY="fz_staff_username";

function loadStaffRememberPreference(){
  try{
    const remember=localStorage.getItem(STAFF_REMEMBER_KEY)==="1";
    if($("staffRememberMe")) $("staffRememberMe").checked=remember;
    if(remember && $("staffUsername")){
      $("staffUsername").value=localStorage.getItem(STAFF_USERNAME_KEY)||"";
    }
  }catch(e){}
}

async function applyStaffRememberPreference(){
  const remember=!!$("staffRememberMe")?.checked;
  try{
    await setPersistence(auth,browserSessionPersistence);
  }catch(e){
    console.warn("Auth persistence:",e);
  }

  try{
    if(remember){
      localStorage.setItem(STAFF_REMEMBER_KEY,"1");
      localStorage.setItem(STAFF_USERNAME_KEY,String($("staffUsername")?.value||"").trim());
    }else{
      localStorage.removeItem(STAFF_REMEMBER_KEY);
      localStorage.removeItem(STAFF_USERNAME_KEY);
    }
  }catch(e){}
}


window.openHostCashierLogin=function(){
  hostCashierRequested=false;
  setLoginMode("hostcashier");
  try{
    const remember=localStorage.getItem("fzHostCashierRemember") === "1";
    if($("hostCashierRememberMe")) $("hostCashierRememberMe").checked=remember;
    if(remember && $("hostCashierUsername")) $("hostCashierUsername").value=localStorage.getItem("fzHostCashierUsername")||"";
  }catch(e){}
};

window.loginHostCashierWorkspace=async function(){
  
  ensureRealtimeAlertAudio();
  await authSecurityReady;
  const username=String($("hostCashierUsername")?.value||"").trim();
  const password=String($("hostCashierPassword")?.value||"");
  if(!username||!password){loginMsg("Enter Manager / Owner username and password.");return;}
  const remember=!!$("hostCashierRememberMe")?.checked;
  try{await setPersistence(auth,browserSessionPersistence)}catch(e){}
  try{
    if(remember){localStorage.setItem("fzHostCashierRemember","1");localStorage.setItem("fzHostCashierUsername",username)}
    else{localStorage.removeItem("fzHostCashierRemember");localStorage.removeItem("fzHostCashierUsername")}
  }catch(e){}
  fzLoginRole="hostcashier";
  hostCashierRequested=true;
  try{
    loginMsg("Signing in...");
    await es18PasswordSignIn(emailFor(username),password);
  }catch(e){
    hostCashierRequested=false;
    loginMsg(`Login failed: ${e.code||"invalid-login"}`);
  }
};

window.loginStaff = async function(){
  
  ensureRealtimeAlertAudio();
  await authSecurityReady;
  await applyStaffRememberPreference();
  const username = $("staffUsername").value.trim();
  const password = $("staffPassword").value;
  if(!username || !password){ loginMsg("Enter username and password."); return; }
  try{
    loginMsg("Signing in...");
    await es18PasswordSignIn(emailFor(username), password);
  }catch(e){
    console.error("Staff login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};

function clearSharedDeviceLoginFields(){
  try{
    if($("fzUnifiedSecret"))$("fzUnifiedSecret").value="";
    if($("fzUnifiedStaffName") && !$("fzUnifiedRemember")?.checked)$("fzUnifiedStaffName").value="";
    window.hostCashierCloseWorkspace?.();
    if($("employeePin")) $("employeePin").value="";
    if($("staffPassword")) $("staffPassword").value="";
    if($("hostCashierPassword")) $("hostCashierPassword").value="";
    if($("hourlyPassword")) $("hourlyPassword").value="";
    if($("hourlyUsername") && !$("hourlyRememberMe")?.checked) $("hourlyUsername").value="";
    if($("signupPin")) $("signupPin").value="";
    if($("signupPin2")) $("signupPin2").value="";
    if($("signupPhone")) $("signupPhone").value="";
    if($("employeeUsername")) $("employeeUsername").selectedIndex=0;
    if($("employeeManualUsername")) $("employeeManualUsername").value="";
    if($("staffUsername") && !$("staffRememberMe")?.checked) $("staffUsername").value="";
    if($("hostCashierUsername") && !$("hostCashierRememberMe")?.checked) $("hostCashierUsername").value="";
    if($("signupName")) $("signupName").selectedIndex=0;
    if($("signupPanel")) $("signupPanel").classList.add("hidden");
    loginMsg("");
  }catch(e){ console.warn("Clear shared-device login fields:",e); }
}

window.logout = async function(){
  es18LoginAttemptRole=null;
  window.es18ClosePrintPreview?.();
  window.es18ClosePasskeys?.();
  try{localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);}catch(e){}

  ownerTableSession=null;++ownerTableRequest;$("ownerTableBody").innerHTML="";if($('ownerTableGroups'))$('ownerTableGroups').innerHTML='';
  hv1RestoreSmallReportHome();
  hourlyWorkspaceRequested=false;hourlyV1Requested=false;hostCashierRequested=false;hourlyV1Mode=false;hv1EditingEmployee="";document.body.classList.remove("hourly-v1-mode","hourly-v1-editing","hourly-v1-small-report");
  applyHourlyWorkspaceMode(false);
  try{
    clearSharedDeviceLoginFields();
    sessionStorage.clear();
    // Never keep an employee draft on a shared device after explicit logout.
    localStorage.removeItem(employeeDraftKey());
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

let loginWelcomeAudioCtx=null;
let loginWelcomePlaying=false;


function primeLoginWelcomeAudio(){ return;
  // Must run inside the actual Login click / Enter gesture.
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(AC){
      loginWelcomeAudioCtx=loginWelcomeAudioCtx||new AC();
      if(loginWelcomeAudioCtx.state==="suspended")loginWelcomeAudioCtx.resume().catch(()=>{});
      const osc=loginWelcomeAudioCtx.createOscillator();
      const g=loginWelcomeAudioCtx.createGain();
      g.gain.value=0.00001;
      osc.connect(g);g.connect(loginWelcomeAudioCtx.destination);
      osc.start();
      osc.stop(loginWelcomeAudioCtx.currentTime+0.02);
    }
  }catch(e){console.warn("Prime login audio:",e);}
  try{
    if("speechSynthesis" in window){
      const u=new SpeechSynthesisUtterance(" ");
      u.volume=0.01;u.rate=10;
      window.speechSynthesis.speak(u);
      setTimeout(()=>window.speechSynthesis.cancel(),40);
    }
  }catch(e){console.warn("Prime login speech:",e);}
}

function playLoginWelcomeMusic(){ return;
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return;
    loginWelcomeAudioCtx=loginWelcomeAudioCtx||new AC();
    const ctx=loginWelcomeAudioCtx;
    if(ctx.state==="suspended")ctx.resume().catch(()=>{});

    const master=ctx.createGain();
    master.gain.setValueAtTime(0.0001,ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.20,ctx.currentTime+0.06);
    master.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+3.7);
    master.connect(ctx.destination);

    // Soft futuristic major arpeggio: C5 E5 G5 B5 E6.
    const notes=[
      {f:523.25,t:0.00,d:0.75},
      {f:659.25,t:0.34,d:0.78},
      {f:783.99,t:0.68,d:0.82},
      {f:987.77,t:1.03,d:0.90},
      {f:1318.51,t:1.42,d:1.20}
    ];

    notes.forEach((n,i)=>{
      const osc=ctx.createOscillator();
      const gain=ctx.createGain();
      const filter=ctx.createBiquadFilter();
      osc.type=i<3?"sine":"triangle";
      osc.frequency.setValueAtTime(n.f,ctx.currentTime+n.t);
      filter.type="lowpass";
      filter.frequency.setValueAtTime(2600,ctx.currentTime+n.t);
      gain.gain.setValueAtTime(0.0001,ctx.currentTime+n.t);
      gain.gain.exponentialRampToValueAtTime(i===4?0.11:0.075,ctx.currentTime+n.t+0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+n.t+n.d);
      osc.connect(filter);filter.connect(gain);gain.connect(master);
      osc.start(ctx.currentTime+n.t);
      osc.stop(ctx.currentTime+n.t+n.d+0.05);
    });

    // Gentle shimmer pad under the voice.
    [261.63,329.63,392.00].forEach((f,i)=>{
      const osc=ctx.createOscillator(),g=ctx.createGain();
      osc.type="sine";
      osc.frequency.value=f;
      g.gain.setValueAtTime(0.0001,ctx.currentTime+0.15);
      g.gain.exponentialRampToValueAtTime(0.025,ctx.currentTime+0.55+i*0.05);
      g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+3.5);
      osc.connect(g);g.connect(master);
      osc.start(ctx.currentTime+0.15);
      osc.stop(ctx.currentTime+3.55);
    });
  }catch(e){
    console.warn("Login welcome music:",e);
  }
}

function speakLoginWelcome(){ return;
  if(!("speechSynthesis" in window))return;
  try{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance("Welcome to Fred Zhang Just Tip Calculator");
    const voices=window.speechSynthesis.getVoices()||[];
    const english=voices.filter(v=>/^en[-_]/i.test(v.lang||""));
    const preferred=["Samantha","Ava","Jenny","Aria","Emma","Victoria","Zira","Joanna","Karen"];
    let voice=null;
    for(const p of preferred){
      voice=english.find(v=>String(v.name||"").toLowerCase().includes(p.toLowerCase()));
      if(voice)break;
    }
    if(!voice)voice=english[0]||voices[0]||null;
    if(voice)u.voice=voice;
    u.lang=voice?.lang||"en-US";
    u.rate=0.90;
    u.pitch=1.04;
    u.volume=1;
    window.speechSynthesis.speak(u);
  }catch(e){
    console.warn("Login welcome voice:",e);
  }
}

window.playSuccessfulLoginWelcome=function(options={}){ return;
  if(loginWelcomePlaying)return;
  loginWelcomePlaying=true;
  try{if(loginWelcomeAudioCtx?.state==="suspended")loginWelcomeAudioCtx.resume().catch(()=>{});}catch(e){}
  playLoginWelcomeMusic();
  setTimeout(speakLoginWelcome,180);
  setTimeout(()=>{loginWelcomePlaying=false;},4300);
};

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
  // Old Tip Report sticky actions are disabled in Employee Check Tip-only mode.
  $("employeeBottom")?.classList.add("hidden");

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
    applyEmployeeWorkProfile();
    listenEmployee();
    listenEmployeeHistoricalReports();
    setEmployeeTab("reports");
  }else if(cashier){
    listenTipCheckSheets();
    document.querySelectorAll("[data-stab]").forEach(b=>b.classList.toggle("hidden",!["tipCheck","setup"].includes(b.dataset.stab)));
    document.querySelector('[data-stab="tipCheck"]')?.click();
  }else{
    document.querySelectorAll("[data-stab]").forEach(b=>b.classList.remove("hidden"));
    document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",!owner));
    listenStaff();
    document.querySelector('[data-stab="approvals"]')?.click();
  }
}
let es18AuthSequence=0;
async function es18HandleAuthUser(user){
  const sequence=++es18AuthSequence;
  await authSecurityReady;
  if(!user&&auth.currentUser)user=auth.currentUser;
  // PassPRNT can fire the listener once with the pre-hydration null value.
  // After authSecurityReady finishes, always prefer the CURRENT hydrated user
  // for this one-time print return instead of treating that stale null as logout.
  if(passPrntReturnBridge && auth.currentUser && !auth.currentUser.isAnonymous){
    user=auth.currentUser;
  }
  // If this callback came from a stale persisted session that was just cleared, ignore it.
  if(user && (!auth.currentUser || user.uid!==auth.currentUser.uid)) return;
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
    if(sequence!==es18AuthSequence || auth.currentUser?.uid!==user.uid)return;
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
    // PassPRNT callback must validate against the role that actually launched PRINT.
    // The unified login UI resets its selector to Employee on DOMContentLoaded; using
    // that temporary/default UI value here would incorrectly sign out a restored
    // Manager/Owner immediately after returning from Star PassPRNT.
    // The default Employee selector is NOT an authorization requirement on
    // refresh. Enforce a chosen role only for an explicit sign-in attempt.
    const selected=es18LoginAttemptRole || (passPrntReturnBridge?.dailyReport?String(passPrntReturnBridge.role||''):'');
    const role=String(profile.role||"");
    if((["manager","owner","employee","cashier"].includes(selected) && role!==selected) || (selected==="hostcashier" && !["manager","owner"].includes(role))){
      await signOut(auth);
      loginMsg(selected==="hostcashier"?"Host / Cashier Tip access is Manager / Owner only.":`This account is ${role.toUpperCase()}. Select its matching login role.`);
      return;
    }
    currentUser=user;
    currentProfile=profile;
    es18LoginAttemptRole=null;
    window.es18UpdateBiometricUi?.();
    $('fz18RetrySession')?.classList.add('hidden');
    loginMsg("");

    if((hourlyWorkspaceRequested||hourlyV1Requested) && !["manager","owner"].includes(String(profile.role||""))){
      hourlyWorkspaceRequested=false;hourlyV1Requested=false;
      loginMsg("Hourly Adjustment access is Manager / Owner only.");
      await signOut(auth);
      return;
    }

    showApp();
    // V13.8.24-P16: every successful authenticated login gets a short music sting + voice welcome.
    // A PassPRNT callback is not a new login, so do not replay the welcome.
    if(!passPrntReturnBridge)setTimeout(()=>window.playSuccessfulLoginWelcome?.(),80);

    if(hostCashierRequested){
      hourlyWorkspaceRequested=false;
      hourlyV1Requested=false;
      hostCashierRequested=false;
      applyHourlyWorkspaceMode(false);
      document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
      $("staffArea")?.classList.remove("hidden");
      $("hostCashierTip")?.classList.remove("hidden");
      setTimeout(()=>window.hostCashierOpenWorkspace?.(),100);
    }else if(hourlyV1Requested){
      hourlyWorkspaceRequested=false;
      applyHourlyWorkspaceMode(false);
      setTimeout(hv1Enter,100);
    }else if(hourlyWorkspaceRequested){
      // Hourly V01 is the FULL Manager/Owner dashboard again.
      // Keep Approval, Manager Review, Users, History, Deleted/Undo, Setup, etc.
      applyHourlyWorkspaceMode(false);
      hourlyWorkspaceRequested=false;
      document.querySelectorAll("[data-stab]").forEach(b=>b.classList.remove("hidden"));
      document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",currentProfile?.role!=="owner"));
      setTimeout(()=>openStaffTab("hourly"),80);
    }else{
      applyHourlyWorkspaceMode(false);
    }
    if(passPrntReturnBridge?.dailyReport){
      restoreSmallReportAfterPassPrnt(passPrntReturnBridge);
      // Only after the authenticated app is back on screen do we restore the
      // tab-scoped session policy. This keeps the user logged in
      // through the PassPRNT callback without changing normal login/logout flow.
      setTimeout(async()=>{
        try{
          if(auth.currentUser && !auth.currentUser.isAnonymous){
            await setPersistence(auth,browserSessionPersistence);
          }
        }catch(e){console.warn("PassPRNT persistence cleanup:",e);}
        try{localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);}catch(e){}
        cleanPassPrntCallbackUrl();
      },5000);
    }
  }catch(e){
    console.error("Profile load:",e);
    // A network/Firestore interruption is not an instruction to log out.
    // Unknown profiles remain hidden until a successful retry; auth is retained.
    if(sequence!==es18AuthSequence || auth.currentUser?.uid!==user.uid)return;
    loginMsg('Session retained. Account connection interrupted. Tap Retry connection.');
    $('fz18RetrySession')?.classList.remove('hidden');
  }
}
onAuthStateChanged(auth,es18HandleAuthUser);
window.es18RetrySession=()=>es18HandleAuthUser(auth.currentUser);
window.addEventListener('online',()=>{if(auth.currentUser&&!currentProfile)window.es18RetrySession();});

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
  }else if(isEarlyShift(shift)){
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
  const target=name==="shift"?"shift":"reports";
  $("employeeShiftContent")?.classList.toggle("hidden",target!=="shift");
  $("employeeReportsContent")?.classList.toggle("hidden",target!=="reports");
  $("employeeTipCheckContent")?.classList.add("hidden");
  $("employeeBottom")?.classList.add("hidden");
  document.querySelectorAll("[data-etab]").forEach(b=>b.classList.toggle("on",b.dataset.etab===target));
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
  const target=name==="shift"?"shift":"reports";
  $("employeeShiftContent")?.classList.toggle("hidden",target!=="shift");
  $("employeeReportsContent")?.classList.toggle("hidden",target!=="reports");
  $("employeeTipCheckContent")?.classList.add("hidden");
  $("employeeBottom")?.classList.add("hidden");
  document.querySelectorAll("[data-etab]").forEach(b=>b.classList.toggle("on",b.dataset.etab===target));
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
    eShift=btn.dataset.eshift;shortShiftFormTimes(eShift,"eIn","eOut");
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
  $("eBarAMWrap").classList.toggle("hidden",!(eShift==="AM"||eShift===SHIFT_EARLY||multi));
  $("eBarPMWrap").classList.toggle("hidden",!(eShift==="PM"||eShift===SHIFT_MIDDLE||multi));
  if(eShift==="AM"||eShift===SHIFT_EARLY) $("eBarPM").checked=false;
  if(eShift==="PM"||eShift===SHIFT_MIDDLE) $("eBarAM").checked=false;
  if($("eBarPMLabel"))$("eBarPMLabel").textContent=eShift===SHIFT_MIDDLE?"With BAR Sales 2–4":"With BAR PM";
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
    if(btn.dataset.stab==="ownerSalesTable"){window.ownerTableOpen();return;}
    document.querySelectorAll("[data-stab]").forEach(x=>x.classList.remove("on"));
    btn.classList.add("on");
    document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
    $(btn.dataset.stab).classList.remove("hidden");
  });
});


const EMPLOYEE_DRAFT_KEY="fredTipEmployeeDraftV103";
function employeeDraftKey(){return EMPLOYEE_DRAFT_KEY+":"+String(currentUser?.uid||slugFor(currentProfile?.username||currentProfile?.displayName)||"signed-out");}
function saveEmployeeDraft(){
  if(!currentProfile || currentProfile.role!=="employee") return;
  const ids=["eDate","ePosition","eBreakMode","eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut","eGrandTotal","eTotalAM","eMeal","eCash"];
  const d={employeeUid:currentUser?.uid||"",shift:eShift,barAM:!!$("eBarAM")?.checked,barPM:!!$("eBarPM")?.checked};
  ids.forEach(id=>{if($(id))d[id]=$(id).value;});
  try{localStorage.setItem(employeeDraftKey(),JSON.stringify(d));}catch(e){}
}
function restoreEmployeeDraft(){
  try{
    const d=JSON.parse(localStorage.getItem(employeeDraftKey())||"null");
    if(!d || d.employeeUid!==currentUser?.uid)return;
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
  localStorage.removeItem(employeeDraftKey());
  try{
    ["eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut"].forEach(id=>{ const e=$(id); if(e)e.value=""; });
    ["eMeal","eCash","eGrandTotal","eTotalAM"].forEach(id=>{ const e=$(id); if(e)e.value="0"; });
    ["eBarAM","eBarPM"].forEach(id=>{ const e=$(id); if(e)e.checked=false; });
    if($("eDate")) $("eDate").value=todayLocal();
    if($("ePosition")) $("ePosition").value="Server";
    applyEmployeeWorkProfile();
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
  applyEmployeeWorkProfile();
  const profile=employeeWorkProfile(currentProfile?.displayName||currentProfile?.username);
  const isMulti=["DOUBLE","LONG"].includes(eShift);
  const r={
    employeeUid:currentUser.uid,
    employee:profile?.name||currentProfile.displayName||currentProfile.username,
    personName:profile?.personName||currentProfile.displayName||currentProfile.username,
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
    localStorage.removeItem(employeeDraftKey());
    clearEmployeeForm();
    alert("Employee submission sent. You are still signed in.");
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
      <b>Money is ready. Please see the Manager on Duty.</b>
    </div>
    <div class="grid3" style="margin-top:14px">
      <div class="kpi"><span>Grand Total</span><b>${money(f.grandTotal ?? r.grandTotal)}</b></div>
      ${["DOUBLE","LONG"].includes(r.shift)?`<div class="kpi"><span>Total AM</span><b>${money(f.totalAM ?? r.totalAM)}</b></div>`:""}
      <div class="kpi"><span>Meal</span><b>${money(f.meal ?? r.meal)}</b></div>
      <div class="kpi"><span>Cash Tip</span><b>${money(f.cashTip ?? r.cashTip)}</b></div>
      <div class="kpi"><span>Busser Rate</span><b>${pct(f.busserRate)}</b></div>
      <div class="kpi"><span>Busser AM</span><b>${money(f.busserTipOutAM??0)}</b></div>
      <div class="kpi"><span>Busser PM</span><b>${money(f.busserTipOutPM??0)}</b></div>
      <div class="kpi"><span>Busser Total</span><b>${money(f.busserTipOut)}</b></div>
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



const FZ_PUBLIC_PORTAL_COLLECTION="publicEmployeePortals";
const FZ_PORTAL_ACCESS_COLLECTION="employeeReportAccess";
let fzPortalSyncHash="";

function fzEmployeeKey(name){
  return String(name||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"employee";
}
function fzRandomPortalToken(){
  const bytes=new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
function fzPortalUrl(token){
  const u=new URL(location.href);
  u.search="";
  u.hash="";
  u.searchParams.set("report",token);
  return u.toString();
}
async function fzEnsureEmployeePortal(name,allRows=latestHourlyReports){
  if(!["manager","owner"].includes(currentProfile?.role||""))return null;
  name=String(name||"").trim();
  if(!name)return null;
  const key=fzEmployeeKey(name);
  const accessRef=doc(db,FZ_PORTAL_ACCESS_COLLECTION,key);
  let token="";
  try{
    const accessSnap=await getDoc(accessRef);
    token=String(accessSnap.data()?.token||"");
  }catch(e){ console.warn("Portal access read:",e); }
  if(!token){
    token=fzRandomPortalToken();
    await setDoc(accessRef,{
      employee:name,token,createdAt:serverTimestamp(),
      createdByUid:currentUser?.uid||"",
      createdBy:currentProfile?.displayName||currentProfile?.username||""
    },{merge:true});
  }
  const rows=(allRows||[]).filter(r=>String(r.employee||"").trim()===name && !shouldExcludeHistoricalReport(r));
  const safeRows=rows.filter(r=>!shouldExcludeHistoricalReport(r)).map(r=>({
    ...r,
    createdAt:r.createdAt?.seconds?{seconds:r.createdAt.seconds}:null,
    updatedAt:r.updatedAt?.seconds?{seconds:r.updatedAt.seconds}:null
  }));
  await setDoc(doc(db,FZ_PUBLIC_PORTAL_COLLECTION,token),{
    employee:name,
    reports:safeRows,
    updatedAt:serverTimestamp()
  },{merge:false});
  return token;
}

async function fzSyncPublicReportPortals(rows=latestHourlyReports){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const names=[...new Set((rows||[]).map(r=>String(r.employee||"").trim()).filter(Boolean))].sort();
  const hash=names.map(n=>n+":"+(rows||[]).filter(r=>r.employee===n).length).join("|");
  if(hash===fzPortalSyncHash)return;
  fzPortalSyncHash=hash;
  for(const name of names){
    try{ await fzEnsureEmployeePortal(name,rows); }
    catch(e){ console.warn("Portal sync skipped for",name,e); }
  }
}

window.openGuestReportCode=function(){
  const code=String($("guestReportCode")?.value||"").trim();
  if(!code){alert("Paste the private report code from your Manager/Owner.");return;}
  const u=new URL(location.href);u.searchParams.set("report",code);location.href=u.toString();
};

window.closeGuestReportPortal=function(){
  const u=new URL(location.href);u.searchParams.delete("report");location.href=u.toString();
};

async function fzOpenGuestReportPortalFromUrl(){
  const token=new URL(location.href).searchParams.get("report");
  if(!token)return false;
  $("loginView")?.classList.add("hidden");
  $("appView")?.classList.add("hidden");
  $("top")?.classList.add("hidden");
  const view=$("guestReportView"),body=$("guestReportPortalBody");
  view?.classList.remove("hidden");
  if(body)body.innerHTML='<div class="card"><div class="small">Loading your private reports...</div></div>';
  try{
    const snap=await getDoc(doc(db,FZ_PUBLIC_PORTAL_COLLECTION,token));
    if(!snap.exists())throw new Error("Private report link not found or expired.");
    const data=snap.data()||{};
    const rows=Array.isArray(data.reports)?data.reports:[];
    if(body){
      body.innerHTML=rows.length
        ? rows.sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))).map(r=>employeeReportExactHtml(r,{guest:true})).join("")
        : '<div class="card"><div class="notice">No finalized tip reports yet.</div></div>';
    }
  }catch(e){
    console.error("Guest report portal:",e);
    if(body)body.innerHTML=`<div class="card"><div class="notice danger"><b>Could not open this private report link.</b><br>${esc(e.code||e.message||"Access error")}</div></div>`;
  }
  return true;
}

function employeeReportExactHtml(r,{guest=false}={}){
  r=reportForWorkPosition(r);
  const hours={...r,...(r.hours||{})};
  const shift=String(r.shift||"").toUpperCase();
  const isDouble=shift==="DOUBLE"||(shift==="LONG"&&!!(r.hourInAM||hours.hourInAM));
  const position=String(r.position||"Server");
  const bartender=position.toLowerCase()==="bartender";
  const paidOut=smallReportPaidOut(r);
  const grandTotal=smallReportGrandTotal(r);
  const signed=Array.isArray(r.pickupSignature?.strokes)&&r.pickupSignature.strokes.length;

  const amIn=isDouble?(r.hourInAM??hours.hourInAM??"-"):(isEarlyShift(shift)?(r.hourIn??hours.hourIn??"-"):"-");
  const amOut=isDouble?(r.hourOutAM??hours.hourOutAM??"-"):(isEarlyShift(shift)?(r.hourOut??hours.hourOut??"-"):"-");
  const pmIn=isDouble?(r.hourInPM??hours.hourInPM??"-"):(["PM","LONG"].includes(shift)?(r.hourIn??hours.hourIn??"-"):"-");
  const pmOut=isDouble?(r.hourOutPM??hours.hourOutPM??"-"):(["PM","LONG"].includes(shift)?(r.hourOut??hours.hourOut??"-"):"-");

  const metric=(label,value,cls="")=>`<div class="fz-report-metric ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
  const money=v=>fmtMoney(Number(v||0));
  const yn=v=>v?"YES":"NO";

  const work=[
    metric("Hour In AM",esc(amIn||"-")),
    metric("Hour Out AM",esc(amOut||"-")),
    metric("Hour In PM",esc(pmIn||"-")),
    metric("Hour Out PM",esc(pmOut||"-")),
    metric("Total Hours",Number(r.totalHoursWork||r.totalHours||0).toFixed(2)),
    metric("Busser AM",esc(r.busserAM||"N/A")),
    metric("Grand Total",money(r.grandTotal)),
    metric("Total AM",money(r.totalAM)),
    metric("Total PM",money(r.totalPM)),
    metric("Total Tips",money(r.totalTips))
  ].join("");

  const tips=[
    metric("Paid Tip",money(r.paidTip)),
    metric("Card Fee",money(r.payCardTipFee??r.cardFee)),
    metric("Busser AM",money(r.busserTipOutAM)),
    metric("Busser PM",money(r.busserTipOutPM)),
    metric("Busser Total",money(r.busserTipOut)),
    metric(bartender?"Bar Tip Received":"Bar Tip Out",money(bartender?r.bartenderBarTipReceived:r.barTipOut)),
    metric("AM Bar Sales",yn(r.amBarSales??r.barSalesAM)),
    metric("PM Bar Sales",yn(r.pmBarSales??r.barSalesPM)),
    metric("AM Bar Tip",money(r.amBarTip??r.amBarTipOut??r.barTipAM)),
    metric("PM Bar Tip",money(r.pmBarTip??r.pmBarTipOut??r.barTipPM))
  ].join("");

  const bartenderCalc=bartender?`
    <div class="fz-report-section">
      <div class="fz-report-section-title">Bartender Calculation</div>
      <div class="fz-report-metrics">
        ${bartenderReceiptPeriods(r).length?[
          metric("BAR AM Received",money(bartenderPeriodAmount(r,"AM"))),
          metric("BAR 2-4 Received",money(bartenderPeriodAmount(r,"2PM_4PM"))),
          metric("BAR PM Received",money(bartenderPeriodAmount(r,"PM"))),
          metric("Periods",esc(bartenderReceiptPeriods(r).map(p=>bartenderPeriodLabel(p.checkpoint)).join(" + "))),
          metric("Received Total",money(r.bartenderBarTipReceived)),
          metric("Calculation","Sum of assigned periods")
        ].join(""):`
        ${metric("Shift",esc(String(r.bartenderShiftType||"-").replace("2PM_4PM","2 PM - 4 PM")))}
        ${metric("Server Sales",money(r.bartenderServerGrandTotalSummary))}
        ${metric("Gross @ 0.6%",money(r.bartenderGrossBarTipOut))}
        ${metric("Less AM",money(r.bartenderLessAM))}
        ${metric("Less 2-4",money(r.bartenderLess24))}
        ${metric("Received",money(r.bartenderBarTipReceived))}
        `}
      </div>
    </div>`:"";

  const signature=signed
    ? `<div class="fz-report-signature">${smallReportSignatureHtml(r)}</div><div class="small" style="margin-top:5px;font-weight:900;color:#0a7040">SIGNED</div>`
    : `<div class="fz-report-signature"><span class="small">SIGNATURE PENDING</span></div>`;

  return `<article class="fz-report-exact">
    <div class="fz-report-exact-head">
      <div class="eyebrow">FRED ZHANG TIP CALCULATOR · EMPLOYEE TIP REPORT</div>
      <h3>${esc(r.employee||"Employee")}</h3>
      <div class="meta">${esc(r.date||"-")} · ${esc(position)} | ${esc(shift||"-")}</div>
      <span class="fz-report-status">${esc(String(r.status||"MONEY READY").replaceAll("_"," ").toUpperCase())}</span>
    </div>
    <div class="fz-report-exact-body">
      <div class="fz-report-section">
        <div class="fz-report-section-title">Work & Sales</div>
        <div class="fz-report-metrics">${work}</div>
      </div>
      <div class="fz-report-section">
        <div class="fz-report-section-title">Tips & Deductions</div>
        <div class="fz-report-metrics">${tips}</div>
      </div>
      ${bartenderCalc}
      <div class="fz-report-section">
        <div class="fz-report-section-title">Payout Summary</div>
        <div class="fz-report-metrics">
          ${metric("Total Before Meal",money(r.totalBeforeMeal))}
          ${metric("Meal",money(r.meal))}
          ${metric("TOTAL PAID OUT",money(paidOut),"payout")}
          ${metric("Cash Tip",money(r.cashTip))}
          ${metric("GRAND TOTAL",money(grandTotal),"grand")}
          ${metric("Adjustment",r.adjustmentDecision==="NONE"?"NO ADJUSTMENT":esc(String(r.adjustmentDecision||"NO ADJUSTMENT")))}
          ${metric("Adjustment Available",money(r.adjustmentCandidate??calculatedHourlyAdjustment(r)))}
          ${metric("Adjustment Applied",money(r.adjustmentSalaryHourly||0))}
        </div>
        <div class="fz-report-formula">Minimum Hourly Check = Total Before Meal + Cash Tip vs. hourly minimum<br>Adjustment = max(0, Hourly Minimum - Total Before Meal - Cash Tip)<br>Total Paid Out = Total Before Meal - Meal${r.adjustmentPayoutVersion?' + Accepted Adjustment':''}<br>Grand Total = Total Before Meal + Cash Tip</div>
      </div>
      <div class="fz-report-section">
        <div class="fz-report-section-title">Employee Signature</div>
        ${signature}
      </div>
      ${guest?"":`<div class="fz-report-download"><button class="btn light" type="button" onclick="downloadMyHistoricalReport('${r.id}')">Download My PDF</button></div>`}
    </div>
  </article>`;
}

function employeeHistoricalReportHtml(r){
  return employeeReportExactHtml(r,{guest:false});
}

function renderEmployeeHistoricalReports(rows=[]){
  const host=$("employeeHistoricalReports");
  if(!host)return;
  const sorted=[...rows].sort((a,b)=>{
    const da=String(a.date||""), dbb=String(b.date||"");
    if(da!==dbb)return dbb.localeCompare(da);
    return Number(b.createdAt?.seconds||b.updatedAt?.seconds||0)-Number(a.createdAt?.seconds||a.updatedAt?.seconds||0);
  });
  host.innerHTML=sorted.length
    ? sorted.map(employeeHistoricalReportHtml).join("")
    : '<div class="notice">No finalized tip reports yet.</div>';
}

window.downloadMyHistoricalReport=function(reportId){
  if(currentProfile?.role!=="employee")return;
  const rows=window.__employeeHistoricalHourlyReports||[];
  const r=rows.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}
  const safeName=String(r.employee||"Employee").replace(/[^a-z0-9_-]+/gi,"_");
  downloadBlob(simplePdfBlob([{...r,totalPaidOut:smallReportPaidOut(r)}]),
    `Fred_Zhang_Tip_Report_${safeName}_${r.date||todayLocal()}.pdf`);
};

function listenEmployeeHistoricalReports(){
  if(currentProfile?.role!=="employee"||!currentUser)return;
  const name=String(currentProfile.displayName||currentProfile.username||"").trim();
  if(!name)return;

  const merged=new Map();
  const push=rows=>{
    rows.filter(r=>!shouldExcludeHistoricalReport(r)).forEach(r=>merged.set(r.id,r));
    const all=[...merged.values()];
    window.__employeeHistoricalHourlyReports=all;
    renderEmployeeHistoricalReports(all);
  };
  const fail=e=>{
    console.error("Employee historical reports:",e);
    const host=$("employeeHistoricalReports");
    if(host && !window.__employeeHistoricalHourlyReports?.length){
      host.innerHTML=`<div class="notice danger"><b>Could not load My Reports.</b><br>${esc(e.code||e.message||"Firestore permission error")}<br><span class="small">Publish the V13.8.24-P16 hourlyReports employee-read rule.</span></div>`;
    }
  };

  const byUid=query(collection(db,"hourlyReports"),where("employeeUid","==",currentUser.uid),limit(100));
  unsubs.push(onSnapshot(byUid,snap=>push(snap.docs.map(d=>({id:d.id,...d.data()}))),fail));

  const byName=query(collection(db,"hourlyReports"),where("employee","==",name),limit(100));
  unsubs.push(onSnapshot(byName,snap=>push(snap.docs.map(d=>({id:d.id,...d.data()}))),fail));
}

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
            "Your tip money is ready. Please see the Manager on Duty.",
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


function ensureRealtimeAlertAudio(){ return;
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

function realtimeAlertSound(kind="normal"){ return;
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
        silent:true,
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

  const swReg=await navigator.serviceWorker.register("./service-worker-v13849.js?v=13849-es15",{updateViaCache:"none"});
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


window.submitEmployeeTipCheckRows=async function(date,rows){
  if(currentProfile?.role!=="employee"){
    alert("Employee login required.");
    return false;
  }
  const cleanRows=Array.isArray(rows)?rows.map((r,i)=>({
    line:i+1,
    checkNumber:String(r?.checkNumber||"").trim(),
    table:String(r?.table||"").trim(),
    tip:Number(r?.tip||0)
  })).filter(r=>r.checkNumber||r.table||r.tip>0):[];

  if(!cleanRows.length){
    alert("Add at least one ticket.");
    return false;
  }

  try{
    if(auth.currentUser) await auth.currentUser.getIdToken(true);
    await saveTipCheckSheetApi({date:date||todayLocal(),rows:cleanRows});
    await loadTipCheckSheets();
    return true;
  }catch(e){
    console.error("Direct Check Tip submit:",e);
    alert(`Submit to Cashier failed: ${e.message||e.code}`);
    return false;
  }
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


function deletedCheckTipIds(){
  return new Set((latestDeletedItems||[]).filter(x=>x.itemType==="check_tip").map(x=>String(x.itemId||"")));
}
function safeDeletedSnapshot(sheet){
  try{return JSON.parse(JSON.stringify(sheet||{}));}catch(e){return {id:sheet?.id||"",date:sheet?.date||"",employeeName:sheet?.employeeName||"",rows:sheet?.rows||[]};}
}
async function loadDeletedItems(){
  latestDeletedItems=[];
  if(!currentUser||currentUser.isAnonymous||!currentProfile)return;
  try{
    let qd;
    if(currentProfile.role==="employee"){
      qd=query(collection(db,"deletedItems"),where("employeeUid","==",currentUser.uid),limit(300));
    }else{
      qd=query(collection(db,"deletedItems"),limit(500));
    }
    const snap=await getDocs(qd);
    latestDeletedItems=snap.docs.map(d=>({archiveId:d.id,...d.data()}));
    renderOwnerDeletedItems();
  }catch(e){
    console.error("Deleted items load:",e);
    if(currentProfile?.role==="owner"&&$("deletedItemsList")){
      $("deletedItemsList").innerHTML=`<div class="notice danger">Deleted / Undo could not load: ${esc(e.code||e.message)}. Publish the V13.8.24-P16 Firestore rules.</div>`;
    }
  }
}
async function archiveCheckTipSheet(sheet){
  if(!sheet?.id||!currentUser||!currentProfile)return false;
  const role=String(currentProfile.role||"");
  if(!["employee","manager","owner"].includes(role))return false;
  if(role==="employee"){
    const mine=String(currentProfile.displayName||currentProfile.username||"").trim();
    if(String(sheet.employeeName||"").trim()!==mine){alert("You can delete only your own Check Tip status.");return false;}
  }
  const archiveRef=doc(db,"deletedItems",`checktip_${sheet.id}`);
  const old=await getDoc(archiveRef);
  if(old.exists())return true;
  await setDoc(archiveRef,{
    itemType:"check_tip",
    itemId:String(sheet.id),
    employeeName:String(sheet.employeeName||""),
    employeeUid:role==="employee"?currentUser.uid:String(sheet.employeeUid||sheet.submittedByUid||""),
    date:String(sheet.date||""),
    label:`Check Tip • ${sheet.employeeName||""} • ${sheet.date||""}`,
    snapshot:safeDeletedSnapshot(sheet),
    deletedByUid:currentUser.uid,
    deletedBy:currentProfile.displayName||currentProfile.username||"",
    deletedByRole:role,
    deletedAt:serverTimestamp()
  });
  return true;
}
window.employeeDeleteTipCheckDate=async function(encodedDate){
  if(currentProfile?.role!=="employee")return;
  let date=encodedDate;try{date=decodeURIComponent(encodedDate)}catch(e){}
  const mine=String(currentProfile.displayName||currentProfile.username||"").trim();
  const targets=latestTipCheckSheets.filter(s=>String(s.date||"")===String(date||"")&&String(s.employeeName||"").trim()===mine);
  if(!targets.length){alert("No Check Tip status found for this date.");return;}
  if(!confirm(`Remove Check Tip status for ${date}?\n\nOwner can restore it later.`))return;
  try{
    for(const s of targets)await archiveCheckTipSheet(s);
    await loadTipCheckSheets();
  }catch(e){
    console.error("Employee Check Tip delete:",e);
    alert(`Delete failed: ${e.code||e.message}\n\nIf this says permission-denied, publish the V13.8.24-P16 Firestore rules.`);
  }
};
function deletedTypeLabel(t){
  return ({
    check_tip:"Check Tip",
    hourly_report:"Daily Report",
    submission:"Submission",
    team_employee:"Team Board Employee",
    user_profile:"User Account"
  })[t]||String(t||"Deleted Item");
}
async function fzRestoreArchive(x){
  if(currentProfile?.role!=="owner")throw new Error("Owner access required.");
  const value=x.snapshot||{};
  if(x.itemType==="hourly_report" || x.itemType==="submission"){
    const col=x.itemType==="hourly_report"?"hourlyReports":"submissions";
    const ref=doc(db,col,x.itemId);
    if((await getDoc(ref)).exists())throw new Error("A live record with this ID already exists. It was not overwritten.");
    await setDoc(ref,value);
  }else if(x.itemType==="user_profile"){
    const clean={...value};delete clean.uid;
    clean.active=value.active!==false;clean.deletedAt=null;clean.deletedBy="";
    await setDoc(doc(db,"users",x.itemId),clean,{merge:true});
  }else if(x.itemType==="team_employee"){
    const date=x.date||value.date||todayLocal(), name=x.employeeName||value.name;
    if(!name)throw new Error("Archive has no employee name.");
    const key=HV1_STORAGE_PREFIX+date, ref=doc(db,"hourlyV1Batches",date);
    const cloud=await getDoc(ref);
    let state=cloud.exists()?cloud.data():JSON.parse(localStorage.getItem(key)||'{"team":[],"drafts":{}}');
    state=JSON.parse(JSON.stringify(state));
    state.team=state.team||[];state.drafts=state.drafts||{};
    if(state.team.includes(name) && state.drafts[name] && Number(state.drafts[name].savedAt||0)>Number(value.draft?.savedAt||0)){
      throw new Error("This employee has newer live work. It was not overwritten.");
    }
    if(!state.team.includes(name))state.team.push(name);
    state.drafts[name]=value.draft||hv1BlankDraft(name);
    state.removedEmployees=state.removedEmployees||{};
    state.removedEmployees[name]={...(state.removedEmployees[name]||{}),restoredAt:Date.now()};
    await setDoc(ref,{...state,date,updatedAt:serverTimestamp(),updatedByUid:currentUser.uid,updatedBy:currentProfile.displayName||currentProfile.username||""});
    localStorage.setItem(key,JSON.stringify(state));
    if(date===hv1DateValue()){
      $('hv1Setup')?.classList.add('hidden');$('hv1BoardBox')?.classList.remove('hidden');hv1RenderCards();
    }
  }else if(x.itemType!=="check_tip")throw new Error("Unsupported archive type. Backup retained.");
  await deleteDoc(doc(db,"deletedItems",x.archiveId));
}
function fzRenderRemovedCards(){
  const host=$("fzRemovedCards");if(!host)return;
  if(currentProfile?.role!=="owner"){host.classList.add("hidden");return;}
  const items=(latestDeletedItems||[]).filter(x=>x.itemType==="team_employee" && x.date===hv1DateValue());
  host.classList.toggle("hidden",!items.length);
  host.innerHTML=items.length?`<div class="fz-section-kicker">RECENTLY REMOVED · ${items.length}</div><div class="hv1-cards">${items.map(x=>`<div class="fz-removed-card"><span class="hv1-status">DELETED · RECOVERABLE</span><h4>${esc(x.employeeName||x.snapshot?.name||"Employee")}</h4><div class="small">Removed by ${esc(x.deletedBy||"Staff")}</div><button class="btn gold" type="button" onclick="restoreDeletedItem('${esc(x.archiveId)}')">↶ UNDO DELETE</button></div>`).join("")}</div>`:"";
}

function renderOwnerDeletedItems(){
  fzRenderRemovedCards();
  if(currentProfile?.role!=="owner")return;
  const list=$("deletedItemsList"),badge=$("deletedItemsBadge");
  const rows=[...(latestDeletedItems||[])].sort((a,b)=>Number(b.deletedAt?.seconds||0)-Number(a.deletedAt?.seconds||0));
  if(badge)badge.textContent=rows.length;
  if(!list)return;
  list.innerHTML=rows.length?rows.map(x=>{
    const when=x.deletedAt?.seconds?new Date(x.deletedAt.seconds*1000).toLocaleString():"";
    return `<div class="deleted-item-card">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <b style="font-size:18px">${esc(x.label||x.employeeName||deletedTypeLabel(x.itemType))}</b>
          <div class="deleted-meta">${esc(deletedTypeLabel(x.itemType))}${x.date?` • ${esc(x.date)}`:""}</div>
          <div class="deleted-meta">Deleted by ${esc(x.deletedBy||"")} (${esc(x.deletedByRole||"")})${when?` • ${esc(when)}`:""}</div>
        </div>
        <div class="actions">
          <button class="btn gold" type="button" onclick="restoreDeletedItem('${x.archiveId}')">RESTORE</button>
          <button class="btn red" type="button" onclick="permanentDeleteArchivedItem('${x.archiveId}')">DELETE PERMANENT</button>
        </div>
      </div>
    </div>`;
  }).join(""):'<div class="notice good">Deleted / Undo is empty.</div>';
}

window.restoreDeletedItem=async function(archiveId){
  if(currentProfile?.role!=="owner")return;
  const item=latestDeletedItems.find(x=>x.archiveId===archiveId);if(!item)return;
  if(!await requireCurrentAccountPassword("Undo Delete","OWNER PASSWORD REQUIRED. Restore this archived item?"))return;
  try{await fzRestoreArchive(item);await loadDeletedItems();renderSmallReport();fzRenderRemovedCards();alert("Deleted item restored.");}
  catch(e){alert("Restore failed. Backup retained: "+(e.code||e.message));}
};

window.permanentDeleteArchivedItem=async function(archiveId){
  if(currentProfile?.role!=="owner")return;
  const x=latestDeletedItems.find(r=>r.archiveId===archiveId);if(!x)return;
  const ok=await requireCurrentAccountPassword("Delete Permanent","OWNER PASSWORD REQUIRED. This action cannot be undone.");
  if(!ok)return;
  try{
    if(x.itemType==="check_tip"&&x.itemId)await deleteTipCheckSheetApi({sheetId:x.itemId});
    await deleteDoc(doc(db,"deletedItems",archiveId));
    await loadDeletedItems();
    alert("Archived item permanently deleted.");
  }catch(e){alert(`Permanent delete failed: ${e.code||e.message}`);}
};

window.undoDeletedCheckTip=async function(archiveId){
  if(currentProfile?.role!=="owner")return;
  const x=latestDeletedItems.find(r=>r.archiveId===archiveId);if(!x)return;
  if(!confirm(`UNDO delete for ${x.employeeName||"this Check Tip record"}?`))return;
  try{await deleteDoc(doc(db,"deletedItems",archiveId));await loadTipCheckSheets();alert("Deleted Check Tip restored.");}
  catch(e){alert(`Undo failed: ${e.code||e.message}`);}
};
window.permanentDeleteCheckTip=async function(archiveId){
  const passwordOk=await requireCurrentAccountPassword("Permanent Delete","OWNER PASSWORD REQUIRED.");
  if(!passwordOk)return;
  if(currentProfile?.role!=="owner")return;
  const x=latestDeletedItems.find(r=>r.archiveId===archiveId);if(!x)return;
  if(!confirm(`DELETE PERMANENTLY?\n\n${x.employeeName||""} • ${x.date||""}\n\nThis cannot be undone.`))return;
  try{
    await deleteTipCheckSheetApi({sheetId:x.itemId});
    await deleteDoc(doc(db,"deletedItems",archiveId));
    await loadTipCheckSheets();
    alert("Check Tip permanently deleted.");
  }catch(e){alert(`Permanent delete failed: ${e.message||e.code}`);}
};
window.undoAllDeletedCheckTips=async function(){
  if(currentProfile?.role!=="owner")return;
  const items=[...latestDeletedItems];if(!items.length){alert("Nothing to restore.");return;}
  if(!await requireCurrentAccountPassword("Undo All","OWNER PASSWORD REQUIRED. Restore all archived items without overwriting newer live data?"))return;
  let restored=0,failed=0;
  for(const x of items){try{await fzRestoreArchive(x);restored++;}catch(e){failed++;console.warn("Archive retained",x.archiveId,e);}}
  await loadDeletedItems();renderSmallReport();fzRenderRemovedCards();
  alert(`${restored} restored. ${failed} left in Deleted / Undo for review.`);
};

window.permanentDeleteAllCheckTips=async function(){
  if(currentProfile?.role!=="owner")return;
  const items=[...latestDeletedItems];if(!items.length){alert("Nothing to purge.");return;}
  if(!await requireCurrentAccountPassword("Delete Permanent All","OWNER PASSWORD REQUIRED. Permanently remove all archived items? Cannot be undone."))return;
  let removed=0;
  try{
    for(const x of items){
      if(x.itemType==="check_tip"&&x.itemId)await deleteTipCheckSheetApi({sheetId:x.itemId});
      await deleteDoc(doc(db,"deletedItems",x.archiveId));removed++;
    }
    await loadDeletedItems();fzRenderRemovedCards();alert(`${removed} archived items permanently removed.`);
  }catch(e){await loadDeletedItems();alert(`${removed} removed. Remaining backups retained: ${e.code||e.message}`);}
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
    const activeSheets=sheets.filter(s=>Array.isArray(s.rows) && s.rows.length>0);
    if(!activeSheets.length) return "";

    const allRows=[];
    activeSheets.forEach(s=>(s.rows||[]).forEach(r=>allRows.push(r)));

    const totalTip=allRows.reduce((sum,r)=>sum+Number(r.tip||0),0);
    const doneRows=allRows.filter(r=>r.result==="done");
    const noSigRows=allRows.filter(r=>r.result==="no_signature");
    const notFoundRows=allRows.filter(r=>r.result==="ticket_not_found");
    const approvedTip=doneRows.reduce((sum,r)=>sum+Number(r.tip||0),0);
    const allCompleted=activeSheets.every(s=>s.status==="cashier_completed");
    const issueCount=noSigRows.length+notFoundRows.length;
    const pendingCount=allRows.filter(r=>!r.result).length;

    const rowResult=(r)=>{
      if(r.result==="done") return '<span class="status approved">Done</span>';
      if(r.result==="no_signature") return '<span class="status rejected">No Signature</span>';
      if(r.result==="ticket_not_found") return '<span class="status rejected">Ticket Not Found</span>';
      return '<span class="status pending">Pending Cashier</span>';
    };

    return `<div class="tip-check-sheet">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <b style="font-size:20px">${esc(date)}</b>
        <span class="status ${allCompleted?"approved":"pending"}">${allCompleted?"CASHIER COMPLETED":"WAITING CASHIER"}</span>
      </div>

      <div class="small" style="margin-top:5px">
        ${allRows.length} ticket(s) • Submitted ${fmtMoney(totalTip)} • Approved ${fmtMoney(approvedTip)}
      </div>

      <div class="notice ${allCompleted?(issueCount?"warning":"good"):""}" style="margin-top:10px">
        ${allCompleted
          ? `<b>Cashier has completed your Check Tip review.</b><div style="margin-top:5px">Done: ${doneRows.length} • No Signature: ${noSigRows.length} • Ticket Not Found: ${notFoundRows.length}</div>`
          : `<b>Cashier review is still in progress.</b><div style="margin-top:5px">You can view your submitted tickets below. Results are read-only. Pending: ${pendingCount}</div>`}
      </div>

      <div class="tablewrap" style="margin-top:10px"><table>
        <thead><tr><th>#</th><th>Check Number</th><th>Table</th><th>Tip</th><th>Cashier Result</th></tr></thead>
        <tbody>${allRows.map((x,i)=>`<tr class="${x.result&&x.result!=="done"?"tip-check-row-problem":""}">
          <td>${i+1}</td>
          <td>${esc(x.checkNumber||"")}</td>
          <td>${esc(x.table||"")}</td>
          <td>${fmtMoney(x.tip||0)}</td>
          <td>${rowResult(x)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <button class="btn red employee-delete-checktip" type="button" onclick="employeeDeleteTipCheckDate('${encodeURIComponent(date)}')">Delete This Status</button>
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

window.ownerOpenTipCheckSheet=function(id){
  if(currentProfile?.role!=="owner")return;
  const block=$("tipCheckManagerBlock");
  if(block){
    block.style.display="";
    block.classList.remove("hidden");
  }
  window.editTipCheckSheet(id);
  setTimeout(()=>{
    if(block){
      block.style.display="";
      block.classList.remove("hidden");
      block.scrollIntoView({behavior:"smooth",block:"start"});
    }
  },50);
};

window.deleteTipCheckSheet=async function(id){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const sheet=latestTipCheckSheets.find(x=>String(x.id)===String(id));if(!sheet)return;
  if(!confirm(`Delete this Check Tip sheet?\n\n${sheet.employeeName||""} • ${sheet.date||""}\n\nOwner can Undo this from Deleted / Undo.`))return;
  try{await archiveCheckTipSheet(sheet);await loadTipCheckSheets();}catch(e){alert(`Delete failed: ${e.message||e.code}`);}
};
window.clearAllTipCheckSheets=async function(){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  if(!confirm(`CLEAR ALL CHECK TIP RECORDS?\n\nMove ${latestTipCheckSheets.length} record(s) to Deleted / Undo?`))return;
  try{for(const s of latestTipCheckSheets)await archiveCheckTipSheet(s);await loadTipCheckSheets();alert("All Check Tip records moved to Deleted / Undo.");}catch(e){alert(`Clear All failed: ${e.message||e.code}`);}
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

window.shareTipCheckPdf=async function(target){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  await shareReportFile(
    tipCheckPdfBlob(),
    `Fred_Zhang_Check_Tip_${todayLocal()}.pdf`,
    target
  );
};
window.shareTipCheckXls=async function(target){
  if(currentProfile?.role!=="owner")return;
  if(!latestTipCheckSheets.length){alert("No Check Tip records.");return;}
  await shareReportFile(
    tipCheckXlsBlob(),
    `Fred_Zhang_Check_Tip_${todayLocal()}.xls`,
    target
  );
};

async function loadTipCheckSheets(){
  if(!currentUser || currentUser.isAnonymous || !currentProfile)return;
  try{
    await loadDeletedItems();
    const res=await listTipCheckSheetsApi({});
    const allSheets=Array.isArray(res.data?.rows)?res.data.rows:[];
    const deleted=deletedCheckTipIds();
    latestTipCheckSheets=allSheets.filter(r=>!deleted.has(String(r.id||"")));
    renderEmployeeTipCheckStatus();
    renderCashierTipCheckQueue();
    renderOwnerTipCheckRecords();
    renderOwnerDeletedItems();
  }catch(e){
    console.error("Check Tip load:",e);
  }
}
function listenTipCheckSheets(){ /* retired; history remains in database */ }

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
  if($("pendingBadge"))$("pendingBadge").textContent=p.length;
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




function shouldExcludeHistoricalReport(r){
  const name=String(r.employee||"").trim().toLowerCase();
  const date=String(r.date||"");
  const hours=Number(r.totalHoursWork||r.totalHours||0);

  // User-approved historical cleanup:
  // - Angela Grizzad 2026-09-04 should not sync/show.
  // - Sarah Kibler duplicate on 2026-09-05 with 0 hours should not sync/show.
  if(name==="angela grizzad" && date==="2026-09-04") return true;
  if(name==="sarah kibler" && date==="2026-09-05" && hours<=0) return true;
  return false;
}

function fzEmployeeIdentityKey(name){
  return String(name||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"");
}

async function syncHistoricalReportsToEmployeeAccount(uid,displayName,{silent=false}={}){
  if(!["manager","owner"].includes(currentProfile?.role||""))return {matched:0,updated:0};
  const name=String(displayName||"").trim();
  if(!uid||!name)return {matched:0,updated:0};

  const qh=query(collection(db,"hourlyReports"),where("employee","==",name),limit(200));
  const snap=await getDocs(qh);
  const eligibleDocs=snap.docs.filter(ds=>!shouldExcludeHistoricalReport(ds.data()||{}));
  let updated=0;
  for(const ds of eligibleDocs){
    const r=ds.data()||{};
    const patch={};
    if(String(r.employeeUid||"")!==uid)patch.employeeUid=uid;
    const key=fzEmployeeIdentityKey(name);
    if(String(r.employeeKey||"")!==key)patch.employeeKey=key;
    if(Object.keys(patch).length){
      patch.accountLinkedAt=serverTimestamp();
      patch.accountLinkedBy=currentProfile?.displayName||currentProfile?.username||"Manager";
      await updateDoc(ds.ref,patch);
      updated++;
    }
  }
  if(!silent){
    const msg=`${name}: ${eligibleDocs.length} historical report(s) found, ${updated} linked/updated.`;
    const el=$("historicalSyncStatus"); if(el)el.textContent=msg;
  }
  return {matched:eligibleDocs.length,updated};
}


window.cleanHistoricalDuplicates=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const ok=confirm("Delete the approved historical duplicates: Angela Grizzad 2026-09-04 and Sarah Kibler 2026-09-05 zero-hour duplicate?");
  if(!ok)return;
  const targets=[
    {employee:"Angela Grizzad",date:"2026-09-04",zeroOnly:false},
    {employee:"Sarah Kibler",date:"2026-09-05",zeroOnly:true}
  ];
  let deleted=0;
  for(const t of targets){
    const qh=query(collection(db,"hourlyReports"),where("employee","==",t.employee),where("date","==",t.date),limit(20));
    const snap=await getDocs(qh);
    for(const ds of snap.docs){
      const r=ds.data()||{};
      if(t.zeroOnly && Number(r.totalHoursWork||r.totalHours||0)>0)continue;
      await deleteDoc(ds.ref);
      deleted++;
    }
  }
  alert(`${deleted} historical report(s) deleted. Run Sync Historical Reports again.`);
  await window.syncAllHistoricalReportsToAccounts?.();
};

window.syncAllHistoricalReportsToAccounts=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const el=$("historicalSyncStatus");
  if(el)el.textContent="Syncing historical reports to employee accounts...";
  try{
    const us=await getDocs(collection(db,"users"));
    const employees=us.docs.map(d=>({uid:d.id,...d.data()}))
      .filter(u=>u.role==="employee" && u.active===true && u.approvalStatus==="approved");
    let matched=0,updated=0,linkedUsers=0;
    for(const u of employees){
      const name=String(u.displayName||u.username||"").trim();
      if(!name)continue;
      const result=await syncHistoricalReportsToEmployeeAccount(u.uid,name,{silent:true});
      matched+=result.matched; updated+=result.updated;
      if(result.matched)linkedUsers++;
    }
    if(el)el.innerHTML=`<b>Historical sync complete.</b> ${linkedUsers} employee account(s) matched, ${matched} report(s) found, ${updated} report link(s) updated.`;
  }catch(e){
    console.error("Historical account sync:",e);
    if(el)el.textContent=`Historical sync failed: ${e.code||e.message}`;
  }
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

    const historicalSync=await syncHistoricalReportsToEmployeeAccount(uid,before.displayName||before.username||"",{silent:true});

    await writeAudit("employee_signup_approved",uid,before.displayName||"",{
      before,
      after:{active:true,approvalStatus:"approved"},
      historicalReportsLinked:historicalSync.matched,
      historicalReportsUpdated:historicalSync.updated
    });

    alert(`Employee approved. ${historicalSync.matched} historical report(s) are now available in My Reports.`);
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
    latestUsers=a;
    syncEmployeeAccountRoster(a);
    userNameByUid=Object.fromEntries(a.map(u=>[u.uid,u.displayName||u.username||""]));

    if(!historicalAccountAutoSyncStarted && ["manager","owner"].includes(currentProfile?.role||"")){
      historicalAccountAutoSyncStarted=true;
      setTimeout(()=>{Promise.resolve(window.syncAllHistoricalReportsToAccounts?.()).catch(()=>{});},350);
    }

    $("userList").innerHTML=a.length?a.map(u=>{
      const active=u.active!==false;
      const created=u.createdAt?.toDate?u.createdAt.toDate().toLocaleString():"—";
      const status=active
        ? '<span class="status approved">ACTIVE</span>'
        : '<span class="status rejected">DISABLED</span>';
      const approval=String(u.approvalStatus||"—").toUpperCase();

      return `<div class="owner-user-card">
        <div class="owner-user-head">
          <div>
            <b class="owner-user-name">${esc(u.displayName||u.username||"User")}</b>
            <div class="small">${status}</div>
            <div class="small">Credential source: ${esc(u.approvedBy||u.createdBy||(u.role==="employee"?"Employee signup":"Owner/Manager"))}</div>
          </div>
          <div class="actions">
            <button type="button" class="btn light" onclick="openEditUser('${u.uid}')">View / Edit</button>
            ${u.role!=="owner"?(active
              ? `<button type="button" class="btn red" onclick="setUserActive('${u.uid}',false)">Disable</button>`
              : `<button type="button" class="btn green" onclick="setUserActive('${u.uid}',true)">Enable</button>`):""}
            ${u.role!=="owner"?`<button type="button" class="btn red" style="background:#7f1d1d;color:white" onclick="deleteAppUser('${u.uid}')">Delete</button>`:""}
          </div>
        </div>
        <div class="owner-user-grid">
          <div><span>Username</span><b>${esc(u.username||"—")}</b></div>
          <div><span>Role</span><b>${esc(u.role||"—")}</b></div>
          <div><span>Phone</span><b>${esc(u.phone||"—")}</b></div>
          <div><span>Approval</span><b>${esc(approval)}</b></div>
          <div><span>Created</span><b>${esc(created)}</b></div>
          <div><span>PIN / Password</span><b>Protected — not viewable</b></div>
        </div>
      </div>`;
    }).join(""):'<div class="notice">No users found.</div>';
  },e=>console.error("Users listener:",e)));
}


window.openEditUser=function(uid){
  if(currentProfile?.role!=="owner")return;
  const u=latestUsers.find(x=>x.uid===uid);
  if(!u){alert("User not found.");return;}

  $("editUserNewPassword").value="";
  $("editUserNewPassword").placeholder=u.role==="employee"?"Enter exactly 4 digits":"Enter at least 6 characters";
  $("editUserUid").value=u.uid;
  $("editUserUsername").value=u.username||"";
  $("editUserDisplayName").value=u.displayName||"";
  $("editUserPhone").value=u.phone||"";
  $("editUserRole").value=u.role||"employee";
  $("editUserApproval").value=u.approvalStatus||"approved";
  $("editUserActive").value=u.active===false?"false":"true";

  const protectedOwner=u.role==="owner";
  $("editUserRole").disabled=true;
  $("editUserActive").disabled=protectedOwner;
  $("editUserApproval").disabled=protectedOwner;

  $("userEditModal").classList.remove("hidden");
  $("userEditModal").style.display="flex";
};

let ownerCredentialSaving=false;
window.ownerResetSelectedUserPassword=async function(){
  if(currentProfile?.role!=="owner" || !currentUser){alert("Owner only.");return;}
  if(ownerCredentialSaving)return;
  const uid=String($("editUserUid")?.value||"").trim();
  const target=latestUsers.find(u=>u.uid===uid),secret=String($("editUserNewPassword")?.value||"");
  if(!target){alert("Select a user first.");return;}
  if(target.role==='owner'){alert('Use Change Owner Password for an Owner account.');return;}
  if(target.role==='employee'?!/^\d{4}$/.test(secret):secret.length<6){alert(target.role==='employee'?'Employee PIN must be exactly 4 digits.':'Password must be at least 6 characters.');return;}
  const button=$('ownerResetCredentialBtn');ownerCredentialSaving=true;if(button)button.disabled=true;
  try{
    const result=await resetAppCredentialApi({uid,secret});
    if(result?.data?.ok!==true)throw new Error('Password update was not confirmed.');
    if($('editUserUid')?.value===uid)$('editUserNewPassword').value='';
    alert('New '+(target.role==='employee'?'PIN':'password')+' saved for '+(target.displayName||target.username)+'.');
  }catch(e){
    const missing=['functions/not-found','functions/unavailable','functions/internal'].includes(e.code);
    alert(missing?'Credential service could not be reached. Deploy the Firebase BACKEND included in build 13.8.49, then retry. No success has been confirmed.':'Password update failed: '+(e.message||e.code));
  }finally{ownerCredentialSaving=false;if(button)button.disabled=false;}
};

window.closeEditUser=function(){
  $("editUserNewPassword").value="";
  $("userEditModal").classList.add("hidden");
  $("userEditModal").style.display="none";
};
window.saveEditUser=async function(){
  if(currentProfile?.role!=="owner")return;
  const uid=$("editUserUid").value;
  const before=latestUsers.find(x=>x.uid===uid);
  if(!before){alert("User not found.");return;}

  const displayName=$("editUserDisplayName").value.trim();
  const phone=$("editUserPhone").value.replace(/\D/g,"");
  const approval=$("editUserApproval").value;
  const active=$("editUserActive").value==="true";

  if(!displayName){alert("Display Name is required.");return;}
  if(phone&&!/^\d{7,15}$/.test(phone)){alert("Enter a valid phone number.");return;}

  const after={
    displayName,
    phone,
    ...(before.role==="owner"?{}:{approvalStatus:approval,active})
  };

  try{
    await updateDoc(doc(db,"users",uid),after);
    const requestRef=doc(db,"signupRequests",uid);
    const requestSnap=await getDoc(requestRef);
    if(requestSnap.exists()){
      await updateDoc(requestRef,{
        displayName,
        phone,
        ...(before.role==="owner"?{}:{status:approval})
      });
    }
    try{await writeAudit("user_profile_edit",uid,displayName,{before,after});}
    catch(e){console.warn("User edit audit:",e);}
    closeEditUser();
    alert("User updated.");
  }catch(e){
    console.error("Edit user:",e);
    alert(`User update failed: ${e.code||e.message}`);
  }
};

window.openOwnerPasswordModal=function(){
  if(currentProfile?.role!=="owner")return;
  ["ownerCurrentPassword","ownerNewPassword","ownerConfirmPassword"].forEach(id=>{if($(id))$(id).value="";});
  $("ownerPasswordModal").classList.remove("hidden");
  $("ownerPasswordModal").style.display="flex";
  setTimeout(()=>$("ownerCurrentPassword")?.focus(),50);
};
window.closeOwnerPasswordModal=function(){
  $("ownerPasswordModal").classList.add("hidden");
  $("ownerPasswordModal").style.display="none";
};
window.changeOwnerPassword=async function(){
  if(currentProfile?.role!=="owner")return;
  const current=$("ownerCurrentPassword").value;
  const next=$("ownerNewPassword").value;
  const confirmNext=$("ownerConfirmPassword").value;

  if(!current||!next||!confirmNext){alert("Complete all password fields.");return;}
  if(next.length<6){alert("New password must be at least 6 characters.");return;}
  if(next!==confirmNext){alert("New passwords do not match.");return;}
  if(!auth.currentUser?.email){alert("Owner authentication email not found.");return;}

  const btn=$("ownerChangePasswordBtn");
  if(btn){btn.disabled=true;btn.textContent="Changing...";}
  try{
    const credential=EmailAuthProvider.credential(auth.currentUser.email,current);
    await reauthenticateWithCredential(auth.currentUser,credential);
    await updatePassword(auth.currentUser,next);
    closeOwnerPasswordModal();
    alert("Owner password changed successfully.");
  }catch(e){
    console.error("Owner password change:",e);
    alert(`Password change failed: ${e.code||e.message}`);
  }finally{
    if(btn){btn.disabled=false;btn.textContent="Change Password";}
  }
};

window.deleteAppUser=async function(uid){
  if(currentProfile?.role!=="owner")return;
  const target=latestUsers.find(u=>u.uid===uid);
  if(!target){alert("User not found.");return;}
  if(target.role==="owner"){alert("Owner account cannot be deleted from User Management.");return;}

  const name=target.displayName||target.username||"User";

  const ok=await requireCurrentAccountPassword(
    `Permanently Delete User ${name}`,
    "OWNER PASSWORD REQUIRED. This permanently deletes the employee login account and removes the user profile. Historical tip reports will NOT be deleted."
  );
  if(!ok)return;

  if(!confirm(`Permanently delete ${name}? This cannot be undone. Historical tip reports will remain available for future re-linking.`))return;

  try{
    const result=await deleteUserAdmin({uid});
    if(result?.data?.ok===false){
      throw new Error(result.data.message||"Firebase Authentication delete failed.");
    }

    try{
      const ref=doc(db,"users",uid);
      const snap=await getDoc(ref);
      if(snap.exists())await deleteDoc(ref);
    }catch(e){ console.warn("users cleanup:",e); }

    try{
      const ref=doc(db,"signupRequests",uid);
      const snap=await getDoc(ref);
      if(snap.exists())await deleteDoc(ref);
    }catch(e){ console.warn("signupRequests cleanup:",e); }

    try{
      const ds=await getDocs(query(collection(db,"deletedItems"),where("employeeUid","==",uid),limit(100)));
      for(const d of ds.docs){
        const x=d.data()||{};
        if(x.itemType==="user_profile")await deleteDoc(d.ref);
      }
    }catch(e){ console.warn("deletedItems user cleanup:",e); }

    try{
      await writeAudit("user_permanent_delete",uid,name,{
        role:target.role||"",
        historicalReportsPreserved:true
      });
    }catch(e){ console.warn("Permanent delete audit:",e); }

    alert(`${name} was permanently deleted. Historical tip reports were preserved.`);
  }catch(e){
    console.error("Permanent user delete:",e);
    alert(`Permanent delete failed: ${e.code||e.message}`);
  }
};

let creatingAngelaAccounts=false;
async function findWorkAccount(username){
  const snap=await getDocs(query(collection(db,"users"),where("username","==",username),limit(2)));
  if(snap.docs.length>1)throw new Error("More than one account uses "+username+". Review Users first.");
  return snap.docs.length?{uid:snap.docs[0].id,...snap.docs[0].data()}:null;
}
window.createAngelaWorkAccounts=async function(){
  if(currentProfile?.role!=="owner"){alert("Owner access required.");return;}
  if(creatingAngelaAccounts)return;
  const pins=[$("angelaBarPin")?.value||"",$("angelaServerPin")?.value||""];
  if(pins.some(pin=>!/^\d{4}$/.test(pin))){alert("Enter a 4-digit PIN for each Angela account.");return;}
  creatingAngelaAccounts=true;
  const button=$("createAngelaAccountsBtn"),status=$("angelaAccountsStatus");
  if(button)button.disabled=true;
  const messages=[];
  try{
    for(let i=0;i<ANGELA_WORK_PROFILES.length;i++){
      const p=ANGELA_WORK_PROFILES[i],username=slugFor(p.name);
      try{
        let account=await findWorkAccount(username),created=false;
        if(!account){
          const result=await createUserAdmin({username,role:"employee",secret:pins[i]});
          const uid=result?.data?.uid||result?.data?.user?.uid;
          if(uid){const snap=await getDoc(doc(db,"users",uid));if(snap.exists())account={uid,...snap.data()};}
          if(!account)account=await findWorkAccount(username);
          if(!account)throw new Error("Account creation returned, but its user profile could not be verified. Retry to check its status.");
          created=true;
        }
        if(account.role!=="employee" || slugFor(account.username)!==username)
          throw new Error("This username belongs to a different account type. Review Users first.");
        if(account.displayName && ![username,slugFor(p.name)].includes(slugFor(account.displayName)))
          throw new Error("This username has a different display name. Review Users first.");
        const changes={displayName:p.name,workPosition:p.position,personName:p.personName,
          phone:account.phone||RECOVERED_EMPLOYEE_PHONES[p.personName]||""};
        if(created){changes.active=true;changes.approvalStatus="approved";}
        await updateDoc(doc(db,"users",account.uid),changes);
        messages.push(p.name+": "+(created?"CREATED":"ALREADY EXISTS — existing PIN retained")+(account.active===false&&!created?" (disabled; review Users)":""));
      }catch(e){messages.push(p.name+": "+String(e.message||e.code||"Could not create account"));}
      if(status)status.textContent=messages.join("\n");
    }
    populateRoster();
  }finally{
    pins.fill("");
    if($("angelaBarPin"))$("angelaBarPin").value="";
    if($("angelaServerPin"))$("angelaServerPin").value="";
    creatingAngelaAccounts=false;if(button)button.disabled=false;
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
  if(!["manager","owner"].includes(currentProfile.role))return;
  const ok=await requireCurrentAccountPassword(
    "Delete Submission",
    `Enter the ${String(currentProfile.role).toUpperCase()} password currently logged in. This submission will be recoverable by Owner.`
  );
  if(!ok)return;
  try{
    const ref=doc(db,"submissions",id),s=await getDoc(ref),before=s.exists()?s.data():null;
    if(before)await archiveDeletedItem({
      itemType:"submission",itemId:id,label:`Submission • ${before.employee||""} • ${before.date||""}`,
      date:before.date||"",employeeName:before.employee||"",employeeUid:before.employeeUid||"",
      snapshot:before,sourceCollection:"submissions"
    });
    await deleteDoc(ref);
    await writeAudit("delete",id,before?.employee||"",{before});
    await loadDeletedItems();
  }catch(e){alert(`Delete failed: ${e.code||e.message}`);}
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

  const passwordOk=await requireCurrentAccountPassword(
    "Delete All History",
    "OWNER PASSWORD REQUIRED. Deleted history remains recoverable during its Undo window."
  );
  if(!passwordOk)return;

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
  if(!["manager","owner"].includes(currentProfile.role))return;
  const r=latestRows.find(x=>x.id===id);
  const ok=await requireCurrentAccountPassword(
    "Delete Queue Submission",
    `Enter the ${String(currentProfile.role).toUpperCase()} password currently logged in. Owner can restore this submission later.`
  );
  if(!ok)return;
  try{
    const ref=doc(db,"submissions",id),s=await getDoc(ref),before=s.exists()?s.data():r||null;
    if(before)await archiveDeletedItem({
      itemType:"submission",itemId:id,label:`Queue Submission • ${before.employee||""} • ${before.date||""}`,
      date:before.date||"",employeeName:before.employee||"",employeeUid:before.employeeUid||"",
      snapshot:before,sourceCollection:"submissions"
    });
    await deleteDoc(ref);
    await writeAudit("hourly_queue_duplicate_delete",id,before?.employee||"",{before});
    await loadDeletedItems();
  }catch(e){alert(`Delete failed: ${e.code||e.message}`);}
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
  $("hShift").value=r.shift||"AM";
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
  return latestHourlyReports.map(reportForWorkPosition).map(r=>({
    id:r.id||"",
    date:r.date||"",
    employee:r.employee||"",
    position:r.position||"",
    shift:r.shift||"",
    reportKind:r.reportKind||"",hostCashierReport:r.hostCashierReport===true,
    hostCashierTipAM:r.hostCashierTipAM??null,hostCashierTipPM:r.hostCashierTipPM??null,
    ...(es16ExportIsHost(r)?{hostCashierPoolSummary:r.hostCashierPoolSummary??null,hostCashierPoolAM:r.hostCashierPoolAM??null,hostCashierPoolPM:r.hostCashierPoolPM??null,hostCashierCountAM:r.hostCashierCountAM??null,hostCashierCountPM:r.hostCashierCountPM??null}:{}),
    busserAM:r.busserAM==="N/A"?"-":(r.busserAM||"-"),
    hourInAM:r.hourInAM||r.hours?.hourInAM||"",
    hourOutAM:r.hourOutAM||r.hours?.hourOutAM||"",
    hourInPM:r.hourInPM||r.hours?.hourInPM||"",
    hourOutPM:r.hourOutPM||r.hours?.hourOutPM||"",
    hourIn:r.hourIn||r.hours?.hourIn||"",
    hourOut:r.hourOut||r.hours?.hourOut||"",
    totalHoursWork:Number(r.totalHoursWork??r.totalHours??0),
    totalMinutesWork:r.totalMinutesWork??null,
    grandTotal:Number(r.grandTotal||0),
    totalAM:Number(r.totalAM||0),
    totalPM:Number(r.totalPM||0),
    totalTips:Number(r.totalTips||0),
    payCardTipFee:Number(r.payCardTipFee??r.cardFee??0),
    paidTip:Number(r.paidTip||0),
    busserRate:Number(r.busserRate||0),
    busserTipOut:Number(r.busserTipOut||0),
    busserTipOutAM:Number(r.busserTipOutAM||0),
    busserTipOutPM:Number(r.busserTipOutPM||0),
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
    bartenderPeriodReceipts:bartenderReceiptPeriods(r),
    totalBeforeMeal:Number(r.totalBeforeMeal||0),
    cashTip:Number(r.cashTip||0),
    grandTotalTip:Number(r.grandTotalTip||0),
    hourlyRate:Number(r.hourlyRate||0),
    hourlyMinimum:Number(r.hourlyMinimum||0),
    adjustmentSalaryHourly:Number(r.adjustmentSalaryHourly||0),
    adjustmentCandidate:Number(r.adjustmentCandidate??calculatedHourlyAdjustment(r)),
    adjustmentPayoutVersion:r.adjustmentPayoutVersion||"",
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
  rows=rows.map(reportForWorkPosition);
  const header=[
    "Date","Name","Position","Shift","Busser AM",
    "Hour In AM","Hour Out AM","Hour In PM","Hour Out PM","Total Hours Work",
    "Grand Total","Total AM","Total PM","Total Tips","Pay Card Tip Fee","Paid Tip",
    "Busser Rate %","Busser Tip Out","AM Bar Sales","AM Bar Tip","PM Bar Sales","PM Bar Tip",
    "Bar Tip Out","Bartender Shift","Server Sales Summary","Gross @ 0.6%","Less Bartender AM","Less Bartender 2-4","Bar Tip Out Received","Total Before Meal","Cash Tip","Grand Total Tip","Hourly Rate","Hourly Minimum",
    "Adjustment Salary Hourly","Adjustment Decision","Grand Total After Adjustment","Meal",
    "Total Paid Out","Signature Status","Signed At","Status","Finalized By",
    "BAR AM Received","BAR 2-4 Received","BAR PM Received","Adjustment Available"
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

  const cols=header.map((_,i)=>widths[i]||125).map(w=>`<Column ss:AutoFitWidth="0" ss:Width="${w}"/>`).join("");
  const headerRow=`<Row ss:StyleID="Header" ss:Height="34">${header.map(h=>xlsCellString(h)).join("")}</Row>`;

  const dataRows=rows.map(r=>{
    const hours=r.hours||{};
    const shift=String(r.shift||"").toUpperCase();
    const isDouble=shift==="DOUBLE"||(shift==="LONG"&&!!(r.hourInAM||hours.hourInAM));
    const amIn=isDouble?r.hourInAM:(isEarlyShift(shift)?r.hourIn:"");
    const amOut=isDouble?r.hourOutAM:(isEarlyShift(shift)?r.hourOut:"");
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
        xlsCellString(r.finalizedBy,"Body"),
        xlsCellNumber(bartenderPeriodAmount(r,"AM"),"Money14"),
        xlsCellNumber(bartenderPeriodAmount(r,"2PM_4PM"),"Money14"),
        xlsCellNumber(bartenderPeriodAmount(r,"PM"),"Money14"),
        xlsCellNumber(r.adjustmentCandidate??calculatedHourlyAdjustment(r),"Money14")
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
  return `BT /F1 11 Tf ${x} ${y} Td (${pdfEscape(label)}) Tj ET\n`+
         `BT /F2 16 Tf ${x} ${y-17} Td (${pdfEscape(value)}) Tj ET\n`;
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
  if(es16ExportIsHost(r))return hc184PdfReportContent(r,index,total);
  const hours={...r,...(r.hours||{})};
  r={...r,
    hourIn:r.hourIn??hours.hourIn??"",hourOut:r.hourOut??hours.hourOut??"",
    hourInAM:r.hourInAM??hours.hourInAM??"",hourOutAM:r.hourOutAM??hours.hourOutAM??"",
    hourInPM:r.hourInPM??hours.hourInPM??"",hourOutPM:r.hourOutPM??hours.hourOutPM??"",
    payCardTipFee:r.payCardTipFee??r.cardFee??0,
    amBarTip:r.amBarTip??r.amBarTipOut??r.barTipAM??0,
    pmBarTip:r.pmBarTip??r.pmBarTipOut??r.barTipPM??0,
    amBarSales:r.amBarSales??r.barSalesAM??false,
    pmBarSales:r.pmBarSales??r.barSalesPM??false
  };
  const shift=String(r.shift||"").toUpperCase();
  const isDouble=shift==="DOUBLE"||(shift==="LONG"&&!!(r.hourInAM||hours.hourInAM));
  const paidOut=smallReportPaidOut(r);
  const employeeGrandTotal=smallReportGrandTotal(r);
  const position=String(r.position||"Server");
  const bartender=position.toLowerCase()==="bartender";

  const amIn=isDouble?r.hourInAM:(isEarlyShift(shift)?r.hourIn:"-");
  const amOut=isDouble?r.hourOutAM:(isEarlyShift(shift)?r.hourOut:"-");
  const pmIn=isDouble?r.hourInPM:(["PM","LONG"].includes(shift)?r.hourIn:"-");
  const pmOut=isDouble?r.hourOutPM:(["PM","LONG"].includes(shift)?r.hourOut:"-");

  const txt=(font,size,x,y,text)=>`BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET\n`;
  const line=(x1,y1,x2,y2,w=0.6)=>`${w} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
  const box=(x,y,w,h,fill="0.97 0.98 1")=>`${fill} rg ${x} ${y} ${w} ${h} re f\n0.82 0.86 0.91 RG 0.7 w ${x} ${y} ${w} ${h} re S\n0 0 0 rg\n0 0 0 RG\n`;
  const sectionTitle=(x,y,w,title)=>{
    let s=`0.06 0.14 0.25 rg ${x} ${y-18} ${w} 24 re f\n0 0 0 rg\n`;
    s+=txt("F2",10,x+10,y-11,title.toUpperCase());
    // title text is white
    s=s.replace(`BT /F2 10 Tf ${x+10} ${y-11} Td (`, `1 1 1 rg\nBT /F2 10 Tf ${x+10} ${y-11} Td (`)+`0 0 0 rg\n`;
    return s;
  };
  const metric=(x,y,label,value,wide=0)=>{
    const w=wide||156;
    let s=box(x,y-33,w,33,"0.985 0.99 1");
    s+=txt("F1",7.8,x+9,y-13,label);
    s+=txt("F2",12.2,x+9,y-28,value);
    return s;
  };

  let c="";
  // Header band
  c+="0.06 0.14 0.25 rg 0 704 612 88 re f\n0 0 0 rg\n";
  c+="1 1 1 rg\n";
  c+=txt("F2",20,28,758,"FRED ZHANG TIP CALCULATOR");
  c+=txt("F1",9.5,28,740,"EMPLOYEE TIP REPORT");
  c+=txt("F1",9,466,758,`REPORT ${index+1} / ${total}`);
  c+=txt("F1",9,466,741,String(r.date||"-"));
  c+="0 0 0 rg\n";

  // Employee identity card
  c+=box(28,646,556,46,"0.96 0.975 0.995");
  c+=txt("F2",16,42,674,String(r.employee||"Employee"));
  c+=txt("F1",9,42,658,`${position}  |  ${shift||"-"}`);
  c+=txt("F1",8.5,430,674,"STATUS");
  c+=txt("F2",10.5,430,657,String(r.status||"MONEY READY").replaceAll("_"," ").toUpperCase());

  // Work & Sales section
  c+=sectionTitle(28,632,270,"Work & Sales");
  const leftX=28, colW=129, gap=12;
  let y=602;
  const workMetrics=[
    ["Hour In AM",amIn||"-"],["Hour Out AM",amOut||"-"],
    ["Hour In PM",pmIn||"-"],["Hour Out PM",pmOut||"-"],
    ["Total Hours",Number(r.totalHoursWork||0).toFixed(2)],["Busser AM",r.busserAM||"N/A"],
    ["Grand Total",pdfMoney(r.grandTotal)],["Total AM",pdfMoney(r.totalAM)],
    ["Total PM",pdfMoney(r.totalPM)],["Total Tips",pdfMoney(r.totalTips)]
  ];
  for(let i=0;i<workMetrics.length;i+=2){
    c+=metric(leftX,y,workMetrics[i][0],workMetrics[i][1],colW);
    if(workMetrics[i+1])c+=metric(leftX+colW+gap,y,workMetrics[i+1][0],workMetrics[i+1][1],colW);
    y-=43;
  }

  // Tips & deductions section
  c+=sectionTitle(314,632,270,"Tips & Deductions");
  const rx=314; y=602;
  const tipsMetrics=[
    ["Paid Tip",pdfMoney(r.paidTip)],["Card Fee",pdfMoney(r.payCardTipFee)],
    ["Busser AM",pdfMoney(r.busserTipOutAM)],["Busser PM",pdfMoney(r.busserTipOutPM)],
    ["Busser Total",pdfMoney(r.busserTipOut)],[bartender?"Bar Tip Received":"Bar Tip Out",pdfMoney(bartender?r.bartenderBarTipReceived:r.barTipOut)],
    ["AM Bar Sales",pdfBool(r.amBarSales)],["PM Bar Sales",pdfBool(r.pmBarSales)],
    ["AM Bar Tip",pdfMoney(r.amBarTip)],["PM Bar Tip",pdfMoney(r.pmBarTip)]
  ];
  let ty=y;
  for(let i=0;i<tipsMetrics.length;i+=2){
    c+=metric(rx,ty,tipsMetrics[i][0],tipsMetrics[i][1],colW);
    if(tipsMetrics[i+1])c+=metric(rx+colW+gap,ty,tipsMetrics[i+1][0],tipsMetrics[i+1][1],colW);
    ty-=43;
  }

  // Bartender detail panel, only when relevant
  let payoutTop=365;
  if(bartender){
    c+=sectionTitle(28,374,556,"Bartender Calculation");
    const bx=28, bw=128, bg=11;
    const bvals=bartenderReceiptPeriods(r).length?[
      ["BAR AM Received",pdfMoney(bartenderPeriodAmount(r,"AM"))],
      ["BAR 2-4 Received",pdfMoney(bartenderPeriodAmount(r,"2PM_4PM"))],
      ["BAR PM Received",pdfMoney(bartenderPeriodAmount(r,"PM"))],
      ["Periods",bartenderReceiptPeriods(r).map(p=>p.checkpoint==="2PM_4PM"?"2-4":p.checkpoint).join(" + ")],
      ["Received Total",pdfMoney(r.bartenderBarTipReceived)],
      ["Calculation","Sum of periods"]
    ]:[
      ["Shift",String(r.bartenderShiftType||"-").replace("2PM_4PM","2 PM - 4 PM")],
      ["Server Sales",pdfMoney(r.bartenderServerGrandTotalSummary)],
      ["Gross @ 0.6%",pdfMoney(r.bartenderGrossBarTipOut)],
      ["Less AM",pdfMoney(r.bartenderLessAM)],
      ["Less 2-4",pdfMoney(r.bartenderLess24)],
      ["Received",pdfMoney(r.bartenderBarTipReceived)]
    ];
    for(let i=0;i<6;i++) c+=metric(bx+(i%3)*(bw+bg),344-Math.floor(i/3)*43,bvals[i][0],bvals[i][1],bw);
    payoutTop=252;
  }

  // Payout summary - large, separated, no duplicate totals
  c+=sectionTitle(28,payoutTop,556,"Payout Summary");
  const py=payoutTop-48;
  const pboxW=174;
  const pGap=17;
  const payoutVals=[
    ["Total Before Meal",pdfMoney(r.totalBeforeMeal)],
    ["Meal",pdfMoney(r.meal)],
    ["TOTAL PAID OUT",pdfMoney(paidOut)],
    ["Cash Tip",pdfMoney(r.cashTip)],
    ["GRAND TOTAL",pdfMoney(employeeGrandTotal)],
    ["Adjustment",r.adjustmentDecision==="NONE"?"NO ADJUSTMENT":String(r.adjustmentDecision||"PENDING")+" "+pdfMoney(r.adjustmentDecision==='ACCEPTED'?r.adjustmentSalaryHourly:r.adjustmentCandidate??calculatedHourlyAdjustment(r))]
  ];
  for(let i=0;i<3;i++){
    const x=28+i*(pboxW+pGap);
    c+=box(x,py-38,pboxW,42,i===2?"0.90 0.97 0.92":"0.985 0.99 1");
    c+=txt("F1",8.2,x+10,py-15,payoutVals[i][0]);
    c+=txt("F2",14.5,x+10,py-32,payoutVals[i][1]);
  }
  const py2=py-54;
  for(let i=0;i<3;i++){
    const x=28+i*(pboxW+pGap);
    c+=box(x,py2-38,pboxW,42,i===1?"1 0.97 0.86":"0.985 0.99 1");
    c+=txt("F1",8.2,x+10,py2-15,payoutVals[i+3][0]);
    c+=txt("F2",14.5,x+10,py2-32,payoutVals[i+3][1]);
  }

  // Formula note
  if(bartender){
    c+=txt("F1",8,28,94,"Total Paid Out = Total Before Meal - Meal"+(r.adjustmentPayoutVersion?" + Accepted Adjustment":""));
    c+=txt("F1",8,28,81,"Grand Total = Total Before Meal + Cash Tip");
  }else{
    c+=txt("F1",8.5,28,198,"Paid Out = Before Meal - Meal | Grand Total = Before Meal + Cash Tip");
  }

  // Signature & footer
  const sigY=36;
  c+=txt("F2",9,380,sigY+72,"EMPLOYEE SIGNATURE");
  c+=box(380,sigY,204,62,"1 1 1");
  c+=pdfSignatureCommands(r.pickupSignature,390,sigY+8,184,44);
  if(Array.isArray(r.pickupSignature?.strokes) && r.pickupSignature.strokes.length){
    c+=txt("F1",7.5,380,sigY-10,"SIGNED");
  }
  c+=txt("F1",8,28,42,`Generated ${new Date().toLocaleString()}  |  Page ${index+1}`);
  c+=txt("F1",7.5,28,27,"Fred Zhang Tip Calculator - Internal Employee Report");
  return c;
}

function simplePdfBlob(rows){
  rows=rows.map(reportForWorkPosition);
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
  if(blob?.type==='application/pdf' && es18IsAppleMobile()){
    es18OpenPdfPreview(blob,filename);return;
  }
  es18DownloadRaw(blob,filename);
}
function es18DownloadRaw(blob,filename){
  const a=document.createElement("a");
  if(blob?.type==='application/pdf'){a.target='_blank';a.rel='noopener';}
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





function smallReportClockFields(r){
  if(es16ExportIsHost(r))return {in1:"",out1:"",in2:"",out2:""};
  const shift=String(r.shift||"").toUpperCase();
  const amIn=r.hourInAM||r.hours?.hourInAM||"";
  const amOut=r.hourOutAM||r.hours?.hourOutAM||"";
  const pmIn=r.hourInPM||r.hours?.hourInPM||"";
  const pmOut=r.hourOutPM||r.hours?.hourOutPM||"";
  const singleIn=r.hourIn||r.hours?.hourIn||"";
  const singleOut=r.hourOut||r.hours?.hourOut||"";

  // DOUBLE/LONG with a real break has two separate clock pairs.
  if((shift==="DOUBLE"||shift==="LONG") && (amIn||amOut||pmIn||pmOut)){
    return {
      in1:amIn||singleIn,
      out1:amOut||"",
      in2:pmIn||"",
      out2:pmOut||singleOut
    };
  }
  return {in1:singleIn||amIn,in2:"",out1:singleOut||pmOut,out2:""};
}

function smallReportBarAmount(r){
  return String(r.position||"").toLowerCase()==="bartender"
    ? Number(r.bartenderBarTipReceived||0)
    : Number(r.barTipOut||0);
}


function minimumHourlyTarget(r){
  return window.FredTipCalculatorLogic.calculateHourlyAdjustment(r).hourlyMinimum;
}
function adjustmentBaseWithCash(r){
  return Number(r.totalBeforeMeal||0)+Number(r.cashTip||0);
}
function calculatedHourlyAdjustment(r){
  const target=minimumHourlyTarget(r);
  const base=adjustmentBaseWithCash(r);
  return howRoundCent(Math.max(0,target-base));
}
function smallReportPaidOut(r){
  return Number.isFinite(Number(r.totalPaidOut)) && r.totalPaidOut!=null
    ? Number(r.totalPaidOut) : howRoundCent(Math.max(0,Number(r.totalBeforeMeal||0)-Number(r.meal||0)));
}
function smallReportGrandTotal(r){
  return Number.isFinite(Number(r.grandTotalTip)) && r.grandTotalTip!=null
    ? Number(r.grandTotalTip) : howRoundCent(Number(r.totalBeforeMeal||0)+Number(r.cashTip||0));
}

function smallReportSignatureSvg(signature,width=240,height=86){
  const strokes=signature?.strokes;
  if(!Array.isArray(strokes)||!strokes.length)return "";
  const paths=[];
  for(const raw of strokes){
    const pts=Array.isArray(raw)?raw:(Array.isArray(raw?.points)?raw.points:[]);
    if(pts.length<2)continue;
    const d=pts.map((p,i)=>{
      const x=Math.max(0,Math.min(1,Number(p.x||0)))*width;
      const y=Math.max(0,Math.min(1,Number(p.y||0)))*height;
      return `${i===0?"M":"L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    paths.push(`<path d="${d}" fill="none" stroke="#10213c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  if(!paths.length)return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${paths.join("")}</svg>`;
}

function smallReportSignatureHtml(r){
  const svg=smallReportSignatureSvg(r.pickupSignature);
  if(!svg)return `<div class="small-report-signature-pending">PENDING SIGNATURE</div>`;
  return `<div class="small-report-signature">${svg}</div>`;
}


// V13.8.49 ADD-ONLY — signed Daily Report thermal receipt printing.
// This does not alter Daily Report calculations, report rendering, signature storage,
// BAR logic, Hourly Adjustment, Host/Cashier, exports, or any existing workflow.
function smallReportHasPickupSignature(r){
  return Array.isArray(r?.pickupSignature?.strokes) && r.pickupSignature.strokes.length>0;
}
function thermalReportPaidOut(r){
  const paidTip=Number(r?.paidTip||0);
  const meal=Number(r?.meal||0);
  const bartender=String(r?.position||"").toLowerCase()==="bartender";
  const barTipOut=Number(r?.barTipOut||0);
  const barTipReceived=Number(r?.bartenderBarTipReceived||0);
  // Requested thermal receipt formula only:
  // Server = Paid Tip - Bar Tip Out - Meal
  // Bartender = Paid Tip + Bar Tip Out Received - Meal
  return howRoundCent(bartender
    ? paidTip + barTipReceived - meal
    : paidTip - barTipOut - meal);
}
// ES1.8.2 receipt-only informational totals. Cash is never paid twice.
function thermalReportTipBeforeMeal(r){
  const paid=Number(r?.paidTip||0),bar=Number(r?.barTipOut||0),received=Number(r?.bartenderBarTipReceived||0);
  return howRoundCent(String(r?.position||'').toLowerCase()==='bartender'?paid+received:paid-bar);
}
function thermalReportGrandTotalTip(r){return howRoundCent(thermalReportTipBeforeMeal(r)+Number(r?.cashTip||0));}
function thermalReceiptMoney(v){
  return Number(v||0).toLocaleString("en-US",{style:"currency",currency:"USD"});
}
function thermalReceiptSafe(v){
  return String(v??"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
function buildSmallReportThermalHtml(r){
  const bartender=String(r.position||"").toLowerCase()==="bartender";
  // PassPRNT rasterizes HTML. Use a 576px document to match the TSP100IIIBI
  // 72mm / 576-dot printable width so the receipt fills the paper instead of
  // being scaled down from Android's default wide WebView viewport.
  const signature=smallReportSignatureSvg(r.pickupSignature,500,160);
  const rows=[
    ["Name",r.employee||""],
    ["Shift",r.shift||""],
    ["Grand Total",thermalReceiptMoney(r.grandTotal)],
    ["Paid Tip",thermalReceiptMoney(r.paidTip)],
    ["Card Fee",thermalReceiptMoney(r.payCardTipFee??r.cardFee)],
    ["Busser Tip Out (%)",`${Number(r.busserRate||0).toFixed(3)}%`],
    ["Busser Tip Out ($)",thermalReceiptMoney(r.busserTipOut)],
    ["Bar Tip Out",thermalReceiptMoney(r.barTipOut)]
  ];
  if(bartender)rows.push(["Bar Tip Out Received",thermalReceiptMoney(r.bartenderBarTipReceived)]);
  rows.push(["Total Tip Before Meal",thermalReceiptMoney(thermalReportTipBeforeMeal(r))]);
  rows.push(["Meal",thermalReceiptMoney(r.meal)]);
  const rowHtml=rows.map(([label,value])=>`<div class="row"><span>${thermalReceiptSafe(label)}</span><b>${thermalReceiptSafe(value)}</b></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=576,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="format-detection" content="telephone=no"><title>Daily Tip Report</title><style>
    @page{size:80mm auto;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#000;width:576px;max-width:576px;overflow:hidden}
    body{padding:20px 24px 32px;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:500;line-height:1.32}
    .title{text-align:center;font-weight:900;font-size:34px;line-height:1.08;letter-spacing:.3px;margin:0 0 5px}
    .sub{text-align:center;font-weight:700;font-size:20px;line-height:1.15;margin:0 0 14px}
    .rule{border-top:3px dashed #000;margin:10px 0}
    .row{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:5px 0;font-size:24px}
    .row span{flex:1 1 auto;min-width:0}.row b{flex:0 0 auto;text-align:right;max-width:285px;word-break:break-word;font-weight:900}
    .total{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;font-weight:900;font-size:31px;line-height:1.1;padding:10px 0}
    .total span{white-space:nowrap}.total b{text-align:right}
    .payout-note,.tip-note{font-size:18px;line-height:1.3;text-align:center;font-weight:700;margin:4px 0 7px}
    /* ES1.8.3: cash/gross tip are ordinary detail rows; only payout is emphasized. */
    .tip-grand{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;font-size:24px;line-height:1.32;font-weight:400;padding:5px 0;text-transform:none}
    .tip-grand span{flex:1 1 auto;min-width:0}.tip-grand .amount{flex:0 0 auto;text-align:right;max-width:285px;word-break:break-word;font-weight:400}
    .tip-note{font-weight:400}
    .signature-title{text-align:center;font-weight:900;font-size:22px;margin:14px 0 2px}
    .signature{width:100%;height:164px;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .signature svg{display:block;width:500px!important;height:160px!important;max-width:100%}
    .signed{text-align:center;font-size:18px;font-weight:900;margin-top:2px}
    .receipt-note{text-align:center;font-size:28px;font-weight:900;line-height:1.38;margin:18px 6px 0}
    @media print{
      html,body{width:80mm;max-width:80mm}
      body{padding:3mm 3mm 5mm;font-size:14pt}
      .title{font-size:20pt}.sub{font-size:12pt}.row{font-size:14pt;padding:1.2mm 0}
      .total{font-size:16pt;gap:6px}.total span{white-space:normal;min-width:0;flex:1}.total b,.tip-grand .amount{max-width:48%;overflow-wrap:anywhere}.row b{max-width:48%}.tip-grand{font-size:14pt;font-weight:400}.payout-note,.tip-note{font-size:10pt}.signature-title{font-size:13pt}.signed{font-size:11pt}
      .receipt-note{font-size:16pt;line-height:1.38;margin-top:3.5mm}
      .signature{height:23mm}.signature svg{width:68mm!important;height:22mm!important}
    }
  </style></head><body>
    <div class="title">DAILY TIP REPORT</div>
    <div class="sub">Fred Zhang Tip Calculator</div>
    <div class="rule"></div>
    ${rowHtml}
    <div class="row"><span>Cash Tip (already received)</span><b>${thermalReceiptSafe(thermalReceiptMoney(r.cashTip))}</b></div>
    <div class="tip-grand"><span>Grand Total Tip</span><span class="amount">${thermalReceiptSafe(thermalReceiptMoney(thermalReportGrandTotalTip(r)))}</span></div>
    <div class="tip-note">Total Tip Before Meal + Cash Tip<br>Before meal deduction; not an extra payout.</div>
    <div class="rule"></div>
    <div class="total"><span>TOTAL PAID OUT</span><b>${thermalReceiptSafe(thermalReceiptMoney(thermalReportPaidOut(r)))}</b></div>
    <div class="payout-note">Cash Tip is NOT included in Total Paid Out.</div>
    <div class="rule"></div>
    <div class="signature-title">EMPLOYEE SIGNATURE</div>
    <div class="signature">${signature}</div>
    <div class="signed">SIGNED</div>
    <div class="rule"></div>
    <div class="receipt-note"><b>DISCLAIMER:</b><br>This receipt only shows the Paid Out calculation received by the employee. For the complete original detailed report before tip payout, please print it directly from the POS using your own account.</div>
  </body></html>`;
}
function openSmallReportSystemThermalPrint(r){
  es18OpenPrintPreview(buildSmallReportThermalHtml(r),(r.employee||'Employee')+' — Daily Report');
  return true;
}

async function prepareSmallReportPassPrntReturn(r){
  const bridge={
    startedAt:Date.now(),
    expiresAt:Date.now()+5*60*1000,
    role:String(currentProfile?.role||""),
    reportId:String(r?.id||""),
    date:String(r?.date||""),
    employee:String(r?.employee||""),
    dailyReport:true
  };
  localStorage.setItem(PASS_PRNT_BRIDGE_KEY,JSON.stringify(bridge));
  // Persist only for the few seconds while Android hands the page to PassPRNT.
  // The callback validates this same user and migrates back to session persistence.
  await setPersistence(auth,browserLocalPersistence);
  return bridge;
}
async function cancelSmallReportPassPrntReturn(){
  try{localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);}catch(e){}
  try{await setPersistence(auth,browserSessionPersistence);}catch(e){}
}
function openSmallReportStarPassPrnt(r){
  const html=buildSmallReportThermalHtml(r);
  // Star PassPRNT official URL bridge. TSP100IIIBI Bluetooth uses 576-dot / 72mm print width.
  const backUrl=new URL(window.location.href);
  backUrl.searchParams.set(PASS_PRNT_RETURN_PARAM,"1");
  backUrl.searchParams.set("fzPrntRole",String(currentProfile?.role||""));
  backUrl.searchParams.set("fzPrntReport",String(r?.id||""));
  backUrl.searchParams.set("fzPrntDate",String(r?.date||""));
  backUrl.searchParams.set("fzPrntExpires",String(Date.now()+5*60*1000));
  backUrl.searchParams.delete("passprnt_code");
  backUrl.searchParams.delete("passprnt_message");
  const uri="starpassprnt://v1/print/nopreview?"
    +"back="+encodeURIComponent(backUrl.href)
    +"&size=576"
    +"&cut=partial"
    +"&popup=enable"
    +"&html="+encodeURIComponent(html);
  try{
    const a=document.createElement("a");
    a.href=uri;
    a.style.display="none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }catch(e){
    console.warn("Star PassPRNT launch:",e);
    return false;
  }
}
window.printSmallReportThermal=async function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const r=latestHourlyReports.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}
  if(!smallReportHasPickupSignature(r)){
    alert(`Please collect ${r.employee||"employee"}'s signature first. PRINT is available only after the employee has signed.`);
    return;
  }
  // On Android use Star's supported PassPRNT bridge for the paired TSP100IIIBI.
  // Preserve only this authenticated Manager/Owner for the PassPRNT callback,
  // then restore the exact Daily Report without forcing another login.
  if(/Android/i.test(navigator.userAgent||"")){
    try{
      await prepareSmallReportPassPrntReturn(r);
      if(!openSmallReportStarPassPrnt(r)){
        await cancelSmallReportPassPrntReturn();
        openSmallReportSystemThermalPrint(r);
      }
    }catch(e){
      console.error("PassPRNT return bridge:",e);
      await cancelSmallReportPassPrntReturn();
      openSmallReportSystemThermalPrint(r);
    }
    return;
  }
  openSmallReportSystemThermalPrint(r);
};

function restoreSmallReportAfterPassPrnt(state){
  if(!state?.dailyReport || !["manager","owner"].includes(currentProfile?.role||""))return;
  const reportId=String(state.reportId||"");
  const date=String(state.date||"");
  let tries=0;
  const reopen=()=>{
    tries++;
    try{
      // Existing V1 Daily Report UI only — no report calculation/rendering changes.
      if(typeof window.hv1OpenSmallReport==="function")window.hv1OpenSmallReport();
      if(date && $("smallReportDate"))$("smallReportDate").value=date;
      renderSmallReport();
      const report=latestHourlyReports.find(x=>x.id===reportId);
      if(report){
        window.openSmallReportDetail(reportId);
        return;
      }
    }catch(e){console.warn("PassPRNT Daily Report restore:",e);}
    if(tries<24)setTimeout(reopen,250);
  };
  setTimeout(reopen,450);
}

function smallReportFilteredRows(){
  const date=$("smallReportDate")?.value||"";
  const employee=$("smallReportEmployee")?.value||"";
  return [...latestHourlyReports]
    .filter(r=>(!date||r.date===date)&&(!employee||r.employee===employee))
    .sort((a,b)=>{
      const d=String(b.date||"").localeCompare(String(a.date||""));
      return d || String(a.employee||"").localeCompare(String(b.employee||""));
    });
}

function populateSmallReportEmployeeFilter(){
  const sel=$("smallReportEmployee");
  if(!sel)return;
  const current=sel.value;
  const names=[...new Set(latestHourlyReports.map(r=>r.employee).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML=`<option value="">All Employees</option>`+
    names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if(names.includes(current))sel.value=current;
}



window.newHourlyEntryFromSmallReport=function(){
  if(!["manager","owner"].includes(currentProfile?.role||"")) return;
  if(hourlyV1Mode && document.body.classList.contains("hourly-v1-small-report")){
    window.hv1CloseSmallReport();
    alert("Select an employee card on the Tip Calculation Team Board.");
    return;
  }

  // Clear any edit context so the next Submit Final creates a brand-new report.
  currentHourlyReportId="";
  currentHourlySubmissionId="";

  // Reset the underlying Hourly Adjustment fields.
  if($("hDate")) $("hDate").value=todayLocal();
  if($("hEmployee")) $("hEmployee").selectedIndex=0;
  if($("hPosition")) $("hPosition").value="Server";
  if($("hShift")) $("hShift").value="AM";
  if($("hBusserAM")) $("hBusserAM").value="WITHOUT";

  ["hIn","hOut","hAmIn","hAmOut","hPmIn","hPmOut"].forEach(id=>{
    if($(id)) $(id).value="";
  });
  ["hGrandTotal","hTotalAM","hPaidTip","hCardFee","hCashTip","hMeal"].forEach(id=>{
    if($(id)) $(id).value="0";
  });

  if($("hAmBar")) $("hAmBar").value="no";
  if($("hPmBar")) $("hPmBar").value="no";
  if($("hBartenderShiftType")) $("hBartenderShiftType").value="AM";
  if($("hBartenderBarReceived")) $("hBartenderBarReceived").value="0";
  if($("hBtPrevAMInput")) $("hBtPrevAMInput").value="";
  if($("hBtPrev24Input")) $("hBtPrev24Input").value="";

  for(let i=1;i<=9;i++){
    if($(`hBtServerName${i}`)) $(`hBtServerName${i}`).value="";
    if($(`hBtServerGrand${i}`)) $(`hBtServerGrand${i}`).value="";
  }

  $("hourlyEditBanner")?.classList.add("hidden");

  // Open Hourly Adjustment in the correct app mode.
  if(hourlyWorkspaceMode){
    window.openHourlyWorkspacePanel("hourly");
  }else{
    openStaffTab("hourly");
  }

  setTimeout(()=>{
    window.resetHourlyWizard?.(true);
    window.startHourlyWizardFromLegacy?.();
    $("hourly")?.scrollIntoView({behavior:"smooth",block:"start"});
  },100);
};


window.deleteSmallReportRow=async function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||"")) return;
  const row=latestHourlyReports.find(r=>r.id===reportId);
  if(!row){alert("Report not found.");return;}
  const ok=await requireCurrentAccountPassword(
    `Delete ${row.employee||"Daily Report"}`,
    `Enter the ${String(currentProfile.role).toUpperCase()} password currently logged in. The report will move to Owner Deleted / Undo and can be restored.`
  );
  if(!ok)return;
  try{
    await archiveDeletedItem({
      itemType:"hourly_report",itemId:reportId,
      label:`Daily Report • ${row.employee||""} • ${row.date||""}`,
      date:row.date||"",employeeName:row.employee||"",employeeUid:row.employeeUid||"",
      snapshot:row,sourceCollection:"hourlyReports"
    });
    await deleteDoc(doc(db,"hourlyReports",reportId));
    if(currentHourlyReportId===reportId)currentHourlyReportId="";
    await loadDeletedItems();renderSmallReport();
  }catch(e){alert(`Delete failed: ${e.code||e.message}`);}
};

window.deleteAllSmallReportRows=async function(){
  if(currentProfile?.role!=="owner"){alert("Delete All is Owner only.");return;}
  const rows=smallReportFilteredRows();
  if(!rows.length){alert("No Daily Report rows to delete.");return;}
  const ok=await requireCurrentAccountPassword(
    "Delete All Daily Reports",
    `OWNER PASSWORD REQUIRED. ${rows.length} report(s) will move to Deleted / Undo.`
  );
  if(!ok)return;
  try{
    for(const r of rows){
      await archiveDeletedItem({
        itemType:"hourly_report",itemId:r.id,label:`Daily Report • ${r.employee||""} • ${r.date||""}`,
        date:r.date||"",employeeName:r.employee||"",employeeUid:r.employeeUid||"",
        snapshot:r,sourceCollection:"hourlyReports"
      });
    }
    for(let i=0;i<rows.length;i+=400){
      const batch=writeBatch(db);
      rows.slice(i,i+400).forEach(r=>batch.delete(doc(db,"hourlyReports",r.id)));
      await batch.commit();
    }
    currentHourlyReportId="";
    await loadDeletedItems();renderSmallReport();
    alert(`${rows.length} Daily Report row(s) moved to Deleted / Undo.`);
  }catch(e){alert(`Delete All failed: ${e.code||e.message}`);}
};

function buildSmallReportPrintableHtml(rows){
  const safe=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const money=v=>Number(v||0).toLocaleString("en-US",{style:"currency",currency:"USD"});
  const sig=r=>{
    const svg=smallReportSignatureSvg(r.pickupSignature,220,78);
    return svg || '<div style="height:78px;border:1px dashed #c8a64b;display:flex;align-items:center;justify-content:center;font-weight:700">PENDING SIGNATURE</div>';
  };

  return `<!doctype html><html><head><meta charset="utf-8">
    <title>Fred Zhang Daily Report</title>
    <style>
      @page{size:landscape;margin:0.35in}
      *{box-sizing:border-box}
      body{font-family:Arial,sans-serif;color:#111827;margin:0}
      h1{font-size:20px;margin:0 0 4px}
      .sub{font-size:11px;color:#5f6b7a;margin-bottom:12px}
      table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8px}
      th{background:#10213c;color:white;padding:5px 3px;border:1px solid #9eb0c8;white-space:nowrap}
      td{border:1px solid #d4dde8;padding:4px 3px;vertical-align:middle;word-wrap:break-word}
      .sig{width:220px;height:78px}
      .emp{font-weight:700}
    </style></head><body>
    <h1>Fred Zhang Tip Calculator — Daily Report</h1>
    <div class="sub">Generated ${safe(new Date().toLocaleString())}</div>
    <table>
      <thead><tr>
        <th>Date</th><th>Employee</th><th>Shift</th>
        <th>In 1</th><th>Out 1</th><th>In 2</th><th>Out 2</th><th>Total Hrs</th>
        <th>Paid Tips</th><th>Card Fee</th><th>Busser</th><th>Bar Out / Received</th>
        <th>Before Meal</th><th>Cash Tip</th><th>Meal</th><th>Total Paid Out</th><th>Grand Total</th><th style="width:230px">Signature</th>
      </tr></thead>
      <tbody>
      ${rows.map(r=>{
        const c=smallReportClockFields(r);
        return `<tr>
          <td>${safe(r.date||"")}</td>
          <td><span class="emp">${safe(r.employee||"")}</span><br>${safe(r.position||"")}</td>
          <td>${safe(r.shift||"")}</td>
          <td>${safe(c.in1||"")}</td><td>${safe(c.out1||"")}</td>
          <td>${safe(c.in2||"")}</td><td>${safe(c.out2||"")}</td>
          <td>${Number(r.totalHoursWork??r.totalHours??0).toFixed(2)}</td>
          <td>${money(r.paidTip)}</td><td>${money(r.payCardTipFee??r.cardFee)}</td>
          <td>${money(r.busserTipOut)}</td><td>${money(smallReportBarAmount(r))}</td>
          <td>${money(r.totalBeforeMeal)}</td><td>${money(r.cashTip)}</td>
          <td>${money(r.meal)}</td>
          <td><b>${money(smallReportPaidOut(r))}</b></td>
          <td><b>${money(smallReportGrandTotal(r))}</b></td>
          <td class="sig">${sig(r)}</td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>
    </body></html>`;
}

function employeePdfRows(name,date){
  return [...latestHourlyReports].filter(r=>r.employee===name && (!date || r.date===date)).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}
window.refreshEmployeePdfOptions=function(){
  const sel=$('employeePdfName');if(!sel)return;
  const previous=sel.value,date=$('smallReportDate')?.value||'';
  const names=[...new Set(latestHourlyReports.filter(r=>!date || r.date===date).map(r=>r.employee).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">Select employee</option>'+names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
  sel.value=names.includes(previous)?previous:'';
};
window.downloadSelectedEmployeePdf=function(){
  if(!['owner','manager'].includes(currentProfile?.role||''))return;
  const name=$('employeePdfName')?.value||'',date=$('smallReportDate')?.value||'';
  if(!name){alert('Select an employee for the PDF.');return;}
  const rows=employeePdfRows(name,date);
  if(!rows.length){alert('No finalized report for this employee and date.');return;}
  const normalized=rows.map(r=>({...r,totalPaidOut:smallReportPaidOut(r),employeeGrandTotal:smallReportGrandTotal(r)}));
  downloadBlob(simplePdfBlob(normalized),`Fred_Zhang_${slugFor(name)}_${date||'all_dates'}.pdf`);
};

window.downloadSmallReportPdf=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  let rows;try{rows=await es184FinalDailyRows();}catch(e){alert(e.message);return;}
  if(!rows.length){alert("No Daily Report data for this filter.");return;}
  const normalized=rows.map(r=>({
    ...r,
    totalPaidOut:smallReportPaidOut(r),
    employeeGrandTotal:smallReportGrandTotal(r)
  }));
  const date=$("smallReportDate")?.value||todayLocal();
  downloadBlob(simplePdfBlob(normalized),`Fred_Zhang_Small_Report_ALL_${date}.pdf`);
};



function normalizeEmployeeNameKey(v){
  return String(v||"").trim().toLowerCase().replace(/\s+/g," ");
}
function normalizePhone(v){
  const raw=String(v||"").trim();
  if(!raw)return "";
  const plus=raw.startsWith("+");
  const digits=raw.replace(/\D/g,"");
  return plus?`+${digits}`:digits;
}
function rememberEmployeePhone(name,phone,source=""){
  const key=normalizeEmployeeNameKey(name);
  const normalized=normalizePhone(phone);
  if(!key||!normalized)return;
  employeePhoneDirectory.set(key,{phone:normalized,name:String(name||"").trim(),source});
}

async function refreshEmployeePhoneDirectory(force=false){
  if(!["manager","owner","cashier"].includes(currentProfile?.role||"") && !hourlyWorkspaceMode){
    return employeePhoneDirectory;
  }
  if(!force && employeePhoneDirectory.size && Date.now()-employeePhoneDirectoryLoadedAt<60000){
    return employeePhoneDirectory;
  }

  const next=new Map();

  // 0) Recovered restaurant employee phone list (2026-08-24).
  // Firestore/User edits below override this fallback when a newer number exists.
  Object.entries(RECOVERED_EMPLOYEE_PHONES).forEach(([name,phone])=>{
    const key=normalizeEmployeeNameKey(name);
    const normalized=normalizePhone(phone);
    if(key&&normalized) next.set(key,{phone:normalized,name,source:"recovered-2026-08-24"});
  });

  // 1) Existing live users cache.
  for(const u of latestUsers||[]){
    const name=u.displayName||u.username||"";
    const phone=normalizePhone(u.phone||"");
    const key=normalizeEmployeeNameKey(name);
    if(key&&phone) next.set(key,{phone,name,source:"users-cache"});
  }


  // 2) Custom employee master directory.
  // This lets Manager/Owner add employees and phone numbers without creating login credentials.
  try{
    const snap=await getDocs(query(collection(db,"employeeDirectory"),limit(500)));
    snap.forEach(d=>{
      const u=d.data()||{};
      if(u.active===false)return;
      const name=String(u.displayName||u.name||"").trim();
      const phone=normalizePhone(u.phone||"");
      const key=normalizeEmployeeNameKey(name);
      if(name)addDynamicEmployeeName(name);
      if(key&&phone) next.set(key,{phone,name,source:"employeeDirectory",id:d.id});
    });
  }catch(e){
    console.warn("Employee directory Firestore read:",e);
  }

  // Local fallback for environments whose Firestore rules have not yet added employeeDirectory.
  try{
    const local=JSON.parse(localStorage.getItem("fz_employee_directory")||"[]");
    for(const u of Array.isArray(local)?local:[]){
      if(u.active===false)continue;
      const name=String(u.displayName||"").trim();
      const phone=normalizePhone(u.phone||"");
      const key=normalizeEmployeeNameKey(name);
      if(name)addDynamicEmployeeName(name);
      if(key&&phone&&!next.has(key))next.set(key,{phone,name,source:"local-directory",id:u.id||""});
    }
  }catch(e){}

  // 2) Pull all app users directly so the Hourly sub-app does not depend on Owner → Users being open.
  try{
    const snap=await getDocs(query(collection(db,"users"),limit(500)));
    syncEmployeeAccountRoster(snap.docs.map(d=>({uid:d.id,...d.data()})));
    snap.forEach(d=>{
      const u=d.data()||{};
      const name=u.displayName||u.username||"";
      const phone=normalizePhone(u.phone||"");
      const key=normalizeEmployeeNameKey(name);
      if(key&&phone) next.set(key,{phone,name,source:"users"});
    });
  }catch(e){
    console.warn("Employee phone directory users:",e);
  }

  // 3) Fallback to approved signup requests; some legacy employee profiles kept the phone here.
  try{
    const snap=await getDocs(query(collection(db,"signupRequests"),limit(500)));
    snap.forEach(d=>{
      const u=d.data()||{};
      const name=u.displayName||u.name||u.username||"";
      const phone=normalizePhone(u.phone||u.mobilePhone||"");
      const key=normalizeEmployeeNameKey(name);
      if(key&&phone&&!next.has(key)) next.set(key,{phone,name,source:"signupRequests"});
    });
  }catch(e){
    console.warn("Employee phone directory signupRequests:",e);
  }

  employeePhoneDirectory=next;
  employeePhoneDirectoryLoadedAt=Date.now();
  populateRoster();
  populateBartenderServerDropdowns();
  return employeePhoneDirectory;
}


function recoveredPhoneForEmployeeName(name){
  const key=normalizeEmployeeNameKey(name);
  for(const [n,p] of Object.entries(RECOVERED_EMPLOYEE_PHONES)){
    if(normalizeEmployeeNameKey(n)===key)return normalizePhone(p);
  }
  return "";
}

async function phoneForEmployeeName(name){
  await refreshEmployeePhoneDirectory(false);
  const key=normalizeEmployeeNameKey(name);
  let hit=employeePhoneDirectory.get(key);
  if(hit?.phone)return hit.phone;

  // One forced refresh in case the phone was edited recently.
  await refreshEmployeePhoneDirectory(true);
  hit=employeePhoneDirectory.get(key);
  return hit?.phone||"";
}

function findEmployeeUserByName(name){
  const key=normalizeEmployeeNameKey(name);
  if(!key)return null;
  const live=latestUsers.find(u=>
    normalizeEmployeeNameKey(u.displayName||"")===key ||
    normalizeEmployeeNameKey(u.username||"")===key
  );
  if(live)return live;
  const cached=employeePhoneDirectory.get(key);
  return cached?{displayName:cached.name,phone:cached.phone}:null;
}


window.openSmallReportDetail=function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const r=latestHourlyReports.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}
  const c=smallReportClockFields(r);
  const barLabel=String(r.position||"").toLowerCase()==="bartender"?"Bar Tip Out Received":"Bar Tip Out";
  $("smallReportDetailTitle").textContent=r.employee||"Employee Report";
  $("smallReportDetailSub").textContent=`${r.date||""} • ${r.position||""} • ${r.shift||""}`;
  $("smallReportDetailBody").innerHTML=`
    <div class="sr-detail-grid">
      <div><span>Clock In 1</span><b>${esc(c.in1||"-")}</b></div>
      <div><span>Clock Out 1</span><b>${esc(c.out1||"-")}</b></div>
      <div><span>Clock In 2</span><b>${esc(c.in2||"-")}</b></div>
      <div><span>Clock Out 2</span><b>${esc(c.out2||"-")}</b></div>
      <div><span>Total Hours</span><b>${Number(r.totalHoursWork??r.totalHours??0).toFixed(2)}</b></div>
      <div><span>Paid Tip</span><b>${fmtMoney(r.paidTip)}</b></div>
      <div><span>Tip Card Fee</span><b>${fmtMoney(r.payCardTipFee??r.cardFee)}</b></div>
      <div><span>Busser AM</span><b>${fmtMoney(r.busserTipOutAM||0)}</b></div>
      <div><span>Busser PM</span><b>${fmtMoney(r.busserTipOutPM||0)}</b></div>
      <div><span>Busser Total</span><b>${fmtMoney(r.busserTipOut||0)}</b></div>
      <div><span>${barLabel}</span><b>${fmtMoney(smallReportBarAmount(r))}</b></div>
      ${bartenderReceiptPeriods(r).map(p=>`<div><span>BAR ${bartenderPeriodLabel(p.checkpoint)} Received</span><b>${fmtMoney(p.amount)}</b></div>`).join("")}
      <div><span>Total Before Meal</span><b>${fmtMoney(r.totalBeforeMeal)}</b></div>
      <div><span>Cash Tip</span><b>${fmtMoney(r.cashTip)}</b></div>
      <div><span>Meal</span><b>${fmtMoney(r.meal)}</b></div>
      <div class="accent"><span>Total Paid Out</span><b>${fmtMoney(smallReportPaidOut(r))}</b></div>
      <div class="accent grand"><span>Grand Total</span><b>${fmtMoney(smallReportGrandTotal(r))}</b><small>Total Before Meal + Cash Tip</small></div>
    </div>`;
  $("smallReportDetailSignature").innerHTML=smallReportSignatureHtml(r);
  $("smallReportDetailActions").innerHTML=`
    <button class="btn green" type="button" onclick="signSmallReportFromDetail('${r.id}')">${Array.isArray(r.pickupSignature?.strokes)&&r.pickupSignature.strokes.length?"RE-SIGN":"SIGN"}</button>
    ${smallReportHasPickupSignature(r)?`<button class="btn dark" type="button" onclick="printSmallReportThermal('${r.id}')">PRINT</button>`:""}
    <button class="btn gold" type="button" onclick="editSmallReportFromDetail('${r.id}')">EDIT</button>
    <button class="btn red" type="button" onclick="deleteSmallReportFromDetail('${r.id}')">DELETE</button>`;
  const modal=$("smallReportDetailModal");
  modal.classList.remove("hidden");
  modal.style.display="flex";
  document.body.classList.add("small-report-modal-open");
  requestAnimationFrame(()=>modal.querySelector(".small-report-detail-modalbox")?.scrollTo(0,0));
};
window.closeSmallReportDetail=function(){
  const modal=$("smallReportDetailModal");
  modal?.classList.add("hidden");
  if(modal)modal.style.display="none";
  document.body.classList.remove("small-report-modal-open");
  // Always return to V1 Daily Report — never to legacy Hourly V01.
  if(hourlyV1Mode){
    document.body.classList.add("hourly-v1-mode","hourly-v1-small-report");
    $("hourlyV1Workspace")?.classList.remove("hidden");
    $("hv1SmallReportBox")?.classList.remove("hidden");
  }
};
document.addEventListener("click",e=>{
  if(e.target?.id==="smallReportDetailModal")closeSmallReportDetail();
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape" && !$("smallReportDetailModal")?.classList.contains("hidden"))closeSmallReportDetail();
});

window.signSmallReportFromDetail=function(id){
  closeSmallReportDetail();
  signSmallReport(id);
};
window.editSmallReportFromDetail=function(id){
  closeSmallReportDetail();
  editSubmittedHourlyFromSmallReport(id);
};
window.deleteSmallReportFromDetail=function(id){
  closeSmallReportDetail();
  deleteSmallReportRow(id);
};

window.signSmallReport=function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const r=latestHourlyReports.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}

  // Reuse the existing employee signature pad and store the signature
  // directly on this hourlyReports record.
  window.markMoneyPickedUp(
    r.id,
    r.sourceSubmissionId||"",
    r.employee||""
  );
};


function smsBodyUrl(phone,message){
  const clean=normalizePhone(phone);
  const isApple=/iPad|iPhone|iPod/.test(navigator.userAgent);
  // iOS commonly accepts '&body=', Android commonly accepts '?body='.
  return `sms:${clean}${isApple?"&":"?"}body=${encodeURIComponent(message)}`;
}

async function openNativeSmsComposer(phone,message){
  const clean=normalizePhone(phone);
  if(!clean)return false;

  const url=smsBodyUrl(clean,message);

  // Must be triggered from the user's click. Use a real <a> instead of
  // assigning window.location, which is less reliable in some Android/PWA builds.
  try{
    const a=document.createElement("a");
    a.href=url;
    a.style.display="none";
    a.setAttribute("rel","noopener");
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }catch(e){
    console.warn("Native SMS composer:",e);
  }

  // Last fallback: copy number + message so it is never lost.
  try{
    await navigator.clipboard?.writeText(`${clean}\n${message}`);
    alert(`Could not open the SMS app. Phone number and message were copied.\n\n${clean}`);
  }catch(e){
    alert(`Could not open the SMS app.\n\nPhone: ${clean}\n\nMessage:\n${message}`);
  }
  return false;
}

window.sendSmallReportSms=async function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const r=latestHourlyReports.find(x=>x.id===reportId);
  if(!r){alert("Report not found.");return;}

  const hasSignature=Array.isArray(r.pickupSignature?.strokes)&&r.pickupSignature.strokes.length;
  if(!hasSignature){
    alert(`Please collect ${r.employee||"employee"}'s signature first. The employee PDF must include the signature.`);
    return;
  }

  // Resolve ONE employee phone by exact employee name.
  // Do not invoke the generic share sheet because that opens a contact/recipient chooser.
  const phone=await phoneForEmployeeName(r.employee);
  if(!phone){
    alert(`No mobile phone found for ${r.employee||"this employee"}. Add/update the Employee Phone Directory first.`);
    return;
  }

  const rr={
    ...r,
    totalPaidOut:smallReportPaidOut(r),
    employeeGrandTotal:smallReportGrandTotal(r)
  };
  const blob=simplePdfBlob([rr]);
  const safeName=String(r.employee||"Employee").replace(/[^a-z0-9_-]+/gi,"_");
  const filename=`Fred_Zhang_Tip_Report_${safeName}_${r.date||todayLocal()}.pdf`;
  let portalLink="";
  try{
    const token=await fzEnsureEmployeePortal(r.employee,latestHourlyReports);
    if(token)portalLink=fzPortalUrl(token);
  }catch(e){console.warn("Private report portal link:",e);}
  const msg=`Hi ${r.employee||""}, your complete signed tip report for ${r.date||""} (${r.shift||""}) is ready. Total Paid Out: ${fmtMoney(smallReportPaidOut(r))}. Cash Tip: ${fmtMoney(r.cashTip)}. Grand Total: ${fmtMoney(smallReportGrandTotal(r))}.${portalLink?` View all your work reports without signing up: ${portalLink}`:""} The complete PDF has been downloaded on this device; attach that PDF to this message.`;

  // Browser security does not allow a website to silently attach a local PDF
  // to an SMS/MMS while also forcing a specific recipient. We therefore:
  // 1) download the exact signed PDF, then
  // 2) open the native SMS composer already addressed to the employee's exact number.
  downloadBlob(blob,filename);

  const ok=await openNativeSmsComposer(phone,msg);
  if(ok){
    setTimeout(()=>{
      alert(`SMS opened directly for ${r.employee||"employee"} at ${phone}. Attach ${filename} from Downloads, then Send.`);
    },500);
  }
};
window.editSubmittedHourlyFromSmallReport=function(reportId){
  if(!["manager","owner"].includes(currentProfile?.role||"")) return;
  const row=latestHourlyReports.find(r=>r.id===reportId);
  if(!row){ alert("Report not found."); return; }

  // Reuse the existing finalized-report editor so we update the SAME report,
  // not create a duplicate.
  if(typeof window.editHourlyReport==="function"){
    currentHourlyReportId=reportId;
    window.editHourlyReport(reportId);

    if(hourlyWorkspaceMode){
      setTimeout(()=>window.openHourlyWorkspacePanel("hourly"),80);
    }else{
      openStaffTab("hourly");
    }

    setTimeout(()=>{
      window.startHourlyWizardFromLegacy?.();
      $("hourly")?.scrollIntoView({behavior:"smooth",block:"start"});
    },120);
    return;
  }

  alert("Edit function is unavailable in this build.");
};



function employeeDirectoryDocId(name){
  return "emp_"+normalizeEmployeeNameKey(name).replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
}
function loadLocalEmployeeDirectory(){
  try{
    const x=JSON.parse(localStorage.getItem("fz_employee_directory")||"[]");
    return Array.isArray(x)?x:[];
  }catch(e){return [];}
}
function saveLocalEmployeeDirectoryRow(row,oldName=""){
  const rows=loadLocalEmployeeDirectory();
  const oldKey=normalizeEmployeeNameKey(oldName);
  const newKey=normalizeEmployeeNameKey(row.displayName);
  const filtered=rows.filter(x=>{
    const k=normalizeEmployeeNameKey(x.displayName);
    return k!==oldKey && k!==newKey;
  });
  filtered.push(row);
  localStorage.setItem("fz_employee_directory",JSON.stringify(filtered));
}
function deleteLocalEmployeeDirectoryName(name){
  const key=normalizeEmployeeNameKey(name);
  const rows=loadLocalEmployeeDirectory().filter(x=>normalizeEmployeeNameKey(x.displayName)!==key);
  localStorage.setItem("fz_employee_directory",JSON.stringify(rows));
}

window.openEmployeeDirectoryEditor=function(name=""){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  try{name=decodeURIComponent(name||"");}catch(e){}
  const key=normalizeEmployeeNameKey(name);
  const hit=employeePhoneDirectory.get(key);
  $("employeeDirectoryOldName").value=name||"";
  $("employeeDirectoryName").value=name||hit?.name||"";
  $("employeeDirectoryPhone").value=hit?.phone||recoveredPhoneForEmployeeName(name)||"";
  $("employeeDirectoryModalTitle").textContent=name?"Edit Employee / Phone":"Add Employee";
  $("employeeDirectoryModal").classList.remove("hidden");
  $("employeeDirectoryModal").style.display="flex";
  setTimeout(()=>$("employeeDirectoryName")?.focus(),50);
};
window.closeEmployeeDirectoryEditor=function(){
  $("employeeDirectoryModal").classList.add("hidden");
  $("employeeDirectoryModal").style.display="none";
};

window.saveEmployeeDirectoryEditor=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const oldName=String($("employeeDirectoryOldName")?.value||"").trim();
  const name=String($("employeeDirectoryName")?.value||"").trim().replace(/\s+/g," ");
  const phone=normalizePhone($("employeeDirectoryPhone")?.value||"");

  if(!name){alert("Employee Name is required.");return;}
  if(phone&&!/^\+?\d{7,15}$/.test(phone)){alert("Enter a valid mobile phone number.");return;}

  const row={
    displayName:name,
    phone,
    active:true,
    updatedBy:currentProfile.displayName||currentProfile.username||"",
    updatedAt:Date.now()
  };

  // Immediate local persistence so the feature still works if Firestore rules
  // have not yet been updated for employeeDirectory.
  saveLocalEmployeeDirectoryRow(row,oldName);
  if(oldName && normalizeEmployeeNameKey(oldName)!==normalizeEmployeeNameKey(name)){
    removeDynamicEmployeeName(oldName);
  }
  addDynamicEmployeeName(name);

  let cloudSaved=false;
  try{
    const newId=employeeDirectoryDocId(name);
    await setDoc(doc(db,"employeeDirectory",newId),{
      displayName:name,
      phone,
      active:true,
      updatedBy:currentProfile.displayName||currentProfile.username||"",
      updatedAt:serverTimestamp()
    },{merge:true});
    cloudSaved=true;

    if(oldName && normalizeEmployeeNameKey(oldName)!==normalizeEmployeeNameKey(name)){
      const oldId=employeeDirectoryDocId(oldName);
      try{
        await setDoc(doc(db,"employeeDirectory",oldId),{
          active:false,
          replacedBy:newId,
          updatedBy:currentProfile.displayName||currentProfile.username||"",
          updatedAt:serverTimestamp()
        },{merge:true});
      }catch(e){}
    }
  }catch(e){
    console.warn("Employee directory cloud save:",e);
  }

  // If Owner edits an employee who already has an application login,
  // update the live user profile too.
  if(currentProfile?.role==="owner"){
    const existing=latestUsers.find(u=>
      normalizeEmployeeNameKey(u.displayName||u.username)===normalizeEmployeeNameKey(oldName||name)
    );
    if(existing?.uid){
      try{
        await updateDoc(doc(db,"users",existing.uid),{displayName:name,phone});
        const req=doc(db,"signupRequests",existing.uid);
        const reqSnap=await getDoc(req);
        if(reqSnap.exists()) await updateDoc(req,{displayName:name,phone});
      }catch(e){console.warn("Live user phone/name update:",e);}
    }
  }

  employeePhoneDirectoryLoadedAt=0;
  closeEmployeeDirectoryEditor();
  await refreshPhoneDirectoryUi();

  if(cloudSaved){
    alert(`${name} saved to the shared employee directory.`);
  }else{
    alert(`${name} saved on this device. Shared Firestore directory write is currently blocked by database rules.`);
  }
};

window.refreshPhoneDirectoryUi=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const el=$("phoneDirectoryStatus");
  if(el)el.textContent="Loading employee phone numbers...";
  await refreshEmployeePhoneDirectory(true);
  if(el)el.textContent=`Employee phone directory: ${employeePhoneDirectory.size} number(s) loaded (recovered list + live database).`;
  renderPhoneDirectoryList();
};

window.renderPhoneDirectoryList=function(){
  const host=$("phoneDirectoryList");
  if(!host)return;
  const rows=[...employeePhoneDirectory.values()].sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")));
  host.innerHTML=rows.length?rows.map(r=>`
    <div class="phone-directory-row">
      <b>${esc(r.name||"")}</b>
      <span>${esc(r.phone||"")}</span>
      <button class="btn light" type="button" onclick="openNativeSmsComposer('${esc(r.phone||"")}','Hi ${esc(r.name||"")},')">SMS</button>
      <button class="btn gold" type="button" onclick="openEmployeeDirectoryEditor('${encodeURIComponent(r.name||"")}')">EDIT</button>
      <div class="phone-source">${esc(r.source||"directory")}</div>
    </div>`).join(""):'<div class="notice">No phone numbers loaded.</div>';
};

window.clearSmallReportFilters=function(){
  if($("smallReportDate"))$("smallReportDate").value="";
  if($("smallReportEmployee"))$("smallReportEmployee").value="";
  renderSmallReport();
};
window.smallReportToday=function(){
  if($("smallReportDate"))$("smallReportDate").value=todayLocal();
  renderSmallReport();
};
window.smallReportYesterday=function(){
  const d=new Date();
  d.setDate(d.getDate()-1);
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");
  if($("smallReportDate"))$("smallReportDate").value=`${y}-${m}-${day}`;
  renderSmallReport();
};

window.renderSmallReport=function(){
  window.refreshEmployeePdfOptions();
  populateSmallReportEmployeeFilter();
  refreshEmployeePhoneDirectory(false).then(()=>{
    const el=$("phoneDirectoryStatus");
    if(el)el.textContent=`Employee phone directory: ${employeePhoneDirectory.size} number(s) loaded (recovered list + live database).`;
    renderPhoneDirectoryList();
  }).catch(()=>{});
  const body=$("smallReportBody"),summary=$("smallReportSummary");
  if(!body||!summary)return;

  const rows=smallReportFilteredRows();
  const signed=rows.filter(r=>Array.isArray(r.pickupSignature?.strokes)&&r.pickupSignature.strokes.length).length;
  const totalHours=rows.reduce((a,r)=>a+Number(r.totalHoursWork??r.totalHours??0),0);
  const paidOutTotal=rows.reduce((a,r)=>a+smallReportPaidOut(r),0);
  const grandTotalAll=rows.reduce((a,r)=>a+smallReportGrandTotal(r),0);

  summary.innerHTML=`
    <div class="kpi"><span>Reports</span><b>${rows.length}</b></div>
    <div class="kpi"><span>Total Hours</span><b>${totalHours.toFixed(2)}</b></div>
    <div class="kpi"><span>Total Paid Out</span><b>${fmtMoney(paidOutTotal)}</b></div>
    <div class="kpi"><span>Grand Total</span><b>${fmtMoney(grandTotalAll)}</b><div class="small">Total Before Meal + Cash Tip</div></div>
    <div class="kpi"><span>Signatures</span><b>${signed}/${rows.length}</b></div>`;

  if(!rows.length){
    body.innerHTML='<tr><td colspan="1" style="padding:24px;text-align:center">No finalized Hourly Adjustment reports for this filter.</td></tr>';
    return;
  }

  body.innerHTML=rows.map(r=>{
    return `<tr class="small-report-name-row">
      <td>
        <button class="small-report-name-btn" type="button" onclick="openSmallReportDetail('${r.id}')">
          ${esc(r.employee||"")}
        </button>
      </td>
    </tr>`;
  }).join("");
};

function smallReportHtmlXlsBlob(rows){
  if(rows.length&&rows.every(es16ExportIsHost))return es16DailyXlsBlob(rows,'host-cashier',rows[0].date||'');
  const escH=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const money=v=>Number(v||0).toLocaleString("en-US",{style:"currency",currency:"USD"});
  const signatureDataUri=signature=>{
    const svg=smallReportSignatureSvg(signature,240,86);
    if(!svg)return "";
    return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));
  };

  const body=rows.map(r=>{
    const c=smallReportClockFields(r);
    const bar=smallReportBarAmount(r);
    const sig=signatureDataUri(r.pickupSignature);
    const sigCell=sig
      ? `<img src="${sig}" width="240" height="86" style="display:block;border:1px solid #ccd6e5">`
      : `<div style="width:240px;height:86px;display:flex;align-items:center;justify-content:center;border:1px dashed #c8a64b;background:#fff8df;font-weight:bold">PENDING SIGNATURE</div>`;

    return `<tr style="height:96px">
      <td>${escH(r.date||"")}</td>
      <td><b>${escH(r.employee||"")}</b><br><span>${escH(r.position||"")}</span></td>
      <td>${escH(r.shift||"")}</td>
      <td>${escH(c.in1||"")}</td>
      <td>${escH(c.out1||"")}</td>
      <td>${escH(c.in2||"")}</td>
      <td>${escH(c.out2||"")}</td>
      <td>${Number(r.totalHoursWork??r.totalHours??0).toFixed(2)}</td>
      <td>${money(r.paidTip)}</td>
      <td>${money(r.payCardTipFee??r.cardFee)}</td>
      <td>${money(r.busserTipOutAM||0)}</td>
      <td>${money(r.busserTipOutPM||0)}</td>
      <td>${money(r.busserTipOut||0)}</td>
      <td>${money(bar)}</td>
      <td>${money(r.totalBeforeMeal)}</td>
      <td>${money(r.cashTip)}</td>
      <td>${money(r.meal)}</td>
      <td><b>${money(smallReportPaidOut(r))}</b></td>
      <td><b>${money(smallReportGrandTotal(r))}</b></td>
      <td style="width:260px;height:96px">${sigCell}</td>
    </tr>`;
  }).join("");

  const html=`<!DOCTYPE html>
  <html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:x="urn:schemas-microsoft-com:office:excel"
        xmlns="http://www.w3.org/TR/REC-html40">
  <head>
    <meta charset="UTF-8">
    <style>
      table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:12pt}
      th{background:#10213c;color:#fff;font-weight:bold;text-align:center;vertical-align:middle;border:1px solid #9fb0c8;padding:8px;white-space:nowrap}
      td{border:1px solid #cdd7e5;padding:8px;vertical-align:middle;white-space:nowrap}
      .sig{width:260px}
    </style>
  </head>
  <body>
    <table>
      <colgroup>
        <col style="width:95px"><col style="width:180px"><col style="width:90px">
        <col style="width:90px"><col style="width:90px"><col style="width:90px"><col style="width:90px">
        <col style="width:95px"><col style="width:110px"><col style="width:110px">
        <col style="width:115px"><col style="width:145px"><col style="width:145px">
        <col style="width:110px"><col style="width:130px"><col style="width:260px">
      </colgroup>
      <thead><tr>
        <th>Date</th><th>Employee</th><th>Shift</th>
        <th>Clock In 1</th><th>Clock Out 1</th><th>Clock In 2</th><th>Clock Out 2</th>
        <th>Total Hours</th><th>Paid Tips</th><th>Tip Card Fee</th>
        <th>Busser AM</th><th>Busser PM</th><th>Busser Total</th><th>Bar Tip Out / Received</th>
        <th>Total Tip Before Meal</th><th>Cash Tip</th><th>Meal</th><th>Total Paid Out</th><th>Grand Total (Total Before Meal + Cash Tip)</th><th>Signature</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body></html>`;

  return new Blob([html],{type:"application/vnd.ms-excel"});
}

window.downloadSmallReportXls=async function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  let rows;try{rows=await es184FinalDailyRows();}catch(e){alert(e.message);return;}
  if(!rows.length){alert("No Daily Report data for this filter.");return;}
  const date=$("smallReportDate")?.value||todayLocal();
  downloadBlob(smallReportHtmlXlsBlob(rows),`Fred_Zhang_Small_Report_${date}.xls`);
};

window.shareSmallReportXls=async function(target){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const rows=smallReportFilteredRows();
  if(!rows.length){alert("No Daily Report data for this filter.");return;}
  const date=$("smallReportDate")?.value||todayLocal();
  await shareReportFile(smallReportHtmlXlsBlob(rows),`Fred_Zhang_Small_Report_${date}.xls`,target);
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
    alert("Please sign before saving the signature.");
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

    alert(`Signature saved for ${employee||"employee"}. Removed ${matches.length} matching Server Room board item(s).`);
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


let analyticsMetric="sales";
let analyticsPeriod="daily";

const ANALYTICS_METRICS={
  sales:{label:"Sales",money:true,value:r=>Number(r.grandTotal||0)},
  tip:{label:"Tip",money:true,value:r=>Number(r.totalBeforeMeal||0)+Number(r.cashTip||0)},
  paidout:{label:"Paid Out",money:true,value:r=>Number(r.totalBeforeMeal||0)-Number(r.meal||0)},
  cash:{label:"Cash Tip",money:true,value:r=>Number(r.cashTip||0)},
  busser:{label:"Busser",money:true,value:r=>Number(r.busserTipOut||0)},
  bar:{label:"Bar",money:true,value:r=>Math.max(0,Number(smallReportBarAmount(r)||0))},
  tips:{label:"Paid Tips",money:true,value:r=>Number(r.paidTip||0)},
  hours:{label:"Hours",money:false,value:r=>Number(r.totalHoursWork??r.totalHours??0)}
};

function analyticsDateObject(s){
  const m=String(s||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),12,0,0);
}
function analyticsIso(d){
  const z=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function analyticsWeekStart(dateStr){
  const d=analyticsDateObject(dateStr); if(!d)return "";
  const day=d.getDay();
  const delta=(day+6)%7; // Monday
  d.setDate(d.getDate()-delta);
  return analyticsIso(d);
}
function analyticsMonthKey(dateStr){
  return String(dateStr||"").slice(0,7);
}
function analyticsBucketKey(dateStr){
  if(analyticsPeriod==="weekly")return analyticsWeekStart(dateStr);
  if(analyticsPeriod==="monthly")return analyticsMonthKey(dateStr);
  return String(dateStr||"");
}
function analyticsBucketLabel(key){
  if(analyticsPeriod==="monthly"){
    const [y,m]=key.split("-").map(Number);
    if(!y||!m)return key;
    return new Date(y,m-1,1).toLocaleDateString(undefined,{month:"short",year:"numeric"});
  }
  if(analyticsPeriod==="weekly"){
    const d=analyticsDateObject(key);
    return d?`Week of ${d.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`:key;
  }
  const d=analyticsDateObject(key);
  return d?d.toLocaleDateString(undefined,{month:"short",day:"numeric"}):key;
}
function analyticsValueText(v){
  const cfg=ANALYTICS_METRICS[analyticsMetric]||ANALYTICS_METRICS.sales;
  if(cfg.money)return fmtMoney(v);
  return `${Number(v||0).toFixed(2)} h`;
}
function populateAnalyticsEmployeeFilter(){
  const sel=$("analyticsEmployee"); if(!sel)return;
  const current=sel.value||"";
  const names=[...new Set(latestHourlyReports.map(r=>String(r.employee||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">All Employees</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if(names.includes(current))sel.value=current;
}
function analyticsFilteredReports(){
  const from=$("analyticsFrom")?.value||"";
  const to=$("analyticsTo")?.value||"";
  const employee=$("analyticsEmployee")?.value||"";
  return latestHourlyReports.filter(r=>{
    const d=String(r.date||"");
    return d && (!from||d>=from) && (!to||d<=to) && (!employee||String(r.employee||"")===employee);
  });
}
function analyticsSeries(){
  const metric=ANALYTICS_METRICS[analyticsMetric]||ANALYTICS_METRICS.sales;
  const buckets=new Map();
  analyticsFilteredReports().forEach(r=>{
    const key=analyticsBucketKey(r.date);
    if(!key)return;
    buckets.set(key,(buckets.get(key)||0)+Math.max(0,Number(metric.value(r)||0)));
  });
  return [...buckets.entries()]
    .map(([key,value])=>({key,label:analyticsBucketLabel(key),value}))
    .sort((a,b)=>a.key.localeCompare(b.key));
}
function analyticsNiceMax(max){
  if(max<=0)return 1;
  const pow=Math.pow(10,Math.floor(Math.log10(max)));
  const n=max/pow;
  const nice=n<=1?1:n<=2?2:n<=5?5:10;
  return nice*pow;
}
function analyticsCompact(v){
  const cfg=ANALYTICS_METRICS[analyticsMetric]||ANALYTICS_METRICS.sales;
  if(!cfg.money)return Number(v).toFixed(v>=100?0:1);
  const a=Math.abs(v);
  if(a>=1e6)return `$${(v/1e6).toFixed(1)}M`;
  if(a>=1e3)return `$${(v/1e3).toFixed(1)}K`;
  return `$${Number(v).toFixed(0)}`;
}

window.setAnalyticsMetric=function(metric){
  if(!ANALYTICS_METRICS[metric])return;
  analyticsMetric=metric;
  document.querySelectorAll("[data-chart-metric]").forEach(b=>b.classList.toggle("on",b.dataset.chartMetric===metric));
  renderAnalyticsChart();
};
window.setAnalyticsPeriod=function(period){
  if(!["daily","weekly","monthly"].includes(period))return;
  analyticsPeriod=period;
  document.querySelectorAll("[data-chart-period]").forEach(b=>b.classList.toggle("on",b.dataset.chartPeriod===period));
  renderAnalyticsChart();
};
window.analyticsRangeDays=function(days){
  const to=new Date();
  const from=new Date();
  from.setDate(to.getDate()-Math.max(0,Number(days)-1));
  if($("analyticsTo"))$("analyticsTo").value=analyticsIso(to);
  if($("analyticsFrom"))$("analyticsFrom").value=analyticsIso(from);
  renderAnalyticsChart();
};
window.analyticsAllHistory=function(){
  if($("analyticsFrom"))$("analyticsFrom").value="";
  if($("analyticsTo"))$("analyticsTo").value="";
  renderAnalyticsChart();
};

window.renderAnalyticsChart=function(){
  const host=$("analyticsChart"); if(!host)return;
  populateAnalyticsEmployeeFilter();

  const data=analyticsSeries();
  const cfg=ANALYTICS_METRICS[analyticsMetric]||ANALYTICS_METRICS.sales;
  const employee=$("analyticsEmployee")?.value||"All Employees";

  if($("analyticsMetricLabel"))$("analyticsMetricLabel").textContent=cfg.label;
  if($("analyticsChartTitle"))$("analyticsChartTitle").textContent=`${cfg.label} Trend`;
  if($("analyticsChartSubtitle"))$("analyticsChartSubtitle").textContent=`${analyticsPeriod[0].toUpperCase()+analyticsPeriod.slice(1)} • ${employee}`;

  if(!data.length){
    ["analyticsTotal","analyticsAverage","analyticsHigh","analyticsLastValue"].forEach(id=>{if($(id))$(id).textContent=analyticsValueText(0)});
    if($("analyticsChange"))$("analyticsChange").textContent="—";
    if($("analyticsHighLabel"))$("analyticsHighLabel").textContent="—";
    host.innerHTML='<div class="analytics-empty"><b>No finalized report data</b><span>Change the date range or employee filter.</span></div>';
    return;
  }

  const total=data.reduce((a,x)=>a+x.value,0);
  const avg=total/data.length;
  const high=data.reduce((a,x)=>x.value>a.value?x:a,data[0]);
  const first=data[0].value,last=data[data.length-1].value;
  const change=first===0?(last===0?0:null):((last-first)/Math.abs(first))*100;

  if($("analyticsTotal"))$("analyticsTotal").textContent=analyticsValueText(total);
  if($("analyticsAverage"))$("analyticsAverage").textContent=analyticsValueText(avg);
  if($("analyticsHigh"))$("analyticsHigh").textContent=analyticsValueText(high.value);
  if($("analyticsHighLabel"))$("analyticsHighLabel").textContent=high.label;
  if($("analyticsLastValue"))$("analyticsLastValue").textContent=analyticsValueText(last);
  if($("analyticsChange")){
    $("analyticsChange").textContent=change===null?"NEW":`${change>=0?"+":""}${change.toFixed(1)}%`;
    $("analyticsChange").classList.toggle("analytics-positive",change!==null&&change>=0);
    $("analyticsChange").classList.toggle("analytics-negative",change!==null&&change<0);
  }

  const W=1000,H=420, pad={l:72,r:28,t:28,b:58};
  const innerW=W-pad.l-pad.r, innerH=H-pad.t-pad.b;
  const maxY=analyticsNiceMax(Math.max(...data.map(x=>x.value))*1.08);
  const x=(i)=>data.length===1?pad.l+innerW/2:pad.l+(i/(data.length-1))*innerW;
  const y=(v)=>pad.t+innerH-(Math.max(0,v)/maxY)*innerH;

  const line=data.map((d,i)=>`${i===0?"M":"L"} ${x(i).toFixed(2)} ${y(d.value).toFixed(2)}`).join(" ");
  const area=`M ${x(0).toFixed(2)} ${(pad.t+innerH).toFixed(2)} L ${data.map((d,i)=>`${x(i).toFixed(2)} ${y(d.value).toFixed(2)}`).join(" L ")} L ${x(data.length-1).toFixed(2)} ${(pad.t+innerH).toFixed(2)} Z`;

  const yTicks=[0,.25,.5,.75,1].map(t=>{
    const val=maxY*(1-t), yy=pad.t+innerH*t;
    return `<g><line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" class="stock-grid-line"/><text x="${pad.l-12}" y="${yy+4}" text-anchor="end" class="stock-axis-text">${esc(analyticsCompact(val))}</text></g>`;
  }).join("");

  const maxLabels=window.innerWidth<600?4:window.innerWidth<900?6:10;
  const step=Math.max(1,Math.ceil(data.length/maxLabels));
  const xLabels=data.map((d,i)=>{
    if(i%step!==0 && i!==data.length-1)return "";
    return `<text x="${x(i)}" y="${H-20}" text-anchor="middle" class="stock-axis-text">${esc(d.label)}</text>`;
  }).join("");

  const points=data.map((d,i)=>`
    <g class="stock-point-group">
      <circle cx="${x(i)}" cy="${y(d.value)}" r="5" class="stock-point"/>
      <circle cx="${x(i)}" cy="${y(d.value)}" r="14" class="stock-point-hit">
        <title>${esc(d.label)} — ${esc(analyticsValueText(d.value))}</title>
      </circle>
    </g>`).join("");

  host.innerHTML=`
    <svg viewBox="0 0 ${W} ${H}" class="stock-svg" role="img" aria-label="${esc(cfg.label)} trend chart">
      <defs>
        <linearGradient id="stockAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2563eb" stop-opacity=".28"/>
          <stop offset="100%" stop-color="#2563eb" stop-opacity=".02"/>
        </linearGradient>
      </defs>
      ${yTicks}
      <path d="${area}" fill="url(#stockAreaGradient)"/>
      <path d="${line}" class="stock-line"/>
      ${points}
      ${xLabels}
    </svg>
    <div class="stock-chart-foot"><span>${data.length} period${data.length===1?"":"s"}</span><span>Hover/tap a point for value</span></div>`;
};

function listenHourlyReports(){
  const q=query(collection(db,"hourlyReports"),orderBy("createdAt","desc"),limit(1000));
  unsubs.push(onSnapshot(q,snap=>{
    latestHourlyReports=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(hourlyV1Mode)hv1RenderCards();
    fzSyncPublicReportPortals(latestHourlyReports).catch(()=>{});
    renderFinalDailyByName();
    populateSmallReportEmployeeFilter();
    renderSmallReport();
    populateAnalyticsEmployeeFilter();
    renderAnalyticsChart();
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
      message:"Money is ready. Please see the Manager on Duty.",
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
  $("hourlyEditBanner")?.classList.remove("hidden");
  const r=latestHourlyReports.find(x=>x.id===id); if(!r) return;
  currentHourlyReportId=id;
  hourlyAdjustmentChoice=null;
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
    hydrateHowBartenderState(
      r.bartenderShiftType||"AM",
      r.bartenderServerEntries||[],
      r.bartenderPreviousAMInput||r.bartenderLessAM||0,
      r.bartenderPrevious24Input||r.bartenderLess24||0
    );
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
  if(isEarlyShift(shift)){
    $("hBusserAM").value=weekend?"WITH":"WITHOUT";
  }else if(["DOUBLE","LONG"].includes(shift)){
    $("hBusserAM").value=weekend?"WITH":"WITHOUT";
  }else{
    $("hBusserAM").value="WITHOUT";
  }
}

function syncHourlyShift(){
  const shift=$("hShift").value;
  if(isShortShift(shift) && $("hPosition").value==="Bartender"){
    $("hBartenderShiftType").value=shift===SHIFT_EARLY?"AM":"2PM_4PM";
  }
  const dbl=shift==="DOUBLE";
  shortShiftFormTimes(shift);
  $("hSingleClock").classList.toggle("hidden",dbl);
  $("hDoubleClock").classList.toggle("hidden",!dbl);
  $("hTotalAMWrap").classList.toggle("hidden",!["DOUBLE","LONG"].includes(shift));
  const busser=$("hBusserAM")?.closest("div");
  if(busser) busser.classList.toggle("hidden",shift==="PM" || $("hPosition").value==="Bartender");
  const am=$("hAmBar")?.closest("div"), pm=$("hPmBar")?.closest("div");
  if(am) am.classList.toggle("hidden",$("hPosition").value==="Bartender" || !(shift==="AM"||shift===SHIFT_EARLY||dbl));
  if(pm) pm.classList.toggle("hidden",$("hPosition").value==="Bartender" || !(shift==="PM"||shift===SHIFT_MIDDLE||dbl));
  applyAutomaticBusserRule();
  syncBartenderBarReceivedField();
}
$("hShift").addEventListener("change",syncHourlyShift);
$("mShift")?.addEventListener("change",()=>{const t=shortShiftTimes($("mShift").value);if(t && !$("mClock").value.trim())$("mClock").value=t.join("–");});
$("hPosition").addEventListener("change",syncHourlyShift);
$("hDate").addEventListener("change",applyAutomaticBusserRule);





function populateBartenderServerDropdowns(){
  const names=getEmployeeRoster();
  const options=names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join("");

  for(let i=1;i<=9;i++){
    const sel=$(`hBtServerName${i}`);
    if(!sel) continue;

    const previous=sel.value||"";
    // Populate once only. Rebuilding a native SELECT while it is open causes
    // the "must click quickly" problem on Chrome/tablets.
    if(sel.dataset.rosterLoaded!=="1" || sel.dataset.rosterNames!==JSON.stringify(names)){
      sel.innerHTML=`<option value="">Select Server ${i}</option>${options}`;
      sel.dataset.rosterLoaded="1";
      sel.dataset.rosterNames=JSON.stringify(names);
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

function isBartenderReport(report){
  return String(report?.position||'').trim().toLowerCase()==='bartender';
}
function reportForWorkPosition(report){
  if(isBartenderReport(report))return report;
  // Explicit empty values also clear old Firestore fields when an existing
  // report is updated from Bartender to Server. Preserve server deductions,
  // cash, payout and every unrelated field.
  return {...report,bartenderCheckpoints:[],bartenderPeriodReceipts:[],bartenderReceiptsSource:'',
    bartenderShiftType:'',bartenderServerEntries:[],bartenderServerGrandTotalSummary:0,
    bartenderGrossBarTipOut:0,bartenderLessAM:0,bartenderLess24:0,
    bartenderPreviousAMInput:0,bartenderPrevious24Input:0,bartenderBarTipReceived:0};
}
function bartenderReceiptPeriods(report){
  if(!isBartenderReport(report))return [];
  const allowed=["AM","2PM_4PM","PM"],byPeriod=new Map();
  for(const row of report?.bartenderPeriodReceipts||[]){
    if(allowed.includes(row?.checkpoint) && Number.isFinite(Number(row.amount)))
      byPeriod.set(row.checkpoint,{checkpoint:row.checkpoint,amount:howRoundCent(Math.max(0,Number(row.amount)))});
  }
  return allowed.filter(key=>byPeriod.has(key)).map(key=>byPeriod.get(key));
}
function bartenderPeriodLabel(key){return key==="2PM_4PM"?"2–4":key;}
function bartenderPeriodAmount(report,key){
  if(!isBartenderReport(report))return 0;
  const periods=bartenderReceiptPeriods(report);
  if(periods.length)return periods.find(p=>p.checkpoint===key)?.amount||0;
  return String(report?.bartenderShiftType||"")===key?Number(report?.bartenderBarTipReceived||0):0;
}
function howAssignedBartenderReceipts(){
  if(String($("hPosition")?.value||"").toLowerCase()!=="bartender")return null;
  const name=String($("hEmployee")?.value||"").trim(),date=$("hDate")?.value||"";
  if(!name || !date)return null;
  const matches=n=>String(n||"").trim().toLowerCase()===name.toLowerCase();
  const saved=(latestHourlyReports||[]).find(r=>r.id===currentHourlyReportId && matches(r.employee) && r.date===date);
  let batch;try{batch=JSON.parse(localStorage.getItem(HV1_STORAGE_PREFIX+date)||"null")}catch{batch=null}
  if(batch?.bar){
    const assigned=["AM","2PM_4PM","PM"].filter(key=>matches(hv1BarRecipient(key,batch)));
    const previousAssignment=batch.drafts?.[name]?.barAutoReceived || bartenderReceiptPeriods(saved).length;
    if(assigned.length || previousAssignment){
      const periods=assigned.map(checkpoint=>({checkpoint,amount:hv1BarReceived(checkpoint,batch)}));
      return {source:"BAR_CENTER",periods,total:howRoundCent(periods.reduce((sum,p)=>sum+p.amount,0))};
    }
    return null;
  }
  const periods=bartenderReceiptPeriods(saved);
  return periods.length?{source:"SAVED_REPORT",periods,total:howRoundCent(periods.reduce((sum,p)=>sum+p.amount,0))}:null;
}
function howBartenderReceiptsHtml(receipts){
  return `<div class="how-info"><b>${receipts.source==="BAR_CENTER"?"Assigned BAR periods":"Saved report periods"}</b><br>${receipts.source==="BAR_CENTER"?"Each assigned period is included once. Edit assignments or sales in BAR Center.":"The saved period breakdown is retained while BAR Center data is unavailable."}</div>
    <div class="how-summary">
      ${receipts.periods.map(p=>`<div><small>BAR ${bartenderPeriodLabel(p.checkpoint)} Received</small><b>${howMoney(p.amount)}</b></div>`).join("")}
      <div style="grid-column:1 / -1;background:#edf8f2"><small>TOTAL BAR TIP OUT RECEIVED</small><b>${howMoney(receipts.total)}</b></div>
    </div>`;
}

function previousBartenderReceived(date,type){
  const matches=(latestHourlyReports||[])
    .filter(r=>String(r.position||"").toLowerCase()==="bartender" && String(r.date||"")===String(date||""))
    .filter(r=>{
      const periods=bartenderReceiptPeriods(r);
      if(periods.length)return periods.some(p=>p.checkpoint===type);
      const bt=String(r.bartenderShiftType||"");
      return bt===type || (!bt && type==="AM" && String(r.shift||"").toUpperCase()==="AM");
    }).sort((a,b)=>(b.updatedAt?.seconds||b.createdAt?.seconds||0)-(a.updatedAt?.seconds||a.createdAt?.seconds||0));
  const report=matches[0];
  if(!report)return 0;
  return bartenderReceiptPeriods(report).length?bartenderPeriodAmount(report,type):Number(report.bartenderBarTipReceived||0);
}

window.calculateBartenderBarTipOut=function calculateBartenderBarTipOut(){
  const isBartender=String($("hPosition")?.value||"").toLowerCase()==="bartender";
  if(!isBartender) return {
    bartenderShiftType:"",serverEntries:[],serverGrandTotalSummary:0,
    grossBarTipOut:0,lessBartenderAM:0,lessBartender24:0,bartenderBarTipReceived:0
  };

  const type=$("hBartenderShiftType")?.value||"AM";
  const date=$("hDate")?.value||"";
  const enteredEntries=bartenderServerEntries();
  const snapshot=howBartenderState[type]?.barCenterCalculation;
  const inputKey=hv1BarFormKey({servers:enteredEntries,
    previousAM:$("hBtPrevAMInput")?.value,previous24:$("hBtPrev24Input")?.value});
  const managed=snapshot && snapshot.checkpoint===type && snapshot.inputKey===inputKey;
  const serverEntries=managed?snapshot.serverEntries:enteredEntries;
  const summary=managed?snapshot.summary:serverEntries.reduce((s,r)=>s+Number(r.grandTotal||0),0);
  const gross=managed?snapshot.gross:summary*0.006;

  const lessAM=managed?snapshot.lessAM:(type==="AM" ? 0 : hv1BarNumber($("hBtPrevAMInput")?.value));
  const less24=managed?snapshot.less24:(type==="PM" ? hv1BarNumber($("hBtPrev24Input")?.value) : 0);

  if($("hBtPrevAMWrap")) $("hBtPrevAMWrap").classList.toggle("hidden",type==="AM");
  if($("hBtPrev24Wrap")) $("hBtPrev24Wrap").classList.toggle("hidden",type!=="PM");

  let finalReceived=type==="AM" ? gross
    : type==="2PM_4PM" ? gross-lessAM
    : gross-lessAM-less24;

  finalReceived=Math.max(0,managed?snapshot.finalReceived:finalReceived);

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
  const workProfile=applyWorkProfilePosition();
  const isBartenderNow=String($("hPosition")?.value||"").toLowerCase()==="bartender";
  let bartenderWizardSnapshot=null;

  if(isBartenderNow){
    // Step-6 data was already captured when leaving Step 6.
    // Step 7 has no bartender server fields, so NEVER recapture here.
    bartenderWizardSnapshot=howBartenderFormula();
  }

  const L=window.FredTipCalculatorLogic;
  if(!L){ alert("Tip Calculation calculation engine is unavailable."); return null; }
  howSyncLongBusserForm();howSyncShortShiftBusserForm();
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
  if(!$("hEmployee").value || !$("hDate").value){alert("Choose employee and date.");return null;}
  if(!(L.calculateTotalMinutes(shift,hours)>0)){alert("Enter valid clock times with positive working hours.");return null;}
  for(const id of ["hGrandTotal","hPaidTip","hCardFee","hCashTip","hMeal"]){
    const raw=String($(id)?.value??"").trim(),amount=L.parseMoney(raw,NaN);
    if(raw==="" || !Number.isFinite(amount) || amount<0){alert("Enter a valid non-negative amount for "+id.slice(1)+". Use 0 when appropriate.");return null;}
  }
  if(["DOUBLE","LONG"].includes(shift)){
    const raw=String($("hTotalAM")?.value??"").trim(),am=L.parseMoney(raw,NaN);
    if(raw==="" || !Number.isFinite(am) || am<0 || am>L.parseMoney($("hGrandTotal").value)){
      alert("Total AM must be between 0 and Grand Total.");return null;
    }
  }
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

  lastHourlyResult.barTipAM=lastHourlyResult.amBarTipOut||0;
  lastHourlyResult.barTipPM=lastHourlyResult.pmBarTipOut||0;
  // These fields used to be omitted for servers, leaving earlier bartender
  // breakdowns in Firestore after updateDoc merged the new calculation.
  lastHourlyResult.bartenderCheckpoints=[];
  lastHourlyResult.bartenderPeriodReceipts=[];
  lastHourlyResult.bartenderReceiptsSource='';

  // Bartender Bar Tip Out Received:
  // V13.5.2 uses the visible V13.5.1 Step-6 calculator as the authoritative source.
  let bartenderBarTipReceived=0;
  if(isBartenderNow && bartenderWizardSnapshot){
    const d=howBartenderCurrent();
    bartenderBarTipReceived=Number(bartenderWizardSnapshot.finalReceived||0);
    const assignedReceipts=howAssignedBartenderReceipts();
    if(assignedReceipts){
      lastHourlyResult.bartenderCheckpoints=assignedReceipts.periods.map(p=>p.checkpoint);
      lastHourlyResult.bartenderPeriodReceipts=assignedReceipts.periods.map(p=>({...p}));
      lastHourlyResult.bartenderReceiptsSource=assignedReceipts.source;
      bartenderBarTipReceived=assignedReceipts.total;
    }



    if(!Number.isFinite(bartenderBarTipReceived)){
      alert("Bartender Bar Tip Out calculation is invalid. Please go BACK to Step 6 and review the server totals.");
      return null;
    }

    lastHourlyResult.bartenderShiftType=howBartenderState.checkpoint||"";
    lastHourlyResult.bartenderServerEntries=(bartenderWizardSnapshot.serverEntries||d.servers||[])
      .map((row,i)=>({slot:i+1,name:String(row.name||""),grandTotal:Number(row.grandTotal||0)}))
      .filter(row=>row.name || row.grandTotal>0);
    lastHourlyResult.bartenderServerGrandTotalSummary=Number(bartenderWizardSnapshot.summary||0);
    lastHourlyResult.bartenderGrossBarTipOut=Number(bartenderWizardSnapshot.gross||0);
    lastHourlyResult.bartenderLessAM=Number(bartenderWizardSnapshot.lessAM||0);
    lastHourlyResult.bartenderLess24=Number(bartenderWizardSnapshot.less24||0);
    lastHourlyResult.bartenderPreviousAMInput=Number(d.previousAM||0);
    lastHourlyResult.bartenderPrevious24Input=Number(d.previous24||0);
    lastHourlyResult.bartenderBarTipReceived=bartenderBarTipReceived;
    // V13.8.24-P16 hard guard: visible Step-6 result stays authoritative.
    howSetSilent("hBartenderBarReceived",Number(bartenderBarTipReceived||0).toFixed(2));

    // Keep the hidden field synchronized only for compatibility/report editing.
    howSetSilent("hBartenderShiftType",howBartenderState.checkpoint||"AM");
    howSetSilent("hBartenderBarReceived",bartenderBarTipReceived.toFixed(2));
  }else{
    lastHourlyResult.bartenderShiftType="";
    lastHourlyResult.bartenderServerEntries=[];
    lastHourlyResult.bartenderServerGrandTotalSummary=0;
    lastHourlyResult.bartenderGrossBarTipOut=0;
    lastHourlyResult.bartenderLessAM=0;
    lastHourlyResult.bartenderLess24=0;
    lastHourlyResult.bartenderPreviousAMInput=0;
    lastHourlyResult.bartenderPrevious24Input=0;
    lastHourlyResult.bartenderBarTipReceived=0;
  }

  if(bartenderBarTipReceived>0){
    // Added to bartender payout. Cash Tip is still excluded from TOTAL PAID OUT.
    lastHourlyResult.grandTotalTip=Number(lastHourlyResult.grandTotalTip||0)+bartenderBarTipReceived;
    lastHourlyResult.totalBeforeMeal=Number(lastHourlyResult.totalBeforeMeal||0)+bartenderBarTipReceived;
    lastHourlyResult.grandTotalAfterAdjustment=Number(lastHourlyResult.grandTotalAfterAdjustment||0)+bartenderBarTipReceived;
    lastHourlyResult.totalPaidOut=Number(lastHourlyResult.totalPaidOut||0)+bartenderBarTipReceived;
  }


  // Tip Calculation BAR Center server override.
  // Same 0.6% rate; this simply supplies the checkpoint split automatically.
  if(hourlyV1Mode && hv1EditingEmployee && !isBartenderNow){
    const bd=hv1ServerBarCalculationValues(hv1EditingEmployee);
    if(bd){
      const newBar=Number(bd.totalFee||0);
      const oldBar=Number(lastHourlyResult.barTipOut||0);
      const delta=newBar-oldBar;
      lastHourlyResult.barTipAM=Number(bd.amFee||0);
      lastHourlyResult.barTipPM=Number(bd.fee24||0)+Number(bd.pmFee||0);
      lastHourlyResult.barTip24=Number(bd.fee24||0);
      lastHourlyResult.barTipOut=newBar;
      lastHourlyResult.barBreakdown={
        amGrandTotal:Number(bd.amGT||0),
        grandTotal24:Number(bd.gt24||0),
        pmGrandTotal:Number(bd.pmGT||0),
        amFee:Number(bd.amFee||0),
        fee24:Number(bd.fee24||0),
        pmFee:Number(bd.pmFee||0)
      };
      // Engine already deducted its original barTipOut. Apply only the difference.
      if(Math.abs(delta)>0.000001){
        ['grandTotalTip','totalBeforeMeal','grandTotalAfterAdjustment','totalPaidOut'].forEach(k=>{
          lastHourlyResult[k]=Number(lastHourlyResult[k]||0)-delta;
        });
      }
    }
  }

  // V13.8.24-P16 Busser split. Preserve the existing V01 total busser formula,
  // but show/store the amount separately as Busser AM and Busser PM.
  {
    const br=Number(lastHourlyResult.busserRate||0)/100;
    const totalBusser=Math.max(0,Number(lastHourlyResult.busserTipOut||0));
    const resultShift=String(lastHourlyResult.shift||shift||"").toUpperCase();
    let busserAM=0,busserPM=0;

    if(String(lastHourlyResult.position||"").toLowerCase()==="bartender"){
      busserAM=0; busserPM=0;
    }else if(resultShift==="PM"){
      busserPM=totalBusser;
    }else if(["DOUBLE","LONG"].includes(resultShift)){
      const totalAM=Math.max(0,Number(lastHourlyResult.totalAM||0));
      const withBusserAM=String($("hBusserAM")?.value||"WITHOUT").toUpperCase()==="WITH";
      const expectedAM=withBusserAM?Math.max(0,totalAM*br):0;
      busserAM=Math.min(totalBusser,expectedAM);
      busserPM=Math.max(0,totalBusser-busserAM);
    }else{
      busserAM=totalBusser;
    }

    lastHourlyResult.busserTipOutAM=busserAM;
    lastHourlyResult.busserTipOutPM=busserPM;
  }

  // V13.8.25: V13.8.18/P24 payout contract, after all BAR overrides.
  lastHourlyResult.grandTotalTip=L.roundCent(lastHourlyResult.totalBeforeMeal+lastHourlyResult.cashTip);
  const savedDecision=currentHourlyReportId
    ? latestHourlyReports.find(row=>row.id===currentHourlyReportId
      && hourlyReportBelongsTo(row,lastHourlyResult.employee,lastHourlyResult.date)) : null;
  const choice=hourlyReportBelongsTo(hourlyAdjustmentChoice,lastHourlyResult.employee,lastHourlyResult.date)
    && hourlyAdjustmentChoice.reportId===String(currentHourlyReportId||'') ? hourlyAdjustmentChoice : null;
  const override=choice?null:(savedDecision && Object.prototype.hasOwnProperty.call(savedDecision,'adjustmentOverride')
    ? savedDecision.adjustmentOverride : savedDecision?.adjustmentDecision==='ACCEPTED'?savedDecision.adjustmentSalaryHourly:null);
  const adjustment=L.calculateHourlyAdjustment({
    ...lastHourlyResult,
    adjustmentDecision:choice?.decision||savedDecision?.adjustmentDecision,
    adjustmentOverride:override
  });
  Object.assign(lastHourlyResult,adjustment);
  lastHourlyResult.adjustmentOverride=override;
  lastHourlyResult.adjustmentPayoutVersion="13.8.29";
  lastHourlyResult.grandTotalAfterAdjustment=L.roundCent(lastHourlyResult.grandTotalTip+adjustment.adjustmentSalaryHourly);
  lastHourlyResult.totalPaidOutBeforeAdjustment=L.roundCent(Math.max(0,lastHourlyResult.totalBeforeMeal-lastHourlyResult.meal));
  lastHourlyResult.totalPaidOut=L.roundCent(Math.max(0,lastHourlyResult.totalBeforeMeal-lastHourlyResult.meal+adjustment.adjustmentSalaryHourly));
  lastHourlyResult.formulaVersion="13.8.29";
  lastHourlyResult.payoutFormula="Total Before Meal - Meal + Accepted Adjustment";
  lastHourlyResult.hours={...hours};

  // Pay Card Tip Fee: manager input is authoritative.
  // This avoids legacy V01 naming differences (cardFee vs payCardTipFee).
  const enteredCardFee=L.parseMoney($("hCardFee")?.value||0);
  lastHourlyResult.cardFee=enteredCardFee;
  lastHourlyResult.payCardTipFee=enteredCardFee;

  if(shift==="LONG" && !isBartenderNow){
    const weekend=isWeekendDate(lastHourlyResult.date);
    lastHourlyResult.busserSalesThrough4PM=lastHourlyResult.totalAM;
    lastHourlyResult.salesWithoutBusser=weekend?0:lastHourlyResult.totalAM;
    lastHourlyResult.busserSalesBasis=weekend?lastHourlyResult.grandTotal:lastHourlyResult.totalPM;
    lastHourlyResult.busserPolicyVersion="LONG_MON_FRI_BAR_2_4_V1";
  }
  if(workProfile){lastHourlyResult.personName=workProfile.personName;lastHourlyResult.workProfile=workProfile.name;}
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
  let busserSplitLine=$("hrBusserSplitLine");
  if(!busserSplitLine){
    busserSplitLine=document.createElement("div");
    busserSplitLine.id="hrBusserSplitLine";
    busserSplitLine.innerHTML='Busser AM <b id="hrBusserAM"></b> &nbsp; • &nbsp; Busser PM <b id="hrBusserPM"></b>';
    $("hrBusserTip")?.parentElement?.insertAdjacentElement("afterend",busserSplitLine);
  }
  if($("hrBusserAM"))$("hrBusserAM").textContent=m(r.busserTipOutAM);
  if($("hrBusserPM"))$("hrBusserPM").textContent=m(r.busserTipOutPM);
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
  renderHourlyAdjustmentReview(r);
  $("hourlyResult").classList.remove("hidden");
  return r;
};

let hourlyFinalSaveInProgress=false;
function hourlyAdjustmentReviewHtml(r){
  const minutes=Number(r.totalMinutesWork);
  const duration=r.totalMinutesWork!=null && Number.isFinite(minutes)
    ? `${Math.floor(minutes/60)}h ${Math.round(minutes%60)}m`
    : `${Number(r.totalHoursWork||0).toFixed(2)} hours`;
  const candidate=Number(r.adjustmentCandidate||0),decision=r.adjustmentDecision||'PENDING';
  return `<div class="how-card"><h3>Hourly Adjustment</h3>
    <div class="how-summary">
      <div><small>Hours × Hourly Rate</small><b>${esc(duration)} × ${fmtMoney(r.hourlyRate)}</b></div>
      <div><small>Hourly Minimum</small><b>${fmtMoney(r.hourlyMinimum)}</b></div>
      <div><small>Total Before Meal + Cash Tip</small><b>${fmtMoney(r.grandTotalTip)}</b></div>
      <div><small>Adjustment Available</small><b>${fmtMoney(candidate)}</b></div>
      <div><small>Status</small><b>${esc(candidate>0?decision:'NO ADJUSTMENT NEEDED')}</b></div>
      <div><small>Adjustment Applied</small><b>${fmtMoney(r.adjustmentSalaryHourly)}</b></div>
    </div>
    ${candidate>0?`<p>Accept to add the adjustment to Total Paid Out. Cash Tip is already included in the minimum check.</p>
      <div class="how-actions"><button type="button" class="btn green" onclick="setHourlyAdjustmentDecision('ACCEPTED')" aria-pressed="${decision==='ACCEPTED'}">ACCEPT ${fmtMoney(candidate)}</button>
      <button type="button" class="btn light" onclick="setHourlyAdjustmentDecision('DECLINED')" aria-pressed="${decision==='DECLINED'}">DECLINE</button></div>`:''}
  </div>`;
}
function renderHourlyAdjustmentReview(r){
  const wizard=$('howAdjustmentReview'),legacy=$('hourlyAdjustmentReview');
  if(wizard)wizard.innerHTML=hourlyAdjustmentReviewHtml(r);
  if(legacy){legacy.innerHTML=hourlyAdjustmentReviewHtml(r);legacy.classList.toggle('hidden',hourlyWizardStep===7 && !!wizard);}
}
window.setHourlyAdjustmentDecision=function(decision){
  if(!['manager','owner'].includes(currentProfile?.role||'') || hourlyFinalSaveInProgress || hv1LoadingEmployee)return;
  if(!['ACCEPTED','DECLINED'].includes(decision))return;
  captureHourlyWizard();
  const r=calculateHourlyV01();if(!r || r.adjustmentCandidate<=0)return;
  hourlyAdjustmentChoice={employee:r.employee,date:r.date,reportId:String(currentHourlyReportId||''),decision};
  calculateHourlyV01();
  if(hourlyV1Mode && hv1EditingEmployee)hv1CapturePage(false);
};
async function writeHourlyFinalForAccount(r,candidateId,submissionId){
  const newRef=doc(collection(db,"hourlyReports"));
  return runTransaction(db,async transaction=>{
    const candidateRef=candidateId?doc(db,"hourlyReports",candidateId):null;
    const snap=candidateRef?await transaction.get(candidateRef):null;
    const before=snap?.exists()?snap.data():null;
    const wasEditing=hourlyReportBelongsTo(before,r.employee,r.date);
    // Verify both links before any write. A stale report/submission ID must
    // never rename another work account's record or share its Money Ready row.
    const sourceId=submissionId||(wasEditing?before.sourceSubmissionId:'')||'';
    const sourceSnap=sourceId?await transaction.get(doc(db,"submissions",sourceId)):null;
    const source=sourceSnap?.exists()?sourceSnap.data():null;
    const sourceSubmissionId=hourlyReportBelongsTo(source,r.employee,r.date)?sourceId:'';
    const ref=wasEditing?candidateRef:newRef;
    const payload={...reportForWorkPosition(r),sourceSubmissionId,status:"money_ready",
      employeeKey:fzEmployeeIdentityKey(r.employee),reportIdentityVersion:"13.8.28"};
    if(sourceSubmissionId && source.employeeUid)payload.employeeUid=source.employeeUid;
    if(wasEditing){
      transaction.update(ref,{...payload,updatedAt:serverTimestamp(),
        updatedBy:currentProfile.displayName||currentProfile.username});
    }else{
      transaction.set(ref,{...payload,createdAt:serverTimestamp(),createdByUid:currentUser.uid,
        createdBy:currentProfile.displayName||currentProfile.username});
    }
    return {ref,wasEditing,sourceSubmissionId};
  });
}
window.saveHourlyV01=async function(){
  if(hourlyFinalSaveInProgress)return;
  if(hv1LoadingEmployee){alert("Employee report is loading. Please wait.");return;}
  if(hourlyV1Mode && hv1EditingEmployee
    && ($("hEmployee")?.value!==hv1EditingEmployee || $("hDate")?.value!==hv1DateValue())){
    alert("Employee/date does not match the open Team Board card. Reopen the correct employee card before submitting.");return;
  }
  const r=calculateHourlyV01();
  if(!r) return;
  hourlyFinalSaveInProgress=true;
  const savingEmployee=r.employee,savingDate=r.date;
  let savingSubmissionId=currentHourlySubmissionId;
  let savingReportId=currentHourlyReportId;
  let linkedSubmissionWarning="";
  const savingFromTeam=hourlyV1Mode;
  try{
    const saved=await writeHourlyFinalForAccount(r,savingReportId,savingSubmissionId);
    const {ref,wasEditing}=saved;
    savingSubmissionId=saved.sourceSubmissionId;

    savingReportId=ref.id;
    if($("hEmployee")?.value===savingEmployee)currentHourlyReportId=ref.id;
    const finalRow={...r,id:ref.id,status:"money_ready",sourceSubmissionId:savingSubmissionId||""};
    latestHourlyReports=[finalRow,...latestHourlyReports.filter(x=>x.id!==ref.id)];
    if(savingFromTeam)await hv1MarkFinal(ref.id,savingSubmissionId||"",savingEmployee,savingDate);


    if(savingSubmissionId){
      try{await updateDoc(doc(db,"submissions",savingSubmissionId),{
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
          busserTipOutAM:Number(r.busserTipOutAM||0),
          busserTipOutPM:Number(r.busserTipOutPM||0),
          barTipOut:Number(r.barTipOut||0),
    bartenderBarTipReceived:Number(r.bartenderBarTipReceived||0),
    bartenderPeriodReceipts:bartenderReceiptPeriods(r),
          grandTotalTip:Number(r.grandTotalTip||0),
          hourlyRate:Number(r.hourlyRate||0),
          hourlyMinimum:Number(r.hourlyMinimum||0),
          adjustmentCandidate:Number(r.adjustmentCandidate||0),
          adjustmentDecision:r.adjustmentDecision||"NONE",
          adjustmentPayoutVersion:r.adjustmentPayoutVersion||"",
          adjustmentSalaryHourly:Number(r.adjustmentSalaryHourly||0),
          grandTotalAfterAdjustment:Number(r.grandTotalAfterAdjustment||0),
          totalPaidOut:Number(r.totalPaidOut||0)
        },
        finalizedBy:currentProfile.displayName||currentProfile.username,
        finalizedAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });}catch(e){
        console.warn("Final report saved; linked submission sync failed:",e);
        linkedSubmissionWarning="Final report is saved. The linked submission could not sync; reopen the saved report and submit again to retry the link. Do not create another report.";
      }
    }

    // Optional actions must NOT cause Final Submit to fail.
    try{
      await writeAudit(wasEditing?"hourly_report_edit":"hourly_final_money_ready",
        ref.id,r.employee,{after:r,sourceSubmissionId:savingSubmissionId||""});
    }catch(e){ console.warn("Audit log skipped:",e); }

    if(savingSubmissionId){
      try{
        const moneyReadyRef=doc(db,"moneyReadyBoard",savingSubmissionId);
        await setDoc(moneyReadyRef,{
          employee:r.employee||"",
          submissionId:savingSubmissionId,
          reportId:ref.id,
          message:"Your tip money is ready. Please see the Manager on Duty.",
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

    alert(wasEditing
      ? "Final report updated. Daily Report refreshed. Existing report was edited — no duplicate created."
      : "Final approved. Daily Report updated. Employee status: MONEY READY.");
    if(linkedSubmissionWarning)alert(linkedSubmissionWarning);
    if(!savingFromTeam){
      openStaffTab("smallReport");
      setTimeout(()=>renderSmallReport(),150);
    }
    if($("hEmployee")?.value===savingEmployee){currentHourlyReportId=null;currentHourlySubmissionId=null;hourlyAdjustmentChoice=null;}
  }catch(e){
    console.error("Final submit failed:",e);
    alert(`Final Submit failed: ${e.code || e.message}`);
  }finally{hourlyFinalSaveInProgress=false;}
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
if($("smallReportDate")) $("smallReportDate").value="";
populateRoster();
window.refreshEmployeeLoginOptions();
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

// V13.3.6: employee sees own Check Tip rows read-only while waiting and after completion.

// V13.3.7 cashier history role-switch compatibility.

// V13.3.8 Owner full Check Tip controls and share actions.

// V13.4.2: Employee Check Tip only; original Manager/Owner Hourly/Reports preserved.


// ===== V13.4.3 ORIGINAL HOURLY ADJUSTMENT SIMPLE WIZARD =====
let hourlyWizardStep=1;
let hourlyWizardState={position:"Server",shift:"AM",busserAM:"WITHOUT"};

function newHowBartenderCheckpoint(){
  return {servers:Array.from({length:9},()=>({name:"",grandTotal:""})),previousAM:"",previous24:""};
}
let howBartenderState={
  checkpoint:"AM",
  AM:newHowBartenderCheckpoint(),
  "2PM_4PM":newHowBartenderCheckpoint(),
  PM:newHowBartenderCheckpoint()
};

function resetHowBartenderState(){
  howBartenderState={checkpoint:"AM",AM:newHowBartenderCheckpoint(),"2PM_4PM":newHowBartenderCheckpoint(),PM:newHowBartenderCheckpoint()};
}

function hydrateHowBartenderState(type,entries,previousAM,previous24){
  resetHowBartenderState();
  const checkpoint=["AM","2PM_4PM","PM"].includes(type)?type:"AM";
  howBartenderState.checkpoint=checkpoint;
  const d=howBartenderState[checkpoint];
  const src=Array.isArray(entries)?entries:[];
  d.servers=Array.from({length:9},(_,i)=>{
    const e=src.find(x=>Number(x.slot)===i+1)||src[i]||{};
    return {name:String(e.name||""),grandTotal:Number(e.grandTotal||0)>0?String(Number(e.grandTotal)):""};
  });
  d.previousAM=Number(previousAM||0)>0?String(Number(previousAM)):"";
  d.previous24=Number(previous24||0)>0?String(Number(previous24)):"";
}

function howBartenderCurrent(){return howBartenderState[howBartenderState.checkpoint];}
function howRoundCent(v){return Math.round((Number(v)||0)*100)/100;}
function howBartenderFormula(checkpoint=howBartenderState.checkpoint){
  const d=howBartenderState[checkpoint]||newHowBartenderCheckpoint();
  const saved=d.barCenterCalculation;
  if(saved && saved.checkpoint===checkpoint && saved.inputKey===hv1BarFormKey(d)){
    return {checkpoint,summary:howRoundCent(saved.summary),gross:howRoundCent(saved.gross),
      lessAM:howRoundCent(saved.lessAM),less24:howRoundCent(saved.less24),
      finalReceived:howRoundCent(saved.finalReceived),serverEntries:saved.serverEntries};
  }
  const summary=howRoundCent((d.servers||[]).reduce((s,r)=>s+(Number(r.grandTotal)||0),0));
  const gross=howRoundCent(summary*0.006);
  const lessAM=checkpoint==="AM"?0:howRoundCent(hv1BarNumber(d.previousAM));
  const less24=checkpoint==="PM"?howRoundCent(hv1BarNumber(d.previous24)):0;
  const finalReceived=Math.max(0,howRoundCent(gross-lessAM-less24));
  return {checkpoint,summary,gross,lessAM,less24,finalReceived};
}

function howBartenderServerOptions(slot,selected=""){
  const current=howVal("hEmployee");
  const names=getEmployeeRoster().filter(n=>n!==current);
  return `<option value="">Select Server ${slot}</option>`+names.map(n=>`<option value="${esc(n)}" ${n===selected?"selected":""}>${esc(n)}</option>`).join("");
}

function captureHowBartenderDom(){
  const d=howBartenderCurrent();
  if(!d)return;

  // IMPORTANT: only capture when the Step-6 bartender form is actually on screen.
  // On Step 7 those fields do not exist; capturing there would erase the saved server totals.
  const firstName=$("howBtName1");
  const firstGrand=$("howBtGrand1");
  if(!firstName && !firstGrand) return;

  for(let i=1;i<=9;i++){
    const nameEl=$(`howBtName${i}`);
    const grandEl=$(`howBtGrand${i}`);
    if(nameEl || grandEl){
      d.servers[i-1]={
        name:String(nameEl?.value||"").trim(),
        grandTotal:String(grandEl?.value||"").trim()
      };
    }
  }
  if($("howBtPreviousAM")) d.previousAM=String($("howBtPreviousAM").value||"").trim();
  if($("howBtPrevious24")) d.previous24=String($("howBtPrevious24").value||"").trim();
}

function ensureHowBartenderPreviousDefaults(){
  const d=howBartenderCurrent(); if(!d)return;
  const date=howVal("hDate");
  if(howBartenderState.checkpoint!=="AM" && !String(d.previousAM||"").trim()){
    const v=previousBartenderReceived(date,"AM");
    if(v>0)d.previousAM=String(v.toFixed(2));
  }
  if(howBartenderState.checkpoint==="PM" && !String(d.previous24||"").trim()){
    const v=previousBartenderReceived(date,"2PM_4PM");
    if(v>0)d.previous24=String(v.toFixed(2));
  }
}

function validateHowBartenderStep(){
  if(howAssignedBartenderReceipts())return true;
  captureHowBartenderDom();
  const d=howBartenderCurrent();
  const used=(d.servers||[]).filter(r=>String(r.name||"").trim() || Number(r.grandTotal||0)>0);
  if(!used.length){
    alert("Enter at least one server name and Grand Total for this bartender checkpoint.");
    return false;
  }
  for(const r of used){
    if(!String(r.name||"").trim()){
      alert("Choose a server name for every Grand Total entered.");
      return false;
    }
    if(!(Number(r.grandTotal||0)>0)){
      alert(`Enter the Grand Total for ${r.name}.`);
      return false;
    }
  }
  if(howBartenderState.checkpoint!=="AM" && String(d.previousAM||"").trim()===""){
    alert("Enter Bartender AM Tip Out Received.");
    return false;
  }
  // BAR 2–4 is OPTIONAL. If it is blank, PM subtracts AM only.
  // If 2–4 exists, the existing cumulative formula subtracts AM + 2–4.
  return true;
}

function syncHowBartenderToLegacy(){
  const assigned=howAssignedBartenderReceipts();
  if(assigned){howSetSilent("hBartenderBarReceived",assigned.total.toFixed(2));return {bartenderBarTipReceived:assigned.total};}
  captureHowBartenderDom();
  const d=howBartenderCurrent();
  populateBartenderServerDropdowns();
  howSetSilent("hBartenderShiftType",howBartenderState.checkpoint);
  for(let i=1;i<=9;i++){
    const row=d.servers[i-1]||{};
    const sel=$(`hBtServerName${i}`);
    if(sel && row.name && !Array.from(sel.options).some(o=>o.value===row.name)){
      const opt=document.createElement("option"); opt.value=row.name; opt.textContent=row.name; sel.appendChild(opt);
    }
    if(sel)sel.value=row.name||"";
    if($(`hBtServerGrand${i}`))$(`hBtServerGrand${i}`).value=row.grandTotal||"";
  }
  howSetSilent("hBtPrevAMInput",d.previousAM||"");
  howSetSilent("hBtPrev24Input",d.previous24||"");
  const calc=howBartenderFormula();
  howSetSilent("hBartenderBarReceived",calc.finalReceived.toFixed(2));
  return window.calculateBartenderBarTipOut();
}

function updateHowBartenderPreview(){
  const assigned=howAssignedBartenderReceipts();
  if(assigned){howSetSilent("hBartenderBarReceived",assigned.total.toFixed(2));return;}
  captureHowBartenderDom();
  const r=howBartenderFormula();
  if($("howBtSummary"))$("howBtSummary").textContent=howMoney(r.summary);
  if($("howBtGross"))$("howBtGross").textContent=howMoney(r.gross);
  if($("howBtLessAM"))$("howBtLessAM").textContent=howMoney(r.lessAM);
  if($("howBtLess24"))$("howBtLess24").textContent=howMoney(r.less24);
  if($("howBtFinal"))$("howBtFinal").textContent=howMoney(r.finalReceived);
  if($("howBtFormula")){
    $("howBtFormula").textContent=r.checkpoint==="AM"
      ? `${howMoney(r.summary)} × 0.6% = ${howMoney(r.finalReceived)}`
      : r.checkpoint==="2PM_4PM"
        ? `${howMoney(r.summary)} × 0.6% = ${howMoney(r.gross)} − AM ${howMoney(r.lessAM)} = ${howMoney(r.finalReceived)}`
        : r.less24>0
          ? `${howMoney(r.summary)} × 0.6% = ${howMoney(r.gross)} − AM ${howMoney(r.lessAM)} − 2 PM–4 PM ${howMoney(r.less24)} = ${howMoney(r.finalReceived)}`
          : `${howMoney(r.summary)} × 0.6% = ${howMoney(r.gross)} − AM ${howMoney(r.lessAM)} = ${howMoney(r.finalReceived)} (No 2–4 BAR)`;
  }
  howSetSilent("hBartenderBarReceived",r.finalReceived.toFixed(2));
}


function howMoney(v){return Number(v||0).toLocaleString("en-US",{style:"currency",currency:"USD"});}
function howVal(id){return $(id)?.value||"";}
function howSet(id,v){if($(id)){$(id).value=v;$(id).dispatchEvent(new Event("change",{bubbles:true}));}}
function howSetSilent(id,v){if($(id)) $(id).value=v;}
function howField(label,id,value,type="text",placeholder=""){
  const isMoney=type==="number";
  const isTime=["howIn","howOut","howAmIn","howAmOut","howPmIn","howPmOut"].includes(id);
  let display=String(value??"");
  if(isMoney && (display==="" || Number(display)===0)) display="";
  const classes=[isMoney?"how-money-input":"",isTime?"how-time-input":""].filter(Boolean).join(" ");
  const actualType=isMoney?"text":type;
  const attrs=[
    `id="${id}"`,
    `type="${actualType}"`,
    classes?`class="${classes}"`:"",
    `value="${display.replace(/"/g,"&quot;")}"`,
    `placeholder="${placeholder}"`,
    isMoney?'inputmode="decimal" autocomplete="off"':"",
    isTime?'inputmode="numeric" maxlength="5" pattern="[0-9:]*" autocomplete="off" enterkeyhint="done"':""
  ].filter(Boolean).join(" ");
  return `<div class="how-field"><label>${label}</label><input ${attrs}></div>`;
}

function hourlyFormatTimeDigits(value){
  const digits=String(value??"").replace(/\D/g,"").slice(0,4);
  if(digits.length<2) return digits;
  return `${digits.slice(0,2)}:${digits.slice(2)}`;
}
function hourlyParseTime(value){
  const text=String(value??"").trim().toUpperCase().replace(/\s+/g," ");
  if(!text) return null;
  let match=text.match(/^(\d{1,2})(?:(?::|\.)(\d{1,2})|(\d{2}))?\s*(AM|PM)?$/);
  let hour,minute,meridiem;
  if(match){
    hour=Number(match[1]);
    minute=Number(match[2]||match[3]||0);
    meridiem=match[4]||"";
  }else{
    const compact=text.match(/^(\d{3,4})\s*(AM|PM)?$/);
    if(!compact) return null;
    const digits=compact[1];
    hour=Number(digits.slice(0,-2));
    minute=Number(digits.slice(-2));
    meridiem=compact[2]||"";
  }
  if(!Number.isInteger(hour)||!Number.isInteger(minute)||minute<0||minute>59) return null;
  if(meridiem){
    if(hour<1||hour>12) return null;
    if(hour===12) hour=0;
    if(meridiem==="PM") hour+=12;
  }else if(hour<0||hour>23){
    return null;
  }
  return hour*60+minute;
}
function hourlyNormalizeTime(value){
  const raw=String(value??"").trim();
  if(!raw) return "";
  const minutes=hourlyParseTime(raw);
  if(minutes===null) return hourlyFormatTimeDigits(raw);
  return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
}
function bindHourlyTimeMask(){
  const ids=["howIn","howOut","howAmIn","howAmOut","howPmIn","howPmOut"];
  const inputs=ids.map(id=>$(id)).filter(Boolean);

  inputs.forEach((el,index)=>{
    if(el.dataset.timeMaskBound==="1") return;
    el.dataset.timeMaskBound="1";
    el.classList.add("how-time-input");
    el.inputMode="numeric";
    el.maxLength=5;
    el.pattern="[0-9:]*";
    el.autocomplete="off";
    el.enterKeyHint="done";
    el.value=hourlyNormalizeTime(el.value);

    el.addEventListener("keydown",event=>{
      if(event.key!=="Backspace" || el.selectionStart!==el.selectionEnd || el.selectionStart<1) return;
      const caret=el.selectionStart;
      if(el.value.charAt(caret-1)!==":") return;
      event.preventDefault();

      let digits=el.value.replace(/\D/g,"").slice(0,4);
      const before=el.value.slice(0,caret).replace(/\D/g,"").length;
      if(before>0) digits=digits.slice(0,before-1)+digits.slice(before);
      el.value=hourlyFormatTimeDigits(digits);

      let nextCaret=Math.max(0,before-1);
      if(nextCaret>=2) nextCaret++;
      setTimeout(()=>{try{el.setSelectionRange(nextCaret,nextCaret)}catch(e){}},0);
    });

    el.addEventListener("input",()=>{
      const caret=el.selectionStart==null?el.value.length:el.selectionStart;
      const digitsBefore=el.value.slice(0,caret).replace(/\D/g,"").length;
      const digits=el.value.replace(/\D/g,"").slice(0,4);

      el.value=hourlyFormatTimeDigits(digits);
      let nextCaret=digitsBefore>=2?digitsBefore+1:digitsBefore;
      nextCaret=Math.min(nextCaret,el.value.length);
      try{el.setSelectionRange(nextCaret,nextCaret)}catch(e){}

      if(digits.length===4){
        setTimeout(()=>{
          const next=inputs[index+1];
          if(next){
            next.focus();
            try{next.setSelectionRange(0,next.value.length)}catch(e){}
          }else{
            el.blur();
            $("howNext")?.scrollIntoView({behavior:"smooth",block:"end"});
          }
        },90);
      }
    });

    el.addEventListener("blur",()=>{
      el.value=hourlyNormalizeTime(el.value);
    });
  });
}

function bindHourlyMoneyOverwrite(){
  $("hourlyOriginalWizard")?.querySelectorAll("input.how-money-input").forEach(el=>{
    if(el.dataset.zeroOverwriteBound==="1") return;
    el.dataset.zeroOverwriteBound="1";

    const clearZero=()=>{
      const raw=String(el.value??"").trim();
      if(raw==="0" || raw==="0.0" || raw==="0.00") el.value="";
    };
    el.addEventListener("focus",clearZero);
    el.addEventListener("pointerdown",clearZero);
    el.addEventListener("beforeinput",clearZero);
    el.addEventListener("blur",()=>{
      const raw=String(el.value??"").trim();
      if(raw && !/^\d*(?:\.\d{0,2})?$/.test(raw)){
        const n=Number(raw.replace(/,/g,""));
        el.value=Number.isFinite(n)?String(Math.max(0,n)):"";
      }
    });
  });
}
function howChoice(name,value,label,on){
  return `<button type="button" class="how-choice ${on?"on":""}" data-how-choice="${name}" data-how-value="${value}">${label}</button>`;
}
function howNav(back="BACK",next="SUBMIT"){
  return `<div class="how-actions"><button type="button" class="btn light" id="howBack">${back}</button><button type="button" class="btn green" id="howNext">${next}</button></div><button type="button" class="btn light how-team-back" onclick="hv1ReturnToTeamBoard()">BACK TO TEAM BOARD</button>`;
}
window.hv1ReturnToTeamBoard=async function(){
  if(!['manager','owner'].includes(currentProfile?.role||''))return;
  if(hourlyFinalSaveInProgress){alert('Final report is saving. Please wait.');return;}
  if(document.body.classList.contains('hourly-v1-editing'))return window.hv1SavePage();
  if($('hourly') && !$('hourly').classList.contains('hidden')){
    captureHourlyWizard();
    const name=$('hEmployee')?.value,date=$('hDate')?.value;
    if(name && date){
      if($('hv1Date'))$('hv1Date').value=date;
      hv1EditingEmployee=name;hourlyV1Mode=true;
      const batch=hv1Load();batch.team ||= [];batch.drafts ||= {};
      if(!batch.team.includes(name))batch.team.push(name);
      const draft=batch.drafts[name]||hv1BlankDraft(name);
      for(const id of HV1_BACKING_IDS){const value=hv1VisibleValue(id);hv1SetValue(draft,id,value,value!=='');}
      draft.date=date;batch.drafts[name]=draft;hv1Save(batch);
      return window.hv1SavePage();
    }
  }
  const state=hv1Load();hv1ApplyBarAutomation(state);hv1Save(state);
  if(!await hv1CloudSave(state)){alert("Saved on this device. Cloud sync failed; BAR remains open.");return;}
  document.body.classList.remove('hourly-v1-editing','hourly-v1-small-report','small-report-fullscreen');
  document.documentElement.classList.remove('small-report-fullscreen');
  document.body.classList.add('hourly-v1-mode');hourlyV1Mode=true;
  $('hourly')?.classList.add('hidden');$('smallReport')?.classList.add('hidden');
  $('hv1BarBox')?.classList.add('hidden');$('hv1SmallReportBox')?.classList.add('hidden');
  $('hv1BoardBox')?.classList.remove('hidden');$('hourlyV1Workspace')?.classList.remove('hidden');
  hv1RenderCards();window.scrollTo(0,0);
};

function hideLegacyHourlyInput(){
  const hourly=$("hourly"), wiz=$("hourlyOriginalWizard");
  if(!hourly||!wiz)return;
  const card=wiz.parentElement;
  if(!card)return;
  let started=false;
  [...card.children].forEach(el=>{
    if(el===wiz)return;
    if(el.tagName==="H3" && el.textContent.trim()==="Employee & Shift") started=true;
    if(started && el.id!=="hourlyResult") el.classList.add("hourlyLegacyHidden");
  });
  $("hourlyResult")?.classList.remove("hourlyLegacyHidden");
}

function syncWizardFromLegacy(){
  hourlyWizardState.position=howVal("hPosition")||hourlyWizardState.position||"Server";
  hourlyWizardState.shift=howVal("hShift")||hourlyWizardState.shift||"AM";
  hourlyWizardState.busserAM=howVal("hBusserAM")||hourlyWizardState.busserAM||"WITHOUT";
}


let hourlyBartenderCalcMarker=null;

function ensureHourlyBartenderCalcMarker(){
  const calc=$("hBartenderBarReceivedWrap");
  if(!calc || hourlyBartenderCalcMarker) return;
  hourlyBartenderCalcMarker=document.createComment("hourly-bartender-calculator-home");
  calc.parentNode.insertBefore(hourlyBartenderCalcMarker,calc);
}

function parkHourlyBartenderCalculator(){
  const calc=$("hBartenderBarReceivedWrap");
  if(!calc) return;
  ensureHourlyBartenderCalcMarker();
  if(hourlyBartenderCalcMarker?.parentNode && calc.parentNode!==hourlyBartenderCalcMarker.parentNode){
    hourlyBartenderCalcMarker.parentNode.insertBefore(calc,hourlyBartenderCalcMarker.nextSibling);
  }
  calc.classList.add("hidden","hourlyLegacyHidden");
}

function mountHourlyBartenderCalculator(){
  const calc=$("hBartenderBarReceivedWrap");
  const mount=$("howBartenderCalcMount");
  if(!calc || !mount) return;

  ensureHourlyBartenderCalcMarker();
  mount.appendChild(calc);
  calc.classList.remove("hidden","hourlyLegacyHidden");
  populateBartenderServerDropdowns();
  window.calculateBartenderBarTipOut();
}

function clearHourlyBartenderCalculator(){
  if($("hBartenderShiftType")) $("hBartenderShiftType").value="AM";
  for(let i=1;i<=9;i++){
    if($(`hBtServerName${i}`)) $(`hBtServerName${i}`).value="";
    if($(`hBtServerGrand${i}`)) $(`hBtServerGrand${i}`).value="";
  }
  if($("hBtPrevAMInput")) $("hBtPrevAMInput").value="";
  if($("hBtPrev24Input")) $("hBtPrev24Input").value="";
  if($("hBartenderBarReceived")) $("hBartenderBarReceived").value="0.00";
  window.calculateBartenderBarTipOut();
}

function renderHourlyWizard(){
  const workProfile=applyWorkProfilePosition();
  const mount=$("howBody"); if(!mount)return;
  howSyncLongBusserForm();howSyncShortShiftBusserForm();
  parkHourlyBartenderCalculator();
  hideLegacyHourlyInput();
  if($("howStepBadge")) $("howStepBadge").textContent=`STEP ${hourlyWizardStep} / 7`;

  const employeeOptions=[...($("hEmployee")?.options||[])].map(o=>`<option value="${o.value}" ${o.value===howVal("hEmployee")?"selected":""}>${o.textContent}</option>`).join("");
  let body="";

  if(hourlyWizardStep===1){
    body=`<h3 class="how-title">Employee</h3><p class="how-sub">Choose the employee, position, and shift.</p>
      <div class="how-card">
        <div class="how-field"><label>Date</label><input id="howDate" type="date" value="${howVal("hDate")}" ${hourlyV1Mode&&hv1EditingEmployee?'disabled':''}></div>
        <div class="how-field"><label>Employee Name</label><select id="howEmployee" ${hourlyV1Mode&&hv1EditingEmployee?'disabled':''}>${employeeOptions}</select></div>
        ${hourlyV1Mode&&hv1EditingEmployee?'<p class="small">To enter another employee, use Back to Team Board and open their card.</p>':''}
        <div class="how-field"><span class="how-label">Position</span><div class="how-choices">
          ${workProfile?`<div class="how-info">${esc(workProfile.name)} — ${esc(workProfile.position)}</div>`:
            howChoice("position","Server","SERVER",hourlyWizardState.position==="Server")+
            howChoice("position","Bartender","BARTENDER",hourlyWizardState.position==="Bartender")}

        </div></div>
        <div class="how-field"><span class="how-label">Shift</span><div class="how-choices four">
          ${howChoice("shift","AM","AM",hourlyWizardState.shift==="AM")}
          ${howChoice("shift","PM","PM",hourlyWizardState.shift==="PM")}
          ${howChoice("shift","DOUBLE","DOUBLE",hourlyWizardState.shift==="DOUBLE")}
          ${howChoice("shift","LONG","LONG",hourlyWizardState.shift==="LONG")}
          ${howChoice("shift",SHIFT_EARLY,SHIFT_EARLY,hourlyWizardState.shift===SHIFT_EARLY)}
          ${howChoice("shift",SHIFT_MIDDLE,SHIFT_MIDDLE,hourlyWizardState.shift===SHIFT_MIDDLE)}
        </div></div>
      </div>${howNav("CANCEL","SUBMIT")}`;
  }

  if(hourlyWizardStep===2){
    const dbl=hourlyWizardState.shift==="DOUBLE";
    body=`<h3 class="how-title">Work Hours</h3><p class="how-sub">${howVal("hEmployee")||"Employee"}</p>
      <div class="how-card"><div class="how-info"><b>Type the actual clock times.</b> Example: 10:45 and 16:00.</div>
      ${dbl
        ? howField("Hour In AM","howAmIn",howVal("hAmIn"),"text","10:45")+howField("Hour Out AM","howAmOut",howVal("hAmOut"),"text","16:00")+howField("Hour In PM","howPmIn",howVal("hPmIn"),"text","16:30")+howField("Hour Out PM","howPmOut",howVal("hPmOut"),"text","22:00")
        : howField("Hour In","howIn",howVal("hIn"),"text","10:45")+howField("Hour Out","howOut",howVal("hOut"),"text","16:00")}
      </div>${howNav()}`;
  }

  if(hourlyWizardStep===3){
    let busser="";
    if(hourlyWizardState.position==="Bartender"){
      busser=`<div class="how-info"><b>Bartender Busser Rate: 0%</b><br>No busser tip out is calculated.</div>`;
    }else if(hourlyWizardState.shift==="LONG"){
      const weekend=isWeekendDate(howVal("hDate"));
      busser=weekend
        ? `<div class="how-info"><b>LONG — Saturday / Sunday: 1.50% all day.</b><br>Busser Tip Out = Grand Total × 1.50%.</div>`
        : `<div class="how-info"><b>LONG — Monday–Friday: no busser through 4 PM.</b><br>Sales entered in BAR 2–4 are the no-busser portion.<br>Busser Tip Out = (Grand Total − BAR 2–4 sales) × 1.50%.</div>`;
    }else if(hourlyWizardState.shift==="PM"){
      busser=`<div class="how-info"><b>PM Busser Rate: 1.5%</b><br>Busser Tip Out will use the PM sales total.</div>`;
    }else{
      busser=`<div class="how-field"><span class="how-label">Busser AM</span><div class="how-choices">
        ${howChoice("busserAM","WITHOUT","WITHOUT BUSSER AM",hourlyWizardState.busserAM==="WITHOUT")}
        ${howChoice("busserAM","WITH","WITH BUSSER AM",hourlyWizardState.busserAM==="WITH")}
      </div></div>`;
    }
    body=`<h3 class="how-title">Busser</h3><p class="how-sub">Confirm the busser setup for this shift.</p><div class="how-card">${busser}</div>${howNav()}`;
  }

  if(hourlyWizardStep===4){
    const showAM=["DOUBLE","LONG"].includes(hourlyWizardState.shift);
    body=`<h3 class="how-title">Sales Totals</h3><p class="how-sub">Enter the sales amount. The app calculates the split.</p>
      <div class="how-card">
        ${howField("Grand Total ($)","howGrand",howVal("hGrandTotal"),"number","0.00")}
        ${showAM?howField(hourlyWizardState.shift==="LONG"?"Sales through 4 PM ($)":"Total AM ($)","howTotalAM",howVal("hTotalAM"),"number","0.00"):""}
        <div class="how-metrics">
          <div class="how-metric"><span>${hourlyWizardState.shift==="LONG"?"Sales through 4 PM":"Total AM"}</span><b id="howPreviewAM">$0.00</b></div>
          <div class="how-metric"><span>${hourlyWizardState.shift==="LONG"?"Sales after 4 PM":"Total PM"}</span><b id="howPreviewPM">$0.00</b></div>
          <div class="how-metric" style="grid-column:1 / -1">
            <span id="howPreviewBusserLabel">Busser Rate (%)</span><b id="howPreviewBusserRate" aria-live="polite">—</b>
            <small id="howPreviewBusserBasis" style="display:block;margin-top:6px;font-size:14px;line-height:1.4;color:#66738a"></small>
          </div>
        </div>
      </div>${howNav()}`;
  }

  if(hourlyWizardStep===5){
    body=`<h3 class="how-title">Tips & Meal</h3><p class="how-sub">Enter the final amounts from the receipt.</p>
      <div class="how-card">
        <div class="how-info"><b>Paid Tip is used directly.</b><br>Busser is not subtracted a second time.</div>
        ${howField("Paid Tip ($)","howPaid",howVal("hPaidTip"),"number","0.00")}
        ${howField("Pay Card Tip Fee ($)","howCardFee",howVal("hCardFee"),"number","0.00")}
        ${howField("Cash Tip ($)","howCash",howVal("hCashTip"),"number","0.00")}
        ${howField("Meal ($)","howMeal",howVal("hMeal"),"number","0.00")}
      </div>${howNav()}`;
  }

  if(hourlyWizardStep===6){
    if(hourlyWizardState.position==="Bartender"){
      const assignedReceipts=howAssignedBartenderReceipts();
      if(assignedReceipts){
        body=`<h3 class="how-title">Bartender Bar Tip Out Received</h3><p class="how-sub">${esc(howVal("hEmployee"))} · ${esc(howVal("hDate"))}</p><div class="how-card">${howBartenderReceiptsHtml(assignedReceipts)}</div>${howNav()}`;
      }else{
      ensureHowBartenderPreviousDefaults();
      const bt=howBartenderCurrent();
      const result=howBartenderFormula();
      body=`<h3 class="how-title">Bartender Bar Tip Out Received</h3>
        <p class="how-sub">Choose the bartender checkpoint, then enter each server name and Grand Total.</p>
        <div class="how-card">
          <div class="how-field"><span class="how-label">Bartender Checkpoint</span>
            <div class="how-choices how-bt-checkpoints">
              <button type="button" class="how-choice ${howBartenderState.checkpoint==="AM"?"on":""}" data-how-bt-checkpoint="AM">BARTENDER AM</button>
              <button type="button" class="how-choice ${howBartenderState.checkpoint==="2PM_4PM"?"on":""}" data-how-bt-checkpoint="2PM_4PM">BARTENDER 2 PM–4 PM</button>
              <button type="button" class="how-choice ${howBartenderState.checkpoint==="PM"?"on":""}" data-how-bt-checkpoint="PM">BARTENDER PM</button>
            </div>
          </div>

          <div class="how-info"><b>Enter the Grand Total for every server working in this checkpoint.</b><br>Unused rows may remain blank.</div>

          <div class="how-bt-grid">
            <div class="how-bt-row how-bt-head"><b>Server Name</b><b>Grand Total ($)</b></div>
            ${bt.servers.map((row,i)=>`<div class="how-bt-row">
              <select id="howBtName${i+1}">${howBartenderServerOptions(i+1,row.name)}</select>
              <input id="howBtGrand${i+1}" class="how-money-input how-bt-grand" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${Number(row.grandTotal||0)===0?"":esc(row.grandTotal)}">
            </div>`).join("")}
          </div>

          ${howBartenderState.checkpoint!=="AM"?howField("Bartender AM Tip Out Received ($)","howBtPreviousAM",bt.previousAM,"number","0.00"):""}
          ${howBartenderState.checkpoint==="PM"?howField("Bartender 2 PM–4 PM Tip Out Received ($)","howBtPrevious24",bt.previous24,"number","0.00"):""}

          <div class="how-metrics how-bt-metrics">
            <div class="how-metric"><span>All Server Grand Total</span><b id="howBtSummary">${howMoney(result.summary)}</b></div>
            <div class="how-metric"><span>Gross @ 0.6%</span><b id="howBtGross">${howMoney(result.gross)}</b></div>
            <div class="how-metric"><span>Less Bartender AM</span><b id="howBtLessAM">${howMoney(result.lessAM)}</b></div>
            <div class="how-metric"><span>Less Bartender 2 PM–4 PM</span><b id="howBtLess24">${howMoney(result.less24)}</b></div>
            <div class="how-metric how-bt-final"><span>FINAL BAR TIP OUT RECEIVED</span><b id="howBtFinal">${howMoney(result.finalReceived)}</b></div>
          </div>

          <div id="howBtFormula" class="notice good" style="margin-top:14px;font-weight:900"></div>
          <div class="how-bt-formulas">
            <b>AM:</b> All Server Grand Total × 0.6%<br>
            <b>2 PM–4 PM:</b> All Server Grand Total × 0.6% − Bartender AM Tip Out Received<br>
            <b>PM:</b> All Server Grand Total × 0.6% − Bartender AM Tip Out Received − Bartender 2 PM–4 PM Tip Out Received
          </div>
        </div>${howNav()}`;
      }
    }else{
      const am=hourlyWizardState.shift==="AM"||hourlyWizardState.shift===SHIFT_EARLY||hourlyWizardState.shift==="DOUBLE";
      const pm=hourlyWizardState.shift===SHIFT_MIDDLE||hourlyWizardState.shift==="PM"||hourlyWizardState.shift==="DOUBLE"||hourlyWizardState.shift==="LONG";
      const barAuto=(hourlyV1Mode&&hv1EditingEmployee)?(hv1Draft(hv1EditingEmployee)?.barAuto||null):null;
      const grand=Number(howVal("hGrandTotal")||0);
      const totalAM=["DOUBLE","LONG"].includes(hourlyWizardState.shift)?Number(howVal("hTotalAM")||0):(hourlyWizardState.shift==="PM"?0:grand);
      const totalPM=(hourlyWizardState.shift===SHIFT_MIDDLE||hourlyWizardState.shift==="PM")?grand:(["DOUBLE","LONG"].includes(hourlyWizardState.shift)?Math.max(0,grand-totalAM):0);

      const draftNow=(hourlyV1Mode&&hv1EditingEmployee)?hv1Draft(hv1EditingEmployee):null;
      const amChecked=draftNow?.entered?.hAmBar
        ? howVal("hAmBar")==="yes"
        : (barAuto?Number(barAuto.amGT||0)>0:howVal("hAmBar")==="yes");
      const pmChecked=draftNow?.entered?.hPmBar
        ? howVal("hPmBar")==="yes"
        : (barAuto?!!(barAuto.valid24||barAuto.validPM):howVal("hPmBar")==="yes");

      const amTip=barAuto?Math.max(0,Number(barAuto.amFee||0)):(amChecked?Math.max(0,totalAM*0.006):0);
      const tip24=barAuto?Math.max(0,Number(barAuto.fee24||0)):0;
      const pmTip=barAuto?Math.max(0,Number(barAuto.pmFee||0)):(pmChecked?Math.max(0,totalPM*0.006):0);
      const totalBarTip=Math.max(0,amTip+tip24+pmTip);

      const pmInvalid=barAuto && Number(barAuto.pmGT||0)>0 && !barAuto.validPM;
      const p24Invalid=barAuto && Number(barAuto.gt24||0)>0 && !barAuto.valid24;

      body=`<h3 class="how-title">Bar Tip Out</h3><p class="how-sub">${barAuto?"BAR Center supplies the amounts. You can uncheck a BAR period when it should not apply. Negative amounts are never allowed.":"Check only the shift that had bar sales."}</p>
        <div class="how-card">
          ${am?`<label class="check-card"><input id="howAmBar" type="checkbox" ${amChecked?"checked":""}><span><strong>AM BAR SALES</strong><span>${barAuto?`Cumulative ${howMoney(barAuto.amGT||0)}`:"Checked = 0.6% of Total AM"}</span></span></label>`:""}
          ${pm?`<label class="check-card"><input id="howPmBar" type="checkbox" ${pmChecked?"checked":""}><span><strong>${hourlyWizardState.shift===SHIFT_MIDDLE?"2–4 BAR SALES":"PM BAR SALES"}</strong><span>${barAuto?`PM cumulative ${howMoney(barAuto.pmGT||0)} • 2–4 is optional (${howMoney(barAuto.gt24||0)})`:"Checked = 0.6% of Total PM"}</span></span></label>`:""}
          ${(p24Invalid||pmInvalid)?`<div class="notice warn" style="margin-top:12px"><b>BAR checkpoint ignored:</b> ${p24Invalid?`2–4 cumulative ${howMoney(barAuto.gt24||0)} is lower than AM cumulative ${howMoney(barAuto.amGT||0)}. `:""}${pmInvalid?`PM cumulative ${howMoney(barAuto.pmGT||0)} is lower than the previous cumulative checkpoint, so PM Bar Tip is $0.00.`:""}</div>`:""}
          <div class="how-metrics">
            <div class="how-metric"><span>AM Bar Tip</span><b>${howMoney(amTip)}</b></div>
            ${barAuto?`<div class="how-metric"><span>2–4 Bar Tip</span><b>${howMoney(tip24)}</b></div>`:""}
            <div class="how-metric"><span>PM Bar Tip</span><b>${howMoney(pmTip)}</b></div>
            <div class="how-metric"><span>Total Bar Tip Out</span><b>${howMoney(totalBarTip)}</b></div>
          </div>
        </div>${howNav()}`;
    }
  }

  if(hourlyWizardStep===7){
    const quickShowAM=["DOUBLE","LONG"].includes(hourlyWizardState.shift);
    const serverMode=hourlyWizardState.position!=="Bartender";
    const quickAm=serverMode && ["AM","DOUBLE",SHIFT_EARLY].includes(hourlyWizardState.shift);
    const quickPm=serverMode && ["PM","DOUBLE","LONG",SHIFT_MIDDLE].includes(hourlyWizardState.shift);
    const draftNow=(hourlyV1Mode&&hv1EditingEmployee)?hv1Draft(hv1EditingEmployee):null;
    const amChecked=draftNow?.entered?.hAmBar
      ? String(draftNow.values?.hAmBar||"no")==="yes"
      : howVal("hAmBar")==="yes";
    const pmChecked=draftNow?.entered?.hPmBar
      ? String(draftNow.values?.hPmBar||"no")==="yes"
      : howVal("hPmBar")==="yes";

    body=`<h3 class="how-title">Employee Report — Quick Edit</h3>
      <p class="how-sub">Edit the final numbers directly here. You do not need to go Back to Sales or Tips.</p>
      <div class="how-card">
        <div class="how-summary">
          <div><small>Employee</small><b>${howVal("hEmployee")||"—"}</b></div>
          <div><small>Shift</small><b>${hourlyWizardState.shift}</b></div>
        </div>

        <div class="how-quick-edit-grid">
          ${howField("Grand Total ($)","howGrand",howVal("hGrandTotal"),"number","0.00")}
          ${quickShowAM?howField(hourlyWizardState.shift==="LONG"?"Sales through 4 PM ($)":"Total AM ($)","howTotalAM",howVal("hTotalAM"),"number","0.00"):""}
          ${howField("Paid Tip ($)","howPaid",howVal("hPaidTip"),"number","0.00")}
          ${howField("Pay Card Tip Fee ($)","howCardFee",howVal("hCardFee"),"number","0.00")}
          ${howField("Cash Tip ($)","howCash",howVal("hCashTip"),"number","0.00")}
          ${howField("Meal ($)","howMeal",howVal("hMeal"),"number","0.00")}
        </div>

        ${serverMode?`<div class="how-quick-bar">
          <div class="how-info"><b>BAR sync is automatic.</b><br>Check a period and the saved Grand Total is pushed to BAR Center. Editing BAR Center pushes the value back to this employee.</div>
          ${quickAm?`<label class="check-card"><input id="howAmBar" type="checkbox" ${amChecked?"checked":""}><span><strong>AM BAR SALES</strong><span>Auto-sync to BAR AM</span></span></label>`:""}
          ${quickPm?`<label class="check-card"><input id="howPmBar" type="checkbox" ${pmChecked?"checked":""}><span><strong>${hourlyWizardState.shift===SHIFT_MIDDLE?"2–4 BAR SALES":"PM BAR SALES"}</strong><span>${hourlyWizardState.shift===SHIFT_MIDDLE?"Auto-sync to BAR 2–4":"Auto-sync to BAR PM"}</span></span></label>`:""}
        </div>`:""}

        ${hourlyWizardState.position==="Bartender"
          ? (()=>{const assigned=howAssignedBartenderReceipts();if(assigned)return howBartenderReceiptsHtml(assigned);const bt=howBartenderFormula();return `<div class="how-summary" style="margin-top:14px">
              <div><small>Server Grand Total</small><b>${howMoney(bt.summary)}</b></div>
              <div><small>Gross @ 0.6%</small><b>${howMoney(bt.gross)}</b></div>
              <div><small>Less AM</small><b>${howMoney(bt.lessAM)}</b></div>
              <div><small>Less 2 PM–4 PM</small><b>${howMoney(bt.less24)}</b></div>
              <div><small>Bar Tip Out Received</small><b>${howMoney(bt.finalReceived)}</b></div>
            </div>`;})()
          : ""}

        <div id="howAdjustmentReview" aria-live="polite"><p>Press Calculate to check the hourly minimum and adjustment.</p></div>
        <div class="how-review-actions">
          <button type="button" class="btn gold" id="howCalc">CALCULATE</button>
          <button type="button" class="btn green" id="howFinal">SUBMIT FINAL & MONEY READY</button>
        </div>
      </div>${howNav("BACK","NEW ENTRY")}`;
  }

  mount.innerHTML=body;
  bindHourlyWizard();
  bindHourlyTimeMask();
  bindHourlyMoneyOverwrite();

  parkHourlyBartenderCalculator();
  if(hourlyWizardStep===6 && hourlyWizardState.position==="Bartender") updateHowBartenderPreview();

  if(hourlyWizardStep===4 || hourlyWizardStep===7) updateHowSalesPreview();
  if(hourlyWizardStep===7) $("hourlyResult")?.classList.remove("hourlyLegacyHidden");
  if(hourlyV1Mode && document.body.classList.contains("hourly-v1-editing")) setTimeout(hv1PatchWizard,0);
}

function updateHowSalesPreview(){
  howSyncLongBusserForm();howSyncShortShiftBusserForm();
  const L=window.FredTipCalculatorLogic;
  const shift=hourlyWizardState.shift;
  const grandRaw=String($("howGrand")?.value??"").trim();
  const amRaw=String($("howTotalAM")?.value??"").trim();
  const grand=L.parseMoney(grandRaw,NaN);
  const split=["DOUBLE","LONG"].includes(shift);
  const amInput=split?L.parseMoney(amRaw,NaN):0;
  const valid=grandRaw!=="" && Number.isFinite(grand) && grand>=0
    && (!split || (amRaw!=="" && Number.isFinite(amInput) && amInput>=0 && amInput<=grand));
  const rateEl=$("howPreviewBusserRate"),basisEl=$("howPreviewBusserBasis");
  if(!valid){
    if($("howPreviewAM"))$("howPreviewAM").textContent="—";
    if($("howPreviewPM"))$("howPreviewPM").textContent="—";
    if(rateEl)rateEl.textContent="—";
    if(basisEl)basisEl.textContent="Enter valid sales totals. Total AM cannot exceed Grand Total.";
    return;
  }
  const input={position:hourlyWizardState.position,shift,
    busserAM:hourlyWizardState.busserAM,grandTotal:grand,totalAM:amInput};
  const totals=L.deriveTotals(input),busser=L.calculateBusser(input);
  if($("howPreviewAM"))$("howPreviewAM").textContent=howMoney(totals.totalAM);
  if($("howPreviewPM"))$("howPreviewPM").textContent=howMoney(totals.totalPM);
  const withoutAM=input.busserAM==="WITHOUT";
  const noBusser=input.position==="Bartender" || (isEarlyShift(shift) && withoutAM);
  const partial=split && withoutAM && !noBusser;
  const label=$("howPreviewBusserLabel");
  if(label)label.textContent=partial?"Busser Rate on Grand Total":"Busser Rate (%)";
  // Use the same effective rate as the final report, including the no-busser sales portion.
  if(rateEl)rateEl.textContent=Number(busser.rate).toFixed(2)+"%";
  if(basisEl){
    if(input.position==="Bartender")basisEl.textContent="Bartender: no busser tip out.";
    else if(partial){
      const early=shift==="LONG"?"BAR 2–4 sales":"AM sales";
      const late=shift==="LONG"?"Sales after 4 PM":"PM sales";
      basisEl.textContent=early+": 0.00%. "+late+": "+howMoney(totals.totalPM)+" × 1.50%. Busser Tip Out: "+howMoney(busser.tipOut)+".";
    }else if(noBusser)basisEl.textContent="Without Busser AM: no busser tip out.";
    else basisEl.textContent=shift==="LONG"?"Saturday / Sunday: Grand Total × 1.50%, including sales through 4 PM.":"1.50% of "+(shift==="AM"?"AM sales.":shift==="PM"?"PM sales.":"Grand Total.");
  }

}

function captureHourlyWizard(){
  if(hv1LoadingEmployee)return;
  if(hourlyWizardStep===1){
    const teamCard=hourlyV1Mode&&hv1EditingEmployee;
    const date=teamCard?hv1DateValue():$("howDate")?.value||howVal("hDate");
    const name=teamCard?hv1EditingEmployee:$("howEmployee")?.value||howVal("hEmployee");
    if(name!==howVal("hEmployee") || date!==howVal("hDate")){
      currentHourlyReportId=null;currentHourlySubmissionId=null;hourlyAdjustmentChoice=null;
    }
    howSetSilent("hDate",date);
    howSetSilent("hEmployee",name);
    howSetSilent("hPosition",hourlyWizardState.position);
    let targetShift=hourlyWizardState.shift;
    // LONG uses one clock pair and preserves separate AM/PM sales totals.
    howSetSilent("hShift",targetShift);
  }else if(hourlyWizardStep===2){
    if(hourlyWizardState.shift==="DOUBLE"){
      howSetSilent("hAmIn",$("howAmIn")?.value||""); howSetSilent("hAmOut",$("howAmOut")?.value||"");
      howSetSilent("hPmIn",$("howPmIn")?.value||""); howSetSilent("hPmOut",$("howPmOut")?.value||"");
    }else{
      howSetSilent("hIn",$("howIn")?.value||""); howSetSilent("hOut",$("howOut")?.value||"");
    }
  }else if(hourlyWizardStep===3){
    howSetSilent("hBusserAM",hourlyWizardState.busserAM);
  }else if(hourlyWizardStep===4){
    howSetSilent("hGrandTotal",$("howGrand")?.value||0);
    if(["DOUBLE","LONG"].includes(hourlyWizardState.shift)) howSetSilent("hTotalAM",$("howTotalAM")?.value||0);
    else howSetSilent("hTotalAM",0);
  }else if(hourlyWizardStep===5){
    howSetSilent("hPaidTip",$("howPaid")?.value||0); howSetSilent("hCardFee",$("howCardFee")?.value||0);
    howSetSilent("hCashTip",$("howCash")?.value||0); howSetSilent("hMeal",$("howMeal")?.value||0);
  }else if(hourlyWizardStep===6){
    if(hourlyWizardState.position==="Bartender"){
      syncHowBartenderToLegacy();
    }else{
      howSetSilent("hAmBar",$("howAmBar")?.checked?"yes":"no");
      howSetSilent("hPmBar",$("howPmBar")?.checked?"yes":"no");
    }
  }else if(hourlyWizardStep===7){
    if($("howGrand"))howSetSilent("hGrandTotal",$("howGrand").value||0);
    if($("howTotalAM"))howSetSilent("hTotalAM",$("howTotalAM").value||0);
    if($("howPaid"))howSetSilent("hPaidTip",$("howPaid").value||0);
    if($("howCardFee"))howSetSilent("hCardFee",$("howCardFee").value||0);
    if($("howCash"))howSetSilent("hCashTip",$("howCash").value||0);
    if($("howMeal"))howSetSilent("hMeal",$("howMeal").value||0);
    if(hourlyWizardState.position!=="Bartender"){
      if($("howAmBar"))howSetSilent("hAmBar",$("howAmBar").checked?"yes":"no");
      if($("howPmBar"))howSetSilent("hPmBar",$("howPmBar").checked?"yes":"no");
    }
  }
}

function bindHourlyWizard(){
  $("hourlyOriginalWizard")?.querySelectorAll("[data-how-choice]").forEach(b=>b.onclick=(ev)=>{
    ev.preventDefault();
    ev.stopPropagation();
    const key=b.dataset.howChoice,val=b.dataset.howValue;
    hourlyWizardState[key]=val;
    if(key==="position"){
      howSetSilent("hPosition",val);
      if(val==="Bartender"){
        if(hourlyWizardState.shift==="AM"||hourlyWizardState.shift===SHIFT_EARLY) howBartenderState.checkpoint="AM";
        if(hourlyWizardState.shift===SHIFT_MIDDLE) howBartenderState.checkpoint="2PM_4PM";
        if(hourlyWizardState.shift==="PM") howBartenderState.checkpoint="PM";
      }
    }else if(key==="shift"){
      const targetShift=val;
      howSetSilent("hShift",targetShift);shortShiftFormTimes(val);
      if(isShortShift(val)){applyAutomaticBusserRule();hourlyWizardState.busserAM=howVal("hBusserAM");}
      if(hourlyWizardState.position==="Bartender"){
        if(val==="AM"||val===SHIFT_EARLY) howBartenderState.checkpoint="AM";
        if(val===SHIFT_MIDDLE) howBartenderState.checkpoint="2PM_4PM";
        if(val==="PM") howBartenderState.checkpoint="PM";
      }
    }else if(key==="busserAM"){
      howSetSilent("hBusserAM",val);
    }
    if(hourlyV1Mode&&hv1EditingEmployee){
      try{hv1CapturePage(false)}catch(e){console.warn("V1 choice autosave:",e)}
    }
    renderHourlyWizard();
  });
  $("howGrand")?.addEventListener("input",updateHowSalesPreview);
  $("howTotalAM")?.addEventListener("input",updateHowSalesPreview);

  $("hourlyOriginalWizard")?.querySelectorAll("[data-how-bt-checkpoint]").forEach(btn=>btn.onclick=ev=>{
    ev.preventDefault(); ev.stopPropagation();
    captureHowBartenderDom();
    howBartenderState.checkpoint=btn.dataset.howBtCheckpoint;
    ensureHowBartenderPreviousDefaults();
    renderHourlyWizard();
  });
  for(let i=1;i<=9;i++){
    $(`howBtName${i}`)?.addEventListener("change",updateHowBartenderPreview);
    $(`howBtGrand${i}`)?.addEventListener("input",updateHowBartenderPreview);
  }
  $("howBtPreviousAM")?.addEventListener("input",updateHowBartenderPreview);
  $("howBtPrevious24")?.addEventListener("input",updateHowBartenderPreview);
  $("howAmBar")?.addEventListener("change",()=>{howSetSilent("hAmBar",$("howAmBar").checked?"yes":"no");if(hourlyV1Mode&&hv1EditingEmployee)hv1CapturePage(false);renderHourlyWizard();});
  $("howPmBar")?.addEventListener("change",()=>{howSetSilent("hPmBar",$("howPmBar").checked?"yes":"no");if(hourlyV1Mode&&hv1EditingEmployee)hv1CapturePage(false);renderHourlyWizard();});

  if($("howBack")) $("howBack").onclick=()=>{
    captureHourlyWizard();
    if(hourlyV1Mode&&hv1EditingEmployee)hv1CapturePage(false);
    if(hourlyWizardStep===1) return;
    hourlyWizardStep=Math.max(1,hourlyWizardStep-1);
    if(hourlyV1Mode&&hv1EditingEmployee){
      const s=hv1Load(),d=s.drafts?.[hv1EditingEmployee];
      if(d){d.page=hourlyWizardStep;d.savedAt=Date.now();s.drafts[hv1EditingEmployee]=d;hv1Save(s);}
    }
    renderHourlyWizard();
  };
  if($("howNext")) $("howNext").onclick=()=>{
    try{
      captureHourlyWizard();
    }catch(e){
      console.error("Hourly wizard next failed",e);
      alert("Hourly Adjustment button error: "+(e.message||e));
      return;
    }
    if(hourlyV1Mode&&hv1EditingEmployee)hv1CapturePage(false);
    if(hourlyWizardStep===6 && hourlyWizardState.position==="Bartender" && !validateHowBartenderStep()){
      return;
    }
    if(hourlyWizardStep===1 && !howVal("hEmployee")){
      alert("Select an employee.");
      return;
    }
    if(hourlyWizardStep===7){
      hourlyWizardStep=1;
      ["hIn","hOut","hAmIn","hAmOut","hPmIn","hPmOut"].forEach(id=>{if($(id))$(id).value="";});
      ["hGrandTotal","hTotalAM","hPaidTip","hCardFee","hCashTip","hMeal"].forEach(id=>{if($(id))$(id).value="0";});
      resetHowBartenderState();
      clearHourlyBartenderCalculator();
      if($("hourlyResult")) $("hourlyResult").classList.add("hidden");
      syncWizardFromLegacy();
      renderHourlyWizard();
      return;
    }
    hourlyWizardStep=Math.min(7,hourlyWizardStep+1);
    if(hourlyV1Mode&&hv1EditingEmployee){
      const s=hv1Load(),d=s.drafts?.[hv1EditingEmployee];
      if(d){d.page=hourlyWizardStep;d.savedAt=Date.now();s.drafts[hv1EditingEmployee]=d;hv1Save(s);}
    }
    renderHourlyWizard();
  };
  if($("howCalc")) $("howCalc").onclick=()=>{
    captureHourlyWizard();
    const r=window.calculateHourlyV01();
    if(r){
      $("hourlyResult")?.classList.remove("hidden","hourlyLegacyHidden");
      $("hourlyResult")?.scrollIntoView({behavior:"smooth",block:"start"});
    }
  };
  if($("howFinal")) $("howFinal").onclick=()=>{
    captureHourlyWizard();
    window.saveHourlyV01();
  };
}

window.resetHourlyWizard=function(){
  hourlyWizardStep=1;
  syncWizardFromLegacy();
  renderHourlyWizard();
};

setInterval(()=>{
  const hourly=$("hourly");
  if(hourly && !hourly.classList.contains("hidden") && $("hourlyOriginalWizard")){
    hideLegacyHourlyInput();
    ensureHourlyWizardInitialized();
    if(!$("howBody")?.children.length) renderHourlyWizard();
  }
},700);

let hourlyWizardInitialized=false;
function ensureHourlyWizardInitialized(){
  if(hourlyWizardInitialized)return;
  syncWizardFromLegacy();
  hourlyWizardInitialized=true;
}
setTimeout(()=>{ if($("hourlyOriginalWizard")){ensureHourlyWizardInitialized();renderHourlyWizard();} },900);
// ===== END V13.4.3 ORIGINAL HOURLY WIZARD =====


// V13.4.4: hourly wizard button/state fix.

// V13.4.5: employee old Tip Report bottom bar disabled.

// V13.4.6 root fix: removed invalid syncHourlyShiftUI calls that killed wizard clicks.

// V13.4.7 employee old Tip Report controls permanently disabled.

// V13.4.8: Hourly wizard choices update backing fields silently; legacy listeners cannot rebuild/reset wizard.

// V13.4.9: time mask, Owner user edit/password, direct Employee Check Tip submit.

// V13.5.0: original time mask, zero overwrite, full bartender formula/data entry.

// V13.5.1 direct Bartender AM / 2 PM-4 PM / PM server Grand Total calculator.

// V13.5.2: visible Bartender Step-6 state is authoritative during calculate/submit.

// V13.8.24-P16 Calculate + fresh page fix.

// V13.8.24-P16: Step-7 no longer erases Bartender Step-6 server totals.

// V13.8.24-P16 Employee Clear All fix.

// V13.8.24-P16 Daily Report tab + signature XLS.

// V13.8.24-P16 dedicated Hourly Adjustment sub-app.

// V13.8.24-P16 fresh page generated from current index.

// V13.8.24-P16 Edit finalized Hourly report from Daily Report.

// V13.8.24-P16 Daily Report + New Entry.

setTimeout(loadStaffRememberPreference,0);

// V13.8.24-P16 staff Remember Me with Firebase local/session persistence.

// V13.8.24-P16 Main App button removed from Hourly workspace.

// V13.8.24-P16 Daily Report delete row/delete all/PDF.

setTimeout(loadHourlyRememberPreference,0);

// V13.8.24-P16 Remember Me for dedicated Hourly login.

// V13.8.24-P16 Daily Report server signature + SMS.

// V13.8.24-P16 Employee phone directory for Daily Report SMS.

// V13.8.24-P16 recovered employee phone directory + reliable SMS composer.

// V13.8.24-P16 Add/Edit employee + phone directory.

// V13.8.24-P16 Tip Calculation batch workspace.

// V13.8.24-P16 login role selector responsive UI fix.

// V13.8.24-P16 Delete Team.

// V13.8.24-P16 Delete individual Tip Calculation team member.

// V13.8.24-P16 Cloud-backed Tip Calculation drafts.

// V13.8.24-P16 live bar calculation after partial Grand Total save.

// V13.8.24-P16 Team BAR Center with AM / 2-4 / PM automation.

// V13.8.24-P16 show password checkboxes.

// V13.8.24-P16 reliable team-card and BAR server input interactions.

// V13.8.24-P16 separate Team Board and employee editor views.

// V13.8.24-P16 persist BAR state to hourlyV1Batches cloud document.

// V13.8.24-P16 secure Clear All, Owner Undo and permanent deletion.

// V13.8.24-P16 BAR source-of-truth + payout report + signed PDF/SMS.

// V13.8.24-P16: no negative BAR fees; PM checkbox can be manually unchecked.

// V13.8.24-P16: exact-recipient SMS, employee historical reports, finalized V1 edit-in-place.

// V13.8.24-P16 Check Tip soft delete + Owner Undo / Permanent Delete.

// V13.8.24-P16 employee soft-delete ownership uses Firebase UID.

// V13.8.24-P16 finalized edit hydration, autosave, quick Team Board/BAR navigation.

// V13.8.24-P16: direct final editing and two-way BAR/server sync.

// V13.8.24-P16 larger UI, complete signed PDF/SMS, Daily Report Grand Total.

// V13.8.24-P16 Grand Total = Total Before Meal + Cash Tip.

// V13.8.24-P16 larger Daily Report; frozen Date + Employee columns.

// V13.8.24-P16 simple Daily Report list, detail modal, Busser AM/PM split.

// V13.8.24-P16 Daily Report stays in Tip Calculation; employee detail is a true modal; history retained.

// V13.8.24-P16 Daily Report always visible in Tip Calculation.

// V13.8.24-P16 restores full management tabs when logging in through Hourly V01.

// V13.8.24-P16 professional non-overlapping PDF employee report layout.

// V13.8.24-P16 removes Hourly V01 login and renames Hourly V1 to Tip Calculation.

// V13.8.24-P16 clean role login buttons and simplified staff dashboard.

// V13.8.24-P16 responsive all-device layout; owner credential UI does not expose plaintext Firebase passwords.

// V13.8.24-P16 cashier role/UI removed.

// V13.8.24-P16 stock-style Analytics chart page.

// V13.8.24-P16 password-protected per-person delete + finalized report restore.

// V13.8.24-P16 Future UI styling / mobile readability.

// V13.8.24-P16 password-gated deletes + Owner Deleted/Undo recovery.

// V13.8.24-P16 successful-login welcome voice + original WebAudio music sting.

// V13.8.24-P16 primes audio/speech during actual login gesture.

setTimeout(()=>{fzOpenGuestReportPortalFromUrl().catch(()=>{});},50);
// V13.8.24-P16: Employee report-only experience + private no-signup portal.

// V13.8.24-P16 adjustment examples:
// Bartender 7.00 hours, Before Meal $20, Cash Tip $5 => minimum $49, adjustment $24,
// employer Total Paid Out before Meal deduction = $44, final Grand Total received = $49.
// Server 10.00 hours, minimum $72.50. If Before Meal + Cash Tip < $72.50,
// adjustment fills the exact shortfall to $72.50.

window.hv1EnterWorkspace=hv1Enter;


// V13.8.49 ADD-ONLY — Monthly / Period Report employee summary.
// Read-only feature: summarizes existing finalized hourlyReports by employee and date range.
// It does not alter Daily Report rendering/calculation, thermal printing, Firebase writes, or payout formulas.
let monthlyReportUiReady=false;

function monthlyReportNum(value){
  const n=Number(value);
  return Number.isFinite(n)?n:0;
}
function monthlyReportRound(value){
  return Math.round((monthlyReportNum(value)+Number.EPSILON)*100)/100;
}
function monthlyReportHours(r){
  const rawMinutes=Number(r?.totalMinutesWork);
  if(r?.totalMinutesWork!==null && r?.totalMinutesWork!==undefined && r?.totalMinutesWork!=="" && Number.isFinite(rawMinutes) && rawMinutes>=0){
    return rawMinutes/60;
  }
  const rawHours=Number(r?.totalHoursWork??r?.totalHours);
  return Number.isFinite(rawHours)&&rawHours>=0?rawHours:0;
}
function monthlyReportBusserSplit(r){
  const total=Math.max(0,monthlyReportNum(r?.busserTipOut));
  const hasAM=r?.busserTipOutAM!==null && r?.busserTipOutAM!==undefined && r?.busserTipOutAM!=="" && Number.isFinite(Number(r.busserTipOutAM));
  const hasPM=r?.busserTipOutPM!==null && r?.busserTipOutPM!==undefined && r?.busserTipOutPM!=="" && Number.isFinite(Number(r.busserTipOutPM));
  if(hasAM||hasPM){
    let am=hasAM?Math.max(0,monthlyReportNum(r.busserTipOutAM)):Math.max(0,total-monthlyReportNum(r.busserTipOutPM));
    let pm=hasPM?Math.max(0,monthlyReportNum(r.busserTipOutPM)):Math.max(0,total-am);
    // Historical rows can contain rounded split values. Keep the stored total authoritative.
    if(Math.abs((am+pm)-total)>0.011 && total>0){
      if(hasAM&&!hasPM)pm=Math.max(0,total-am);
      else if(hasPM&&!hasAM)am=Math.max(0,total-pm);
    }
    return {am:monthlyReportRound(am),pm:monthlyReportRound(pm),total:monthlyReportRound(total)};
  }
  if(String(r?.position||"").toLowerCase()==="bartender")return {am:0,pm:0,total:0};
  const shift=String(r?.shift||"").toUpperCase();
  if(shift==="PM")return {am:0,pm:monthlyReportRound(total),total:monthlyReportRound(total)};
  if(["DOUBLE","LONG"].includes(shift)){
    const withBusserAM=String(r?.busserAM||"").toUpperCase()==="WITH";
    const rate=Math.max(0,monthlyReportNum(r?.busserRate))/100;
    const expectedAM=withBusserAM?Math.max(0,monthlyReportNum(r?.totalAM)*rate):0;
    const am=Math.min(total,expectedAM);
    return {am:monthlyReportRound(am),pm:monthlyReportRound(Math.max(0,total-am)),total:monthlyReportRound(total)};
  }
  return {am:monthlyReportRound(total),pm:0,total:monthlyReportRound(total)};
}
function monthlyReportPaidOut(r){
  const saved=Number(r?.totalPaidOut);
  if(r?.totalPaidOut!==null && r?.totalPaidOut!==undefined && r?.totalPaidOut!=="" && Number.isFinite(saved))return saved;
  const adjustment=monthlyReportNum(r?.adjustmentSalaryHourly);
  return Math.max(0,monthlyReportNum(r?.totalBeforeMeal)-monthlyReportNum(r?.meal)+adjustment);
}
function monthlyReportGrandTip(r){
  const saved=Number(r?.grandTotalTip);
  if(r?.grandTotalTip!==null && r?.grandTotalTip!==undefined && r?.grandTotalTip!=="" && Number.isFinite(saved))return saved;
  return monthlyReportNum(r?.totalBeforeMeal)+monthlyReportNum(r?.cashTip);
}
function monthlyReportRange(){
  return {
    from:String($("monthlyReportFrom")?.value||""),
    to:String($("monthlyReportTo")?.value||""),
    employee:String($("monthlyReportEmployee")?.value||"")
  };
}
function monthlyReportFilteredReports(){
  const {from,to,employee}=monthlyReportRange();
  if(from&&to&&from>to)return [];
  return (latestHourlyReports||[]).filter(r=>{
    const date=String(r?.date||"");
    const name=String(r?.employee||"").trim();
    return date&&name&&(!from||date>=from)&&(!to||date<=to)&&(!employee||name===employee);
  });
}
function monthlyReportSummaries(){
  const groups=new Map();
  for(const raw of monthlyReportFilteredReports()){
    const r=typeof reportForWorkPosition==="function"?reportForWorkPosition(raw):raw;
    const name=String(r?.employee||"Unknown Employee").trim()||"Unknown Employee";
    const key=name.toLocaleLowerCase();
    if(!groups.has(key))groups.set(key,{
      employee:name,dates:new Set(),positions:new Set(),reports:0,hours:0,grandTotal:0,paidTip:0,cardFee:0,
      busserAM:0,busserPM:0,busserTotal:0,barTipOut:0,barTipReceived:0,cashTip:0,grandTip:0,meal:0,
      adjustment:0,totalPaidOut:0,netToEmployee:0
    });
    const s=groups.get(key);
    if(r.date)s.dates.add(String(r.date));
    if(r.position)s.positions.add(String(r.position));
    s.reports++;
    s.hours+=monthlyReportHours(r);
    s.grandTotal+=monthlyReportNum(r.grandTotal);
    s.paidTip+=monthlyReportNum(r.paidTip);
    s.cardFee+=monthlyReportNum(r.payCardTipFee??r.cardFee);
    const busser=monthlyReportBusserSplit(r);
    s.busserAM+=busser.am;s.busserPM+=busser.pm;s.busserTotal+=busser.total;
    const bartender=String(r.position||"").toLowerCase()==="bartender";
    if(bartender)s.barTipReceived+=monthlyReportNum(r.bartenderBarTipReceived);
    else s.barTipOut+=monthlyReportNum(r.barTipOut);
    s.cashTip+=monthlyReportNum(r.cashTip);
    s.grandTip+=monthlyReportGrandTip(r);
    s.meal+=monthlyReportNum(r.meal);
    s.adjustment+=monthlyReportNum(r.adjustmentSalaryHourly);
    const paidOut=monthlyReportPaidOut(r);
    s.totalPaidOut+=paidOut;
    s.netToEmployee+=paidOut+monthlyReportNum(r.cashTip);
  }
  return [...groups.values()].map(s=>({
    ...s,days:s.dates.size,positionsText:[...s.positions].sort().join(" / "),
    hours:monthlyReportRound(s.hours),grandTotal:monthlyReportRound(s.grandTotal),paidTip:monthlyReportRound(s.paidTip),
    cardFee:monthlyReportRound(s.cardFee),busserAM:monthlyReportRound(s.busserAM),busserPM:monthlyReportRound(s.busserPM),
    busserTotal:monthlyReportRound(s.busserTotal),barTipOut:monthlyReportRound(s.barTipOut),barTipReceived:monthlyReportRound(s.barTipReceived),
    cashTip:monthlyReportRound(s.cashTip),grandTip:monthlyReportRound(s.grandTip),meal:monthlyReportRound(s.meal),
    adjustment:monthlyReportRound(s.adjustment),totalPaidOut:monthlyReportRound(s.totalPaidOut),netToEmployee:monthlyReportRound(s.netToEmployee)
  })).sort((a,b)=>a.employee.localeCompare(b.employee));
}
function monthlyReportTotals(rows){
  const fields=["days","hours","grandTotal","paidTip","cardFee","busserAM","busserPM","busserTotal","barTipOut","barTipReceived","cashTip","grandTip","meal","adjustment","totalPaidOut","netToEmployee"];
  const t={employee:"TOTAL",reports:0};
  for(const f of fields)t[f]=0;
  for(const r of rows){
    t.reports+=r.reports;
    for(const f of fields)t[f]+=monthlyReportNum(r[f]);
  }
  for(const f of fields)t[f]=monthlyReportRound(t[f]);
  return t;
}
function monthlyReportPopulateEmployee(){
  const sel=$("monthlyReportEmployee");if(!sel)return;
  const current=sel.value||"";
  const names=[...new Set((latestHourlyReports||[]).map(r=>String(r.employee||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">All Employees</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if(names.includes(current))sel.value=current;
}
function monthlyReportMoney(v){return fmtMoney(monthlyReportRound(v));}
function monthlyReportPeriodLabel(){
  const {from,to}=monthlyReportRange();
  if(from&&to)return `${from} to ${to}`;
  if(from)return `From ${from}`;
  if(to)return `Through ${to}`;
  return "All Dates";
}
function monthlyReportTableRowsHtml(rows){
  return rows.map(r=>`<tr>
    <td class="fz-monthly-name"><b>${esc(r.employee)}</b><small>${esc(r.positionsText||"-")} • ${r.reports} report${r.reports===1?"":"s"}</small></td>
    <td>${r.days}</td><td>${r.hours.toFixed(2)}</td><td>${monthlyReportMoney(r.grandTotal)}</td><td>${monthlyReportMoney(r.paidTip)}</td>
    <td>${monthlyReportMoney(r.cardFee)}</td><td>${monthlyReportMoney(r.busserAM)}</td><td>${monthlyReportMoney(r.busserPM)}</td>
    <td>${monthlyReportMoney(r.busserTotal)}</td><td>${monthlyReportMoney(r.barTipOut)}</td><td>${monthlyReportMoney(r.barTipReceived)}</td>
    <td>${monthlyReportMoney(r.cashTip)}</td><td>${monthlyReportMoney(r.grandTip)}</td><td>${monthlyReportMoney(r.meal)}</td>
    <td>${monthlyReportMoney(r.adjustment)}</td><td>${monthlyReportMoney(r.totalPaidOut)}</td><td>${monthlyReportMoney(r.netToEmployee)}</td>
  </tr>`).join("");
}
function monthlyReportTotalRowHtml(t){
  return `<tr class="fz-monthly-total"><td><b>TOTAL</b><small>${t.reports} finalized report${t.reports===1?"":"s"}</small></td>
    <td>${t.days}</td><td>${t.hours.toFixed(2)}</td><td>${monthlyReportMoney(t.grandTotal)}</td><td>${monthlyReportMoney(t.paidTip)}</td>
    <td>${monthlyReportMoney(t.cardFee)}</td><td>${monthlyReportMoney(t.busserAM)}</td><td>${monthlyReportMoney(t.busserPM)}</td>
    <td>${monthlyReportMoney(t.busserTotal)}</td><td>${monthlyReportMoney(t.barTipOut)}</td><td>${monthlyReportMoney(t.barTipReceived)}</td>
    <td>${monthlyReportMoney(t.cashTip)}</td><td>${monthlyReportMoney(t.grandTip)}</td><td>${monthlyReportMoney(t.meal)}</td>
    <td>${monthlyReportMoney(t.adjustment)}</td><td>${monthlyReportMoney(t.totalPaidOut)}</td><td>${monthlyReportMoney(t.netToEmployee)}</td></tr>`;
}
function monthlyReportHeaderHtml(){
  return `<tr><th>Employee</th><th>Days Worked</th><th>Total Hours</th><th>Grand Total</th><th>Paid Tip</th><th>Card Fee</th>
    <th>Busser AM</th><th>Busser PM</th><th>Busser Total</th><th>Bar Tip Out</th><th>Bar Tip Received</th><th>Cash Tip</th>
    <th>Grand Tip</th><th>Meal</th><th>Adjustment</th><th>Total Paid Out</th><th>Net to Employee</th></tr>`;
}
window.renderMonthlyReport=function(){
  if(!monthlyReportUiReady)return;
  monthlyReportPopulateEmployee();
  const {from,to}=monthlyReportRange();
  const host=$("monthlyReportBody"),status=$("monthlyReportStatus");
  if(!host)return;
  if(from&&to&&from>to){
    if(status)status.innerHTML='<div class="notice danger"><b>Start Date cannot be after End Date.</b></div>';
    host.innerHTML="";return;
  }
  const rows=monthlyReportSummaries();
  const rawCount=monthlyReportFilteredReports().length;
  if(status)status.innerHTML=`<div class="notice good"><b>${esc(monthlyReportPeriodLabel())}</b> • ${rows.length} employee${rows.length===1?"":"s"} • ${rawCount} finalized report${rawCount===1?"":"s"}</div>`;
  if(!rows.length){
    host.innerHTML='<div class="notice">No finalized reports found for this period.</div>';
    ["monthlyKpiEmployees","monthlyKpiDays","monthlyKpiHours","monthlyKpiNet"].forEach(id=>{if($(id))$(id).textContent=id==="monthlyKpiNet"?"$0.00":"0";});
    return;
  }
  const totals=monthlyReportTotals(rows);
  if($("monthlyKpiEmployees"))$("monthlyKpiEmployees").textContent=String(rows.length);
  if($("monthlyKpiDays"))$("monthlyKpiDays").textContent=String(totals.days);
  if($("monthlyKpiHours"))$("monthlyKpiHours").textContent=totals.hours.toFixed(2);
  if($("monthlyKpiNet"))$("monthlyKpiNet").textContent=monthlyReportMoney(totals.netToEmployee);
  host.innerHTML=`<div class="fz-monthly-table-wrap"><table class="fz-monthly-table"><thead>${monthlyReportHeaderHtml()}</thead><tbody>${monthlyReportTableRowsHtml(rows)}</tbody><tfoot>${monthlyReportTotalRowHtml(totals)}</tfoot></table></div>
    <div class="small fz-monthly-footnote"><b>Days Worked</b> counts unique work dates per employee. <b>Net to Employee</b> = Total Paid Out + Cash Tip. Busser AM and PM use the saved Daily Report split; historical rows without a split follow the same shift/busser rules used by Tip Calculation.</div>`;
};
window.monthlyReportSetThisMonth=function(){
  const d=new Date(),z=n=>String(n).padStart(2,"0");
  const first=`${d.getFullYear()}-${z(d.getMonth()+1)}-01`;
  const lastDay=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  const last=`${d.getFullYear()}-${z(d.getMonth()+1)}-${z(lastDay)}`;
  if($("monthlyReportFrom"))$("monthlyReportFrom").value=first;
  if($("monthlyReportTo"))$("monthlyReportTo").value=last;
  window.renderMonthlyReport();
};
function monthlyReportExportTable(rows){
  const totals=monthlyReportTotals(rows);
  const head=monthlyReportHeaderHtml();
  const body=monthlyReportTableRowsHtml(rows);
  const foot=monthlyReportTotalRowHtml(totals);
  return `<table border="1" cellspacing="0" cellpadding="6"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}
window.downloadMonthlyReportXls=function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const rows=monthlyReportSummaries();if(!rows.length){alert("No Monthly Report data for this period.");return;}
  const range=monthlyReportRange();
  const title=`Fred Zhang Tip Calculator - Monthly / Period Report`;
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif}h1{font-size:20px}p{font-size:12px}table{border-collapse:collapse;font-size:11px}th{background:#10233f;color:white}td,th{white-space:nowrap}</style></head><body><h1>${esc(title)}</h1><p>${esc(monthlyReportPeriodLabel())}</p>${monthlyReportExportTable(rows)}</body></html>`;
  const blob=new Blob(["\ufeff",html],{type:"application/vnd.ms-excel;charset=utf-8"});
  const safeFrom=range.from||"all";const safeTo=range.to||"all";
  downloadBlob(blob,`Fred_Zhang_Monthly_Report_${safeFrom}_to_${safeTo}.xls`);
};
window.printMonthlyReport=function(){
  if(!["manager","owner"].includes(currentProfile?.role||""))return;
  const rows=monthlyReportSummaries();if(!rows.length){alert("No Monthly Report data for this period.");return;}
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Monthly Report</title><style>@page{size:landscape;margin:8mm}body{font-family:Arial,sans-serif;color:#111;margin:0}h1{font-size:18pt;margin:0 0 4px}p{font-size:9pt;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:7.5pt}th,td{border:1px solid #777;padding:4px 5px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{background:#e9eef5}tfoot td{font-weight:bold;background:#f3f5f8}.fz-monthly-name small,.fz-monthly-total small{display:block;font-size:6.5pt;font-weight:normal}</style></head><body><h1>Fred Zhang Tip Calculator — Monthly / Period Report</h1><p>${esc(monthlyReportPeriodLabel())}</p>${monthlyReportExportTable(rows)}<script>window.onload=()=>{setTimeout(()=>window.print(),150)}<\/script></body></html>`;
  es18OpenPrintPreview(html.replace(/<script[\s\S]*?<\/script>/gi,''),'Monthly / Period Report');
};
function initMonthlyReportUi(){
  if(monthlyReportUiReady||$("monthlyReport"))return;
  const menu=document.querySelector(".staff-menu-buttons"),staffArea=$("staffArea")||$("staffApp");
  if(!menu||!staffArea)return;
  const btn=document.createElement("button");
  btn.type="button";btn.className="staff-menu-btn";btn.dataset.stab="monthlyReport";btn.innerHTML="<span>Monthly Report</span>";
  const setupBtn=menu.querySelector('[data-stab="setup"]');
  if(setupBtn)menu.insertBefore(btn,setupBtn);else menu.appendChild(btn);

  const section=document.createElement("section");
  section.className="staffPanel hidden";section.id="monthlyReport";
  section.innerHTML=`<div class="card fz-monthly-card">
    <div class="fz-monthly-head"><div><div class="fz-monthly-kicker">EMPLOYEE PERIOD SUMMARY</div><h2>Monthly / Period Report</h2><p>Choose any date range. Finalized reports are summarized by employee — not shown one Daily Report at a time.</p></div>
      <div class="actions"><button class="btn light" type="button" onclick="monthlyReportSetThisMonth()">THIS MONTH</button><button class="btn light" type="button" onclick="downloadMonthlyReportXls()">DOWNLOAD XLS</button><button class="btn dark" type="button" onclick="downloadMonthlyReportPdf()">DOWNLOAD PDF</button></div></div>
    <div class="fz-monthly-filters"><div><label>Start Date</label><input id="monthlyReportFrom" type="date"></div><div><label>End Date</label><input id="monthlyReportTo" type="date"></div><div><label>Employee</label><select id="monthlyReportEmployee"><option value="">All Employees</option></select></div><button class="btn green" id="monthlyReportApply" type="button">APPLY</button></div>
    <div id="monthlyReportStatus"></div>
    <div class="fz-monthly-kpis"><div><span>Employees</span><b id="monthlyKpiEmployees">0</b></div><div><span>Employee Work Days</span><b id="monthlyKpiDays">0</b></div><div><span>Total Hours</span><b id="monthlyKpiHours">0</b></div><div><span>Net to Employees</span><b id="monthlyKpiNet">$0.00</b></div></div>
    <div id="monthlyReportBody"></div>
  </div>`;
  const analytics=$("analytics");
  if(analytics?.parentNode)analytics.parentNode.insertBefore(section,analytics.nextSibling);else staffArea.appendChild(section);

  const style=document.createElement("style");style.id="fzMonthlyReportStyles";style.textContent=`
    .fz-monthly-card{overflow:hidden}.fz-monthly-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}.fz-monthly-head h2{margin:2px 0 5px;font-size:30px}.fz-monthly-head p{margin:0;color:#64748b}.fz-monthly-kicker{font-size:11px;letter-spacing:.16em;font-weight:1000;color:#2563eb}.fz-monthly-filters{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr)) auto;gap:12px;align-items:end;margin:18px 0 12px}.fz-monthly-filters .btn{min-height:48px}.fz-monthly-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0}.fz-monthly-kpis>div{border:1px solid #dfe7f1;border-radius:15px;background:#f8fbff;padding:13px}.fz-monthly-kpis span{display:block;font-size:11px;font-weight:900;color:#64748b;text-transform:uppercase;letter-spacing:.04em}.fz-monthly-kpis b{display:block;font-size:22px;margin-top:4px;color:#10233f}.fz-monthly-table-wrap{width:100%;overflow:auto;max-height:68vh;border:1px solid #dfe6ef;border-radius:16px;-webkit-overflow-scrolling:touch}.fz-monthly-table{border-collapse:separate;border-spacing:0;min-width:2200px;width:100%;font-size:13px}.fz-monthly-table th,.fz-monthly-table td{padding:10px 11px;border-right:1px solid #e3e9f1;border-bottom:1px solid #e3e9f1;text-align:right;white-space:nowrap}.fz-monthly-table thead th{position:sticky;top:0;z-index:4;background:#10233f;color:#fff;font-size:12px}.fz-monthly-table th:first-child,.fz-monthly-table td:first-child{position:sticky;left:0;text-align:left;z-index:3;background:#fff;min-width:215px}.fz-monthly-table thead th:first-child{z-index:6;background:#10233f}.fz-monthly-table tfoot td{font-weight:1000;background:#eef5ff}.fz-monthly-table tfoot td:first-child{background:#eef5ff}.fz-monthly-name small,.fz-monthly-total small{display:block;margin-top:3px;font-size:10px;color:#718096;font-weight:700}.fz-monthly-footnote{margin-top:10px;color:#64748b;line-height:1.45}@media(max-width:800px){.fz-monthly-head h2{font-size:26px}.fz-monthly-filters{grid-template-columns:1fr 1fr}.fz-monthly-filters>div:nth-child(3){grid-column:1/-1}.fz-monthly-filters .btn{grid-column:1/-1}.fz-monthly-kpis{grid-template-columns:1fr 1fr}.fz-monthly-table{font-size:12px}}@media(max-width:430px){.fz-monthly-filters,.fz-monthly-kpis{grid-template-columns:1fr}.fz-monthly-filters>div:nth-child(3),.fz-monthly-filters .btn{grid-column:auto}.fz-monthly-head .actions{width:100%}}
  `;document.head.appendChild(style);

  const d=new Date(),z=n=>String(n).padStart(2,"0");
  const lastDay=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  $("monthlyReportFrom").value=`${d.getFullYear()}-${z(d.getMonth()+1)}-01`;
  $("monthlyReportTo").value=`${d.getFullYear()}-${z(d.getMonth()+1)}-${z(lastDay)}`;
  btn.addEventListener("click",()=>{
    if(!["manager","owner"].includes(currentProfile?.role||""))return;
    document.querySelectorAll("[data-stab]").forEach(x=>x.classList.remove("on"));btn.classList.add("on");
    document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));section.classList.remove("hidden");
    window.renderMonthlyReport();
  });
  $("monthlyReportApply").addEventListener("click",window.renderMonthlyReport);
  $("monthlyReportFrom").addEventListener("change",window.renderMonthlyReport);
  $("monthlyReportTo").addEventListener("change",window.renderMonthlyReport);
  $("monthlyReportEmployee").addEventListener("change",window.renderMonthlyReport);
  monthlyReportUiReady=true;
  monthlyReportPopulateEmployee();
}
initMonthlyReportUi();
// V13.8.49 ADD-ONLY — Monthly / Period Report with Busser AM / PM split.

// V13.8.49 ADD-ONLY — Monthly / Period Report SIMPLE SUMMARY + direct PDF/XLS.
// Scope: Monthly Report only. Existing Daily Report, payout formulas, thermal print,
// PassPRNT callback/session handling, Firebase writes, and all unrelated features remain unchanged.
(function(){
  const oldRender=window.renderMonthlyReport;

  monthlyReportHeaderHtml=function(){
    return `<tr><th>Name</th><th>Total Hours</th><th>Paid Tip</th><th>Cash Tip</th><th>Paid Tip Before Meal</th>
      <th>Busser Tip Out AM</th><th>Busser Tip Out PM</th><th>Bar Tip Out</th><th>Bar Tip Out Received</th><th>Sales</th><th>Hourly Adjustment</th></tr>`;
  };

  monthlyReportTableRowsHtml=function(rows){
    return rows.map(r=>`<tr>
      <td class="fz-monthly-name"><b>${esc(r.employee)}</b></td>
      <td>${r.hours.toFixed(2)}</td>
      <td>${monthlyReportMoney(r.paidTip)}</td>
      <td>${monthlyReportMoney(r.cashTip)}</td>
      <td>${monthlyReportMoney(monthlyReportRound(r.paidTip+r.cashTip))}</td>
      <td>${monthlyReportMoney(r.busserAM)}</td>
      <td>${monthlyReportMoney(r.busserPM)}</td>
      <td>${monthlyReportMoney(r.barTipOut)}</td>
      <td>${monthlyReportMoney(r.barTipReceived)}</td>
      <td>${monthlyReportMoney(r.grandTotal)}</td>
      <td>${monthlyReportMoney(r.adjustment)}</td>
    </tr>`).join("");
  };

  monthlyReportTotalRowHtml=function(t){
    return `<tr class="fz-monthly-total"><td><b>TOTAL</b></td>
      <td>${t.hours.toFixed(2)}</td>
      <td>${monthlyReportMoney(t.paidTip)}</td>
      <td>${monthlyReportMoney(t.cashTip)}</td>
      <td>${monthlyReportMoney(monthlyReportRound(t.paidTip+t.cashTip))}</td>
      <td>${monthlyReportMoney(t.busserAM)}</td>
      <td>${monthlyReportMoney(t.busserPM)}</td>
      <td>${monthlyReportMoney(t.barTipOut)}</td>
      <td>${monthlyReportMoney(t.barTipReceived)}</td>
      <td>${monthlyReportMoney(t.grandTotal)}</td>
      <td>${monthlyReportMoney(t.adjustment)}</td></tr>`;
  };

  monthlyReportExportTable=function(rows){
    const totals=monthlyReportTotals(rows);
    return `<table border="1" cellspacing="0" cellpadding="6"><thead>${monthlyReportHeaderHtml()}</thead><tbody>${monthlyReportTableRowsHtml(rows)}</tbody><tfoot>${monthlyReportTotalRowHtml(totals)}</tfoot></table>`;
  };

  window.renderMonthlyReport=function(){
    if(!monthlyReportUiReady)return;
    monthlyReportPopulateEmployee();
    const {from,to}=monthlyReportRange();
    const host=$("monthlyReportBody"),status=$("monthlyReportStatus");
    if(!host)return;
    if(from&&to&&from>to){
      if(status)status.innerHTML='<div class="notice danger"><b>Start Date cannot be after End Date.</b></div>';
      host.innerHTML="";return;
    }
    const rows=monthlyReportSummaries();
    const rawCount=monthlyReportFilteredReports().length;
    if(status)status.innerHTML=`<div class="notice good"><b>${esc(monthlyReportPeriodLabel())}</b> • ${rows.length} employee${rows.length===1?"":"s"} • ${rawCount} finalized report${rawCount===1?"":"s"}</div>`;
    if(!rows.length){
      host.innerHTML='<div class="notice">No finalized reports found for this period.</div>';
      return;
    }
    const totals=monthlyReportTotals(rows);
    host.innerHTML=`<div class="fz-monthly-table-wrap"><table class="fz-monthly-table"><thead>${monthlyReportHeaderHtml()}</thead><tbody>${monthlyReportTableRowsHtml(rows)}</tbody><tfoot>${monthlyReportTotalRowHtml(totals)}</tfoot></table></div>
      <div class="small fz-monthly-simple-note"><b>Paid Tip Before Meal</b> = Paid Tip + Cash Tip. <b>Sales</b> = Grand Total sales for the selected period. All employees are summarized into one report/file when All Employees is selected.</div>`;
  };

  function monthlyPdfText(font,size,x,y,value){
    return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET\n`;
  }
  function monthlyPdfCellText(font,size,x,y,w,value,align){
    let s=String(value??"");
    // Width approximation for standard Helvetica. Truncate only when necessary.
    const maxChars=Math.max(3,Math.floor((w-8)/(size*0.52)));
    if(s.length>maxChars)s=s.slice(0,Math.max(1,maxChars-1))+"…";
    s=s.normalize("NFKD").replace(/[^\x20-\x7E]/g," ");
    const approx=s.length*size*0.52;
    let tx=x+4;
    if(align==="right")tx=Math.max(x+4,x+w-4-approx);
    else if(align==="center")tx=Math.max(x+4,x+(w-approx)/2);
    return monthlyPdfText(font,size,tx,y,s);
  }
  function monthlyPdfRect(x,y,w,h,fill){
    let c="";
    if(fill)c+=`${fill} rg ${x} ${y} ${w} ${h} re f\n0 0 0 rg\n`;
    c+=`0.55 G 0.5 w ${x} ${y} ${w} ${h} re S\n0 G\n`;
    return c;
  }
  function monthlyReportPdfBlob(rows){
    // Monthly PDF is intentionally a one-page professional summary.
    // - One selected employee: one-page summary for that employee.
    // - All Employees: one-page grand-total summary for the selected period.
    // XLS remains the detailed per-employee export.
    const totals=monthlyReportTotals(rows);
    const selectedEmployee=String($("monthlyReportEmployee")?.value||"").trim();
    const isAll=!selectedEmployee;
    const source=isAll?totals:(rows.find(r=>String(r.employee||"")===selectedEmployee)||rows[0]||totals);
    const summary={
      name:isAll?"ALL EMPLOYEES":String(source.employee||selectedEmployee||"Employee"),
      hours:monthlyReportNum(source.hours),
      paidTip:monthlyReportNum(source.paidTip),
      cashTip:monthlyReportNum(source.cashTip),
      paidBefore:monthlyReportRound(monthlyReportNum(source.paidTip)+monthlyReportNum(source.cashTip)),
      busserAM:monthlyReportNum(source.busserAM),
      busserPM:monthlyReportNum(source.busserPM),
      barOut:monthlyReportNum(source.barTipOut),
      barReceived:monthlyReportNum(source.barTipReceived),
      sales:monthlyReportNum(source.grandTotal),
      adjustment:monthlyReportNum(source.adjustment)
    };

    const card=(x,y,w,h,label,value,emphasis=false)=>{
      let c="";
      const fill=emphasis?"0.96 0.98 1":"0.985 0.992 1";
      c+=`${fill} rg ${x} ${y} ${w} ${h} re f\n`;
      c+=`0.78 0.84 0.90 RG 0.8 w ${x} ${y} ${w} ${h} re S\n0 G\n`;
      c+=`0.12 0.48 0.70 rg ${x} ${y} 4 ${h} re f\n0 0 0 rg\n`;
      c+=monthlyPdfCellText("F2",8.4,x+14,y+h-19,w-24,label,"left");
      c+=monthlyPdfCellText("F2",18,x+14,y+18,w-24,value,"left");
      return c;
    };

    const left=[
      ["Total Hours",summary.hours.toFixed(2),false],
      ["Paid Tip",pdfMoney(summary.paidTip).replace("$ ","$"),false],
      ["Cash Tip",pdfMoney(summary.cashTip).replace("$ ","$"),false],
      ["Paid Tip Before Meal",pdfMoney(summary.paidBefore).replace("$ ","$"),true],
      ["Sales",pdfMoney(summary.sales).replace("$ ","$"),true]
    ];
    const right=[
      ["Busser Tip Out AM",pdfMoney(summary.busserAM).replace("$ ","$"),false],
      ["Busser Tip Out PM",pdfMoney(summary.busserPM).replace("$ ","$"),false],
      ["Bar Tip Out",pdfMoney(summary.barOut).replace("$ ","$"),false],
      ["Bar Tip Out Received",pdfMoney(summary.barReceived).replace("$ ","$"),false],
      ["Hourly Adjustment",pdfMoney(summary.adjustment).replace("$ ","$"),false]
    ];

    let c="";
    // Header
    c+="0.055 0.14 0.25 rg 28 686 556 78 re f\n";
    c+="0.95 0.68 0.13 rg 28 680 556 5 re f\n";
    c+="0.95 0.68 0.13 rg\n"+monthlyPdfText("F2",9,46,744,"MONTHLY / PERIOD REPORT")+"1 1 1 rg\n";
    c+=monthlyPdfText("F2",20,46,718,"Fred Zhang Tip Calculator");
    c+=monthlyPdfText("F1",9.2,46,699,`Period: ${monthlyReportPeriodLabel()}`);
    c+="0 0 0 rg\n";

    // Name / scope strip
    c+="0.94 0.97 1 rg 34 642 544 26 re f\n";
    c+="0.76 0.84 0.91 RG 0.8 w 34 642 544 26 re S\n0 G\n";
    c+="0.055 0.14 0.25 rg\n"; // ES1.4: restore readable text after pale strip fill.
    c+=monthlyPdfCellText("F2",11,46,650,520,isAll?"SUMMARY: ALL EMPLOYEES":`EMPLOYEE: ${summary.name}`,"left");

    const xL=34,xR=314,w=264,h=68,gap=10,top=626;
    for(let i=0;i<5;i++){
      const y=top-h-i*(h+gap);
      c+=card(xL,y,w,h,left[i][0],left[i][1],left[i][2]);
      c+=card(xR,y,w,h,right[i][0],right[i][1],right[i][2]);
    }

    // Footer note
    c+="0.975 0.98 0.985 rg 34 116 544 76 re f\n";
    c+="0.82 0.85 0.89 RG 0.7 w 34 116 544 76 re S\n0 G\n";
    c+="0.055 0.14 0.25 rg\n"; // ES1.4: footer text must not inherit its near-white background.
    c+=monthlyPdfText("F2",8.6,48,171,"REPORT NOTES");
    c+=monthlyPdfText("F1",8,48,153,"Paid Tip Before Meal = Paid Tip + Cash Tip.");
    c+=monthlyPdfText("F1",8,48,138,"Sales = Grand Total sales for the selected period.");
    c+=monthlyPdfText("F1",8,48,123,isAll?"All figures above are grand totals for all employees in this period.":"All figures above are totals for the selected employee in this period.");
    c+=monthlyPdfText("F1",7.2,34,88,"Generated from finalized Tip Calculation reports.");

    const objects=[];
    objects[1]="<< /Type /Catalog /Pages 2 0 R >>";
    objects[2]="<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    objects[3]="<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>";
    objects[4]=`<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
    objects[5]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objects[6]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
    let pdf="%PDF-1.4\n";const offsets=[0];
    for(let i=1;i<=6;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
    const xref=pdf.length;pdf+=`xref\n0 7\n0000000000 65535 f \n`;
    for(let i=1;i<=6;i++)pdf+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
    pdf+=`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Blob([pdf],{type:"application/pdf"});
  }

  window.downloadMonthlyReportPdf=function(){
    if(!["manager","owner"].includes(currentProfile?.role||""))return;
    const rows=monthlyReportSummaries();
    if(!rows.length){alert("No Monthly Report data for this period.");return;}
    const range=monthlyReportRange(),safeFrom=range.from||"all",safeTo=range.to||"all";
    downloadBlob(monthlyReportPdfBlob(rows),`Fred_Zhang_Monthly_Report_${safeFrom}_to_${safeTo}.pdf`);
  };

  // Replace old render listeners with the simplified renderer. Menu click uses window.renderMonthlyReport dynamically.
  const apply=$("monthlyReportApply"),from=$("monthlyReportFrom"),to=$("monthlyReportTo"),employee=$("monthlyReportEmployee");
  if(oldRender){
    apply?.removeEventListener("click",oldRender);
    from?.removeEventListener("change",oldRender);
    to?.removeEventListener("change",oldRender);
    employee?.removeEventListener("change",oldRender);
  }
  apply?.addEventListener("click",window.renderMonthlyReport);
  from?.addEventListener("change",window.renderMonthlyReport);
  to?.addEventListener("change",window.renderMonthlyReport);
  employee?.addEventListener("change",window.renderMonthlyReport);

  const section=$("monthlyReport");
  if(section){
    section.querySelector(".fz-monthly-kpis")?.remove();
    const headText=section.querySelector(".fz-monthly-head p");
    if(headText)headText.textContent="Choose any date range. All finalized Daily Reports are combined and summarized by employee in one simple report.";
    const actions=section.querySelector(".fz-monthly-head .actions");
    if(actions){
      const printBtn=[...actions.querySelectorAll("button")].find(b=>String(b.getAttribute("onclick")||"").includes("printMonthlyReport"));
      if(printBtn){printBtn.textContent="DOWNLOAD PDF";printBtn.className="btn dark";printBtn.setAttribute("onclick","downloadMonthlyReportPdf()");}
    }
  }
  const style=document.createElement("style");style.id="fzMonthlySimpleSummaryStyles";style.textContent=`
    #monthlyReport .fz-monthly-table{min-width:1450px!important}
    #monthlyReport .fz-monthly-table th,#monthlyReport .fz-monthly-table td{padding:11px 10px!important}
    #monthlyReport .fz-monthly-table th:first-child,#monthlyReport .fz-monthly-table td:first-child{min-width:180px!important}
    #monthlyReport .fz-monthly-simple-note{margin-top:10px;color:#64748b;line-height:1.45}
  `;if(document.head)document.head.appendChild(style);
})();
// V13.8.49 ADD-ONLY — Monthly Simple Summary / Download PDF + XLS.


// V13.8.49 ADD-ONLY — Monthly Report large Home card opener.
// Scope: navigation/UI only. Monthly calculations, Daily Report, thermal print,
// Firebase writes, formulas, and all unrelated functions remain unchanged.
(function(){
  window.fzOpenMonthlyReport=function(){
    const role=String(window.__getCurrentRole?.()||"").toLowerCase();
    if(!["manager","owner"].includes(role))return;

    // Ensure the add-only Monthly Report UI exists even if its first init ran
    // before the Manager / Owner workspace was ready.
    try{ initMonthlyReportUi(); }catch(e){ console.warn("Monthly Report init:",e); }

    const section=$("monthlyReport");
    if(!section){
      alert("Monthly Report is still loading. Please try again.");
      return;
    }

    // If the section had to be created late, normalize its controls to the
    // current Simple Summary build (direct PDF + XLS downloads).
    section.querySelector(".fz-monthly-kpis")?.remove();
    const headText=section.querySelector(".fz-monthly-head p");
    if(headText)headText.textContent="Choose any date range. All finalized Daily Reports are combined and summarized by employee in one simple report.";
    const actions=section.querySelector(".fz-monthly-head .actions");
    if(actions){
      const xls=[...actions.querySelectorAll("button")].find(b=>String(b.getAttribute("onclick")||"").includes("downloadMonthlyReportXls"));
      if(xls){xls.textContent="DOWNLOAD XLS";xls.className="btn light";}
      const pdf=[...actions.querySelectorAll("button")].find(b=>/printMonthlyReport|downloadMonthlyReportPdf/.test(String(b.getAttribute("onclick")||"")));
      if(pdf){pdf.textContent="DOWNLOAD PDF";pdf.className="btn dark";pdf.setAttribute("onclick","downloadMonthlyReportPdf()");}
    }

    $("fzRoleHome")?.classList.add("hidden");
    document.body.classList.remove("hourly-v1-mode","hourly-v1-editing","hourly-v1-small-report","hourly-workspace-mode","small-report-fullscreen");
    document.documentElement.classList.remove("small-report-fullscreen");
    $("hourlyV1Workspace")?.classList.add("hidden");
    $("hostCashierTip")?.classList.add("hidden");
    $("employeeApp")?.classList.add("hidden");
    $("staffApp")?.classList.remove("hidden");

    document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
    section.classList.remove("hidden");
    document.querySelectorAll("[data-stab]").forEach(x=>x.classList.remove("on"));
    document.querySelector('[data-stab="monthlyReport"]')?.classList.add("on");

    try{ monthlyReportPopulateEmployee(); }catch(e){}
    try{ window.renderMonthlyReport?.(); }catch(e){ console.warn("Monthly Report render:",e); }
    window.scrollTo({top:0,left:0,behavior:"instant"});
  };
})();
// V13.8.49 ADD-ONLY — Monthly Report Home card.

/* ================================================================
 * EMPLOYEE SHEET ES1 — additive Manager/Owner workspace.
 * Baseline: MONTHLY_PDF_PRO_ONE_PAGE / 13.8.49.
 * Original calculation engine and original workflows are unchanged.
 * All edits remain drafts until a row is saved to hourlyReports.
 * ================================================================ */
const ES_BUILD='ES1.8.7';
const ES_PERIODS=['AM','2PM_4PM','PM'];
const ES_MONEY=['totalAM','total24','grand','paid','cardFee','cash','meal'];
const ES_FIELDS=['shift','role','clockIn','clockOut','clockIn2','clockOut2',...ES_MONEY,'barAM','bar24','barPM','adjustmentDecision'];
let esSession=null,esOpenToken=0,esSignature=null;
const esClone=x=>JSON.parse(JSON.stringify(x));
const esKey=name=>normalizeEmployeeNameKey(name);
function esAllowed(){return !!currentUser && !currentUser.isAnonymous && ['manager','owner'].includes(currentProfile?.role||'');}
function esDateValid(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return false;const d=new Date(date+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===date;}
function esDraftKey(date,uid=currentUser?.uid||''){return 'fz_employee_sheet_es1_'+uid+'_'+date;}
function esMoney(v){return fmtMoney(Number(v)||0);}
function esStatus(text,error=false){const el=$('esStatus');if(el){el.textContent=text;el.dataset.error=error?'1':'0';}}
function esFixedRole(name){return employeeWorkProfile(name)?.position||'';}
function esNormalizeClock(v){return ownerTableFormatClock(String(v||''));}
function esDefaults(name,date){return {name,shift:'',role:esFixedRole(name)||'Server',clockIn:'',clockOut:'',clockIn2:'',clockOut2:'',totalAM:'',total24:'',grand:'',paid:'',cardFee:'0',cash:'0',meal:'0',barAM:true,bar24:true,barPM:true,adjustmentDecision:''};}
function esFindReport(reports,name){
  const list=reports.filter(r=>esKey(r.employee)===esKey(name));
  return list.length===1?list[0]:null;
}
function esPrepareBatch(source,reports,date){
  const s=esClone(source||{});s.date=date;s.team=Array.isArray(s.team)?s.team:[];s.drafts ||= {};hv1EnsureBarState(s);
  for(const r of reports){
    if(r.date!==date || !r.employee)continue;
    const name=s.team.find(n=>esKey(n)===esKey(r.employee))||r.employee;
    if(!s.team.includes(name))s.team.push(name);
    if(!s.drafts[name] || (!s.drafts[name].values?.hShift && !es16RawValid(s.drafts[name],s,name))){
      s.drafts[name]=hv1DraftFromFinalizedReport(r,name,date);
    }
    const d=s.drafts[name];
    if(!d.hourlyReportId)d.hourlyReportId=r.id;
    if(String(r.position).toLowerCase()==='bartender'){
      for(const p of bartenderReceiptPeriods(r))if(!s.bar[p.checkpoint].bartender)s.bar[p.checkpoint].bartender=name;
    }else if(r.barBreakdown){
      for(const [cp,key] of [['AM','amGrandTotal'],['2PM_4PM','grandTotal24'],['PM','pmGrandTotal']]){
        if(s.bar[cp].entries[name]===undefined && Number(r.barBreakdown[key])>0)s.bar[cp].entries[name]=String(r.barBreakdown[key]);
      }
    }
  }
  s.team=[...new Set(s.team)];return s;
}
function esRowsFromBatch(s,reports=[],date=s.date||hv1DateValue()){
  return (s.team||[]).map(name=>{
    const d=s.drafts?.[name]||{},v=d.values||{},r=esFindReport(reports,name);
    const row={...esDefaults(name,date),...ownerTableRow(s,name)};
    row.role=esFixedRole(name)||v.hPosition||row.role||'Server';
    row.role=row.role==='Bartender'?'Bartender':'Server';
    row.adjustmentDecision=d.employeeSheetAdjustmentDecision||r?.adjustmentDecision||'';
    for(const f of ['paid','cardFee','cash','meal'])if(row[f]==='' && !d.entered?.[OWNER_TABLE_MONEY[f]] && ['cardFee','cash','meal'].includes(f))row[f]='0';
    for(const [field,cp] of [['barAM','AM'],['bar24','2PM_4PM'],['barPM','PM']]){
      if(s.bar?.[cp]?.excluded?.[name]===undefined && !d.entered?.[hv1BarChoiceField(cp,s,name)])row[field]=true;
    }
    if(es16RawValid(d,s,name))for(const field of ES_FIELDS)if(Object.prototype.hasOwnProperty.call(d.employeeSheetRawRow,field))row[field]=d.employeeSheetRawRow[field];
    return row;
  });
}
function esPeriodCandidates(rows,cp){
  return rows.filter(r=>r.role==='Bartender' && (
    cp==='AM'?['AM','DOUBLE',SHIFT_EARLY].includes(r.shift):
    cp==='2PM_4PM'?['DOUBLE','LONG',SHIFT_MIDDLE].includes(r.shift):['PM','DOUBLE','LONG'].includes(r.shift)));
}
function esRouting(rows,old={}){
  const route={};
  for(const cp of ES_PERIODS){
    const candidates=esPeriodCandidates(rows,cp);
    const selected=String(old[cp]||'');
    route[cp]=candidates.some(r=>r.name===selected)?selected:(candidates.length===1?candidates[0].name:'');
  }
  return route;
}
function esSalesMask(row,route){
  if(row.role==='Bartender')return {totalAM:['DOUBLE','LONG'].includes(row.shift),total24:false,grand:true};
  return {totalAM:['AM','DOUBLE',SHIFT_EARLY].includes(row.shift),total24:['DOUBLE','LONG',SHIFT_MIDDLE].includes(row.shift)||(row.shift==='AM'&&!!route['2PM_4PM']),grand:true};
}
function esBarMask(row,route){
  if(row.role==='Bartender')return {barAM:false,bar24:false,barPM:false};
  return {barAM:['AM','DOUBLE',SHIFT_EARLY].includes(row.shift),bar24:['LONG','DOUBLE',SHIFT_MIDDLE].includes(row.shift)||(row.shift==='AM'&&!!route['2PM_4PM']),barPM:['PM','DOUBLE','LONG'].includes(row.shift)};
}
function esLinkSales(row,field,route){
  if(row.role==='Bartender')return;
  let linked='';
  if(row.shift===SHIFT_EARLY || (row.shift==='AM'&&!route['2PM_4PM']))linked='totalAM';
  if(row.shift===SHIFT_MIDDLE || (row.shift==='AM'&&route['2PM_4PM']))linked='total24';
  if(linked){if(field===linked)row.grand=row[linked];else if(field==='grand' || field==='shift')row[linked]=row.grand;}
}
function esValidateSales(row,route,complete=false){
  const errors=[];const mask=esSalesMask(row,route);
  for(const field of ES_MONEY){
    if(field==='totalAM'&&!mask.totalAM || field==='total24'&&!mask.total24)continue;
    const raw=String(row[field]??'').trim();
    if(raw && (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(raw)||!Number.isFinite(Number(raw))))errors.push(field+' must be 0 or more, with at most 2 decimals.');
  }
  if(row.role==='Server'){
    let previous=0;
    for(const [field,enabled] of [['totalAM',mask.totalAM],['total24',mask.total24],['grand',true]]){
      const raw=String(row[field]??'').trim();if(!enabled||raw==='')continue;
      // During an unfinished Double/Long shift the final POS total is still
      // blank/0. Publish valid AM/2-4 checkpoints now, without inventing a PM
      // Grand Total. A real final Save/Sign/Print remains strict.
      if(field==='total24'&&Number(raw)===0&&previous>0)continue;
      if(!complete&&field==='grand'&&['DOUBLE','LONG'].includes(row.shift)&&Number(raw)===0&&previous>0)continue;
      if(Number(raw)<previous)errors.push(field+' cannot be below the earlier cumulative sales.');
      previous=Math.max(previous,Number(raw)||0);
    }
  }else if(['DOUBLE','LONG'].includes(row.shift) && Number(row.totalAM)>Number(row.grand))errors.push('Total AM cannot exceed Grand Total.');
  if(complete){
    if(!TIP_SHIFTS.includes(row.shift))errors.push('Choose a shift.');
    for(const f of ['grand','paid','cardFee','cash','meal'])if(String(row[f]??'').trim()==='')errors.push('Enter '+f+' (use 0 if none).');
    if(row.shift==='DOUBLE' && String(row.totalAM??'').trim()==='')errors.push('Enter Total AM (use 0 if none).');
    if(row.shift==='LONG' && String(row[row.role==='Server'?'total24':'totalAM']??'').trim()==='')errors.push('Enter early sales (use 0 if none).');
    const clocks=row.shift==='DOUBLE'?['clockIn','clockOut','clockIn2','clockOut2']:['clockIn','clockOut'];
    for(const f of clocks)if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(row[f]||''))errors.push('Enter '+f+' as HH:MM, e.g. 21:00.');
    const hours=esHours(row),L=window.FredTipCalculatorLogic;
    if(!(L.calculateTotalMinutes(row.shift,hours)>0))errors.push('Working hours must be greater than zero.');
    if(row.shift==='DOUBLE' && clocks.every(f=>/^([01]\d|2[0-3]):[0-5]\d$/.test(row[f]||''))){
      const mins=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
      const first=mins(row.clockIn),firstEnd=mins(row.clockOut)+(mins(row.clockOut)<first?1440:0);
      let second=mins(row.clockIn2);if(second<first)second+=1440;
      let secondEnd=mins(row.clockOut2);while(secondEnd<second)secondEnd+=1440;
      if(second<firstEnd)errors.push('Clock pair 2 overlaps clock pair 1.');
      if(secondEnd-first>1440)errors.push('Both clock pairs must fit within one 24-hour work day.');
    }
    if(row.role==='Bartender' && !ES_PERIODS.some(cp=>route[cp]===row.name))errors.push('Choose this bartender in the BAR routing on this sheet.');
  }
  return [...new Set(errors)];
}
function esHours(row){return row.shift==='DOUBLE'?{hourInAM:row.clockIn,hourOutAM:row.clockOut,hourInPM:row.clockIn2,hourOutPM:row.clockOut2}:{hourIn:row.clockIn,hourOut:row.clockOut};}
function esBuildBatch(source,rows,date,route){
  const s=esClone(source||{});s.date=date;s.team=rows.map(r=>r.name);s.drafts ||= {};hv1EnsureBarState(s);
  for(const cp of ES_PERIODS)s.bar[cp].bartender=route[cp]||'';
  for(const row of rows){
    const name=row.name,d=s.drafts[name] ||= {employee:name,date,values:{},entered:{},skippedPages:[]};
    d.employee=name;d.date=date;d.values ||= {};d.entered ||= {};
    const put=(key,value)=>{d.values[key]=String(value??'');d.entered[key]=String(value??'').trim()!=='';};
    const fixed=esFixedRole(name);
    if(fixed && fixed!==row.role)throw new Error(name+' is a '+fixed+' work account. Use the matching work account for the other position.');
    put('hEmployee',name);put('hDate',date);put('hPosition',row.role);put('hShift',row.shift);
    put('hBusserAM',isWeekendDate(date)?'WITH':'WITHOUT');
    d.hourlyWizardState={...(d.hourlyWizardState||{}),position:row.role,shift:row.shift,busserAM:isWeekendDate(date)?'WITH':'WITHOUT'};
    const clocks=row.shift==='DOUBLE'?{hAmIn:row.clockIn,hAmOut:row.clockOut,hPmIn:row.clockIn2,hPmOut:row.clockOut2}:{hIn:row.clockIn,hOut:row.clockOut};
    for(const [key,value] of Object.entries(clocks))put(key,value);
    for(const [field,key] of Object.entries(OWNER_TABLE_MONEY))put(key,row[field]);
    d.employeeSheetAdjustmentDecision=row.adjustmentDecision||'';
    d.editHydratedFromFinalV13811=true;
    if(row.role==='Server'){
      const mask=esSalesMask(row,route),barMask=esBarMask(row,route);
      const amount={AM:mask.totalAM?row.totalAM:'','2PM_4PM':mask.total24?row.total24:'',PM:barMask.barPM?row.grand:''};
      if(row.shift===SHIFT_EARLY || (row.shift==='AM'&&!route['2PM_4PM']))amount.AM=row.grand;
      if(row.shift===SHIFT_MIDDLE || (row.shift==='AM'&&route['2PM_4PM']))amount['2PM_4PM']=row.grand;
      for(const [cp,field] of [['AM','barAM'],['2PM_4PM','bar24'],['PM','barPM']]){
        s.bar[cp].entries[name]=String(amount[cp]??'');
        s.bar[cp].excluded ||= {};s.bar[cp].excluded[name]=!barMask[field]||!row[field];
        s.barManual ||= {};s.barManual[name] ||= {};s.barManual[name][cp]=true;
      }
      // Baseline bridge maps cumulative checkpoints into hGrandTotal/hTotalAM.
      delete d.barSalesLinks;
      hv1SyncBarSalesToDraft(s,name);hv1SyncLongBusserDraft(s,name);
      const amCP=row.shift==='AM'&&route['2PM_4PM']?'2PM_4PM':'AM';
      put('hAmBar',s.bar[amCP].excluded[name]?'no':'yes');
      put('hPmBar',s.bar[row.shift===SHIFT_MIDDLE?'2PM_4PM':'PM'].excluded[name]?'no':'yes');
    }else{
      for(const cp of ES_PERIODS){delete s.bar[cp].entries[name];if(s.bar[cp].excluded)delete s.bar[cp].excluded[name];}
      put('hAmBar','no');put('hPmBar','no');
    }
  }
  // These are the same, unchanged BAR functions as the existing Team Board.
  hv1ApplyBarAutomation(s);
  // Preserve intentional blanks through the legacy wizard/BAR bridge. A legacy
  // editor changing its underlying values invalidates this raw overlay.
  for(const row of rows){const d=s.drafts[row.name];d.employeeSheetRawRow=esClone(row);d.employeeSheetRawSource=es16RawSource(s,row.name);}
  return s;
}
function esCalculate(row,batch,oldReport=null){
  const L=window.FredTipCalculatorLogic,d=batch.drafts[row.name],v=d.values,bt=row.role==='Bartender';
  const hours=esHours(row);
  const r=L.calculateReport({date:batch.date,employee:row.name,position:row.role,shift:row.shift,busserAM:v.hBusserAM,hours,grandTotal:v.hGrandTotal,totalAM:v.hTotalAM,paidTip:row.paid,cardFee:row.cardFee,cashTip:row.cash,meal:row.meal,amBarSales:v.hAmBar==='yes',pmBarSales:v.hPmBar==='yes'});
  r.barTipAM=r.amBarTipOut||0;r.barTipPM=r.pmBarTipOut||0;
  Object.assign(r,{bartenderCheckpoints:[],bartenderPeriodReceipts:[],bartenderReceiptsSource:'',bartenderShiftType:'',bartenderServerEntries:[],bartenderServerGrandTotalSummary:0,bartenderGrossBarTipOut:0,bartenderLessAM:0,bartenderLess24:0,bartenderPreviousAMInput:0,bartenderPrevious24Input:0,bartenderBarTipReceived:0});
  if(bt){
    const periods=ES_PERIODS.filter(cp=>hv1BarRecipient(cp,batch)===row.name).map(checkpoint=>({checkpoint,amount:hv1BarReceived(checkpoint,batch)}));
    const received=howRoundCent(periods.reduce((sum,p)=>sum+p.amount,0));
    const last=periods.at(-1)?.checkpoint||'AM',period=hv1BarCheckpointTotals(last,batch);
    Object.assign(r,{bartenderCheckpoints:periods.map(p=>p.checkpoint),bartenderPeriodReceipts:periods,bartenderReceiptsSource:'BAR_CENTER',bartenderShiftType:last,bartenderBarTipReceived:received,
      bartenderServerEntries:hv1ServerNamesForCheckpoint(last,batch).filter(n=>!hv1BarExcluded(last,batch,n)).map((name,i)=>({slot:i+1,name,grandTotal:hv1BarNumber(batch.bar[last].entries[name])})),
      bartenderServerGrandTotalSummary:period.summary,bartenderGrossBarTipOut:period.gross,bartenderLessAM:period.lessAM,bartenderLess24:period.less24,bartenderPreviousAMInput:period.lessAM,bartenderPrevious24Input:period.less24});
    r.totalBeforeMeal=Number(r.totalBeforeMeal||0)+received;
  }else{
    const b=hv1ServerBarFees(row.name,batch),delta=b.totalFee-Number(r.barTipOut||0);
    Object.assign(r,{barTipAM:b.amFee,barTip24:b.fee24,barTipPM:b.fee24+b.pmFee,barTipOut:b.totalFee,
      barBreakdown:{amGrandTotal:b.amGT,grandTotal24:b.gt24,pmGrandTotal:b.pmGT,amFee:b.amFee,fee24:b.fee24,pmFee:b.pmFee}});
    r.totalBeforeMeal=Number(r.totalBeforeMeal||0)-delta;
  }
  // Identical split of the engine's existing busser total (not a new deduction).
  const totalBusser=Math.max(0,Number(r.busserTipOut||0));let am=0,pm=0;
  if(!bt){
    if(row.shift==='PM')pm=totalBusser;
    else if(['DOUBLE','LONG'].includes(row.shift)){
      const expected=v.hBusserAM==='WITH'?Math.max(0,Number(r.totalAM||0)*Number(r.busserRate||0)/100):0;
      am=Math.min(totalBusser,expected);pm=Math.max(0,totalBusser-am);
    }else am=totalBusser;
  }
  r.busserTipOutAM=am;r.busserTipOutPM=pm;
  r.grandTotalTip=L.roundCent(r.totalBeforeMeal+r.cashTip);
  const choice=row.adjustmentDecision,changedChoice=choice && choice!==oldReport?.adjustmentDecision;
  const override=changedChoice?null:(oldReport&&Object.prototype.hasOwnProperty.call(oldReport,'adjustmentOverride')?oldReport.adjustmentOverride:oldReport?.adjustmentDecision==='ACCEPTED'?oldReport.adjustmentSalaryHourly:null);
  const adjustment=L.calculateHourlyAdjustment({...r,adjustmentDecision:choice||oldReport?.adjustmentDecision,adjustmentOverride:override});
  Object.assign(r,adjustment);
  r.adjustmentOverride=override;r.adjustmentPayoutVersion='13.8.29';r.formulaVersion='13.8.29';r.payoutFormula='Total Before Meal - Meal + Accepted Adjustment';
  r.grandTotalAfterAdjustment=L.roundCent(r.grandTotalTip+adjustment.adjustmentSalaryHourly);
  r.totalPaidOutBeforeAdjustment=L.roundCent(Math.max(0,r.totalBeforeMeal-r.meal));
  r.totalPaidOut=L.roundCent(Math.max(0,r.totalBeforeMeal-r.meal+adjustment.adjustmentSalaryHourly));
  r.hours={...hours};r.cardFee=L.parseMoney(row.cardFee);r.payCardTipFee=r.cardFee;
  if(row.shift==='LONG'&&!bt){r.busserSalesThrough4PM=r.totalAM;r.salesWithoutBusser=isWeekendDate(batch.date)?0:r.totalAM;r.busserSalesBasis=isWeekendDate(batch.date)?r.grandTotal:r.totalPM;r.busserPolicyVersion='LONG_MON_FRI_BAR_2_4_V1';}
  const profile=employeeWorkProfile(row.name);if(profile){r.personName=profile.personName;r.workProfile=profile.name;}
  return reportForWorkPosition(r);
}
function esFingerprint(r){
  if(!r)return '';
  // ES1.4: compare financial values, not object-key order or Firestore metadata.
  const shift=String(r.shift||'').toUpperCase(),h={...r,...(r.hours||{})};
  const keys=shift==='DOUBLE'?['hourInAM','hourOutAM','hourInPM','hourOutPM']:['hourIn','hourOut'];
  const clocks=keys.map(k=>esNormalizeClock(String(h[k]||'').trim()));
  const mins=window.FredTipCalculatorLogic.calculateTotalMinutes(shift,Object.fromEntries(keys.map((k,i)=>[k,clocks[i]])));
  const money=['grandTotal','totalAM','totalPM','paidTip','payCardTipFee','cashTip','meal','busserTipOut','busserTipOutAM','busserTipOutPM','barTipOut','bartenderBarTipReceived','totalPaidOut','adjustmentSalaryHourly'];
  const receipts=bartenderReceiptPeriods(r).map(p=>({checkpoint:p.checkpoint,amount:howRoundCent(Number(p.amount)||0)})).sort((a,b)=>String(a.checkpoint).localeCompare(String(b.checkpoint)));
  return JSON.stringify({employee:esKey(r.employee),date:r.date,position:String(r.position||'Server').toLowerCase(),shift,clocks,minutes:mins??r.totalMinutesWork??null,...Object.fromEntries(money.map(k=>[k,howRoundCent(Number(k==='payCardTipFee'?(r[k]??r.cardFee):k==='paidTip'?(r[k]??r.paidTips):r[k])||0)])),receipts});
}
function esCompareValue(a,b){return String(a??'')===String(b??'');}
function esMergeRows(baseRows,editedRows,remoteRows,dirty){
  const out=esClone(remoteRows),conflicts=[];
  for(const row of editedRows){
    const changes=dirty[row.name];if(!changes)continue;
    const base=baseRows.find(r=>r.name===row.name),remote=out.find(r=>r.name===row.name);
    if(changes.__new){if(remote && base===undefined)throw new Error(row.name+' was added on another device. Reload the sheet first.');if(!remote){out.push(esClone(row));continue;}}
    if(!remote)throw new Error(row.name+' was removed on another device. Reload before saving.');
    for(const field of ES_FIELDS){
      if(!changes[field]&&!changes.__new)continue;
      if(base && !esCompareValue(remote[field],base[field]) && !esCompareValue(remote[field],row[field]))conflicts.push(row.name+' / '+field);
      else remote[field]=row[field];
    }
  }
  if(conflicts.length)throw new Error('Changed on another device: '+conflicts.join(', ')+'. Your draft is kept. Reload and review before saving.');
  return out;
}
function esRecalculate(){
  const s=esSession;if(!s||!s.ready)return;
  try{
    s.routing=esRouting(s.rows,s.routing);
    s.working=esBuildBatch(s.baseBatch,s.rows,s.date,s.routing);
    s.results={};s.errors={};
    for(const row of s.rows){
      s.errors[row.name]=esValidateSales(row,s.routing,false);
      s.results[row.name]=esCalculate(row,s.working,esFindReport(s.reports,row.name));
    }
  }catch(e){esStatus(e.message,true);}
}
function esPersistLocal(){
  const s=esSession;if(!s?.ready)return false;
  try{localStorage.setItem(esDraftKey(s.date,s.uid),JSON.stringify({date:s.date,rows:s.rows,dirty:s.dirty,routing:s.routing,baseRows:s.baseRows,baseRouting:s.baseRouting,draftSaves:s.draftSaves||{},savedAt:Date.now(),scrollLeft:$('esGrid')?.scrollLeft||0,scrollTop:$('esGrid')?.scrollTop||0}));return true;}catch(e){esStatus('Device draft could not be saved. Free storage or reconnect before leaving.',true);return false;}
}
const ES_COLUMNS=[
 ['shift','Shift',145,'staff'],['clockIn','Clock In 1',130,'clocks'],['clockOut','Clock Out 1',130,'clocks'],['clockIn2','Clock In 2',130,'clocks'],['clockOut2','Clock Out 2',130,'clocks'],['hours','Total Hours',135,'clocks'],['role','Position',150,'staff'],
 ['totalAM','Total AM',165,'sales'],['total24','Total 2–4',165,'sales'],['grand','Grand Total',175,'sales'],['busserRate','Busser Tip Out %',155,'busser'],['busserAM','Busser AM',155,'busser'],['busserPM','Busser PM',155,'busser'],
 ['barTipAM','BAR Tip Out AM',160,'bar'],['barTip24','BAR Tip Out 2–4',160,'bar'],['barTipPM','BAR Tip Out PM',160,'bar'],['received','BAR Tip Out Received',220,'bar'],
 ['paid','Paid Tip',160,'tips'],['cardFee','Pay Card Tip Fee',160,'tips'],['cash','Cash Tip',155,'tips'],['meal','Meal',145,'tips'],['barAM','AM BAR Sales',125,'checks'],['bar24','2–4 BAR Sales',125,'checks'],['barPM','PM BAR Sales',125,'checks'],
 ['adjustmentDecision','Hourly Adjustment',230,'payout'],['payout','Paid Tip Out',190,'payout']
];
function esOption(value,label,selected){return `<option value="${esc(value)}"${String(value)===String(selected)?' selected':''}>${esc(label)}</option>`;}
function esInput(row,field,label){
  const mask=esSalesMask(row,esSession.routing),barMask=esBarMask(row,esSession.routing),idx=esSession.rows.indexOf(row);
  const attr=`data-es-row="${idx}" data-es-field="${field}" aria-label="${esc(row.name+' — '+label)}"`;
  if(field==='shift')return `<select ${attr}>${esOption('','Select shift',row.shift)}${TIP_SHIFTS.map(x=>esOption(x,x==='DOUBLE'?'Double':x==='LONG'?'Long':x===SHIFT_EARLY?'10:45–2 PM':x===SHIFT_MIDDLE?'2–4 PM':x,row.shift)).join('')}</select>`;
  if(field==='role')return `<select ${attr}${esFixedRole(row.name)?' disabled title="Position follows this work account"':''}>${['Server','Bartender'].map(x=>esOption(x,x,row.role)).join('')}</select>`;
  if(['barAM','bar24','barPM'].includes(field)){
    const cp=field==='barAM'?'AM':field==='bar24'?'2PM_4PM':'PM';
    if(row.role==='Bartender')return `<span class="es-auto">${esSession.routing[cp]===row.name?'✓ Receives':'—'}</span>`;
    return `<label class="es-check"><input type="checkbox" ${attr}${row[field]&&barMask[field]?' checked':''}${!barMask[field]?' disabled':''}><span>${barMask[field]?'Sales':'N/A'}</span></label>`;
  }
  if(field==='adjustmentDecision'){
    const r=esSession.results[row.name]||{};
    return `<div data-es-out="adjustmentAmount">${esMoney(r.adjustmentCandidate||0)} available</div><select ${attr}><option value="">Use saved / Pending</option>${esOption('ACCEPTED','ACCEPT adjustment',row.adjustmentDecision)}${esOption('DECLINED','DECLINE adjustment',row.adjustmentDecision)}</select><small class="es-applied" data-es-out="adjustmentApplied">Applied ${esMoney(r.adjustmentSalaryHourly)}</small>`;
  }
  const clock=field.startsWith('clock');
  const disabled=(clock&&field.endsWith('2')&&row.shift!=='DOUBLE')||(field==='totalAM'&&!mask.totalAM)||(field==='total24'&&!mask.total24);
  return `<input ${attr} type="text" inputmode="numeric"${clock?'':' data-es182-money="1" title="Type digits: 2000 = 20.00"'} autocomplete="off" spellcheck="false"${clock?' maxlength="5"':''} value="${esc(disabled?'':clock?row[field]:es182MoneyDisplay(row[field]))}" placeholder="${disabled?'—':clock?'HH:MM':'0.00'}"${disabled?' disabled':''}>`;
}
function esOutput(row,field){
  const r=esSession.results[row.name]||{};
  if(field==='hours')return r.totalMinutesWork==null?'—':`${Math.floor(r.totalMinutesWork/60)}h ${r.totalMinutesWork%60}m`;
  if(field==='busserRate')return Number(r.busserRate||0).toFixed(3)+'%';
  if(field==='received'){
    if(row.role!=='Bartender')return '—';
    return `<strong>${esMoney(r.bartenderBarTipReceived)}</strong><span class="es-received-parts">${bartenderReceiptPeriods(r).map(p=>`BAR ${bartenderPeriodLabel(p.checkpoint)}: ${esMoney(p.amount)}`).join('<br>')||'Choose BAR routing'}</span>`;
  }
  const values={busserAM:r.busserTipOutAM,busserPM:r.busserTipOutPM,barTipAM:r.barBreakdown?.amFee,barTip24:r.barBreakdown?.fee24,barTipPM:r.barBreakdown?.pmFee,payout:r.totalPaidOut};
  return esMoney(values[field]);
}
function esRowStatus(row){
  const s=esSession,old=esFindReport(s.reports,row.name),r=s.results[row.name];
  const incomplete=esValidateSales(row,s.routing,true).length>0;
  if(incomplete || !old || esFingerprint(r)!==esFingerprint(old)){
    const shared=s.baseBatch?.drafts?.[row.name]?.employeeSheetDraftSaved;
    if(shared&&es16RowMatches(row,shared.row)&&!(s.conflicts||[]).some(c=>c.name===row.name||c.name==='BAR routing'))return {text:'Draft saved · synced',kind:'draft'};
    const local=s.draftSaves?.[row.name];
    if(local&&es16RowMatches(row,local.row))return {text:'Draft saved · device only',kind:'draft'};
  }
  if(s.errors[row.name]?.length)return {text:'Check input',kind:'error'};
  if(!old)return {text:'Draft · not saved',kind:'draft'};
  if(esFingerprint(r)!==esFingerprint(old))return {text:'Changed · Save again',kind:'dirty'};
  return smallReportHasPickupSignature(old)?{text:'Saved · Signed',kind:'signed'}:{text:'Saved · Unsigned',kind:'saved'};
}
function esRenderRows(){
  const s=esSession;if(!s?.ready)return;
  const body=$('esRows');if(!body)return;
  const needle=String($('esSearch')?.value||'').trim().toLowerCase();
  body.innerHTML=s.rows.map((row,idx)=>{
    const state=esRowStatus(row),show=!needle||row.name.toLowerCase().includes(needle);
    return `<tr data-es-index="${idx}"${!show?' hidden':''}><th scope="row" class="es-name"><b>${esc(row.name)}</b><span class="es-state" data-kind="${state.kind}">${esc(state.text)}</span><div class="es-row-actions">${['Save','Sign','Print'].map(action=>`<button type="button" data-es-action="${action.toLowerCase()}" data-es-row="${idx}" aria-label="${action} ${esc(row.name)}">${action}</button>`).join('')}</div><span class="es-row-message"></span></th>${ES_COLUMNS.map(([field,label,,group])=>`<td data-es-col="${field}" class="es-cell es-${group}${field==='payout'?' es-payout':''}">${ES_FIELDS.includes(field)?esInput(row,field,label):`<div class="es-computed" data-es-out="${field}">${esOutput(row,field)}</div>`}</td>`).join('')}</tr>`;
  }).join('');
  if(!s.rows.length)body.innerHTML=`<tr><td colspan="27" class="es-empty">Start with Team / BAR → select an employee → Add. No need to open individual forms.</td></tr>`;
  esUpdateSummary();
}
function esUpdateComputed(){
  if(!esSession?.ready)return;
  document.querySelectorAll('#esRows tr[data-es-index]').forEach(tr=>{
    const row=esSession.rows[Number(tr.dataset.esIndex)];if(!row)return;
    tr.querySelectorAll('[data-es-out]').forEach(el=>{
      const f=el.dataset.esOut,r=esSession.results[row.name];
      if(f==='adjustmentAmount')el.textContent=esMoney(r.adjustmentCandidate)+' available';
      else if(f==='adjustmentApplied')el.textContent='Applied '+esMoney(r.adjustmentSalaryHourly);
      else el.innerHTML=esOutput(row,f);
    });
    const st=esRowStatus(row),status=tr.querySelector('.es-state');status.textContent=st.text;status.dataset.kind=st.kind;
  });esUpdateSummary();
}
function esUpdateSummary(){
  const s=esSession,rows=Object.values(s.results||{});
  $('esTotals').textContent=`${s.rows.length} employees · Sales ${esMoney(rows.reduce((a,r)=>a+Number(r.grandTotal||0),0))} · Payout ${esMoney(rows.reduce((a,r)=>a+Number(r.totalPaidOut||0),0))}`;
  $('esBusserRule').textContent=isWeekendDate(s.date)?'BUSSER · Sat / Sun: 1.5% all day · Bartender: 0%':'BUSSER · Mon–Fri: AM 0% / PM 1.5% · Bartender: 0%';
}
function es18MiddleRouteLabel(rows,route){
  const am=rows.find(r=>r.name===route.AM&&r.role==='Bartender');
  if(!am)return 'No separate 2–4 · assign AM bartender';
  if(am.shift===SHIFT_EARLY)return 'Assign 2–4 bartender · AM ends at 2 PM';
  return 'No separate 2–4 → '+am.name+' (AM)';
}
function esRenderRouting(){
  const s=esSession;if(!s?.ready)return;
  $('esBarRoutes').innerHTML=ES_PERIODS.map(cp=>`<label>BAR ${bartenderPeriodLabel(cp)} → Bartender<select data-es-route="${cp}">${esOption('',cp==='2PM_4PM'?es18MiddleRouteLabel(s.rows,s.routing):'Choose / not assigned',s.routing[cp])}${esPeriodCandidates(s.rows,cp).map(r=>esOption(r.name,r.name,s.routing[cp])).join('')}</select></label>`).join('');
  const existing=new Set(s.rows.map(r=>esKey(r.name)));
  $('esAddName').innerHTML='<option value="">Select employee…</option>'+getEmployeeRoster().filter(n=>!existing.has(esKey(n))).map(n=>esOption(n,n,'')).join('');
}
function esInit(){
  if($('employeeSheet'))return;
  const parent=$('staffApp');if(!parent)return;
  const el=document.createElement('section');el.id='employeeSheet';el.className='staffPanel hidden';
  el.innerHTML=`<div class="es-header"><button type="button" id="esHome" class="es-home">‹ Home</button><div><span class="es-eyebrow">ONE PAGE · LIVE CALCULATION · ${ES_BUILD}</span><h2>Employee Sheet</h2><span id="esDateBadge" class="es-date-badge"></span></div><button type="button" id="esTools" class="es-home" aria-expanded="false">Tools</button><button type="button" id="esReload" class="es-home">Reload</button></div>
    <div class="es-toolbar"><label>Work date<input type="date" id="esDate"></label><label class="es-search">Find employee<input type="search" id="esSearch" placeholder="Search name"></label><details id="esTeamDetails"><summary>＋ Team / BAR</summary><div class="es-team-panel"><div class="es-add"><label>Add employee<select id="esAddName"></select></label><button type="button" id="esAdd">Add</button></div><div id="esBarRoutes"></div><p>Total 2–4 includes AM; Grand Total is the final cumulative amount. One bartender per BAR period. An employee working two positions uses the separate work accounts already in the app.</p></div></details></div>
    <div class="es-guide"><span id="esBusserRule"></span><details><summary>Sales / Save notes</summary><p>Total 2–4 is cumulative (includes AM). Grand Total is the final total, not extra sales. LONG: Total 2–4 is the existing early/no-busser sales basis on weekdays. A checkbox waives only its own BAR period. Without a separate 2–4 bartender, that period goes to the AM bartender (except an explicit 10:45–14:00 shift). AM/2–4 fees calculate before the final Grand Total. BAR Received uses all sales on this sheet; save each employee row to update that employee’s Daily Report. Other input is retained as drafts. Cash Tip is not paid twice; Hourly Adjustment follows the existing acceptance rule.</p></details></div>
    <nav class="es-jump" aria-label="Jump to columns">${[['staff','Staff'],['clocks','Clocks'],['sales','Sales'],['busser','Busser'],['bar','BAR'],['tips','Tips / Meal'],['checks','BAR Sales'],['payout','Payout']].map(([key,label])=>`<button type="button" data-es-jump="${key}">${label}</button>`).join('')}</nav>
    <div id="esStatus" class="es-status" role="status" aria-live="polite">Loading…</div>
    <div class="es-grid" id="esGrid" tabindex="0" aria-label="Employee Sheet: scroll right for more columns"><table class="es-table"><colgroup><col class="es-name-col">${ES_COLUMNS.map(([,,width])=>`<col style="width:${width}px">`).join('')}</colgroup><thead><tr><th scope="col" class="es-name">Employee<span>Save · Sign · Print</span></th>${ES_COLUMNS.map(([field,label,,group])=>`<th scope="col" data-es-col="${field}" data-es-group="${group}">${esc(label)}${field==='total24'?'<small>Includes AM</small>':field==='grand'?'<small>Final cumulative</small>':''}</th>`).join('')}</tr></thead><tbody id="esRows"></tbody></table></div>
    <footer class="es-footer"><span id="esTotals"></span><span>⇄ Slide columns · Name + header stay fixed</span></footer>
    <div id="esSignatureModal" class="es-modal hidden" role="dialog" aria-modal="true" aria-labelledby="esSignatureTitle"><div class="es-sign-card"><h3 id="esSignatureTitle">Employee signature</h3><p id="esSignSummary"></p><canvas id="esSignatureCanvas" width="1000" height="320"></canvas><div class="es-sign-actions"><button type="button" id="esSignCancel">Cancel</button><button type="button" id="esSignClear">Clear</button><button type="button" id="esSignSave">Save signature</button></div><p id="esSignStatus" role="status"></p></div></div>`;
  parent.appendChild(el);
  $('esHome').addEventListener('click',()=>{if(esSession?.busy)return;esPersistLocal();esStopRead();el.classList.add('hidden');document.body.classList.remove('es-active');window.fzOpenRoleHome();});
  $('esTools').addEventListener('click',()=>{const open=$('employeeSheet').classList.toggle('es-controls-open');$('esTools').setAttribute('aria-expanded',String(open));});
  $('esReload').addEventListener('click',()=>window.employeeSheetOpen(esSession?.date,true));
  $('esDate').addEventListener('change',()=>{if(!esSession?.busy)window.employeeSheetOpen($('esDate').value);});
  $('esSearch').addEventListener('input',()=>{const q=$('esSearch').value.toLowerCase();document.querySelectorAll('#esRows tr[data-es-index]').forEach(tr=>tr.hidden=!esSession.rows[+tr.dataset.esIndex].name.toLowerCase().includes(q));});
  $('esAdd').addEventListener('click',()=>{
    const s=esSession,name=$('esAddName').value;if(!s?.ready||s.busy||!name)return;
    s.rows.push(esDefaults(name,s.date));s.dirty[name]={__new:true};esRecalculate();esRenderRouting();esRenderRows();esPersistLocal();esStatus('Employee added. Choose a shift and enter the row.');
  });
  el.addEventListener('input',e=>{const field=e.target.dataset?.esField;if(field && e.target.tagName==='INPUT'&&e.target.type!=='checkbox')esChange(e.target,false);});
  el.addEventListener('change',e=>{
    if(e.target.dataset?.esField)esChange(e.target,true);
    if(e.target.dataset?.esRoute && esSession?.ready&&!esSession.busy){esSession.routing[e.target.dataset.esRoute]=e.target.value;esRecalculate();esRenderRouting();esRenderRows();esPersistLocal();}
  });
  el.addEventListener('click',e=>{
    const jump=e.target.closest('[data-es-jump]');if(jump){const target=el.querySelector('thead [data-es-group="'+jump.dataset.esJump+'"]');if(target)esSheetScrollPort().scrollTo({left:Math.max(0,target.offsetLeft-el.querySelector('thead .es-name').offsetWidth),behavior:'smooth'});return;}
    const button=e.target.closest('[data-es-action]');if(!button||esSession?.busy)return;
    const name=esSession.rows[+button.dataset.esRow]?.name;
    if(button.dataset.esAction==='save')window.employeeSheetSave(name);
    if(button.dataset.esAction==='sign')window.employeeSheetSign(name);
    if(button.dataset.esAction==='print')window.employeeSheetPrint(name);
  });
  $('esGrid').addEventListener('keydown',e=>{
    if(e.key!=='Enter'||!e.target.dataset?.esField||e.target.tagName==='BUTTON')return;e.preventDefault();
    const row=Number(e.target.dataset.esRow),field=e.target.dataset.esField;
    const next=el.querySelector(`[data-es-row="${row+1}"][data-es-field="${field}"]:not(:disabled)`);next?.focus();next?.select?.();
  });
  $('esGrid').addEventListener('focusin',e=>{
    if(!e.target.dataset?.esField)return;
    const grid=esSheetScrollPort(),box=grid.getBoundingClientRect(),input=e.target.getBoundingClientRect(),frozen=el.querySelector('thead .es-name').offsetWidth;
    if(input.left<box.left+frozen)grid.scrollLeft-=box.left+frozen-input.left+8;
    else if(input.right>box.left+grid.clientWidth)grid.scrollLeft+=input.right-box.left-grid.clientWidth+8;
    if(el.classList.contains('es-desktop-page')){
      const header=el.querySelector('thead')?.offsetHeight||68,footer=el.querySelector('.es-footer')?.offsetHeight||42;
      if(input.top<box.top+header+8)grid.scrollTop-=box.top+header+8-input.top;
      else if(input.bottom>box.top+grid.clientHeight-footer-8)grid.scrollTop+=input.bottom-(box.top+grid.clientHeight-footer-8);
    }
  });
  esInitSignature();
}
function esChange(input,final){
  const s=esSession;if(!s?.ready||s.busy)return;
  const row=s.rows[+input.dataset.esRow],f=input.dataset.esField;if(!row||!ES_FIELDS.includes(f))return;
  if(f==='role'&&esFixedRole(row.name))return;
  const before=esClone(row);let value=input.type==='checkbox'?input.checked:input.value;
  if(f.startsWith('clock')){value=esNormalizeClock(value);if(input.value!==value)input.value=value;}
  if(final&&ES_MONEY.includes(f)&&es14MoneyValid(value)&&String(value).trim()!==''){value=es14MoneyText(value);input.value=es182MoneyDisplay(value);}
  row[f]=value;
  if(f==='shift'){
    const old=before.shift;
    if(value==='DOUBLE'&&old!=='DOUBLE'){row.clockIn2='';row.clockOut2='';}
    if(value!==old){
      if(!['AM','DOUBLE',SHIFT_EARLY].includes(value) && row.role==='Server')row.totalAM='';
      if(!['AM','DOUBLE','LONG',SHIFT_MIDDLE].includes(value))row.total24='';
      if(isShortShift(value)){const [a,b]=shortShiftTimes(value);row.clockIn ||= a;row.clockOut ||= b;}
    }
  }
  if(f==='role' && value==='Bartender'){row.barAM=false;row.bar24=false;row.barPM=false;}
  if(f==='role' && value==='Server'){row.barAM=true;row.bar24=true;row.barPM=true;}
  s.routing=esRouting(s.rows,s.routing);esLinkSales(row,f,s.routing);
  s.dirty[row.name] ||= {};
  for(const key of ES_FIELDS)if(!es14Same(key,before[key],row[key]))s.dirty[row.name][key]=true;
  esRecalculate();
  if(['shift','role'].includes(f)){esRenderRouting();esRenderRows();}
  else{
    for(const key of ['totalAM','total24','grand'])if(key!==f){const twin=$('employeeSheet').querySelector(`[data-es-row="${input.dataset.esRow}"][data-es-field="${key}"]`);if(twin&&!twin.disabled)twin.value=es182MoneyDisplay(row[key]);}
    esUpdateComputed();
  }
  esPersistLocal();
  const errors=s.errors[row.name]||[];esStatus(errors.length?row.name+': '+errors.join(' '):'Live preview updated — Save this row.',!!errors.length);
}
window.employeeSheetOpen=async function(date,force=false){
  if(!esAllowed())return;
  esInit();if(!$('employeeSheet')||esSession?.busy)return;
  const d=esDateValid(date)?date:esSession?.date||hv1DateValue();
  if(force && esSession && esHasEdits(esSession) && !confirm('Reload cloud data? Your input remains in a device draft. You can restore it on this screen.'))return;
  esPersistLocal();esStopRead();
  const uid=currentUser.uid;
  esSession={date:d,uid,ready:false,busy:false,rows:[],reports:[],dirty:{},routing:{},baseRouting:{},results:{},errors:{},cloudReady:false};
  $('fzRoleHome')?.classList.add('hidden');$('staffApp')?.classList.remove('hidden');
  document.querySelectorAll('.staffPanel').forEach(x=>x.classList.add('hidden'));
  $('hourlyV1Workspace')?.classList.add('hidden');
  document.body.classList.remove('hourly-v1-mode','hourly-v1-editing','hourly-v1-small-report','hourly-workspace-mode','small-report-fullscreen');
  document.documentElement.classList.remove('small-report-fullscreen');
  $('employeeSheet').classList.remove('hidden');document.body.classList.add('es-active');
  $('esDate').value=d;$('esDateBadge').textContent=d;
  let local={},draft=null;
  try{local=JSON.parse(localStorage.getItem(HV1_STORAGE_PREFIX+d)||'{}')||{};}catch(e){}
  try{draft=JSON.parse(localStorage.getItem(esDraftKey(d,uid))||'null');}catch(e){}
  // Render what this device already has BEFORE waiting for the network.
  const cached=esFastCacheGet(d,uid);
  if(cached?.batch?.exists)local=cached.batch.data;
  const reports=cached?.reports||latestHourlyReports.filter(r=>r.date===d);
  const batch=esPrepareBatch(local,reports,d),rows=esRowsFromBatch(batch,reports,d);
  const routing=esRouting(rows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,batch.bar[cp].bartender||''])));
  Object.assign(esSession,{ready:true,baseBatch:batch,baseRows:esClone(rows),rows,reports,routing,baseRouting:esClone(routing),hadCloud:false,rawBase:esClone(local)});
  esSession.draftSaves=draft?.date===d?draft.draftSaves||{}:{};
  if(draft?.date===d && Array.isArray(draft.rows) && (Object.keys(draft.dirty||{}).length||JSON.stringify(draft.routing)!==JSON.stringify(draft.baseRouting)) && confirm('Restore unfinished Employee Sheet input for '+d+' from this device?')){
    esSession.rows=draft.rows;esSession.dirty=draft.dirty||{};esSession.baseRows=draft.baseRows||rows;esSession.routing=draft.routing||routing;esSession.baseRouting=draft.baseRouting||routing;
  }
  esRecalculate();esRenderRouting();esRenderRows();esEnsureSyncUI();
  if(draft){$('esGrid').scrollLeft=draft.scrollLeft||0;$('esGrid').scrollTop=draft.scrollTop||0;}
  esStatus(rows.length?'Device copy shown. Checking the shared sheet…':'Checking the shared sheet for '+d+'…');
  esStartRead(esSession);
  esFastRefreshRoster(uid,d,force);
};

function esSetBusy(busy){
  if(!esSession)return;esSession.busy=busy;
  $('employeeSheet').classList.toggle('es-busy',busy);
  // A fieldset-like pointer/keyboard lock prevents edits to a transaction snapshot.
  $('employeeSheet').setAttribute('aria-busy',busy?'true':'false');
  for(const el of document.querySelectorAll('#employeeSheet input,#employeeSheet select,#employeeSheet button')){
    if(busy){el.dataset.esWasDisabled=el.disabled?'1':'0';el.disabled=true;}
    else{el.disabled=el.dataset.esWasDisabled==='1';delete el.dataset.esWasDisabled;}
  }
}
function esSignaturePatch(before,calculated,signature){
  if(signature)return {pickupSignature:signature,signatureStatus:'SIGNED'};
  if(before && esFingerprint(before)!==esFingerprint(calculated) && smallReportHasPickupSignature(before))return {pickupSignature:null,signatureStatus:'PENDING',pickupStatus:'',pickedUpBy:'',pickedUpAt:null,pickedUpProcessedBy:'',signatureInvalidatedReason:'Employee Sheet values changed; employee must re-sign.'};
  return {};
}
async function esCommit(name,signature=null,expectedSignatureFingerprint=''){
  const session=esSession;
  if(!esAllowed()||!session?.ready||session.uid!==currentUser.uid)throw new Error('Manager / Owner session required.');
  const selected=session.rows.find(r=>r.name===name);if(!selected)throw new Error('Employee row not found.');
  const errors=esValidateSales(selected,session.routing,true);
  for(const row of session.rows)for(const e of esValidateSales(row,session.routing,false))errors.push(row.name+': '+e);
  if(errors.length)throw new Error(errors.join('\n'));
  const duplicates=session.reports.filter(r=>esKey(r.employee)===esKey(name));
  if(duplicates.length>1 && !session.baseBatch.drafts?.[name]?.hourlyReportId)throw new Error('Multiple Daily Reports exist for '+name+'. Open the intended original report before using this row.');
  const s=esClone({date:session.date,uid:session.uid,rows:session.rows,baseRows:session.baseRows,dirty:session.dirty,routing:session.routing,baseRouting:session.baseRouting,baseBatch:session.baseBatch,reports:session.reports});
  const batchRef=doc(db,'hourlyV1Batches',s.date),newRef=doc(collection(db,'hourlyReports'));
  const result=await runTransaction(db,async tx=>{
    const snap=await tx.get(batchRef);
    if(!esAllowed()||currentUser.uid!==s.uid)throw new Error('Login changed. Nothing was saved.');
    const cloud=snap.exists()?snap.data():s.baseBatch;
    const remoteBatch=esPrepareBatch(cloud,s.reports,s.date),remoteRows=esRowsFromBatch(remoteBatch,s.reports,s.date);
    const rows=esMergeRows(s.baseRows,s.rows,remoteRows,s.dirty);
    const remoteRouting=esRouting(remoteRows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,remoteBatch.bar[cp].bartender||''])));
    for(const cp of ES_PERIODS){
      if(s.routing[cp]!==s.baseRouting[cp]){
        if(remoteRouting[cp]!==s.baseRouting[cp] && remoteRouting[cp]!==s.routing[cp])throw new Error('BAR '+bartenderPeriodLabel(cp)+' assignment changed on another device. Reload and review.');
        remoteRouting[cp]=s.routing[cp];
      }
    }
    const route=esRouting(rows,remoteRouting),batch=esBuildBatch(remoteBatch,rows,s.date,route);
    const row=rows.find(r=>r.name===name);if(!row)throw new Error('Employee no longer exists on this work date.');
    const problems=esValidateSales(row,route,true);if(problems.length)throw new Error(problems.join('\n'));
    for(const server of rows)if(server.role==='Server'){
      const salesErrors=esValidateSales(server,route,false);if(salesErrors.length)throw new Error(server.name+': '+salesErrors.join(' '));
    }
    const linked=remoteBatch.drafts?.[name]?.hourlyReportId||esFindReport(s.reports,name)?.id||'';
    const reportRef=linked?doc(db,'hourlyReports',linked):newRef;
    const reportSnap=linked?await tx.get(reportRef):null;
    const before=reportSnap?.exists()?reportSnap.data():null;
    if(before&&!hourlyReportBelongsTo(before,name,s.date))throw new Error('Saved report belongs to a different employee/date. Nothing was overwritten.');
    const known=s.reports.find(r=>r.id===linked);
    if(before&&known&&esFingerprint(before)!==esFingerprint(known))throw new Error('Daily Report changed on another device. Reload before replacing it.');
    const calculated=esCalculate(row,batch,before);
    if(signature&&expectedSignatureFingerprint!==esFingerprint(calculated))throw new Error('Amounts changed while signing. Review the latest payout and sign again.');
    const sourceId=before?.sourceSubmissionId||batch.drafts[name].sourceSubmissionId||'';
    const subRef=sourceId?doc(db,'submissions',sourceId):null,subSnap=subRef?await tx.get(subRef):null;
    const source=subSnap?.exists()?subSnap.data():null;
    const validSource=hourlyReportBelongsTo(source,name,s.date)?sourceId:'';
    const sigPatch=esSignaturePatch(before,calculated,signature);
    const payload={...calculated,...sigPatch,sourceSubmissionId:validSource,status:'money_ready',employeeKey:fzEmployeeIdentityKey(name),reportIdentityVersion:'13.8.28',employeeSheetBuild:ES_BUILD,updatedAt:serverTimestamp(),updatedBy:currentProfile.displayName||currentProfile.username||''};
    if(validSource&&source.employeeUid)payload.employeeUid=source.employeeUid;
    if(before)tx.update(reportRef,payload);
    else tx.set(reportRef,{...payload,createdAt:serverTimestamp(),createdByUid:s.uid,createdBy:currentProfile.displayName||currentProfile.username||''});
    if(validSource){
      tx.update(subRef,{status:'money_ready',hourlyStatus:'finalized',hourlyReportId:reportRef.id,finalReport:{...calculated},...(signature?{pickupSignature:signature,signatureStatus:'SIGNED'}:sigPatch.pickupSignature===null?{pickupSignature:null,signatureStatus:'PENDING'}:{}),updatedAt:serverTimestamp()});
    }
    for(const n of Object.keys(s.dirty)){if(batch.drafts[n])batch.drafts[n].savedAt=Date.now();}
    Object.assign(batch.drafts[name],{hourlyReportId:reportRef.id,sourceSubmissionId:validSource,finalized:true,finalizedAt:Date.now(),savedAt:Date.now()});
    tx.set(batchRef,{...cloud,date:s.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},updatedAt:serverTimestamp(),updatedByUid:s.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
    return {batch,report:{...(before||{}),...payload,id:reportRef.id},before,route};
  });
  if(esSession!==session)return result;
  session.baseBatch=result.batch;session.rawBase=result.batch;session.hadCloud=true;session.routing=result.route;session.baseRouting=esClone(result.route);
  session.reports=[result.report,...session.reports.filter(r=>r.id!==result.report.id)];
  session.rows=esRowsFromBatch(result.batch,session.reports,session.date);session.baseRows=esClone(session.rows);session.dirty={};
  latestHourlyReports=[result.report,...latestHourlyReports.filter(r=>r.id!==result.report.id)];
  try{localStorage.setItem(HV1_STORAGE_PREFIX+session.date,JSON.stringify(result.batch));}catch(e){}
  esRecalculate();esPersistLocal();
  try{await writeAudit(signature?'employee_sheet_sign':'employee_sheet_save',result.report.id,name,{date:session.date,before:result.before||null,after:result.report,signatureReplaced:!!result.before?.pickupSignature});}catch(e){console.warn('Employee Sheet audit:',e);}
  return result;
}
window.employeeSheetSave=async function(name){
  if(!esAllowed()||esSession?.busy)return false;
  esSetBusy(true);esStatus('Saving '+name+' to Daily Report…');
  try{const out=await esCommit(name);esStatus(name+' saved to Daily Report'+(smallReportHasPickupSignature(out.report)?' · SIGNED.':' · signature can be added later.'));return true;}
  catch(e){esStatus(e.message||String(e),true);return false;}
  finally{esSetBusy(false);esRenderRows();esRenderRouting();}
};
function esSerializeSignature(strokes){
  let budget=4096;const out=[];
  for(const stroke of strokes.slice(0,64)){
    if(stroke.length<2||budget<2)continue;
    const count=Math.min(192,stroke.length,budget),points=[];
    for(let i=0;i<count;i++){const p=stroke[Math.round(i*(stroke.length-1)/(count-1))];points.push({x:Math.round(Math.max(0,Math.min(1,p.x))*10000)/10000,y:Math.round(Math.max(0,Math.min(1,p.y))*10000)/10000});}
    out.push({points});budget-=points.length;
  }
  return {strokes:out,signedAtLocal:new Date().toISOString()};
}
function esInitSignature(){
  const canvas=$('esSignatureCanvas');if(!canvas)return;
  const draw=()=>{
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#10233f';ctx.lineWidth=3.4;ctx.lineCap='round';ctx.lineJoin='round';
    for(const stroke of esSignature?.strokes||[]){ctx.beginPath();stroke.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*canvas.width,p.y*canvas.height));ctx.stroke();}
  };
  const point=e=>{const rect=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};};
  canvas.addEventListener('pointerdown',e=>{if(!esSignature||esSession?.busy)return;e.preventDefault();canvas.setPointerCapture(e.pointerId);esSignature.current=[point(e)];esSignature.strokes.push(esSignature.current);draw();});
  canvas.addEventListener('pointermove',e=>{if(!esSignature?.current)return;e.preventDefault();if(esSignature.current.length<800)esSignature.current.push(point(e));draw();});
  const stop=()=>{if(esSignature)esSignature.current=null;};canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);
  const close=()=>{if(esSession?.busy)return;esSignature=null;$('esSignatureModal').classList.add('hidden');};
  $('esSignCancel').addEventListener('click',close);
  $('esSignClear').addEventListener('click',()=>{if(esSignature){esSignature.strokes=[];draw();}});
  $('esSignSave').addEventListener('click',es182SaveSignature);
  $('esSignatureModal').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();close();}
    if(e.key==='Tab'){const focus=[...$('esSignatureModal').querySelectorAll('button:not(:disabled)')];if(e.shiftKey&&document.activeElement===focus[0]){e.preventDefault();focus.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===focus.at(-1)){e.preventDefault();focus[0]?.focus();}}
  });
  window.addEventListener('resize',draw);
}
window.employeeSheetSign=function(name){
  if(!esAllowed()||esSession?.busy)return;
  const row=esSession.rows.find(r=>r.name===name);if(!row)return;
  const errors=esValidateSales(row,esSession.routing,true);if(errors.length){esStatus(name+': '+errors.join(' '),true);return;}
  const r=esSession.results[name];esSignature={name,fingerprint:esFingerprint(r),strokes:[],current:null,scroll:es14CaptureScroll()};
  $('esSignatureTitle').textContent=name+' — Employee Signature';
  $('esSignSummary').textContent=esSession.date+' · '+row.shift+' · Paid Tip Out '+esMoney(r.totalPaidOut);
  $('esSignStatus').textContent='Save signature updates this Daily Report. Any later change to the amounts requires a new signature.';
  $('esSignatureCanvas').getContext('2d').clearRect(0,0,1000,320);
  $('esSignatureModal').classList.remove('hidden');$('esSignCancel').focus();
};
function esThermalHtml(report){
  // Reuse the exact receipt renderer, including the large disclaimer and signature.
  // The new Sheet permits unsigned print; the original Daily Report gate is unchanged.
  const html=buildSmallReportThermalHtml(report);
  return smallReportHasPickupSignature(report)?html:html.replace('<div class="signed">SIGNED</div>','<div class="signed">NOT SIGNED</div>');
}
function esPassPrntUri(report,html){
  const back=new URL(window.location.href);
  back.searchParams.set(PASS_PRNT_RETURN_PARAM,'1');back.searchParams.set('fzPrntRole',String(currentProfile?.role||''));
  back.searchParams.set('fzPrntReport',String(report.id));back.searchParams.set('fzPrntDate',report.date);back.searchParams.set('fzPrntExpires',String(Date.now()+5*60*1000));
  back.searchParams.set('fzEmployeeSheetReturn','1');back.searchParams.delete('passprnt_code');back.searchParams.delete('passprnt_message');
  return 'starpassprnt://v1/print/nopreview?back='+encodeURIComponent(back.href)+'&size=576&cut=partial&popup=enable&html='+encodeURIComponent(html);
}
window.employeeSheetPrint=async function(name){
  if(!esAllowed()||esSession?.busy)return;
  const android=/Android/i.test(navigator.userAgent||'');let popup=null;
  // Open synchronously in the click gesture before awaiting a save.
  if(!android)popup=es18OpenPrintPreview(null,name+' — Preparing receipt');
  esSetBusy(true);esStatus('Saving current row before printing…');
  try{
    const out=await esCommit(name),r=out.report,html=esThermalHtml(r);
    if(android){
      await prepareSmallReportPassPrntReturn(r);
      try{const bridge=JSON.parse(localStorage.getItem(PASS_PRNT_BRIDGE_KEY)||'{}');bridge.employeeSheet=true;localStorage.setItem(PASS_PRNT_BRIDGE_KEY,JSON.stringify(bridge));}catch(e){}
      esPersistLocal();const link=document.createElement('a');link.href=esPassPrntUri(r,html);link.style.display='none';document.body.appendChild(link);link.click();link.remove();
      esStatus('Sent to Star PassPRNT. The saved Daily Report is unchanged by printing.');
    }else{
      popup?.setHtml(html);esStatus('Receipt ready. Tap Print, then Close / Back to app.');
    }
  }catch(e){if(popup)popup.close();es14HandleError(e);if(android)await cancelSmallReportPassPrntReturn();}
  finally{esSetBusy(false);esRenderRows();esRenderRouting();}
};
// Additive return route only. Existing Daily Report printing keeps its old route.
(function(){
  const original=restoreSmallReportAfterPassPrnt;
  restoreSmallReportAfterPassPrnt=function(state){
    let sheet=state?.employeeSheet;
    try{sheet ||= new URL(window.location.href).searchParams.get('fzEmployeeSheetReturn')==='1';}catch(e){}
    if(!sheet)return original(state);
    if(!esAllowed())return;
    setTimeout(()=>window.employeeSheetOpen(state?.date),500);
    try{const u=new URL(window.location.href);u.searchParams.delete('fzEmployeeSheetReturn');history.replaceState(history.state,'',u.pathname+u.search+u.hash);}catch(e){}
  };
})();
window.addEventListener('beforeunload',()=>esPersistLocal());
// Safe no-op for non-staff roles and old pages; the Home card initializes on demand.

/* ES1.1 — progressive device loading + explicit shared draft sync.
 * Read-only listeners / authenticated read fallback never finalize a report.
 * Sync Draft writes only the existing hourlyV1Batches document in a transaction.
 * The original ES1 calculation and Save / Sign / Print implementations remain.
 */
let esRead=null;
const ES_READ_SLOW_MS=8000;
function esHasEdits(s){return !!s&&(Object.keys(s.dirty||{}).length>0||ES_PERIODS.some(cp=>(s.routing?.[cp]||'')!==(s.baseRouting?.[cp]||'')));}
function esReadCurrent(c){return !!c&&esRead===c&&esSession===c.session&&esAllowed()&&currentUser.uid===c.session.uid;}
function esStopRead(){
  const c=esRead;esRead=null;++esOpenToken;
  if(!c)return;
  for(const fn of c.unsubs||[])try{fn();}catch(e){}
  for(const t of c.timers||[])clearTimeout(t);
  for(const a of c.aborters||[])try{a.abort();}catch(e){}
}
function esEnsureSyncUI(){
  if($('esSyncBar'))return;
  const area=$('employeeSheet'),status=$('esStatus');if(!area||!status)return;
  const bar=document.createElement('div');bar.id='esSyncBar';bar.className='es-syncbar';
  bar.innerHTML='<div id="esCloudStatus" role="status" aria-live="polite">ES1.1 · Checking shared data…</div><button type="button" id="esSyncDraft" title="Share unfinished rows with your other devices, without creating Daily Reports">Sync Draft</button>';
  status.insertAdjacentElement('beforebegin',bar);
  $('esSyncDraft').addEventListener('click',()=>window.employeeSheetSyncDraft());
  area.addEventListener('focusout',()=>setTimeout(()=>{if(esReadCurrent(esRead)&&esRead.pending)esApplyRead(esRead);},100));
}
function esSetReadStatus(c){
  if(!esReadCurrent(c))return;
  const s=c.session;s.cloudReady=!!(c.batch.server&&c.reports.server&&!c.batch.error&&!c.reports.error);
  const error=[c.batch.error,c.reports.error].find(Boolean);
  let text;
  if(error)text='Cloud read failed: '+String(error.code||error.message||error)+'. Tap Reload. Your device draft is kept.';
  else if(s.cloudReady)text=esHasEdits(s)?'Cloud connected · Unsynced device edits. Use Sync Draft or Save.':'Cloud connected · Shared sheet.';
  else if(c.slow)text='Connection is slow or offline. Showing available data; checking another read connection. Save keeps a device draft until the connection is checked.';
  else text='Checking cloud '+(!c.batch.server?'team / BAR':'Daily Reports')+'… Available rows are shown below.';
  const el=$('esCloudStatus');if(el){el.textContent=ES_BUILD+' · '+text;el.dataset.error=error?'1':'0';}
  esReadControls();
  if(!s.rows.length && $('esRows')){
    const empty=$('esRows').querySelector('.es-empty');
    if(empty)empty.textContent=s.cloudReady?'No shared employees for this date. On the laptop with your rows, press Sync Draft. Or use Team / BAR to add an employee.':(error?'Could not read shared employees. Tap Reload; no report was changed.':c.slow?'No copy is available on this device yet. Check your connection, then tap Reload. The laptop draft has not been deleted.':'Waiting for shared employees… This does not mean the sheet is empty.');
  }
}
function esReadControls(){
  const s=esSession;if(!s?.ready||!s.esReadEnabled)return;
  const locked=s.busy||!s.cloudReady;
  for(const b of document.querySelectorAll('#esRows [data-es-action],#esSyncDraft'))b.disabled=b.dataset.esAction==='save'?s.busy||!es14AllowedSession(s):locked;
}
function esReadStamp(value){
  if(!value)return 0;if(typeof value.toMillis==='function')return value.toMillis();
  if(typeof value.seconds==='number')return value.seconds*1000+(Number(value.nanoseconds)||0)/1e6;
  return Number(value)||0;
}
function esAcceptRead(c,kind,value,server=true,origin='sdk'){
  if(!esReadCurrent(c))return;
  const old=c[kind];
  // Never let a late cached/non-server result replace a verified server result.
  if(old.server&&!server)return;
  if(kind==='batch'&&server&&old.server&&value.exists&&old.value?.exists){
    const prior=esReadStamp(old.value.data?.updatedAt),next=esReadStamp(value.data?.updatedAt);
    if(prior&&next&&next<prior)return;
  }
  // REST fallback may win a race against the SDK's initial one-shot request.
  if(origin==='once'&&old.server)return;
  c[kind]={value,server,error:null,origin};c.pending=true;
  if(c.batch.server&&c.reports.server){for(const t of c.timers)clearTimeout(t);c.timers=[];}
  esApplyRead(c);
}
function esRejectRead(c,kind,error){
  if(!esReadCurrent(c))return;
  // A permission failure is not an empty query and never enables Save.
  c[kind].error=error;
  if(/permission|unauthenticated/i.test(String(error?.code||'')))c[kind].server=false;
  esSetReadStatus(c);esStatus('Shared data could not be read. Your input is kept. Tap Reload.',true);
}
function esApplyRead(c){
  if(!esReadCurrent(c))return;
  const s=c.session;esSetReadStatus(c);
  const focus=document.activeElement;
  if(s.busy||esSignature||(focus?.matches?.('#employeeSheet input,#employeeSheet select'))){c.pending=true;return;}
  const batchValue=c.batch.value;
  const raw=batchValue?.exists?batchValue.data:(batchValue&&c.batch.server?{team:[],drafts:{}}:s.rawBase||{});
  const remoteReports=(c.reports.value||s.reports||[]).filter(r=>r.date===s.date);
  try{
    const batch=esPrepareBatch(raw,remoteReports,s.date),remoteRows=esRowsFromBatch(batch,remoteReports,s.date);
    const remoteRoute=esRouting(remoteRows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,batch.bar[cp].bartender||''])));
    // Do not erase a laptop's legacy local-only team if no cloud sheet exists yet.
    if(batchValue&&!batchValue.exists&&c.batch.server){
      for(const row of s.rows)if(!remoteRows.some(r=>esKey(r.name)===esKey(row.name))){
        remoteRows.push(esClone(row));s.dirty[row.name] ||= {__new:true};
      }
    }
    const oldRows=s.rows,oldBase=s.baseRows,oldReports=s.reports;
    const rows=remoteRows.map(r=>s.dirty[r.name]?esClone(oldRows.find(x=>x.name===r.name)||r):r);
    for(const row of oldRows)if(s.dirty[row.name]&&!rows.some(r=>r.name===row.name))rows.push(esClone(row));
    const baseRows=remoteRows.map(r=>s.dirty[r.name]?esClone(oldBase.find(x=>x.name===r.name)||r):esClone(r));
    // A genuinely new local row keeps NO base. esMergeRows then detects concurrent adds.
    for(let i=baseRows.length-1;i>=0;i--)if(s.dirty[baseRows[i].name]?.__new&&!oldBase.some(r=>r.name===baseRows[i].name))baseRows.splice(i,1);
    for(const b of oldBase)if(s.dirty[b.name]&&!baseRows.some(r=>r.name===b.name))baseRows.push(esClone(b));
    const route={...remoteRoute},baseRoute={...remoteRoute};
    for(const cp of ES_PERIODS)if((s.routing[cp]||'')!==(s.baseRouting[cp]||'')){route[cp]=s.routing[cp];baseRoute[cp]=s.baseRouting[cp];}
    // Keep the original report comparison for a dirty row; don't mask remote conflicts.
    const reports=remoteReports.map(r=>s.dirty[r.employee]?oldReports.find(o=>o.id===r.id)||r:r);
    for(const r of oldReports)if(s.dirty[r.employee]&&!reports.some(o=>o.id===r.id))reports.push(r);
    Object.assign(s,{baseBatch:batch,rawBase:esClone(raw),hadCloud:batchValue?batchValue.exists:s.hadCloud,rows,baseRows,reports,routing:route,baseRouting:baseRoute});
    c.pending=false;
    esRecalculate();esRenderRouting();esRenderRows();esSetReadStatus(c);
    if(s.cloudReady&&!c.initialReady){c.initialReady=true;esStatus(esHasEdits(s)?'Your device edits are kept. Sync Draft shares the sheet; Save also updates the selected Daily Report.':'Shared sheet loaded. Edit directly, then Save the row.');}
    else if(!s.cloudReady&&!c.initialReady&&s.rows.length)esStatus('Available rows shown. The remaining cloud check is still in progress.');
    if(c.batch.server&&batchValue?.exists&&!esHasEdits(s)){
      try{localStorage.setItem(HV1_STORAGE_PREFIX+s.date,JSON.stringify(batch));}catch(e){}
    }
  }catch(e){esRejectRead(c,'batch',e);}
}
function esStartRead(s){
  esStopRead();s.esReadEnabled=true;s.cloudReady=false;
  const c={session:s,batch:{server:false,value:null,error:null},reports:{server:false,value:null,error:null},unsubs:[],timers:[],aborters:[],pending:false,slow:false};esRead=c;
  esSetReadStatus(c);
  const refs={batch:doc(db,'hourlyV1Batches',s.date),reports:query(collection(db,'hourlyReports'),where('date','==',s.date))};
  function receive(kind,snap,origin){
    const server=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
    const value=kind==='batch'?{exists:snap.exists(),data:snap.exists()?snap.data():{}}:snap.docs.map(x=>({id:x.id,...x.data()}));
    esAcceptRead(c,kind,value,server,origin);
  }
  for(const kind of ['batch','reports']){
    try{const stop=onSnapshot(refs[kind],{includeMetadataChanges:true},snap=>receive(kind,snap,'listen'),e=>esRejectRead(c,kind,e));if(typeof stop==='function')c.unsubs.push(stop);}catch(e){esRejectRead(c,kind,e);}
    // Independent reads: a slow report request cannot hide an already loaded team.
    Promise.resolve().then(()=>kind==='batch'?getDoc(refs[kind]):getDocs(refs[kind])).then(snap=>receive(kind,snap,'once')).catch(e=>{if(!c[kind].server)esRejectRead(c,kind,e);});
  }
  c.timers.push(setTimeout(()=>{
    if(!esReadCurrent(c)||s.cloudReady)return;
    c.slow=true;esSetReadStatus(c);esStatus('Connection taking too long. Available rows stay visible; retrying the unfinished read.',true);
    for(const kind of ['batch','reports'])if(!c[kind].server&&!/permission|unauthenticated/i.test(String(c[kind].error?.code||'')))esHttpRead(c,kind);
  },ES_READ_SLOW_MS));
}
function esDecodeFirestore(value){
  if(!value||typeof value!=='object')return null;
  if('nullValue' in value)return null;
  if('stringValue' in value)return value.stringValue;
  if('booleanValue' in value)return value.booleanValue;
  if('integerValue' in value)return Number(value.integerValue);
  if('doubleValue' in value)return Number(value.doubleValue);
  if('timestampValue' in value){const ms=Date.parse(value.timestampValue);return {seconds:Math.floor(ms/1000),nanoseconds:(ms%1000)*1e6};}
  if('arrayValue' in value)return (value.arrayValue.values||[]).map(esDecodeFirestore);
  if('mapValue' in value)return Object.fromEntries(Object.entries(value.mapValue.fields||{}).map(([k,v])=>[k,esDecodeFirestore(v)]));
  if('referenceValue' in value)return value.referenceValue;
  if('bytesValue' in value)return value.bytesValue;
  if('geoPointValue' in value)return value.geoPointValue;
  throw new Error('Unrecognized Firestore value; no data was applied.');
}
async function esHttpRead(c,kind){
  // Read-only fallback, using the SAME logged-in user and Firebase Security Rules.
  // No passwords, custom tokens, admin keys, or auth persistence changes.
  if(!esReadCurrent(c)||typeof currentUser.getIdToken!=='function'||typeof fetch!=='function')return;
  const controller=new AbortController();c.aborters.push(controller);
  let timeout;
  try{
    const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new Error('Cloud read timed out. Check connection and tap Reload.'));},10000);});
    const result=await Promise.race([deadline,(async()=>{
      const token=await currentUser.getIdToken();if(!esReadCurrent(c))throw new Error('Session changed.');
      const root='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(FIREBASE_CONFIG.projectId)+'/databases/(default)/documents';
      const resource='projects/'+FIREBASE_CONFIG.projectId+'/databases/(default)/documents/hourlyV1Batches/'+c.session.date;
      // Both APIs are read-only POSTs. This also prevents old PWA workers from
      // reusing or storing an authenticated GET response before they update.
      const options={method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},cache:'no-store',signal:controller.signal};
      options.body=JSON.stringify(kind==='batch'?{documents:[resource]}:{structuredQuery:{from:[{collectionId:'hourlyReports'}],where:{fieldFilter:{field:{fieldPath:'date'},op:'EQUAL',value:{stringValue:c.session.date}}}}});
      const response=await fetch(root+(kind==='batch'?':batchGet':':runQuery'),options);
      const json=await response.json();
      if(!response.ok){const e=new Error(json.error?.message||'Cloud read failed');e.code=response.status===403?'permission-denied':response.status===401?'unauthenticated':json.error?.status||String(response.status);throw e;}
      const decode=d=>esDecodeFirestore({mapValue:{fields:d.fields||{}}});
      if(kind==='batch'){
        if(!Array.isArray(json)||json.length!==1)throw new Error('Invalid shared sheet response; no data was applied.');
        if(json[0].found?.name===resource)return {exists:true,data:decode(json[0].found)};
        if(json[0].missing===resource)return {exists:false,data:{}};
        throw new Error('Shared sheet response did not match the requested date.');
      }
      if(!Array.isArray(json))throw new Error('Invalid report response; not an empty report list.');
      if(json.some(r=>r.error))throw new Error('Cloud report query failed; no data was applied.');
      return json.filter(r=>r.document).map(r=>({id:r.document.name.split('/').pop(),...decode(r.document)}));
    })()]);
    if(esReadCurrent(c)&&!c[kind].server)esAcceptRead(c,kind,result,true,'https');
  }catch(e){if(esReadCurrent(c)&&!c[kind].server)esRejectRead(c,kind,e);}
  finally{clearTimeout(timeout);}
}
window.employeeSheetSyncDraft=async function(){
  const s=esSession;if(!esAllowed()||!s?.ready||s.busy)return false;
  if(!s.cloudReady){esStatus('Wait for the cloud check, or tap Reload. No draft was published.',true);return false;}
  const errors=s.rows.flatMap(r=>esValidateSales(r,s.routing,false).map(e=>r.name+': '+e));
  if(errors.length){esStatus(errors.join(' '),true);return false;}
  esPersistLocal();esSetBusy(true);esStatus('Sharing draft with your other devices… Daily Reports are not being finalized.');
  const draft=esClone({date:s.date,uid:s.uid,rows:s.rows,baseRows:s.baseRows,dirty:s.dirty,routing:s.routing,baseRouting:s.baseRouting,baseBatch:s.baseBatch,reports:s.reports,hadCloud:s.hadCloud});
  try{
    const ref=doc(db,'hourlyV1Batches',draft.date);
    const out=await runTransaction(db,async tx=>{
      const snap=await tx.get(ref);
      if(!esAllowed()||currentUser.uid!==draft.uid)throw new Error('Login changed. No draft was shared.');
      if(!snap.exists()&&draft.hadCloud)throw new Error('The shared sheet was removed on another device. Reload before saving.');
      const cloud=snap.exists()?snap.data():draft.baseBatch;
      const remote=esPrepareBatch(cloud,draft.reports,draft.date),remoteRows=esRowsFromBatch(remote,draft.reports,draft.date);
      const rows=esMergeRows(draft.baseRows,draft.rows,remoteRows,draft.dirty);
      const route=esRouting(remoteRows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,remote.bar[cp].bartender||''])));
      for(const cp of ES_PERIODS)if(draft.routing[cp]!==draft.baseRouting[cp]){
        if(route[cp]!==draft.baseRouting[cp]&&route[cp]!==draft.routing[cp])throw new Error('BAR assignment changed on another device. Your draft is kept; Reload and review.');
        route[cp]=draft.routing[cp];
      }
      const routing=esRouting(rows,route),batch=esBuildBatch(remote,rows,draft.date,routing);
      for(const name of Object.keys(draft.dirty))if(batch.drafts[name])batch.drafts[name].savedAt=Date.now();
      tx.set(ref,{...cloud,date:draft.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},updatedAt:serverTimestamp(),updatedByUid:draft.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
      return {batch,routing};
    });
    if(esSession!==s||!esAllowed()||currentUser.uid!==s.uid)return false;
    s.baseBatch=out.batch;s.rawBase=esClone(out.batch);s.hadCloud=true;s.routing=out.routing;s.baseRouting=esClone(out.routing);
    s.rows=esRowsFromBatch(out.batch,s.reports,s.date);s.baseRows=esClone(s.rows);s.dirty={};
    try{localStorage.setItem(HV1_STORAGE_PREFIX+s.date,JSON.stringify(out.batch));}catch(e){}
    esRecalculate();esPersistLocal();esStartRead(s);
    esStatus('Draft shared. Open the same work date on your phone. Daily Reports were not changed.');return true;
  }catch(e){esStatus((e.message||String(e))+' Your device draft is kept.',true);return false;}
  finally{if(esSession===s){esSetBusy(false);esRenderRouting();esRenderRows();esReadControls();}}
};
// Guard against writing from a partial/offline load; leave original save math intact.
(function(){
  const commit=esCommit,render=esRenderRows,persist=esPersistLocal,setBusy=esSetBusy;
  esCommit=async function(...args){
    if(esSession?.esReadEnabled&&!esSession.cloudReady)throw new Error('Cloud data is not fully checked. Tap Reload before Save / Sign / Print. Your input is kept.');
    const out=await commit(...args);
    if(esSession?.esReadEnabled&&esAllowed())esStartRead(esSession);
    return out;
  };
  esRenderRows=function(...args){const out=render(...args);esReadControls();return out;};
  esPersistLocal=function(...args){const out=persist(...args);if(esReadCurrent(esRead))esSetReadStatus(esRead);return out;};
  esSetBusy=function(busy){setBusy(busy);esReadControls();if(!busy&&esReadCurrent(esRead)&&esRead.pending)setTimeout(()=>{if(esReadCurrent(esRead))esApplyRead(esRead);},0);};
})();
window.addEventListener('online',()=>{if(esAllowed()&&esSession?.esReadEnabled&&document.body.classList.contains('es-active')&&!esSession.busy)esStartRead(esSession);});
window.addEventListener('pagehide',()=>esStopRead());
window.addEventListener('pageshow',()=>{if(esAllowed()&&esSession?.esReadEnabled&&document.body.classList.contains('es-active')&&!esRead)esStartRead(esSession);});
// App backgrounding / sign-out must not let an old response affect a new identity.
try{onAuthStateChanged(auth,user=>{if(esRead&&(!user||user.uid!==esRead.session.uid)){esStopRead();if(esSession?.esReadEnabled){esSession.cloudReady=false;esReadControls();}}});}catch(e){}

/* ES1.2 — compact sheet, fast read path and touch direction lock.
 * Scope: presentation + read scheduling only. Numerical formulas, transactions,
 * signature/print code, authentication and security rules are NOT replaced.
 */
const ES_FAST_READ_MS=900;
const ES_FAST_CACHE_TTL=30*60*1000;
const esFastCache=new Map();
let esFastRoster={uid:'',at:0},esPan=null,esPanFrame=0,esTouchUntil=0,esNoticeTimer=0;
function esFastCacheKey(date,uid){return 'fz_es12_view_'+FIREBASE_CONFIG.projectId+'_'+uid+'_'+date;}
function esFastCacheGet(date,uid){
  const key=esFastCacheKey(date,uid);
  let value=esFastCache.get(key);
  if(!value)try{value=JSON.parse(sessionStorage.getItem(key)||'null');}catch(e){}
  if(!value||value.uid!==uid||value.date!==date||Date.now()-value.at>ES_FAST_CACHE_TTL)return null;
  return esClone(value);
}
function esFastCacheSave(c){
  if(!esReadCurrent(c)||!c.batch.server||!c.reports.server||c.batch.error||c.reports.error)return;
  // Only remote snapshots are cached, never the local dirty row overlay.
  const key=esFastCacheKey(c.session.date,c.session.uid);
  const stamp=JSON.stringify([c.batch.value,c.reports.value]);
  if(c.cacheStamp===stamp)return;
  c.cacheStamp=stamp;
  const value=esClone({date:c.session.date,uid:c.session.uid,at:Date.now(),batch:c.batch.value,reports:c.reports.value});
  esFastCache.delete(key);esFastCache.set(key,value);
  try{
    sessionStorage.setItem(key,JSON.stringify(value));
    const indexKey='fz_es12_view_index_'+FIREBASE_CONFIG.projectId+'_'+c.session.uid;
    const keys=[...(JSON.parse(sessionStorage.getItem(indexKey)||'[]')).filter(k=>k!==key),key];
    while(keys.length>3)sessionStorage.removeItem(keys.shift());
    sessionStorage.setItem(indexKey,JSON.stringify(keys));
  }catch(e){/* Existing local draft persistence is independent and unchanged. */}
  while(esFastCache.size>3)esFastCache.delete(esFastCache.keys().next().value);
}
function esFastRefreshRoster(uid,date,force){
  if(!force&&esFastRoster.uid===uid&&Date.now()-esFastRoster.at<120000)return;
  esFastRoster={uid,at:Date.now()};
  refreshEmployeeAccountRoster().then(()=>{if(esSession?.uid===uid&&esSession.date===date&&esAllowed())esRenderRouting();})
    .catch(()=>{esFastRoster.at=0;});
}
function esFastQueueRead(c){
  if(!esReadCurrent(c)||c.paintFrame)return;
  c.paintFrame=requestAnimationFrame(()=>{c.paintFrame=0;if(esReadCurrent(c))esApplyRead(c);});
}
(function(){
  const stop=esStopRead,apply=esApplyRead,render=esRenderRows,setReadStatus=esSetReadStatus;
  esStopRead=function(){if(esRead?.paintFrame)cancelAnimationFrame(esRead.paintFrame);stop();};
  esAcceptRead=function(c,kind,value,server=true,origin='sdk'){
    if(!esReadCurrent(c))return;
    const old=c[kind];
    if(old.server&&!server)return;
    if(kind==='batch'&&server&&old.server&&value.exists&&old.value?.exists){
      const prior=esReadStamp(old.value.data?.updatedAt),next=esReadStamp(value.data?.updatedAt);
      if(prior&&next&&next<prior)return;
    }
    if(origin==='once'&&old.server)return;
    const key=JSON.stringify(value);
    const changed=old.contentKey!==key;
    c[kind]={value,server,error:null,origin,contentKey:key};
    if(c.batch.server&&c.reports.server){for(const t of c.timers)clearTimeout(t);c.timers=[];}
    esSetReadStatus(c);esFastCacheSave(c);
    // Cache->server metadata alone does not rebuild every cell / lose the row.
    if(changed||c.pending){c.pending=true;esFastQueueRead(c);}
    else if(c.session.cloudReady&&!c.initialReady){c.initialReady=true;esStatus('Shared sheet loaded.');}
  };
  esApplyRead=function(c){
    if(!esReadCurrent(c))return;
    if(esPan||performance.now()<esTouchUntil){
      c.pending=true;
      if(!c.gestureTimer){c.gestureTimer=setTimeout(()=>{c.gestureTimer=0;esFastQueueRead(c);},180);c.timers.push(c.gestureTimer);}
      return;
    }
    const out=apply(c);esFastCacheSave(c);return out;
  };
  esRenderRows=function(...args){
    const g=esSheetScrollPort();let left=g?.scrollLeft||0,top=g?.scrollTop||0,anchor=null;
    if(g&&top>0){
      const edge=g.getBoundingClientRect().top+(g.querySelector('thead')?.offsetHeight||0);
      for(const tr of g.querySelectorAll('tbody tr[data-es-index]:not([hidden])')){
        const box=tr.getBoundingClientRect();if(box.bottom>edge){anchor={name:tr.querySelector('.es-name>b')?.textContent,offset:box.top-g.getBoundingClientRect().top};break;}
      }
    }
    const out=render(...args);
    if(g){
      g.scrollLeft=left;g.scrollTop=top;
      if(anchor){const tr=[...g.querySelectorAll('tbody tr[data-es-index]:not([hidden])')].find(t=>t.querySelector('.es-name>b')?.textContent===anchor.name);
        if(tr)g.scrollTop+=tr.getBoundingClientRect().top-g.getBoundingClientRect().top-anchor.offset;}
    }
    return out;
  };
  esSetReadStatus=function(c){setReadStatus(c);esCompactReadBadge();};
})();
esStartRead=function(s){
  // Preserve the baseline fresh verification after Save / Sync Draft.
  esStopRead();s.esReadEnabled=true;s.cloudReady=false;
  const c={session:s,batch:{server:false,value:null,error:null},reports:{server:false,value:null,error:null},unsubs:[],timers:[],aborters:[],pending:false,slow:false};esRead=c;
  esSetReadStatus(c);
  const refs={batch:doc(db,'hourlyV1Batches',s.date),reports:query(collection(db,'hourlyReports'),where('date','==',s.date))};
  for(const kind of ['batch','reports']){
    try{
      const unsubscribe=onSnapshot(refs[kind],{includeMetadataChanges:true},snap=>{
        const server=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
        const value=kind==='batch'?{exists:snap.exists(),data:snap.exists()?snap.data():{}}:snap.docs.map(x=>({id:x.id,...x.data()}));
        esAcceptRead(c,kind,value,server,'listen');
      },e=>esRejectRead(c,kind,e));
      if(typeof unsubscribe==='function')c.unsubs.push(unsubscribe);
    }catch(e){esRejectRead(c,kind,e);}
  }
  // Only two scoped listeners normally. No duplicate getDoc/getDocs requests.
  // A stalled stream uses the existing authenticated, read-only HTTPS fallback
  // after 900ms, rather than leaving the phone waiting through the 8s watchdog.
  c.timers.push(setTimeout(()=>{
    if(!esReadCurrent(c)||s.cloudReady)return;
    for(const kind of ['batch','reports'])if(!c[kind].server&&!/permission|unauthenticated/i.test(String(c[kind].error?.code||'')))esHttpRead(c,kind);
  },ES_FAST_READ_MS));
  c.timers.push(setTimeout(()=>{
    if(!esReadCurrent(c)||s.cloudReady)return;c.slow=true;esSetReadStatus(c);
    esStatus('Connection is slow. Available rows stay visible; Save waits for a cloud check.',true);
  },5000));
};
function esCompactReadBadge(){
  const b=$('esReadBadge'),s=esSession;if(!b||!s)return;
  const c=esReadCurrent(esRead)?esRead:null;
  const error=!!(c?.batch.error||c?.reports.error);
  b.textContent=ES_BUILD+' · '+(error?'Retry':s.cloudReady?(esHasEdits(s)?'Draft':'Live'):c?.slow?'Offline?':'Checking…');
  b.dataset.state=error?'error':s.cloudReady?(esHasEdits(s)?'draft':'ready'):'waiting';
  b.title=$('esCloudStatus')?.textContent||'Open sheet tools';
}
function esCompactTools(open){
  const area=$('employeeSheet');if(!area)return;
  area.classList.toggle('es-controls-open',open);
  $('esTools').setAttribute('aria-expanded',String(open));
  if(!open)$('esTeamDetails').open=false;
}
function esCompactInit(){
  const area=$('employeeSheet');if(!area||$('esCompactTools'))return;
  area.classList.add('es-compact');
  const header=area.querySelector('.es-header');
  $('esTools').textContent='More';$('esTools').setAttribute('aria-label','More: Team, BAR, Sync Draft, Reload and notes');
  $('esSearch').placeholder='Find name';$('esSearch').setAttribute('aria-label','Find employee');$('esDate').setAttribute('aria-label','Work date');
  for(const label of area.querySelectorAll('.es-toolbar>label')){
    for(const node of [...label.childNodes])if(node.nodeType===3&&node.textContent.trim()){
      const span=document.createElement('span');span.className='es-sr-only';span.textContent=node.textContent;node.replaceWith(span);
    }
  }
  const tools=document.createElement('div');tools.id='esCompactTools';tools.className='es-extra-controls';tools.setAttribute('role','region');tools.setAttribute('aria-label','Employee Sheet tools');
  tools.innerHTML='<div class="es-tool-heading"><b>Sheet tools</b><button type="button" id="esToolsClose" aria-label="Close sheet tools">✕</button></div><div id="esToolActions"></div>';
  area.appendChild(tools);
  $('esTools').setAttribute('aria-controls','esCompactTools');
  $('esToolActions').appendChild($('esReload'));
  tools.appendChild($('esTeamDetails'));
  tools.appendChild(area.querySelector('.es-guide'));
  tools.appendChild(area.querySelector('.es-jump'));
  tools.appendChild($('esStatus'));
  const footer=area.querySelector('.es-footer');
  tools.appendChild($('esTotals'));
  footer.replaceChildren();
  footer.innerHTML='<label class="es-sr-only" for="esQuickColumns">Jump to columns</label><select id="esQuickColumns" aria-label="Jump to columns"><option value="">⇄ Columns</option>'+[['staff','Staff'],['clocks','Clocks'],['sales','Sales'],['busser','Busser'],['bar','BAR'],['tips','Tips / Meal'],['checks','BAR Sales'],['payout','Payout']].map(([v,t])=>'<option value="'+v+'">'+t+'</option>').join('')+'</select><button type="button" id="esReadBadge" aria-label="Connection status — open tools">'+ES_BUILD+' · Checking…</button>';
  const notice=document.createElement('div');notice.id='esQuickNotice';notice.className='es-quick-notice hidden';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');area.appendChild(notice);
  $('esReadBadge').addEventListener('click',()=>esCompactTools(!area.classList.contains('es-controls-open')));
  $('esToolsClose').addEventListener('click',()=>{esCompactTools(false);$('esTools').focus({preventScroll:true});});
  area.addEventListener('pointerdown',e=>{if(area.classList.contains('es-controls-open')&&!tools.contains(e.target)&&e.target!==$('esTools')&&e.target!==$('esReadBadge'))esCompactTools(false);});
  area.addEventListener('keydown',e=>{if(e.key==='Escape'&&area.classList.contains('es-controls-open')){esCompactTools(false);$('esTools').focus({preventScroll:true});}});
  $('esQuickColumns').addEventListener('change',e=>{
    const button=area.querySelector('[data-es-jump="'+e.target.value+'"]');
    if(button)button.click();e.target.value='';
  });
  esInstallAxisLock();
}
(function(){
  const init=esInit,sync=esEnsureSyncUI,status=esStatus;
  esInit=function(...a){const out=init(...a);esCompactInit();return out;};
  esEnsureSyncUI=function(...a){const out=sync(...a);const tools=$('esCompactTools');if(tools&&$('esSyncBar')){
    tools.insertBefore($('esSyncBar'),$('esTeamDetails'));$('esToolActions').appendChild($('esSyncDraft'));
  }return out;};
  esStatus=function(text,error=false){
    status(text,error);esCompactReadBadge();
    const toast=$('esQuickNotice');if(!toast)return;
    // Routine instructions remain in More, not five paragraphs over the table.
    const routine=/^(Loading|Checking|Device copy|Available rows|Shared sheet loaded|Your device edits|Live preview|Ready)/i.test(text||'');
    if(routine&&!error)return;
    clearTimeout(esNoticeTimer);toast.textContent=text;toast.dataset.error=error?'1':'0';toast.classList.remove('hidden');
    esNoticeTimer=setTimeout(()=>toast.classList.add('hidden'),error?6500:4200);
  };
})();
function esInstallAxisLock(){
  const grid=$('esGrid');if(!grid||grid.dataset.esAxisLock)return;
  grid.dataset.esAxisLock='1';grid.classList.add('es-axis-scroll');
  let suppressClickUntil=0,settleTimer=0;
  function stopCoast(){cancelAnimationFrame(esPanFrame);esPanFrame=0;}
  function flush(){if(esReadCurrent(esRead)&&esRead.pending)esFastQueueRead(esRead);}
  function finish(cancel=false){
    const p=esPan;esPan=null;
    if(!p)return;
    if(p.axis==='x'){
      suppressClickUntil=performance.now()+450;
      // Short, controlled horizontal glide only. Vertical coordinate stays pinned.
      let speed=cancel||performance.now()-p.lastAt>100?0:Math.max(-1.8,Math.min(1.8,p.velocity));
      if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)speed=0;
      let last=performance.now(),started=last;
      const step=now=>{
        if(esPan){stopCoast();return;}
        const dt=Math.min(32,now-last);last=now;
        const before=grid.scrollLeft;grid.scrollLeft=before+speed*dt;grid.scrollTop=p.top;
        speed*=Math.pow(.88,dt/16.67);
        if(Math.abs(speed)>.025&&now-started<280&&grid.scrollLeft!==before){esTouchUntil=now+100;esPanFrame=requestAnimationFrame(step);}
        else{esPanFrame=0;esTouchUntil=0;flush();}
      };
      if(Math.abs(speed)>.025){esTouchUntil=performance.now()+350;esPanFrame=requestAnimationFrame(step);}else{esTouchUntil=0;flush();}
    }else{
      // Let native vertical inertia finish before a snapshot may rebuild the rows.
      esTouchUntil=performance.now()+180;clearTimeout(settleTimer);settleTimer=setTimeout(flush,200);
    }
  }
  grid.addEventListener('touchstart',e=>{
    stopCoast();
    // Fine-pointer desktop uses the whole page scrollport; phones keep ES1.2 axis lock.
    if($('employeeSheet')?.classList.contains('es-desktop-page')){esPan=null;esTouchUntil=0;return;}
    if(e.touches.length!==1){finish(true);esPan=null;esTouchUntil=0;return;}
    suppressClickUntil=0; // A new intentional tap must not be blocked by the prior swipe.
    const t=e.touches[0],active=document.activeElement;
    // Keep native caret selection when dragging inside the currently edited text.
    if(active===e.target&&active.matches('input[type="text"],input[type="search"],textarea')){esPan=null;return;}
    esPan={id:t.identifier,x:t.clientX,y:t.clientY,left:grid.scrollLeft,top:grid.scrollTop,axis:'',lastX:t.clientX,lastAt:performance.now(),velocity:0};
  },{passive:true});
  grid.addEventListener('touchmove',e=>{
    const p=esPan;if(!p)return;
    if(e.touches.length!==1){finish(true);esTouchUntil=0;return;}
    const t=[...e.touches].find(x=>x.identifier===p.id);if(!t)return;
    const dx=t.clientX-p.x,dy=t.clientY-p.y;
    if(!p.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<7)return;p.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';}
    if(p.axis==='x'){
      if(e.cancelable)e.preventDefault();
      grid.scrollLeft=p.left-dx;grid.scrollTop=p.top;
      const now=performance.now(),dt=Math.max(1,now-p.lastAt);p.velocity=(p.lastX-t.clientX)/dt;p.lastX=t.clientX;p.lastAt=now;
    }
    // Vertical direction uses native scrolling (pan-y) and keeps horizontal still.
  },{passive:false});
  grid.addEventListener('touchend',e=>{if(!e.touches.length)finish(false);},{passive:true});
  grid.addEventListener('touchcancel',()=>finish(true),{passive:true});
  grid.addEventListener('scroll',()=>{
    if(esPan?.axis==='x'&&Math.abs(grid.scrollTop-esPan.top)>.5)grid.scrollTop=esPan.top;
    if(esPan?.axis==='y'&&Math.abs(grid.scrollLeft-esPan.left)>.5)grid.scrollLeft=esPan.left;
    if(!esPan&&performance.now()<esTouchUntil&&!esPanFrame){esTouchUntil=performance.now()+180;clearTimeout(settleTimer);settleTimer=setTimeout(flush,200);}
  },{passive:true});
  grid.addEventListener('click',e=>{if(performance.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
  window.addEventListener('pagehide',()=>{stopCoast();esPan=null;esTouchUntil=0;clearTimeout(settleTimer);});
}


/* ES1.3 — desktop page scrolling, scoped to Employee Sheet only.
 * A single native two-axis page scrollport keeps CSS sticky name/header cells
 * in the same scroll ancestor. No duplicate headers or transform-based rows.
 * Coarse-pointer phones/tablets retain the ES1.2 bounded grid + touch lock.
 */
function esSheetScrollPort(){
  const area=$('employeeSheet');
  return area?.classList.contains('es-desktop-page')?area:$('esGrid');
}
function esInstallDesktopPage(){
  const area=$('employeeSheet'),grid=$('esGrid');
  if(!area||!grid||area.dataset.esDesktopInstalled)return;
  area.dataset.esDesktopInstalled='1';
  const media=window.matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
  function sizeControls(){
    if(!area.classList.contains('es-desktop-page')||!area.clientWidth)return;
    const css=getComputedStyle(area);
    const width=area.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    const value=Math.max(0,width)+'px';
    if(area.style.getPropertyValue('--es-page-width')!==value)area.style.setProperty('--es-page-width',value);
  }
  function changeMode(){
    const prior=esSheetScrollPort(),left=prior?.scrollLeft||0,top=prior?.scrollTop||0;
    const wasDesktop=area.classList.contains('es-desktop-page'),desktop=media.matches;
    let anchor=null;
    if(prior&&top>0){
      const edge=prior.getBoundingClientRect().top+(grid.querySelector('thead')?.offsetHeight||0);
      for(const row of grid.querySelectorAll('tbody tr[data-es-index]:not([hidden])')){
        const box=row.getBoundingClientRect();
        if(box.bottom>edge){anchor={name:row.querySelector('.es-name>b')?.textContent,offset:box.top-prior.getBoundingClientRect().top};break;}
      }
    }
    area.classList.toggle('es-desktop-page',desktop);
    sizeControls();
    if(wasDesktop!==desktop){
      cancelAnimationFrame(esPanFrame);esPanFrame=0;esPan=null;esTouchUntil=0;
      prior.scrollLeft=0;prior.scrollTop=0;
      const next=esSheetScrollPort();next.scrollLeft=left;next.scrollTop=top;
      if(anchor){
        const row=[...grid.querySelectorAll('tbody tr[data-es-index]:not([hidden])')].find(r=>r.querySelector('.es-name>b')?.textContent===anchor.name);
        if(row)next.scrollTop+=row.getBoundingClientRect().top-next.getBoundingClientRect().top-anchor.offset;
      }
    }
  }
  media.addEventListener('change',changeMode);
  window.addEventListener('resize',sizeControls,{passive:true});
  if(typeof ResizeObserver==='function')new ResizeObserver(sizeControls).observe(area);
  changeMode();
}
(function(){
  const init=esInit;
  esInit=function(...args){const result=init(...args);esInstallDesktopPage();return result;};
})();

/* ES1.4 — per-field live sync + isolated final Save/Sign.
 * Shared drafts auto-sync. A Daily Report is finalized ONLY by Save/Sign/Print.
 * Original esBuildBatch/esCalculate and all payroll engines are reused verbatim.
 * Transactions read before writing and never erase another employee's input.
 */
const ES14_DEBOUNCE_MS=650;
function es14MoneyValid(v){const t=String(v??'').trim();return t===''||(/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(t)&&Number.isFinite(Number(t)));}
function es14MoneyText(v){const t=String(v??'').trim();return t===''?'':es14MoneyValid(t)?String(Number(t)):t;}
function es14Same(field,a,b){return ES_MONEY.includes(field)?es14MoneyText(a)===es14MoneyText(b):field.startsWith('clock')?esNormalizeClock(a)===esNormalizeClock(b):String(a??'')===String(b??'');}
function es14CleanRow(row){const r=esClone(row);for(const f of ES_MONEY)if(es14MoneyValid(r[f]))r[f]=es14MoneyText(r[f]);return r;}
function es14Conflict(name,field,base,local,remote){return {name,field,base:base??'',local:local??'',remote:remote??''};}
function es14ConflictError(conflicts){const e=new Error('Another device edited the same field. Tap Review changes to choose the value; other employees can still be saved.');e.esConflicts=conflicts;return e;}
function es14UniqueConflicts(items){return [...new Map(items.map(x=>[x.name+'\u0000'+x.field,x])).values()];}
function es14RecordConflicts(s,conflicts){s.conflicts=es14UniqueConflicts(conflicts);es14ConflictUI();}
function es14HasEligible(s){return !!s&&esHasEdits(s)&&s.esReadEnabled;}
function es14AllowedSession(s){return !!s&&esAllowed()&&currentUser.uid===s.uid;}
function es14IsOnline(){return typeof navigator==='undefined'||navigator.onLine!==false;}
function es14CaptureScroll(){const port=esSheetScrollPort();return {left:port?.scrollLeft||0,top:port?.scrollTop||0};}
function es14RestoreScroll(pos,name){
  if(!pos)return;const apply=()=>{const p=esSheetScrollPort();if(p){p.scrollLeft=pos.left;p.scrollTop=pos.top;}const index=esSession?.rows.findIndex(r=>r.name===name);if(index>=0)$('esRows')?.querySelector(`[data-es-row="${index}"][data-es-action="sign"]`)?.focus({preventScroll:true});if(p){p.scrollLeft=pos.left;p.scrollTop=pos.top;}};
  apply();requestAnimationFrame(apply);
}
function es14ReportRow(r,fallback){
  if(r.employeeSheetRow&&r.employeeSheetFingerprint===esFingerprint(r))return {...esClone(r.employeeSheetRow),name:r.employee};
  const row={...esClone(fallback||esDefaults(r.employee,r.date)),name:r.employee},h={...r,...r.hours};
  row.shift=String(r.shift||row.shift||'').toUpperCase();row.role=String(r.position||row.role).toLowerCase()==='bartender'?'Bartender':'Server';
  row.clockIn=esNormalizeClock(h[row.shift==='DOUBLE'?'hourInAM':'hourIn']||'');row.clockOut=esNormalizeClock(h[row.shift==='DOUBLE'?'hourOutAM':'hourOut']||'');
  if(row.shift==='DOUBLE'){row.clockIn2=esNormalizeClock(h.hourInPM||'');row.clockOut2=esNormalizeClock(h.hourOutPM||'');}
  for(const [f,k]of [['grand','grandTotal'],['paid','paidTip'],['cardFee','payCardTipFee'],['cash','cashTip'],['meal','meal']])if(r[k]!==undefined)row[f]=String(r[k]);
  if(r.payCardTipFee===undefined&&r.cardFee!==undefined)row.cardFee=String(r.cardFee);
  row.adjustmentDecision=r.adjustmentDecision||'';
  if(['DOUBLE','LONG'].includes(row.shift))row[row.role==='Server'&&row.shift==='LONG'?'total24':'totalAM']=String(r.totalAM??0);
  if(r.barBreakdown){row.totalAM=String(r.barBreakdown.amGrandTotal??row.totalAM);row.total24=String(r.barBreakdown.grandTotal24??row.total24);}
  if(['AM',SHIFT_EARLY].includes(row.shift)&&!r.barBreakdown)row.totalAM=String(r.grandTotal??0);
  if(row.shift===SHIFT_MIDDLE)row.total24=String(r.grandTotal??0);
  return es14CleanRow(row);
}
function es14FreshReports(reports,s){
  return reports.map(r=>{const prior=s?.reports?.find(x=>x.id===r.id);return prior&&Number(prior.employeeSheetRevision||0)>Number(r.employeeSheetRevision||0)?esClone(prior):r;});
}
function es14Remote(raw,reports,date,s){
  const batch=esPrepareBatch(raw,reports,date),rows=esRowsFromBatch(batch,reports,date),conflicts=[];
  // Reconcile edits made through the original Daily Report editor. A newer
  // signature/timestamp alone is not a financial change and never blocks Save.
  for(const row of rows){
    const d=batch.drafts[row.name],r=esFindReport(reports,row.name);if(!d||!r)continue;
    // Batch and report listeners can arrive in either order. An older report
    // cannot reverse a newer atomic Save already acknowledged by the batch.
    if(Number(r.employeeSheetRevision||0)<Number(d.employeeSheetReportRevision||0))continue;
    const previous=s?.reports?.find(x=>x.id===r.id);
    // Keep the initial legacy financial baseline across subsequent snapshots.
    // Otherwise a reports-listener update could briefly show a newer report and
    // then revert it when the independent batch listener emits again.
    if(s&&!d.employeeSheetFinalRow){s.reportBases ||= {};s.reportBases[r.id] ||= {row:es14ReportRow(previous||r,row),fingerprint:esFingerprint(previous||r)};}
    const legacy=s?.reportBases?.[r.id];
    const reference=d.employeeSheetFinalRow||legacy?.row||(previous?es14ReportRow(previous,row):null);
    const fp=d.employeeSheetFinalFingerprint||legacy?.fingerprint||(previous?esFingerprint(previous):'');
    if(!reference||!fp||esFingerprint(r)===fp)continue;
    const updated=es14ReportRow(r,reference);
    for(const field of ES_FIELDS)if(!es14Same(field,updated[field],reference[field])){
      if(es14Same(field,row[field],reference[field])||es14Same(field,row[field],updated[field]))row[field]=updated[field];
      else conflicts.push({...es14Conflict(row.name,field,reference[field],row[field],updated[field]),origin:'report',reportId:r.id,reportFingerprint:esFingerprint(r)});
    }
  }
  return {batch,rows,conflicts,routing:esRouting(rows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,batch.bar[cp].bartender||''])))};
}
function es14Patch(baseRows,editedRows,remoteRows,dirty,route,skipInvalid=true){
  const rows=esClone(remoteRows),applied={},conflicts=[],skipped=[];
  for(const edited of editedRows){
    const changes=dirty[edited.name];if(!changes)continue;
    const base=baseRows.find(r=>r.name===edited.name);let target=rows.find(r=>r.name===edited.name);
    if(!target){
      if(changes.__new){target=esDefaults(edited.name,'');rows.push(target);applied[edited.name]={__new:true};}
      else{conflicts.push(es14Conflict(edited.name,'__removed','present','keep row','removed'));continue;}
    }
    const salesErrors=esValidateSales({...edited,paid:'0',cardFee:'0',cash:'0',meal:'0'},route,false);
    for(const field of ES_FIELDS){
      if(!changes[field]&&!changes.__new)continue;
      const value=ES_MONEY.includes(field)&&es14MoneyValid(edited[field])?es14MoneyText(edited[field]):edited[field];
      if(skipInvalid&&((ES_MONEY.includes(field)&&!es14MoneyValid(value))||(['totalAM','total24','grand'].includes(field)&&salesErrors.length))){skipped.push({name:edited.name,field});continue;}
      const original=base?.[field]??esDefaults(edited.name,'')[field];
      if(base&&es14Same(field,value,original))continue; // No remaining local edit.
      if(!es14Same(field,target[field],original)&&!es14Same(field,target[field],value)){
        // An existing concurrently-added row is not reset to new-row defaults.
        if(changes.__new&&!base&&!changes[field])continue;
        conflicts.push(es14Conflict(edited.name,field,original,value,target[field]));continue;
      }
      if(!es14Same(field,target[field],value)){target[field]=value;(applied[edited.name] ||= {})[field]=true;}
    }
  }
  return {rows,applied,conflicts,skipped};
}
function es14MergeRoute(base,local,remote){
  const route={...remote},conflicts=[];
  for(const cp of ES_PERIODS)if((local?.[cp]||'')!==(base?.[cp]||'')){
    if((remote[cp]||'')!==(base?.[cp]||'')&&(remote[cp]||'')!==(local[cp]||''))conflicts.push(es14Conflict('BAR routing',cp,base?.[cp],local?.[cp],remote[cp]));
    else route[cp]=local[cp]||'';
  }
  return {route,conflicts};
}
function es14Rebase(s,raw,reports,ack=null){
  if(!es14AllowedSession(s))return;
  reports=es14FreshReports(reports,s);
  const remote=es14Remote(raw,reports,s.date,s),old=s.rows||[],base=s.baseRows||[],dirty=s.dirty||{};
  // Only the sent values are acknowledged. Keystrokes entered while the request
  // was in flight remain dirty, with the acknowledged value as their new base.
  if(ack)for(const [name,fields]of Object.entries(ack.fields||{})){
    const sent=ack.rows.find(r=>r.name===name);if(!sent)continue;
    let b=base.find(r=>r.name===name);if(!b){b=esClone(sent);base.push(b);}
    for(const f of ES_FIELDS)if(fields[f]||fields.__new)b[f]=sent[f];
    if(dirty[name]?.__new)delete dirty[name].__new;
  }
  if(ack?.routing)for(const cp of ES_PERIODS)if((s.routing[cp]||'')===(ack.routing[cp]||''))s.baseRouting[cp]=ack.routing[cp]||'';
  const rows=remote.rows.map(esClone),nextBase=remote.rows.map(esClone),nextDirty={},conflicts=[...remote.conflicts];
  for(const local of old){
    const changes=dirty[local.name];if(!changes)continue;
    let target=rows.find(r=>r.name===local.name),original=base.find(r=>r.name===local.name),b=nextBase.find(r=>r.name===local.name);
    if(!target){rows.push(esClone(local));nextDirty[local.name]={...changes};if(original){nextBase.push(esClone(original));conflicts.push(es14Conflict(local.name,'__removed','present','keep row','removed'));}continue;}
    for(const f of ES_FIELDS)if(changes[f]||changes.__new){
      if(es14Same(f,local[f],target[f]))continue;
      const prior=original?.[f]??esDefaults(local.name,s.date)[f];
      if(original&&es14Same(f,local[f],prior))continue; // Adopt newer value after an undone/equivalent edit.
      if(!es14Same(f,target[f],prior))conflicts.push(es14Conflict(local.name,f,prior,local[f],target[f]));
      target[f]=local[f];b[f]=prior;(nextDirty[local.name] ||= {})[f]=true;
    }
  }
  const route=es14MergeRoute(s.baseRouting,s.routing,remote.routing),baseRoute={...remote.routing};
  for(const c of route.conflicts){route.route[c.field]=s.routing[c.field];baseRoute[c.field]=s.baseRouting[c.field];}
  Object.assign(s,{baseBatch:remote.batch,rawBase:esClone(raw),rows,baseRows:nextBase,dirty:nextDirty,reports:esClone(reports),routing:esRouting(rows,route.route),baseRouting:baseRoute});
  es14RecordConflicts(s,[...conflicts,...route.conflicts]);
  esRecalculate();es14Paint();if($('esBarRoutes'))esRenderRouting();esPersistLocal();
}
function es14Paint(force=false){
  const s=esSession;if(!s?.ready||!$('esRows'))return;
  if(esPan||performance.now()<esTouchUntil){if(esReadCurrent(esRead))esRead.pending=true;return;}
  const trs=[...$('esRows').querySelectorAll('tr[data-es-index]')];
  const shape=JSON.stringify(s.rows.map(r=>[r.name,r.shift,r.role]))+JSON.stringify(s.routing);
  const focus=document.activeElement,editing=!!focus?.matches?.('#esRows input,#esRows select');
  if(force||!editing&&(s.paintShape!==shape||trs.length!==s.rows.length)){esRenderRows();s.paintShape=shape;es14ConflictUI();return;}
  for(const tr of trs){
    const name=tr.querySelector('.es-name>b')?.textContent,row=s.rows.find(r=>r.name===name);if(!row)continue;
    for(const input of tr.querySelectorAll('[data-es-field]')){
      const f=input.dataset.esField;
      // An acknowledged formatting-only refresh must not move the typing caret.
      // A genuinely newer remote value still paints into a focused, unedited cell.
      if(input===focus&&(s.dirty[row.name]?.[f]||es14Same(f,input.type==='checkbox'?input.checked:input.value,row[f])))continue;
      if(input.type==='checkbox')input.checked=!!row[f]&&!!esBarMask(row,s.routing)[f];
      else if(!input.disabled)input.value=ES_MONEY.includes(f)?es182MoneyDisplay(row[f]):String(row[f]??'');
    }
  }
  esUpdateComputed();es14ConflictUI();
}
function es14AcceptCommit(s,batch,reports,ack){
  if(esSession!==s||!es14AllowedSession(s))return;
  s.hadCloud=true;es14Rebase(s,batch,reports,ack);
  try{localStorage.setItem(HV1_STORAGE_PREFIX+s.date,JSON.stringify(batch));}catch(e){}
  const c=esReadCurrent(esRead)?esRead:null;
  if(c){
    c.batch={value:{exists:true,data:esClone(batch)},server:true,error:null,origin:'transaction',contentKey:JSON.stringify({exists:true,data:batch})};
    c.reports={value:esClone(reports),server:true,error:null,origin:'transaction',contentKey:JSON.stringify(reports)};
    c.pending=false;esSetReadStatus(c);esFastCacheSave(c);
  }
}
function es14DraftSnapshot(s){return esClone({date:s.date,uid:s.uid,rows:s.rows,baseRows:s.baseRows,dirty:s.dirty,routing:s.routing,baseRouting:s.baseRouting,baseBatch:s.baseBatch,reports:s.reports,hadCloud:s.hadCloud});}
async function es14PublishDraft(s){
  const draft=es14DraftSnapshot(s),ref=doc(db,'hourlyV1Batches',s.date);
  const out=await runTransaction(db,async tx=>{
    const snap=await tx.get(ref);if(!es14AllowedSession(s))throw new Error('Login changed. No draft was shared.');
    if(!snap.exists()&&draft.hadCloud)throw new Error('This work date was removed. Your device draft is kept.');
    const raw=snap.exists()?snap.data():draft.baseBatch;
    const remote=es14Remote(raw,draft.reports,draft.date,s);
    const routes=es14MergeRoute(draft.baseRouting,draft.routing,remote.routing);
    const merge=es14Patch(draft.baseRows,draft.rows,remote.rows,draft.dirty,routes.route,true);
    const routing=esRouting(merge.rows,routes.route),routeChanged=ES_PERIODS.some(cp=>(routing[cp]||'')!==(remote.routing[cp]||''));
    const changed=Object.keys(merge.applied).length>0||routeChanged||!snap.exists()&&merge.rows.length>0;
    const batch=changed?esBuildBatch(remote.batch,merge.rows,draft.date,routing):remote.batch;
    if(changed){
      for(const name of Object.keys(merge.applied))if(batch.drafts[name])batch.drafts[name].savedAt=Date.now();
      batch.employeeSheetRevision=Number(raw.employeeSheetRevision||0)+1;
      tx.set(ref,{...raw,date:draft.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},employeeSheetRevision:batch.employeeSheetRevision,updatedAt:serverTimestamp(),updatedByUid:s.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
    }
    return {batch,routing,changed,fields:merge.applied,rows:merge.rows,conflicts:[...remote.conflicts,...merge.conflicts,...routes.conflicts],skipped:merge.skipped};
  });
  if(esSession===s){
    es14AcceptCommit(s,out.batch,s.reports,{rows:out.rows,fields:out.fields,routing:out.routing});
    es14RecordConflicts(s,[...(s.conflicts||[]),...out.conflicts]);s.autoError='';s.autoRetries=0;
  }
  return out;
}
function es14HasPublishable(s){
  const conflicts=s.conflicts||[];
  for(const row of s.rows){const changes=s.dirty[row.name];if(!changes)continue;
    if(changes.__new&&!s.baseRows.some(r=>r.name===row.name))return true;
    const salesErrors=esValidateSales({...row,paid:'0',cardFee:'0',cash:'0',meal:'0'},s.routing,false);
    for(const f of ES_FIELDS)if(changes[f]&&!conflicts.some(c=>c.name===row.name&&c.field===f)&&(!ES_MONEY.includes(f)||es14MoneyValid(row[f]))&&(!['grand','totalAM','total24'].includes(f)||!salesErrors.length))return true;
  }
  return ES_PERIODS.some(cp=>(s.routing[cp]||'')!==(s.baseRouting[cp]||'')&&!conflicts.some(c=>c.name==='BAR routing'&&c.field===cp));
}
function es14Schedule(s=esSession,delay=ES14_DEBOUNCE_MS){
  if(!s)return;clearTimeout(s.autoTimer);
  if(!es14HasEligible(s)||!es14HasPublishable(s)||!s.cloudReady||s.busy||s.autoPromise||esSignature||!es14IsOnline())return;
  s.autoTimer=setTimeout(()=>{s.autoTimer=0;void es14AutoFlush(s);},delay);
}
async function es14AutoFlush(s=esSession){
  if(s?.autoPromise){await s.autoPromise;return;}
  if(!es14AllowedSession(s)||!s.ready||!s.cloudReady||!esHasEdits(s)||!es14IsOnline())return;
  clearTimeout(s.autoTimer);s.autoWriting=true;esCompactReadBadge();
  s.autoPromise=es14PublishDraft(s).catch(e=>{if(esSession===s){s.autoError=e.message||String(e);s.autoRetries=(s.autoRetries||0)+1;es14HandleError(e);}return null;});
  try{await s.autoPromise;}finally{
    s.autoPromise=null;s.autoWriting=false;esCompactReadBadge();if(esReadCurrent(esRead)&&esRead.pending)esFastQueueRead(esRead);
    if(esSession===s&&!s.autoError&&es14HasPublishable(s))es14Schedule(s);
    // Invalid/incomplete cells and real conflicts wait for a user change. Network
    // failures retry with bounded backoff; no busy loop or repeated finalization.
    if(esSession===s&&s.autoError&&s.autoRetries<4&&!/permission|removed|Login/i.test(s.autoError))es14Schedule(s,Math.min(2000*2**s.autoRetries,15000));
  }
}
function es14HandleError(e){
  if(e.esConflicts&&esSession)es14RecordConflicts(esSession,[...(esSession.conflicts||[]),...e.esConflicts]);
  esStatus(e.message||String(e),true);
}
window.employeeSheetSyncDraft=async function(){
  const s=esSession;if(!es14AllowedSession(s)||s.busy)return false;
  if(!s.cloudReady){esStatus('Checking cloud. Your input stays on this device until the connection is ready.',true);return false;}
  await es14AutoFlush(s);return !s.autoError&&!(s.conflicts||[]).length;
};
// Independent reads keep running after save; do not reset the whole page to
// "loading" after every transaction. Field-level rebasing updates other devices.
esApplyRead=function(c){
  if(!esReadCurrent(c))return;const s=c.session;esSetReadStatus(c);
  if(s.busy||s.autoWriting||esPan||performance.now()<esTouchUntil){c.pending=true;return;}
  const value=c.batch.value,raw=value?.exists?value.data:value&&c.batch.server?{team:[],drafts:{}}:s.rawBase||{};
  const reports=es14FreshReports((c.reports.value||s.reports||[]).filter(r=>r.date===s.date),s);
  if(value&&!value.exists&&c.batch.server&&!s.hadCloud){for(const row of s.rows)if(!(raw.team||[]).includes(row.name)&&!reports.some(r=>esKey(r.employee)===esKey(row.name)))s.dirty[row.name] ||= {__new:true};}
  try{
    es14Rebase(s,raw,reports);s.hadCloud=!!s.hadCloud||!!value?.exists;c.pending=false;
    latestHourlyReports=[...reports,...latestHourlyReports.filter(r=>r.date!==s.date||es16ExportIsHost(r))];
    if(s.cloudReady&&!c.initialReady){c.initialReady=true;esStatus('Shared sheet loaded. Save keeps unfinished rows as drafts; complete rows update Final Report.');}
    esFastCacheSave(c);es14Schedule(s);frRenderIfOpen();
  }catch(e){esRejectRead(c,'batch',e);}
};
// Post-commit semantic overlay prevents an old read from reversing an acknowledged
// draft revision while the other listener catches up.
(function(){const accept=esAcceptRead;esAcceptRead=function(c,kind,value,server=true,origin='sdk'){
  if(kind==='batch'&&value?.exists&&c.batch?.value?.exists&&Number(value.data?.employeeSheetRevision||0)<Number(c.batch.value.data?.employeeSheetRevision||0))return;
  return accept(c,kind,value,server,origin);
};})();

esCommit=async function(name,signature=null,expectedSignatureFingerprint=''){
  const session=esSession;
  if(!es14AllowedSession(session)||!session.ready)throw new Error('Manager / Owner session required.');
  if(session.esReadEnabled&&!session.cloudReady)throw new Error('Cloud connection is not ready yet. Your input and signature are kept.');
  if(!es14IsOnline())throw new Error('Offline. Your input and signature are kept; reconnect before saving the Final Report.');
  // Publish valid independent edits without letting an unrelated incomplete fee
  // reject the chosen employee. Auto-sync never creates hourlyReports.
  if(session.esReadEnabled)await es14AutoFlush(session);
  const selected=session.rows.find(r=>r.name===name);if(!selected)throw new Error('Employee row not found.');
  const errors=esValidateSales(selected,session.routing,true);if(errors.length)throw new Error(name+': '+errors.join(' '));
  // Previously displayed conflicts may already have converged. Re-evaluate
  // against authoritative batch/report reads inside the transaction below.
  // Real simultaneous edits still throw before any write.
  const duplicate=session.reports.filter(r=>esKey(r.employee)===esKey(name));
  if(duplicate.length>1&&!session.baseBatch.drafts?.[name]?.hourlyReportId)throw new Error('Multiple reports exist for this work account. Open the intended report in Final Report.');
  const s=es14DraftSnapshot(session),ref=doc(db,'hourlyV1Batches',s.date),newRef=doc(collection(db,'hourlyReports'));
  const result=await runTransaction(db,async tx=>{
    const snap=await tx.get(ref);if(!es14AllowedSession(session))throw new Error('Login changed. Nothing was saved.');
    if(!snap.exists()&&s.hadCloud)throw new Error('This work date was removed. Your draft is kept.');
    const raw=snap.exists()?snap.data():s.baseBatch;
    const linked=raw.drafts?.[name]?.hourlyReportId||esFindReport(s.reports,name)?.id||'';
    const reportRef=linked?doc(db,'hourlyReports',linked):newRef,reportSnap=linked?await tx.get(reportRef):null;
    const before=reportSnap?.exists()?reportSnap.data():null;
    if(before&&!hourlyReportBelongsTo(before,name,s.date))throw new Error('Saved report belongs to a different employee/date. Nothing was overwritten.');
    const reports=before?[{...before,id:reportRef.id},...s.reports.filter(r=>r.id!==reportRef.id)]:s.reports;
    const remote=es14Remote(raw,reports,s.date,session),routes=es14MergeRoute(s.baseRouting,s.routing,remote.routing);
    const onlyDirty=s.dirty[name]?{[name]:s.dirty[name]}:{};
    const merge=es14Patch(s.baseRows,s.rows,remote.rows,onlyDirty,routes.route,false);
    const conflicts=[...remote.conflicts.filter(c=>c.name===name),...merge.conflicts,...routes.conflicts];if(conflicts.length)throw es14ConflictError(conflicts);
    const route=esRouting(merge.rows,routes.route),batch=esBuildBatch(remote.batch,merge.rows,s.date,route),row=merge.rows.find(r=>r.name===name);
    if(!row)throw new Error('Employee no longer exists on this work date.');
    const problems=esValidateSales(row,route,true);if(problems.length)throw new Error(name+': '+problems.join(' '));
    // Only sales are dependencies of BAR Received, never another worker's tips,
    // fees, meals or unfinished clocks. A server's own fees are row-isolated.
    if(row.role==='Bartender')for(const server of merge.rows)if(server.role==='Server'){
      const affected=ES_PERIODS.some(cp=>route[cp]===name&&!hv1BarExcluded(cp,batch,server.name));if(!affected)continue;
      const p=esValidateSales({...server,paid:'0',cardFee:'0',cash:'0',meal:'0'},route,false);if(p.length)throw new Error(server.name+' sales need review before calculating this bartender: '+p.join(' '));
    }
    const calculated=esCalculate(row,batch,before);
    if(signature&&expectedSignatureFingerprint!==esFingerprint(calculated)){
      const e=new Error('Amounts changed while signing. Tap Review latest amount, then sign the updated report. Your other input is kept.');e.esAmountsChanged=true;throw e;
    }
    const sourceId=before?.sourceSubmissionId||batch.drafts[name].sourceSubmissionId||'',subRef=sourceId?doc(db,'submissions',sourceId):null,subSnap=subRef?await tx.get(subRef):null;
    const source=subSnap?.exists()?subSnap.data():null,validSource=hourlyReportBelongsTo(source,name,s.date)?sourceId:'';
    const sigPatch=esSignaturePatch(before,calculated,signature),savedRow=es14CleanRow(row),fingerprint=esFingerprint(calculated);
    const payload={...calculated,...sigPatch,sourceSubmissionId:validSource,status:'money_ready',employeeKey:fzEmployeeIdentityKey(name),reportIdentityVersion:'13.8.28',employeeSheetBuild:ES_BUILD,employeeSheetRevision:Number(raw.employeeSheetRevision||0)+1,employeeSheetRow:savedRow,employeeSheetFingerprint:fingerprint,updatedAt:serverTimestamp(),updatedBy:currentProfile.displayName||currentProfile.username||''};
    if(validSource&&source.employeeUid)payload.employeeUid=source.employeeUid;
    if(before)tx.update(reportRef,payload);else tx.set(reportRef,{...payload,createdAt:serverTimestamp(),createdByUid:s.uid,createdBy:currentProfile.displayName||currentProfile.username||''});
    if(validSource)tx.update(subRef,{status:'money_ready',hourlyStatus:'finalized',hourlyReportId:reportRef.id,finalReport:{...calculated},...(signature?{pickupSignature:signature,signatureStatus:'SIGNED'}:sigPatch.pickupSignature===null?{pickupSignature:null,signatureStatus:'PENDING'}:{}),updatedAt:serverTimestamp()});
    Object.assign(batch.drafts[name],{hourlyReportId:reportRef.id,sourceSubmissionId:validSource,finalized:true,finalizedAt:Date.now(),savedAt:Date.now(),employeeSheetFinalRow:savedRow,employeeSheetFinalFingerprint:fingerprint,employeeSheetReportRevision:Number(raw.employeeSheetRevision||0)+1});
    batch.employeeSheetRevision=Number(raw.employeeSheetRevision||0)+1;
    tx.set(ref,{...raw,date:s.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},employeeSheetRevision:batch.employeeSheetRevision,updatedAt:serverTimestamp(),updatedByUid:s.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
    return {batch,report:{...(before||{}),...payload,id:reportRef.id},before,route,rows:merge.rows,fields:{[name]:Object.fromEntries(ES_FIELDS.map(f=>[f,true]))}};
  });
  if(esSession===session&&es14AllowedSession(session)){
    const reports=[result.report,...session.reports.filter(r=>r.id!==result.report.id)];
    try{es14AcceptCommit(session,result.batch,reports,{rows:result.rows,fields:result.fields,routing:result.route});}
    catch(e){session.reports=reports;console.warn('Report saved; sheet refresh will retry:',e);if(esReadCurrent(esRead))esRead.pending=true;}
    latestHourlyReports=[result.report,...latestHourlyReports.filter(r=>r.id!==result.report.id)];
    try{frRenderIfOpen();}catch(e){console.warn('Report saved; Final Report view refresh:',e);}
  }
  // Logging must not keep the signature modal open after the report transaction
  // has succeeded. It is deliberately not on the user's critical save path.
  Promise.resolve().then(()=>writeAudit(signature?'employee_sheet_sign':'employee_sheet_save',result.report.id,name,{date:s.date,before:result.before||null,after:result.report,signatureReplaced:!!result.before?.pickupSignature})).catch(e=>console.warn('Employee Sheet audit:',e));
  return result;
};
window.employeeSheetSave=async function(name){
  if(!esAllowed()||esSession?.busy)return false;const scroll=es14CaptureScroll();
  esSetBusy(true);esStatus('Saving '+name+'…');
  try{
    const row=esSession.rows.find(r=>r.name===name);if(!row)throw new Error('Employee row not found.');
    if(esValidateSales(row,esSession.routing,true).length || !esSession.cloudReady || !es14IsOnline())await es16SaveDraft(name);
    else{await esCommit(name);esStatus(name+' saved · Final Report updated.');}
    return true;
  }
  catch(e){es14HandleError(e);return false;}
  finally{esSetBusy(false);esRenderRows();esRenderRouting();const p=esSheetScrollPort();if(p){p.scrollLeft=scroll.left;p.scrollTop=scroll.top;}es14ConflictUI();}
};
function es14ConflictUI(){
  const s=esSession;if(!s||!$('esRows'))return;
  for(const tr of $('esRows').querySelectorAll('tr[data-es-index]')){
    const row=s.rows[Number(tr.dataset.esIndex)];if(!row)continue;const list=(s.conflicts||[]).filter(c=>c.name===row.name),msg=tr.querySelector('.es-row-message');
    if(msg){msg.replaceChildren();if(list.length){const b=document.createElement('button');b.type='button';b.className='es-review-change';b.textContent='Review changes';b.onclick=()=>es14OpenConflicts(row.name);msg.appendChild(b);}}
  }
  const all=$('esReviewChanges');if(all){all.classList.toggle('hidden',!(s.conflicts||[]).length);all.textContent='Review '+(s.conflicts||[]).length+' changed field(s)';}
  const sign=$('esSignConflicts');if(sign)sign.classList.toggle('hidden',!(s.conflicts||[]).some(c=>c.name===esSignature?.name||c.name==='BAR routing'));
}
function es14OpenConflicts(name=''){
  const s=esSession,list=(s?.conflicts||[]).filter(c=>!name||c.name===name||c.name==='BAR routing');if(!list.length)return;
  const host=$('esConflictBody');host.replaceChildren();
  for(const c of list){
    const el=document.createElement('div');el.className='es-conflict-item';
    const title=document.createElement('b');title.textContent=c.name+' · '+(ES_COLUMNS.find(x=>x[0]===c.field)?.[1]||c.field);el.appendChild(title);
    const info=document.createElement('p');info.textContent='This device: '+String(c.local)+'   |   Latest shared: '+String(c.remote);el.appendChild(info);
    for(const [choice,label]of [['remote','Use latest'],['local','Keep this device']]){
      const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=async()=>{try{await es14Resolve(c,choice);el.remove();if(!host.children.length)$('esConflictModal').classList.add('hidden');}catch(e){es14HandleError(e);}};el.appendChild(b);
    }host.appendChild(el);
  }
  $('esConflictModal').classList.remove('hidden');
}
async function es14Resolve(c,choice){
  const s=esSession;if(!s||s.busy)return;
  if(c.origin==='report'){
    esSetBusy(true);
    try{await es14ResolveReport(s,c,choice);es14Schedule(s);return;}
    finally{esSetBusy(false);es14Paint(true);}
  }
  if(c.name==='BAR routing'){s.baseRouting[c.field]=c.remote;s.routing[c.field]=choice==='remote'?c.remote:c.local;}
  else{
    const row=s.rows.find(r=>r.name===c.name);let base=s.baseRows.find(r=>r.name===c.name);if(!row)return;
    if(c.field==='__removed'){
      if(choice==='remote'){s.rows=s.rows.filter(r=>r.name!==c.name);delete s.dirty[c.name];s.baseRows=s.baseRows.filter(r=>r.name!==c.name);}
      else{s.dirty[c.name]={__new:true};s.baseRows=s.baseRows.filter(r=>r.name!==c.name);}
    }else{
      if(!base){base=esDefaults(c.name,s.date);s.baseRows.push(base);}base[c.field]=c.remote;
      row[c.field]=choice==='remote'?c.remote:c.local;
      if(choice==='remote'){if(s.dirty[c.name]){delete s.dirty[c.name][c.field];if(!Object.keys(s.dirty[c.name]).length)delete s.dirty[c.name];}}
      else(s.dirty[c.name] ||= {})[c.field]=true;
      // Store this explicit comparison as the new baseline of a legacy report.
      // The next transaction re-checks remote again; a further edit still conflicts.
    }
  }
  es14RecordConflicts(s,(s.conflicts||[]).filter(x=>x.name!==c.name||x.field!==c.field));
  esRecalculate();es14Paint(true);esRenderRouting();esPersistLocal();es14Schedule(s);
}
async function es14ResolveReport(s,c,choice){
  if(!es14AllowedSession(s)||!es14IsOnline())throw new Error('Reconnect before resolving shared changes. Your input is kept.');
  if(s.autoPromise)await s.autoPromise;
  const ref=doc(db,'hourlyV1Batches',s.date),reportRef=doc(db,'hourlyReports',c.reportId);
  const chosen=choice==='remote'?c.remote:c.local;
  const out=await runTransaction(db,async tx=>{
    const bs=await tx.get(ref),rs=await tx.get(reportRef);
    if(!es14AllowedSession(s)||!bs.exists()||!rs.exists())throw new Error('This record changed. Review the latest shared values.');
    const report={...rs.data(),id:reportRef.id},raw=bs.data();
    if(!hourlyReportBelongsTo(report,c.name,s.date)||esFingerprint(report)!==c.reportFingerprint)throw new Error('The report changed again. Review the latest values; nothing was overwritten.');
    const reports=[report,...s.reports.filter(r=>r.id!==report.id)],remote=es14Remote(raw,reports,s.date,s);
    const row=remote.rows.find(r=>r.name===c.name),current=remote.conflicts.find(x=>x.name===c.name&&x.field===c.field&&x.origin==='report');
    if(!row||!current||!es14Same(c.field,current.local,c.local)||!es14Same(c.field,current.remote,c.remote))throw new Error('The shared field changed again. Review the latest values; nothing was overwritten.');
    row[c.field]=chosen;
    const batch=esBuildBatch(remote.batch,remote.rows,s.date,remote.routing),d=batch.drafts[c.name];
    const baseline=d.employeeSheetFinalRow||s.reportBases?.[report.id]?.row||es14ReportRow(report,row);
    d.employeeSheetFinalRow={...esClone(baseline),[c.field]:c.remote};
    d.employeeSheetFinalFingerprint ||= s.reportBases?.[report.id]?.fingerprint||c.reportFingerprint;
    batch.employeeSheetRevision=Number(raw.employeeSheetRevision||0)+1;
    tx.set(ref,{...raw,date:s.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},employeeSheetRevision:batch.employeeSheetRevision,updatedAt:serverTimestamp(),updatedByUid:s.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
    return {batch,reports,row:esClone(row),routing:remote.routing};
  });
  if(esSession===s&&es14AllowedSession(s)){
    const local=s.rows.find(r=>r.name===c.name);
    if(local&&es14Same(c.field,local[c.field],c.local))local[c.field]=chosen;
    es14AcceptCommit(s,out.batch,out.reports,{rows:[out.row],fields:{[c.name]:{[c.field]:true}},routing:out.routing});
    es14RecordConflicts(s,(s.conflicts||[]).filter(x=>x.name!==c.name||x.field!==c.field));
  }
}
function es14Install(){
  if(!$('employeeSheet')||$('esConflictModal'))return;
  const modal=document.createElement('div');modal.id='esConflictModal';modal.className='es-modal hidden';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','Review changed fields');
  modal.innerHTML='<div class="es-sign-card"><h3>Review changes</h3><p>Only the fields changed on both devices need a choice. Other employees are not blocked.</p><div id="esConflictBody"></div><button type="button" id="esConflictClose">Back to sheet</button></div>';
  $('employeeSheet').appendChild(modal);$('esConflictClose').onclick=()=>modal.classList.add('hidden');
  const review=document.createElement('button');review.id='esReviewChanges';review.type='button';review.className='hidden';review.onclick=()=>es14OpenConflicts();$('esToolActions').appendChild(review);
  const final=document.createElement('button');final.id='esOpenFinal';final.type='button';final.textContent='Final Report';final.onclick=()=>window.fzOpenFinalReport('daily',esSession?.date);$('esToolActions').appendChild(final);
  const signReview=document.createElement('button');signReview.id='esSignReview';signReview.type='button';signReview.className='hidden';signReview.textContent='Review latest amount & re-sign';signReview.onclick=async()=>{
    if(!esSignature||esSession?.busy)return;const name=esSignature.name;esSignature=null;
    if(esReadCurrent(esRead))esApplyRead(esRead);esRecalculate();window.employeeSheetSign(name);signReview.classList.add('hidden');
  };$('esSignStatus').insertAdjacentElement('afterend',signReview);
  const signConflict=document.createElement('button');signConflict.id='esSignConflicts';signConflict.type='button';signConflict.className='hidden';signConflict.textContent='Review changes';signConflict.onclick=()=>es14OpenConflicts(esSignature?.name);signReview.insertAdjacentElement('afterend',signConflict);
  esEnsureSyncUI();
  $('esSyncDraft').textContent='Sync now';$('esSyncDraft').title='Changes sync automatically. Retry now if connection was interrupted.';
  $('employeeSheet').addEventListener('focusout',()=>setTimeout(()=>{es14Paint();es14Schedule();},60));
}
(function(){
  const init=esInit,persist=esPersistLocal,badge=esCompactReadBadge,stop=esStopRead,setRead=esSetReadStatus,sign=window.employeeSheetSign;
  esInit=function(...a){const out=init(...a);es14Install();return out;};
  esPersistLocal=function(...a){const out=persist(...a);es14Schedule();return out;};
  esStopRead=function(){
    const s=esRead?.session||esSession;if(s){clearTimeout(s.autoTimer);if(!s.busy&&s.cloudReady&&es14AllowedSession(s)&&es14HasPublishable(s))void es14AutoFlush(s);}
    stop();
  };
  esSetReadStatus=function(c){setRead(c);esCompactReadBadge();if(c.session.cloudReady)es14Schedule(c.session);};
  esCompactReadBadge=function(){badge();const s=esSession,b=$('esReadBadge');if(!s||!b)return;const conflicts=(s.conflicts||[]).length;
    const text=!es14IsOnline()?'Offline · device draft':s.autoWriting?'Syncing…':conflicts?'Review changes':s.autoError?'Retry sync':s.cloudReady?(esHasEdits(s)?'Pending edits':'Auto-sync · Live'):'Checking…';
    b.textContent=ES_BUILD+' · '+text;b.dataset.state=conflicts||s.autoError?'error':s.autoWriting?'draft':s.cloudReady?'ready':'waiting';
    const cloud=$('esCloudStatus');if(cloud&&s.cloudReady)cloud.textContent='Edits auto-sync. Save / Sign updates Final Report.';
  };
  window.employeeSheetSign=function(name){sign(name);$('esSignReview')?.classList.add('hidden');es14ConflictUI();};
})();
window.addEventListener('online',()=>es14Schedule(esSession,100));
window.addEventListener('offline',()=>esCompactReadBadge());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&esAllowed()&&document.body.classList.contains('es-active')){if(!esRead)esStartRead(esSession);else if(esReadCurrent(esRead))esFastQueueRead(esRead);es14Schedule(esSession,100);}});

/* Final Report — one Manager/Owner page, original Daily/Monthly renderers and
 * PDF/XLS math reused. The two original DOM trees are moved, never duplicated.
 */
let frState={open:false,mode:'daily',rows:[],key:'',verified:false,unsub:null,token:0,rendering:false};
function frAllowed(){return esAllowed();}
function frStop(){if(frState.unsub)frState.unsub();frState.unsub=null;frState.verified=false;++frState.token;}
function frExit(){frState.open=false;frStop();$('finalReportHub')?.classList.add('hidden');document.body.classList.remove('fz-final-report');}
function frRange(){return frState.mode==='daily'?{from:$('smallReportDate')?.value||'',to:$('smallReportDate')?.value||'',employee:$('smallReportEmployee')?.value||''}:monthlyReportRange();}
function frKey(){const r=frRange();return frState.mode+'|'+r.from+'|'+r.to;}
function frInit(){
  if($('finalReportHub'))return;
  initMonthlyReportUi();const parent=$('staffApp'),daily=$('smallReport'),monthly=$('monthlyReport');if(!parent||!daily||!monthly)return;
  const hub=document.createElement('section');hub.id='finalReportHub';hub.className='staffPanel hidden';
  hub.innerHTML='<div class="fr-header"><button type="button" id="frHome">‹ Home</button><h2>Final Report</h2><button type="button" id="frSheet">Employee Sheet</button></div><div class="fr-tabs" role="tablist" aria-label="Final Report type"><button type="button" id="frDailyTab" role="tab" aria-controls="frDailyPane">Daily</button><button type="button" id="frMonthlyTab" role="tab" aria-controls="frMonthlyPane">Monthly / Period</button></div><div class="fr-live-line"><span id="frSyncStatus" role="status" aria-live="polite"></span><button id="frRetry" type="button" class="hidden">Retry</button></div><div id="frDailyPane" class="fr-pane" role="tabpanel"></div><div id="frMonthlyPane" class="fr-pane hidden" role="tabpanel"></div>';
  parent.appendChild(hub);$('frDailyPane').appendChild(daily);$('frMonthlyPane').appendChild(monthly);
  $('frHome').onclick=()=>{frExit();window.fzOpenRoleHome();};$('frSheet').onclick=()=>{const date=$('smallReportDate')?.value;frExit();window.employeeSheetOpen(date);};
  $('frDailyTab').onclick=()=>frSelect('daily');$('frMonthlyTab').onclick=()=>frSelect('monthly');$('frRetry').onclick=()=>frSubscribe(true);
  hub.addEventListener('change',e=>{if(['smallReportDate','monthlyReportFrom','monthlyReportTo'].includes(e.target.id))frSubscribe();});
  const menu=document.querySelector('[data-stab="monthlyReport"]');if(menu)menu.innerHTML='<span>Final Report</span>';
}
function frSelect(mode){
  frState.mode=mode==='monthly'?'monthly':'daily';const daily=frState.mode==='daily';
  $('frDailyPane').classList.toggle('hidden',!daily);$('frMonthlyPane').classList.toggle('hidden',daily);
  $('smallReport').classList.remove('hidden');$('monthlyReport').classList.remove('hidden');
  for(const [id,on]of [['frDailyTab',daily],['frMonthlyTab',!daily]]){$(id).classList.toggle('on',on);$(id).setAttribute('aria-selected',String(on));}
  frSubscribe();frRenderIfOpen();
}
function frControls(){
  const hub=$('finalReportHub');if(!hub)return;
  for(const b of hub.querySelectorAll('button[onclick]')){
    if(/download|share|print/i.test(b.getAttribute('onclick')||''))b.disabled=!frState.verified;
  }
}
function frSubscribe(force=false){
  if(!frState.open||!frAllowed())return;
  const range=frRange(),key=frKey();if(!force&&key===frState.key&&frState.unsub)return;
  frStop();frState.key=key;frState.rows=[];frState.verified=false;const token=frState.token,uid=currentUser.uid;
  $('frRetry').classList.add('hidden');$('frSyncStatus').textContent='Loading saved reports…';frControls();
  if(range.from&&range.to&&range.from>range.to){$('frSyncStatus').textContent='Start date must be on or before end date.';frRenderIfOpen();return;}
  const filters=[];
  if(range.from&&range.from===range.to)filters.push(where('date','==',range.from));
  else{if(range.from)filters.push(where('date','>=',range.from));if(range.to)filters.push(where('date','<=',range.to));}
  const q=query(collection(db,'hourlyReports'),...filters);
  frState.unsub=onSnapshot(q,{includeMetadataChanges:true},snap=>{
    if(!frState.open||token!==frState.token||!frAllowed()||currentUser.uid!==uid)return;
    frState.rows=snap.docs.map(d=>({id:d.id,...d.data()}));frState.verified=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
    const ids=new Set(frState.rows.map(r=>r.id));latestHourlyReports=[...frState.rows,...latestHourlyReports.filter(r=>!ids.has(r.id))];
    $('frSyncStatus').textContent=frState.verified?'Live · '+frState.rows.length+' saved report(s)':'Checking cloud · cached reports shown';
    $('frRetry').classList.add('hidden');frRenderIfOpen();frControls();
  },error=>{
    if(token!==frState.token||!frState.open)return;frState.verified=false;
    $('frSyncStatus').textContent='Reports could not sync: '+(error.message||String(error))+'. Your saved data has not been deleted.';$('frRetry').classList.remove('hidden');frControls();
  });
}
function frRenderIfOpen(){
  if(!frState.open||!frAllowed()||frState.rendering)return;
  frState.rendering=true;
  try{if(frState.mode==='daily'){populateSmallReportEmployeeFilter();window.renderSmallReport();}else{monthlyReportPopulateEmployee();window.renderMonthlyReport();}frControls();}
  finally{frState.rendering=false;}
}
window.fzOpenFinalReport=function(mode='daily',date=''){
  if(!frAllowed())return;
  esPersistLocal();if(esSession?.ready&&!esSession.busy)void es14AutoFlush(esSession);
  esStopRead();frInit();if(!$('finalReportHub'))return;
  document.body.classList.remove('es-active','hourly-v1-mode','hourly-v1-editing','hourly-v1-small-report','hourly-workspace-mode','small-report-fullscreen');document.documentElement.classList.remove('small-report-fullscreen');
  $('employeeSheet')?.classList.add('hidden');$('fzRoleHome')?.classList.add('hidden');$('staffApp')?.classList.remove('hidden');$('employeeApp')?.classList.add('hidden');$('hourlyV1Workspace')?.classList.add('hidden');
  document.querySelectorAll('.staffPanel').forEach(x=>x.classList.add('hidden'));
  $('finalReportHub').classList.remove('hidden');document.body.classList.add('fz-final-report');frState.open=true;
  if(esDateValid(date))$('smallReportDate').value=date;else if(!$('smallReportDate').value)$('smallReportDate').value=esSession?.date||todayLocal();
  frSelect(mode);window.scrollTo({top:0,left:0,behavior:'instant'});
};
(function(){
  const daily=smallReportFilteredRows,monthly=monthlyReportFilteredReports,renderDaily=window.renderSmallReport,renderMonthly=window.renderMonthlyReport,openSheet=window.employeeSheetOpen;
  smallReportFilteredRows=function(){
    if(!frState.open||frState.mode!=='daily')return daily();
    const {from,employee}=frRange();return [...frState.rows].filter(r=>(!from||r.date===from)&&(!employee||r.employee===employee)).sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(a.employee).localeCompare(String(b.employee)));
  };
  monthlyReportFilteredReports=function(){
    if(!frState.open||frState.mode!=='monthly')return monthly();
    const {from,to,employee}=monthlyReportRange();return frState.rows.filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)&&(!employee||r.employee===employee));
  };
  window.renderSmallReport=function(...a){const out=renderDaily(...a);if(frState.open){if(!frState.rendering)frSubscribe();frControls();}return out;};
  window.renderMonthlyReport=function(...a){const out=renderMonthly(...a);if(frState.open){if(!frState.rendering)frSubscribe();frControls();}return out;};
  window.fzOpenMonthlyReport=()=>window.fzOpenFinalReport('monthly');
  window.hv1OpenSmallReport=()=>window.fzOpenFinalReport('daily',hv1DateValue());
  window.employeeSheetOpen=function(...a){frExit();return openSheet(...a);};
  // Existing Home, new-entry and other workspaces remain available.
  for(const name of ['fzOpenRoleHome','fzOpenManagerTools','fzOpenHostCashier','fzOpenTipCalculation','newHourlyEntryFromSmallReport']){
    const original=window[name];if(typeof original==='function')window[name]=function(...a){frExit();return original(...a);};
  }
})();
document.addEventListener('click',event=>{
  const b=event.target.closest?.('[data-stab="monthlyReport"]');if(b&&frAllowed()){event.preventDefault();event.stopImmediatePropagation();window.fzOpenFinalReport('monthly');}
},true);
try{onAuthStateChanged(auth,user=>{if(!user||!frAllowed())frExit();});}catch(e){}

/* ES1.5 — Today's Team, roster management and Host/Cashier Sheet.
 * Existing Server/Bartender calculators are reused. The Host/Cashier split
 * delegates to the original module's exact whole-cent allocator.
 * Directory edits change labels/defaults only; canonical identities and old
 * reports are never renamed/deleted. Team and host membership commit atomically.
 */
const TT15_ROLES=['Server','Bartender','Host','Cashier','Host / Cashier'];
const TT15_HOST_SHIFTS=['AM','PM','DOUBLE',SHIFT_EARLY,SHIFT_MIDDLE];
const TT15_POOLS=['cashAM','creditAM','cashPM','creditPM'];
let tt15State=null,tt15Token=0,tt15Directory={uid:'',data:{},ready:false,unsub:null};
let hc15Session=null,hc15Sig=null,hc15Credit=null;
const tt15Clean=v=>String(v??'').trim().replace(/\s+/g,' ');
const tt15Host=role=>['Host','Cashier','Host / Cashier'].includes(role);
const tt15Key=name=>Array.from(new TextEncoder().encode(tt15Clean(name).toLowerCase()),b=>b.toString(16).padStart(2,'0')).join('');
const tt15Copy=esClone;
const tt15Stamp=()=>({updatedAt:serverTimestamp(),updatedByUid:currentUser?.uid||'',updatedBy:currentProfile?.displayName||currentProfile?.username||''});
const tt15Same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
function tt15IsHostReport(r){return r?.reportKind==='host_cashier'||r?.hostCashierReport===true;}
function tt15Require(uid=currentUser?.uid){if(!esAllowed()||currentUser.uid!==uid)throw new Error('Manager / Owner login required. Nothing was saved.');if(navigator.onLine===false)throw new Error('Offline. Your edits are kept. Reconnect before saving.');}
function tt15NameValid(name){return !!name&&name.length<=100&&!/[\u0000-\u001f\u007f]/.test(name)&&!['__proto__','constructor','prototype'].includes(name.toLowerCase());}
function tt15DirectoryEntries(data=tt15Directory.data){
  const map=new Map();
  for(const name of getEmployeeRoster())map.set(tt15Key(name),{name,displayName:name,defaultRole:esFixedRole(name)||'Server',active:true,revision:0,phone:''});
  for(const name of window.FZHostCashierMath?.names||[]){const k=tt15Key(name),old=map.get(k);map.set(k,{...(old||{}),name,displayName:name,defaultRole:esFixedRole(name)||'Host / Cashier',active:true,revision:0,phone:''});}
  for(const item of Object.values(data?.entries||{})){
    const name=tt15Clean(item?.name);if(!tt15NameValid(name))continue;const k=tt15Key(name);
    map.set(k,{...(map.get(k)||{}),name,displayName:name,defaultRole:esFixedRole(name)||'Host / Cashier',active:item.active!==false,phone:String(item.phone||''),revision:0});
  }
  for(const [k,item] of Object.entries(data?.directoryEntries||{})){
    if(!tt15NameValid(item?.name)||k!==tt15Key(item.name))continue;
    map.set(k,{...(map.get(k)||{}),...item,displayName:tt15Clean(item.displayName)||item.name,active:item.active!==false});
  }
  return [...map.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName));
}
function tt15Label(name){return tt15DirectoryEntries().find(e=>e.name===name)?.displayName||name;}
function tt15DirectoryStart(){
  if(!esAllowed())return;
  const uid=currentUser.uid;if(tt15Directory.uid===uid&&tt15Directory.unsub)return;
  tt15Directory.unsub?.();tt15Directory={uid,data:{},ready:false,unsub:null};
  tt15Directory.unsub=onSnapshot(doc(db,'hostCashierTipReports','employee-roster'),{includeMetadataChanges:true},snap=>{
    if(!esAllowed()||currentUser.uid!==uid||tt15Directory.uid!==uid)return;
    tt15Directory.data=snap.exists()?snap.data():{};
    tt15Directory.ready=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
    tt15DirectoryPaint();tt15PaintNames();hc15UpdateValues();if(tt15State?.open&&!tt15State.editing)tt15Render();
  },e=>{tt15Directory.ready=false;tt15Message('Employee list could not sync: '+(e.message||e),true);tt15DirectoryPaint();});
}
function tt15TeamRows(batch={},host={}){
  const rows=[];
  for(const name of batch.team||[]){const v=batch.drafts?.[name]?.values||{};rows.push({name,role:esFixedRole(name)||(['Server','Bartender'].includes(v.hPosition)?v.hPosition:'Server'),shift:v.hShift||''});}
  const am=new Set((host.employeesAM||[]).filter(Boolean)),pm=new Set((host.employeesPM||[]).filter(Boolean));
  for(const name of new Set([...am,...pm])){
    const original=host.team?.[name]?.shift;
    const shift=am.has(name)&&pm.has(name)?'DOUBLE':am.has(name)&&[SHIFT_EARLY,SHIFT_MIDDLE].includes(original)?original:am.has(name)?'AM':'PM';
    const role=host.staffDetails?.[name]?.role||host.team?.[name]?.position||'Host / Cashier';
    rows.push({name,role:tt15Host(role)?role:'Host / Cashier',shift});
  }
  return rows;
}
function tt15HostMembership(rows){
  const hosts=rows.filter(r=>tt15Host(r.role));
  const am=hosts.filter(r=>['AM','DOUBLE',SHIFT_EARLY,SHIFT_MIDDLE].includes(r.shift)).map(r=>r.name);
  const pm=hosts.filter(r=>['PM','DOUBLE'].includes(r.shift)).map(r=>r.name);
  if(am.length>7||pm.length>7)throw new Error('Host / Cashier: maximum 7 employees per AM or PM, matching the existing split.');
  return {hosts,am,pm};
}
function tt15TeamValidate(rows,directory){
  const seen=new Set();for(const r of rows){
    if(!tt15NameValid(r.name))throw new Error('Select a valid employee for every row.');
    const key=tt15Key(r.name);if(seen.has(key))throw new Error(tt15Label(r.name)+' is listed twice. Use the existing separate work profiles for two positions.');seen.add(key);
    if(!TT15_ROLES.includes(r.role))throw new Error('Choose a position for '+tt15Label(r.name)+'.');
    if(!(tt15Host(r.role)?TT15_HOST_SHIFTS:TIP_SHIFTS).includes(r.shift))throw new Error('Choose a supported shift for '+tt15Label(r.name)+'.');
    const fixed=esFixedRole(r.name);if(fixed&&fixed!==r.role)throw new Error(r.name+' is a '+fixed+' work profile. Choose the matching profile.');
  }
  tt15HostMembership(rows);return true;
}
function tt15MergeTeam(base,edited,remote){
  const result=tt15Copy(remote),conflicts=[];
  for(const old of base){
    const local=edited.find(r=>r.name===old.name),current=result.find(r=>r.name===old.name);
    if(!local){if(current&&!tt15Same(current,old))conflicts.push(old.name);else if(current)result.splice(result.indexOf(current),1);continue;}
    if(!current){if(!tt15Same(local,old))conflicts.push(old.name);continue;}
    for(const f of ['role','shift'])if(local[f]!==old[f]){if(current[f]!==old[f]&&current[f]!==local[f])conflicts.push(old.name);else current[f]=local[f];}
  }
  for(const row of edited)if(!base.some(r=>r.name===row.name)){
    const current=result.find(r=>r.name===row.name);if(current&&!tt15Same(current,row))conflicts.push(row.name);else if(!current)result.push(tt15Copy(row));
  }
  if(conflicts.length){const e=new Error('Another device changed '+[...new Set(conflicts)].join(', ')+'. Review the latest team before updating. Your edits are kept.');e.teamConflict=true;throw e;}
  return result;
}
function tt15BuildTeam(raw,host,rows,date){
  const batch=tt15Copy(raw||{});batch.date=date;batch.drafts ||= {};hv1EnsureBarState(batch);
  const servers=rows.filter(r=>!tt15Host(r.role)),removed=new Set(batch.todayTeamRemoved||[]);
  for(const name of batch.team||[])if(!servers.some(r=>r.name===name))removed.add(name);
  const resultRows=esRowsFromBatch({...batch,team:servers.map(r=>r.name)},[],date);
  for(const input of servers){
    const row=resultRows.find(r=>r.name===input.name);const old=tt15Copy(row);
    row.role=input.role;row.shift=input.shift;
    if(input.shift!==old.shift){
      if(!['AM','DOUBLE',SHIFT_EARLY].includes(row.shift)&&row.role==='Server')row.totalAM='';
      if(!['AM','DOUBLE','LONG',SHIFT_MIDDLE].includes(row.shift))row.total24='';
      if(row.shift==='DOUBLE'&&old.shift!=='DOUBLE'){row.clockIn2='';row.clockOut2='';}
      if(isShortShift(row.shift)){const [a,b]=shortShiftTimes(row.shift);row.clockIn ||= a;row.clockOut ||= b;}
    }
    if(row.role!==old.role){row.barAM=row.bar24=row.barPM=row.role==='Server';}
    removed.delete(input.name);
  }
  const route=esRouting(resultRows,Object.fromEntries(ES_PERIODS.map(cp=>[cp,batch.bar[cp]?.bartender||''])));
  for(const row of resultRows)esLinkSales(row,'shift',route);
  const built=esBuildBatch(batch,resultRows,date,route);built.todayTeamRemoved=[...removed];built.todayTeamManaged=true;
  built.todayTeamRevision=Number(raw?.todayTeamRevision||0)+1;built.employeeSheetRevision=Number(raw?.employeeSheetRevision||0)+1;
  // Keep removed drafts/receipts; exclude their BAR sales from the active team.
  for(const cp of ES_PERIODS){const allowed=new Set(servers.filter(r=>r.role==='Server').map(r=>r.name));
    for(const name of Object.keys(built.bar[cp].entries||{}))if(!allowed.has(name))delete built.bar[cp].entries[name];
  }
  hv1ApplyBarAutomation(built);
  const membership=tt15HostMembership(rows),hc=tt15Copy(host||{});hc.date=date;hc.team ||= {};hc.staffDetails ||= {};
  for(const name of Object.keys(hc.team))hc.team[name]={...hc.team[name],working:false};
  for(const row of membership.hosts){hc.team[row.name]={...(hc.team[row.name]||{}),working:true,shift:row.shift,position:row.role};hc.staffDetails[row.name]={...(hc.staffDetails[row.name]||{}),role:row.role};}
  hc.employeesAM=[...membership.am,...Array(7-membership.am.length).fill('')];hc.employeesPM=[...membership.pm,...Array(7-membership.pm.length).fill('')];
  hc.todayTeamRevision=Number(host?.todayTeamRevision||0)+1;hc.sheetRevision=Number(host?.sheetRevision||0)+1;
  for(const p of TT15_POOLS)if(hc[p]===undefined)hc[p]=0;
  hc.signatures ||= {AM:{},PM:{}};
  return {batch:built,host:hc};
}
function tt15Message(text,error=false){const el=$('tt15Status');if(el){el.textContent=text;el.dataset.error=error?'1':'0';}}
function tt15Close(){if(tt15State){tt15State.unsubs.forEach(u=>u());tt15State.unsubs=[];tt15State.open=false;}++tt15Token;$('todayTeamPage')?.classList.add('hidden');document.body.classList.remove('tt15-active');}
function tt15Init(){
  if($('todayTeamPage'))return;const parent=$('staffApp');if(!parent)return;
  const page=document.createElement('section');page.id='todayTeamPage';page.className='staffPanel tt15-page hidden';
  page.innerHTML=`<header class="tt15-header"><button type="button" id="tt15Home">‹ Home</button><h2>Today's Team</h2><button type="button" id="tt15Sheet">Sheet ›</button></header>
    <div class="tt15-toolbar"><label>Work date<input id="tt15Date" type="date"></label><button type="button" id="tt15Edit">Edit Team</button><button type="button" id="tt15Manage">Manage Employee</button></div>
    <div id="tt15Status" role="status" aria-live="polite"></div>
    <div class="tt15-team-grid"><table class="tt15-table"><thead><tr><th>Employee</th><th>Position</th><th>Shift</th><th></th></tr></thead><tbody id="tt15Rows"></tbody></table></div>
    <div class="tt15-actions"><button type="button" id="tt15AddRow">＋ Add row</button><button type="button" id="tt15Cancel">Cancel edits</button><button type="button" class="tt15-primary" id="tt15Update">Update Team</button></div>
    <p class="tt15-hint">Server / Bartender → upper sheet. Host / Cashier → lower sheet. Updating the team does not delete saved reports.</p>
    <div id="tt15DirectoryPanel" class="tt15-modal hidden" role="dialog" aria-modal="true" aria-labelledby="tt15DirectoryTitle"><div class="tt15-dialog"><header><h3 id="tt15DirectoryTitle">Manage Employee</h3><button type="button" id="tt15DirectoryClose" aria-label="Close manage employee">✕</button></header>
    <p class="tt15-hint">Team roster only. Login accounts stay in Users. Editing a display name keeps the original report identity.</p><div class="tt15-directory-toolbar"><input type="search" id="tt15DirectorySearch" placeholder="Find employee" aria-label="Find employee in directory"><button type="button" id="tt15New">＋ Add Employee</button></div>
    <div id="tt15DirectoryEdit" class="hidden"><label>Employee name / display name<input id="tt15EmployeeName" maxlength="100" autocomplete="off"></label><label>Default position<select id="tt15EmployeeRole">${TT15_ROLES.map(r=>esOption(r,r,'Server')).join('')}</select></label><label>Phone (optional)<input id="tt15EmployeePhone" type="tel" maxlength="40" autocomplete="off"></label><div class="tt15-actions"><button id="tt15EmployeeCancel" type="button">Cancel</button><button id="tt15EmployeeSave" type="button" class="tt15-primary">Save Employee</button></div></div>
    <label class="tt15-show-inactive"><input id="tt15ShowInactive" type="checkbox"> Show deleted / restore</label><div id="tt15DirectoryStatus" role="status"></div><div id="tt15DirectoryList"></div></div></div>`;
  parent.appendChild(page);
  $('tt15Home').onclick=()=>{if(!tt15MayLeave())return;tt15Close();window.fzOpenRoleHome();};
  $('tt15Sheet').onclick=()=>{if(!tt15MayLeave())return;const date=tt15State.date;tt15Close();window.employeeSheetOpen(date);};
  $('tt15Date').onchange=()=>{const value=$('tt15Date').value;if(tt15MayLeave())window.fzOpenTodayTeam(value);else $('tt15Date').value=tt15State.date;};
  $('tt15Edit').onclick=()=>{if(!tt15State?.ready||tt15State.busy)return;tt15State.editing=true;tt15Render();};
  $('tt15Cancel').onclick=()=>{if(tt15State?.busy)return;tt15State.rows=tt15Copy(tt15State.latestRows||tt15State.baseRows);tt15State.baseRows=tt15Copy(tt15State.rows);tt15State.editing=false;tt15Render();tt15Message('Latest shared team.');};
  $('tt15AddRow').onclick=()=>{if(tt15State?.editing&&!tt15State.busy){tt15State.rows.push({name:'',role:'Server',shift:'AM'});tt15Render();}};
  $('tt15Rows').addEventListener('change',e=>{const i=Number(e.target.dataset.ttIndex),key=e.target.dataset.ttField,s=tt15State;if(!key||!s?.editing||s.busy)return;const row=s.rows[i];if(!row)return;
    row[key]=e.target.value;
    if(key==='name'){const entry=tt15DirectoryEntries().find(x=>x.name===row.name);row.role=esFixedRole(row.name)||entry?.defaultRole||'Server';}
    if(tt15Host(row.role)&&!TT15_HOST_SHIFTS.includes(row.shift))row.shift='PM';
    tt15Render();
  });
  $('tt15Rows').addEventListener('click',e=>{const btn=e.target.closest('[data-tt-remove]');if(btn&&tt15State?.editing&&!tt15State.busy){tt15State.rows.splice(Number(btn.dataset.ttRemove),1);tt15Render();}});
  $('tt15Update').onclick=async()=>{const date=tt15State?.date;if(await tt15UpdateTeam())window.employeeSheetOpen(date);};$('tt15Manage').onclick=()=>{tt15DirectoryStart();$('tt15DirectoryPanel').classList.remove('hidden');tt15DirectoryPaint();};
  $('tt15DirectoryClose').onclick=()=>{if(tt15Directory.busy)return;$('tt15DirectoryPanel').classList.add('hidden');};
  $('tt15New').onclick=()=>tt15EditEmployee();$('tt15DirectorySearch').oninput=tt15DirectoryPaint;$('tt15ShowInactive').onchange=tt15DirectoryPaint;
  $('tt15EmployeeCancel').onclick=()=>{if(!tt15Directory.busy){tt15Directory.edit=null;$('tt15DirectoryEdit').classList.add('hidden');}};
  $('tt15EmployeeSave').onclick=()=>tt15SaveEmployee();
  $('tt15DirectoryList').onclick=e=>{const btn=e.target.closest('[data-dir-action]');if(!btn)return;const entry=tt15DirectoryEntries().find(x=>tt15Key(x.name)===btn.dataset.dirKey);if(!entry)return;if(btn.dataset.dirAction==='edit')tt15EditEmployee(entry);else tt15ToggleEmployee(entry);};
}
function tt15MayLeave(){const s=tt15State;if(s?.busy)return false;return !s?.editing||tt15Same(s.rows,s.baseRows)||confirm('Leave without applying team edits? Existing saved reports are kept.');}
function tt15Render(){
  const s=tt15State;if(!s||!$('tt15Rows'))return;
  const directory=tt15DirectoryEntries(),editable=s.ready&&s.editing&&!s.busy;
  $('tt15Date').value=s.date;$('tt15Date').disabled=!!s.busy;
  $('tt15Edit').disabled=!s.ready||s.editing||s.busy;$('tt15Update').disabled=!editable;$('tt15AddRow').disabled=!editable;$('tt15Cancel').disabled=!s.editing||s.busy;
  $('tt15Manage').disabled=!!s.busy;
  $('tt15Rows').innerHTML=s.rows.map((r,i)=>{
    const options=directory.filter(e=>e.active||e.name===r.name);if(r.name&&!options.some(e=>e.name===r.name))options.push({name:r.name,displayName:r.name,active:false});
    return `<tr><td><select data-tt-index="${i}" data-tt-field="name" aria-label="Employee ${i+1}"${!editable?' disabled':''}>${esOption('','Select employee',r.name)}${options.map(e=>esOption(e.name,e.displayName+(e.active?'':' (inactive)'),r.name)).join('')}</select></td><td><select data-tt-index="${i}" data-tt-field="role" aria-label="Position ${i+1}"${!editable||esFixedRole(r.name)?' disabled':''}>${TT15_ROLES.map(x=>esOption(x,x,r.role)).join('')}</select></td><td><select data-tt-index="${i}" data-tt-field="shift" aria-label="Shift ${i+1}"${!editable?' disabled':''}>${esOption('','Choose shift',r.shift)}${(tt15Host(r.role)?TT15_HOST_SHIFTS:TIP_SHIFTS).map(x=>esOption(x,x==='DOUBLE'?'Double':x==='LONG'?'Long':x,r.shift)).join('')}</select></td><td><button type="button" data-tt-remove="${i}" aria-label="Remove ${esc(r.name||'row')} from this team"${!editable?' disabled':''}>✕</button></td></tr>`;
  }).join('')||'<tr><td colspan="4">No team yet. Click Edit Team, then Add row.</td></tr>';
}
window.fzOpenTodayTeam=async function(date){
  if(!esAllowed())return;tt15Init();if(tt15State?.busy)return;
  const workdate=esDateValid(date)?date:esSession?.date||todayLocal();
  esPersistLocal();if(esSession?.ready&&esSession.cloudReady)await es14AutoFlush(esSession);
  esStopRead();hc15Stop();frExit();tt15Close();tt15DirectoryStart();
  document.querySelectorAll('.staffPanel').forEach(e=>e.classList.add('hidden'));$('fzRoleHome')?.classList.add('hidden');$('staffApp')?.classList.remove('hidden');$('hourlyV1Workspace')?.classList.add('hidden');
  document.body.classList.remove('es-active','fz-final-report','hourly-v1-mode','hourly-v1-editing','hourly-v1-small-report');document.body.classList.add('tt15-active');$('todayTeamPage').classList.remove('hidden');
  const token=++tt15Token,s={uid:currentUser.uid,date:workdate,open:true,ready:false,editing:false,busy:false,rows:[],baseRows:[],latestRows:[],batch:null,host:null,unsubs:[]};tt15State=s;
  tt15Message('Loading team…');tt15Render();
  const accept=(kind,snap)=>{if(tt15State!==s||token!==tt15Token||!esAllowed()||currentUser.uid!==s.uid)return;s[kind]=snap.exists()?snap.data():{};s[kind+'Ready']=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
    if(s.batch!==null&&s.host!==null){const rows=tt15TeamRows(s.batch,s.host);s.latestRows=tt15Copy(rows);s.ready=s.batchReady&&s.hostReady;
      if((!s.editing||tt15Same(s.rows,s.baseRows))&&!s.busy){const wasEmpty=!s.rows.length;s.rows=rows;s.baseRows=tt15Copy(rows);if(s.ready&&!rows.length)s.editing=true;else if(wasEmpty&&rows.length)s.editing=false;tt15Render();}
      if(!s.busy)tt15Message(s.ready?(s.editing?'Edit team, then Update Team.':'Live · '+rows.length+' employees'):'Checking cloud…');}
  };
  for(const [kind,col]of [['batch','hourlyV1Batches'],['host','hostCashierTipReports']])s.unsubs.push(onSnapshot(doc(db,col,workdate),{includeMetadataChanges:true},snap=>accept(kind,snap),e=>{if(tt15State===s){s.ready=false;tt15Message('Team could not sync: '+(e.message||e)+'. Reopen Today\'s Team to retry.',true);tt15Render();}}));
};
async function tt15UpdateTeam(){
  const s=tt15State;if(!s?.ready||!s.editing||s.busy)return false;
  try{tt15Require(s.uid);tt15TeamValidate(s.rows);if(!s.rows.length&&!confirm('Remove everyone from this date’s active team? Saved reports and archived drafts will remain.'))return false;}catch(e){tt15Message(e.message,true);return false;}
  const edited=tt15Copy(s.rows),base=tt15Copy(s.baseRows);s.busy=true;tt15Render();tt15Message('Updating both sections…');
  try{
    const result=await runTransaction(db,async tx=>{
      const ref=doc(db,'hourlyV1Batches',s.date),href=doc(db,'hostCashierTipReports',s.date),dref=doc(db,'hostCashierTipReports','employee-roster');
      const bs=await tx.get(ref),hs=await tx.get(href),ds=await tx.get(dref);tt15Require(s.uid);
      const raw=bs.exists()?bs.data():{},hc=hs.exists()?hs.data():{},dir=tt15DirectoryEntries(ds.exists()?ds.data():{}),remote=tt15TeamRows(raw,hc),rows=tt15MergeTeam(base,edited,remote);
      for(const r of rows)if(!remote.some(x=>x.name===r.name)&&!dir.some(e=>e.name===r.name&&e.active))throw new Error(r.name+' is not active in Manage Employee. Restore or add the employee first.');
      tt15TeamValidate(rows);const out=tt15BuildTeam(raw,hc,rows,s.date);
      tx.set(ref,{...out.batch,...tt15Stamp()});tx.set(href,{...out.host,...tt15Stamp()});return {...out,rows};
    });
    if(tt15State===s){s.batch=result.batch;s.host=result.host;s.rows=tt15Copy(result.rows);s.baseRows=tt15Copy(result.rows);s.latestRows=tt15Copy(result.rows);s.editing=false;tt15Message('Team updated · Employee Sheet is ready.');}
    return true;
  }catch(e){tt15Message(e.message||String(e),true);return false;}
  finally{if(tt15State===s){s.busy=false;tt15Render();}}
}
function tt15DirectoryPaint(){
  const host=$('tt15DirectoryList');if(!host)return;
  const q=($('tt15DirectorySearch')?.value||'').toLowerCase(),inactive=$('tt15ShowInactive')?.checked;
  host.innerHTML=tt15DirectoryEntries().filter(e=>(inactive||e.active)&&(e.displayName+' '+e.name).toLowerCase().includes(q)).map(e=>`<div class="tt15-person"><div><b>${esc(e.displayName)}</b><small>${esc(e.defaultRole||'Server')}${!e.active?' · Deleted from active list':''}</small></div><button type="button" data-dir-action="edit" data-dir-key="${tt15Key(e.name)}"${!tt15Directory.ready||tt15Directory.busy?' disabled':''}>Edit</button><button type="button" data-dir-action="toggle" data-dir-key="${tt15Key(e.name)}"${!tt15Directory.ready||tt15Directory.busy?' disabled':''}>${e.active?'Delete':'Restore'}</button></div>`).join('')||'<p>No matching employees.</p>';
  $('tt15New').disabled=!tt15Directory.ready||!!tt15Directory.busy;$('tt15EmployeeSave').disabled=!tt15Directory.ready||!!tt15Directory.busy;
}
function tt15EditEmployee(entry=null){
  if(!tt15Directory.ready||tt15Directory.busy)return;
  tt15Directory.edit=entry?tt15Copy(entry):{name:'',revision:0,active:true};
  $('tt15EmployeeName').value=entry?.displayName||'';$('tt15EmployeeRole').value=entry?.defaultRole||'Server';$('tt15EmployeeRole').disabled=!!esFixedRole(entry?.name||'');$('tt15EmployeePhone').value=entry?.phone||'';
  $('tt15DirectoryEdit').classList.remove('hidden');$('tt15DirectoryStatus').textContent='';$('tt15EmployeeName').focus();
}
async function tt15WriteEmployee(original,changes){
  const uid=currentUser?.uid;tt15Require(uid);
  const label=tt15Clean(changes.displayName),name=original.name||label;
  if(!tt15NameValid(label)||!tt15NameValid(name))throw new Error('Enter a valid employee name (1–100 characters).');
  if(!TT15_ROLES.includes(changes.defaultRole))throw new Error('Choose a default position.');
  const fixed=esFixedRole(name);if(fixed&&changes.defaultRole!==fixed)throw new Error('This work profile must remain '+fixed+'.');
  const key=tt15Key(name),ref=doc(db,'hostCashierTipReports','employee-roster');
  return runTransaction(db,async tx=>{
    const snap=await tx.get(ref);tt15Require(uid);const raw=snap.exists()?snap.data():{},entries=tt15DirectoryEntries(raw),current=entries.find(e=>tt15Key(e.name)===key);
    if(!original.name&&current)throw new Error('That employee already exists. Use Edit or Restore instead.');
    if(original.name&&Number(current?.revision||0)!==Number(original.revision||0))throw new Error('This employee was edited on another device. Close the editor and choose Edit again.');
    if(entries.some(e=>e.active&&tt15Key(e.name)!==key&&tt15Key(e.displayName)===tt15Key(label)))throw new Error('Another active employee already uses that display name.');
    const value={name,displayName:label,defaultRole:changes.defaultRole,phone:String(changes.phone||'').slice(0,40),active:changes.active!==false,revision:Number(current?.revision||0)+1};
    // Legacy HC membership list gets only HC employees. Server accounts are not
    // injected into the Host/Cashier dropdown. Neither auth nor old reports move.
    const legacy={...(raw.entries||{})};
    if(tt15Host(value.defaultRole)||legacy[key])legacy[key]={name,phone:value.phone,active:value.active&&tt15Host(value.defaultRole)};
    const data={...raw,kind:raw.kind||'host_cashier_roster',entries:legacy,directoryEntries:{...(raw.directoryEntries||{}),[key]:value},...tt15Stamp()};
    tx.set(ref,data);return {data,value};
  });
}
async function tt15SaveEmployee(){
  const edit=tt15Directory.edit;if(!edit||tt15Directory.busy||!tt15Directory.ready)return false;
  tt15Directory.busy=true;tt15DirectoryPaint();
  try{const out=await tt15WriteEmployee(edit,{displayName:$('tt15EmployeeName').value,defaultRole:$('tt15EmployeeRole').value,phone:$('tt15EmployeePhone').value,active:edit.active});
    tt15Directory.data=out.data;tt15Directory.edit=null;$('tt15DirectoryEdit').classList.add('hidden');$('tt15DirectoryStatus').textContent='Employee saved. Available in Today’s Team.';tt15PaintNames();if(tt15State?.open)tt15Render();return true;
  }catch(e){$('tt15DirectoryStatus').textContent=e.message||String(e);return false;}
  finally{tt15Directory.busy=false;tt15DirectoryPaint();}
}
async function tt15ToggleEmployee(entry){
  if(tt15Directory.busy||!tt15Directory.ready)return false;
  if(entry.active&&!confirm('Delete '+entry.displayName+' from the active employee list? Saved reports, signatures and existing teams stay unchanged. Login access is managed separately in Users.'))return false;
  tt15Directory.busy=true;tt15DirectoryPaint();
  try{const out=await tt15WriteEmployee(entry,{...entry,active:!entry.active});tt15Directory.data=out.data;$('tt15DirectoryStatus').textContent=out.value.active?'Employee restored.':'Deleted from active list. Existing reports and today’s team are unchanged.';return true;}
  catch(e){$('tt15DirectoryStatus').textContent=e.message||String(e);return false;}
  finally{tt15Directory.busy=false;tt15DirectoryPaint();if(tt15State?.open)tt15Render();}
}
function tt15PaintNames(){
  if(!esSession?.ready)return;const q=String($('esSearch')?.value||'').toLowerCase();
  document.querySelectorAll('#esRows tr[data-es-index]').forEach(tr=>{const row=esSession.rows[Number(tr.dataset.esIndex)];if(!row)return;const label=tt15Label(row.name),b=tr.querySelector('.es-name>b');if(b)b.textContent=label;tr.hidden=!!q&&!(label+' '+row.name).toLowerCase().includes(q);});
}

/* Host/Cashier: independent draft/pool document, separate from BAR/Busser. */
function hc15Math(data){
  const math=window.FZHostCashierMath;if(!math)throw new Error('Host / Cashier calculator is still loading. Please retry shortly.');
  return math.calculate(data);
}
function hc15Member(data,name){return tt15TeamRows({},data).find(r=>r.name===name)||null;}
function hc15Field(name,field){return JSON.stringify([name||'',field]);}
function hc15Get(data,key){const [name,field]=JSON.parse(key);return name?String(data.staffDetails?.[name]?.[field]??''):field.startsWith('creditAccounts')?(data[field]||[]):String(data[field]??0);}
function hc15Put(data,key,value){const [name,field]=JSON.parse(key);if(name){data.staffDetails ||= {};data.staffDetails[name] ||= {};data.staffDetails[name][field]=value;}else{data[field]=field.startsWith('creditAccounts')?tt15Copy(value):(es14MoneyValid(value)?Number(value)||0:String(value));if(field==='creditAM'||field==='creditPM')data['creditAccounts'+field.slice(-2)]=[{label:'Sheet total',amount:Number(value)||0}];}}
function hc15Equal(key,a,b){const [name,field]=JSON.parse(key);return name?String(a??'')===String(b??''):field.startsWith('creditAccounts')?tt15Same(a,b):es14MoneyText(a)===es14MoneyText(b);}
function hc15Valid(key,value){const [name,field]=JSON.parse(key);if(name)return value===''||/^([01]\d|2[0-3]):[0-5]\d$/.test(value);if(field.startsWith('creditAccounts'))return Array.isArray(value)&&value.length<=50&&value.every(r=>es14MoneyValid(r.amount)&&String(r.label||'').length<=80);return es14MoneyValid(value);}
function hc15View(s=hc15Session){const data=tt15Copy(s?.data||{});for(const [key,e]of Object.entries(s?.edits||{}))hc15Put(data,key,e.local);return data;}
function hc15LocalKey(s){return 'fz_hc15_draft_'+s.uid+'_'+s.date;}
function hc15KeepLocal(s=hc15Session){if(!s)return false;try{if(Object.keys(s.edits).length||Object.keys(s.draftSaves||{}).length)localStorage.setItem(hc15LocalKey(s),JSON.stringify({data:s.data,edits:s.edits,draftSaves:s.draftSaves||{},savedAt:Date.now()}));else localStorage.removeItem(hc15LocalKey(s));return true;}catch(e){return false;}}
function hc15Accept(s,data,verified=true){
  if(s!==hc15Session||!esAllowed()||currentUser.uid!==s.uid)return;
  if(Number(data.sheetRevision||0)<Number(s.data?.sheetRevision||0)&&verified)return;
  s.data=tt15Copy(data);s.verified=verified;s.conflicts=[];
  for(const [key,e]of Object.entries(s.edits)){
    if(JSON.parse(key)[0])continue; // Retain legacy clock draft; not a payout conflict.
    const remote=hc15Get(data,key),[name]=JSON.parse(key);
    if(name&&!hc15Member(data,name)){s.conflicts.push(key);continue;}
    if(hc15Equal(key,remote,e.local))delete s.edits[key];
    else if(!hc15Equal(key,remote,e.base))s.conflicts.push(key);
  }
  hc15KeepLocal(s);hc15Render();hc15Schedule(s);
}
function hc15Stop(){const s=hc15Session;if(!s)return;clearTimeout(s.timer);clearTimeout(s.renderTimer);hc15KeepLocal(s);if(!s.busy&&s.verified&&esAllowed()&&currentUser.uid===s.uid&&Object.keys(s.edits).length)void hc15Flush(s);s.unsub?.();s.unsub=null;++s.readEpoch;hc15Session=null;}
function hc15Start(date){
  if(!esAllowed()||!esDateValid(date))return;
  if(hc15Session?.date===date&&hc15Session.uid===currentUser.uid&&hc15Session.unsub)return;
  hc15Stop();const s={uid:currentUser.uid,date,data:{date},verified:false,edits:{},conflicts:[],unsub:null,busy:false,writing:null,error:'',timer:0,loaded:false};hc15Session=s;
  try{const local=JSON.parse(localStorage.getItem(hc15LocalKey(s))||'{}');s.edits=local.edits||{};s.draftSaves=local.draftSaves||{};if(local.data?.date===date){s.data=local.data;s.deviceRestored=true;}}catch(e){}
  hc15Render();
  s.unsub=onSnapshot(doc(db,'hostCashierTipReports',date),{includeMetadataChanges:true},snap=>{
    if(s!==hc15Session)return;const verified=snap.metadata?.fromCache!==true&&snap.metadata?.hasPendingWrites!==true;
    if(s.verified&&!verified)return;s.loaded=true;
    const exists=snap.exists(),data=exists?snap.data():{date};
    // An offline SDK cache may be empty or older than the draft explicitly saved
    // on this device. Keep that saved team/base until a current server read (or
    // a strictly newer cached revision) is available; this does not verify it.
    if(!verified&&s.deviceRestored&&(!exists||Number(data.sheetRevision||0)<=Number(s.data?.sheetRevision||0))){hc15Render();return;}
    s.hadCloud ||= exists;hc15Accept(s,data,verified);
    if(s.verified)s.deviceRestored=false;
  },e=>{if(s!==hc15Session)return;s.verified=false;s.error='Host / Cashier could not sync: '+(e.message||e);hc15Render();});
  void hc184Refresh(s);
}
function hc15Set(name,field,value){
  const s=hc15Session;if(!s||s.busy)return;
  const key=hc15Field(name,field);if(name)value=esNormalizeClock(value);
  const base=s.edits[key]?.base??hc15Get(s.data,key);
  if(hc15Equal(key,value,base))delete s.edits[key];else s.edits[key]={base:tt15Copy(base),local:tt15Copy(value)};
  s.error='';hc15KeepLocal(s);hc15UpdateValues();hc15Schedule(s);
}
function hc15Schedule(s=hc15Session){
  if(!s)return;clearTimeout(s.timer);if(s!==hc15Session||!s.verified||s.busy||s.writing||hc15Sig||hc15Credit||navigator.onLine===false)return;
  if(Object.entries(s.edits).some(([k,e])=>!JSON.parse(k)[0]&&!s.conflicts.includes(k)&&hc15Valid(k,e.local)))s.timer=setTimeout(()=>void hc15Flush(s),700);
}
async function hc15Flush(s=hc15Session){
  if(s?.writing)return s.writing;if(!s||!s.verified||navigator.onLine===false)return false;
  const edits=tt15Copy(Object.fromEntries(Object.entries(s.edits).filter(([k,e])=>!JSON.parse(k)[0]&&!s.conflicts.includes(k)&&hc15Valid(k,e.local))));if(!Object.keys(edits).length)return true;
  clearTimeout(s.timer);
  s.writing=(async()=>{
    const ref=doc(db,'hostCashierTipReports',s.date);
    const result=await runTransaction(db,async tx=>{
      const snap=await tx.get(ref);tt15Require(s.uid);if(!snap.exists()&&s.hadCloud)throw new Error('This Host / Cashier date was removed. Your device edits are kept.');
      const raw=snap.exists()?snap.data():{date:s.date},next=tt15Copy(raw),applied=[],conflicts=[];
      for(const [key,e]of Object.entries(edits)){
        const [name]=JSON.parse(key);if(name&&!hc15Member(raw,name)){conflicts.push(key);continue;}
        const remote=hc15Get(raw,key);if(!hc15Equal(key,remote,e.base)&&!hc15Equal(key,remote,e.local)){conflicts.push(key);continue;}
        hc15Put(next,key,e.local);applied.push(key);
      }
      if(applied.length){next.sheetRevision=Number(raw.sheetRevision||0)+1;tx.set(ref,{...next,...tt15Stamp()});}
      return {next,applied,conflicts};
    });
    if(s===hc15Session){
      for(const key of result.applied)if(s.edits[key]){if(hc15Equal(key,s.edits[key].local,edits[key].local))delete s.edits[key];else s.edits[key].base=tt15Copy(edits[key].local);}
      s.conflicts=[...new Set([...s.conflicts,...result.conflicts])];s.error=result.conflicts.length?'Another device changed the same field. Review changes below.':'';
      hc15Accept(s,result.next,true);
    }return true;
  })().catch(e=>{if(s===hc15Session){s.error=e.message||String(e);hc15Render();}return false;});
  try{return await s.writing;}finally{s.writing=null;hc15KeepLocal(s);hc15UpdateValues();if(!s.error)hc15Schedule(s);}
}
function hc15Hours(data,name,complete=false){
  const row=hc15Member(data,name),v=data.staffDetails?.[name]||{},fields=row?.shift==='DOUBLE'?['clockIn','clockOut','clockIn2','clockOut2']:['clockIn','clockOut'];
  if(!fields.some(k=>v[k]))return {totalMinutesWork:0,totalHoursWork:0,hours:{}};
  const input={...esDefaults(name,data.date),role:'Server',shift:row?.shift,grand:'0',paid:'0',cardFee:'0',cash:'0',meal:'0',totalAM:'0',total24:'0',...Object.fromEntries(fields.map(k=>[k,String(v[k]||'')]))};
  if(complete){const errs=esValidateSales(input,{},true);if(errs.length)throw new Error(tt15Label(name)+': '+errs.join(' '));}
  const hours=esHours(input),mins=window.FredTipCalculatorLogic.calculateTotalMinutes(row?.shift,hours);
  return {totalMinutesWork:mins||0,totalHoursWork:(mins||0)/60,hours};
}
function hc15Report(data,name){
  const member=hc15Member(data,name);if(!member)throw new Error('This employee is no longer on the Host / Cashier team.');
  const m=hc15Math(data),am=m.amountsAM[name]||0,pm=m.amountsPM[name]||0,total=(Math.round(am*100)+Math.round(pm*100))/100;
  return {date:data.date,employee:name,employeeDisplayName:tt15Label(name),position:member.role,shift:member.shift,reportKind:'host_cashier',hostCashierReport:true,
    paidTip:total,paidTips:total,totalTips:total,payCardTipFee:0,cardFee:0,cashTip:0,meal:0,grandTotal:0,totalAM:0,totalPM:0,busserAM:'N/A',busserRate:0,busserTipOut:0,busserTipOutAM:0,busserTipOutPM:0,totalShared:0,
    barTipOut:0,barTipAM:0,barTipPM:0,amBarTipOut:0,pmBarTipOut:0,bartenderBarTipReceived:0,amBarSales:false,pmBarSales:false,
    totalBeforeMeal:total,grandTotalTip:total,grandTotalAfterAdjustment:total,totalPaidOutBeforeAdjustment:total,totalPaidOut:total,
    hourlyRate:0,hourlyMinimum:0,adjustmentCandidate:0,adjustmentEligible:false,adjustmentSalaryHourly:0,adjustmentDecision:'NONE',
    hostCashierNoClock:true,
    // Snapshot only: the same committed pool used for this employee's payout.
    hostCashierPoolSummary:hc185PoolSummaryFromData(data,m),
    hostCashierTipAM:am,hostCashierTipPM:pm,hostCashierPoolAM:m.poolAM,hostCashierPoolPM:m.poolPM,hostCashierCountAM:m.countAM,hostCashierCountPM:m.countPM,
    hostCashierRounding:'Whole cents; remainder in alphabetical employee order',
    hostCashierCashTreatment:'Paid Tip is the combined cash + credit pool share. Cash Tip is 0 because it is not a separately retained personal cash tip.'};
}
function hc15Fingerprint(r){return JSON.stringify([r.date,r.employee,r.position,r.shift,r.hostCashierTipAM,r.hostCashierTipPM,r.totalPaidOut]);}
function hc184SameFingerprint(old,current){
  if(old===current)return true;
  // Old signatures covered the same seven financial/identity fields followed
  // by optional clocks. Removing clock UI must not invalidate valid signatures.
  try{const a=JSON.parse(old),b=JSON.parse(current);return Array.isArray(a)&&a.length>=7&&Array.isArray(b)&&b.length===7&&es182StableJson(a.slice(0,7))===es182StableJson(b);}catch(e){return false;}
}
function hc15Summary(s,name){
  const view=hc15View(s),r=hc15Report(view,name),old=s.data.sheetFinalized?.[tt15Key(name)];
  if(hc16NeedsDraft(view,name)||!old||!hc184SameFingerprint(old.fingerprint,hc15Fingerprint(r))){
    const raw=hc16DraftRow(view,name),shared=s.data.sheetDraftSaved?.[tt15Key(name)],local=s.draftSaves?.[name];
    if(shared&&tt15Same(raw,shared.row)&&!s.conflicts.length)return {text:'Draft saved · synced',kind:'draft'};
    if(local&&tt15Same(raw,local.row))return {text:'Draft saved · device only',kind:'draft'};
  }
  return !old?{text:'Draft · not saved',kind:'draft'}:!hc184SameFingerprint(old.fingerprint,hc15Fingerprint(r))?{text:'Changed · Save again',kind:'dirty'}:old.signed?{text:'Saved · Signed',kind:'signed'}:{text:'Saved · Unsigned',kind:'saved'};
}
function hc15Init(){
  if($('hc15Section')||!$('esGrid'))return;
  const section=document.createElement('section');section.id='hc15Section';section.className='hc15-section';
  section.innerHTML=`<div class="hc15-heading"><h3>Host / Cashier</h3><div class="hc184-toolbar"><button type="button" id="hc184Refresh">Refresh from server</button><button type="button" id="hc15EditTeam">Edit Team</button></div></div><div id="hc15Status" class="hc15-status" role="status"></div>
    <div id="hc15Pools" class="hc15-pools"><table><thead><tr><th>Shift</th><th>Cash</th><th>Credit</th><th>Pool / Staff</th></tr></thead><tbody>${['AM','PM'].map(cp=>`<tr><th>${cp}</th><td><input data-hc15-pool="cash${cp}" data-es182-money="1" inputmode="numeric" type="text" aria-label="Host Cashier Cash ${cp}" placeholder="0.00"></td><td><input data-hc15-pool="credit${cp}" data-es182-money="1" inputmode="numeric" type="text" aria-label="Host Cashier Credit ${cp}" placeholder="0.00"><button class="hc15-accounts" data-hc15-credit="${cp}" type="button">Accounts +</button></td><td id="hc15Pool${cp}">—</td></tr>`).join('')}</tbody></table></div>
    <div id="hc15Conflict" class="hidden"><p>Another device changed the same field. Choose which values to keep.</p><button type="button" id="hc15UseCloud">Use latest</button><button type="button" id="hc15KeepMine">Keep this device</button></div>
    <table class="es-table hc15-table"><colgroup><col class="es-name-col"><col style="width:145px"><col style="width:170px"><col style="width:150px"><col style="width:150px"><col style="width:200px"></colgroup><thead><tr><th class="es-name">Host / Cashier<span>Save · Sign · Print</span></th>${['Shift','Position','Tip AM','Tip PM','Paid Tip Out'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="hc15Rows"></tbody></table>
    <p class="hc15-footnote">Cash + Credit is split equally within each shift, using the existing cent-rounding rule. Double receives AM + PM. No clock-in / clock-out required. Download uses saved reports from the server on both phone and laptop.</p>`;
  $('esGrid').appendChild(section);
  $('hc184Refresh').onclick=()=>hc184Refresh(hc15Session,true);
  $('hc15EditTeam').onclick=()=>window.fzOpenTodayTeam(hc15Session?.date||esSession?.date);
  section.addEventListener('input',e=>{if(e.target.dataset.hc15Pool)hc15Set('',e.target.dataset.hc15Pool,e.target.value);if(e.target.dataset.hc15Clock){const val=esNormalizeClock(e.target.value);e.target.value=val;hc15Set(e.target.dataset.hc15Name,e.target.dataset.hc15Clock,val);}});
  section.addEventListener('change',e=>{if(e.target.dataset.hc15Pool&&es14MoneyValid(e.target.value)&&e.target.value!==''){e.target.value=es14MoneyText(e.target.value);hc15Set('',e.target.dataset.hc15Pool,e.target.value);}});
  section.addEventListener('click',e=>{const credit=e.target.closest('[data-hc15-credit]');if(credit){hc15OpenCredit(credit.dataset.hc15Credit);return;}const b=e.target.closest('[data-hc15-action]');if(!b)return;const name=b.dataset.hc15Name;if(b.dataset.hc15Action==='sign')hc15Sign(name);else hc15Action(name,b.dataset.hc15Action);});
  $('hc15UseCloud').onclick=()=>{const s=hc15Session;if(!s)return;for(const key of s.conflicts)delete s.edits[key];s.conflicts=[];s.error='';hc15KeepLocal(s);hc15Render();};
  $('hc15KeepMine').onclick=()=>{const s=hc15Session;if(!s)return;for(const key of s.conflicts)if(s.edits[key]){const [name]=JSON.parse(key);if(name&&!hc15Member(s.data,name)){s.error='This employee was removed from the team. Use latest, or add them again in Today’s Team.';hc15Render();return;}s.edits[key].base=tt15Copy(hc15Get(s.data,key));}s.conflicts=[];s.error='';hc15Schedule(s);hc15Render();};
  const modal=document.createElement('div');modal.id='hc15SignModal';modal.className='es-modal hidden';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','hc15SignTitle');
  modal.innerHTML='<div class="es-sign-card"><h3 id="hc15SignTitle">Host / Cashier signature</h3><p id="hc15SignSummary"></p><canvas id="hc15SignCanvas" width="1000" height="320"></canvas><div class="es-sign-actions"><button type="button" id="hc15SignCancel">Cancel</button><button type="button" id="hc15SignClear">Clear</button><button type="button" id="hc15SignSave">Save signature</button></div><p id="hc15SignStatus" role="status"></p></div>';
  $('employeeSheet').appendChild(modal);hc15BindSign();
  const credit=document.createElement('div');credit.id='hc15CreditModal';credit.className='es-modal hidden';credit.setAttribute('role','dialog');credit.setAttribute('aria-modal','true');credit.innerHTML='<div class="es-sign-card"><h3 id="hc15CreditTitle">Credit accounts</h3><div id="hc15CreditRows"></div><button id="hc15CreditAdd" type="button">＋ Add account</button><p id="hc15CreditTotal"></p><div class="es-sign-actions"><button id="hc15CreditCancel" type="button">Cancel</button><button id="hc15CreditUse" type="button">Use total</button></div><p id="hc15CreditStatus" role="status"></p></div>';$('employeeSheet').appendChild(credit);hc15BindCredit();
}
function hc15Render(){
  const s=hc15Session;if(!s||!$('hc15Rows'))return;
  if(esPan||performance.now()<esTouchUntil){clearTimeout(s.renderTimer);s.renderTimer=setTimeout(hc15Render,180);return;}
  const data=hc15View(s),members=tt15TeamRows({},data),key=JSON.stringify(members);
  if(s.rowsKey!==key||!$('hc15Rows').children.length){
    s.rowsKey=key;$('hc15Rows').innerHTML=members.map(r=>`<tr data-hc15-row="${tt15Key(r.name)}"><th class="es-name"><b>${esc(tt15Label(r.name))}</b><span class="es-state" data-hc15-state></span><div class="es-row-actions">${['Save','Sign','Print'].map(a=>`<button type="button" data-hc15-action="${a.toLowerCase()}" data-hc15-name="${esc(r.name)}">${a}</button>`).join('')}</div></th><td>${esc(r.shift)}</td><td>${esc(r.role)}</td><td data-hc15-out="am"></td><td data-hc15-out="pm"></td><td class="es-payout" data-hc15-out="total"></td></tr>`).join('')||'<tr><td colspan="6">No Host / Cashier on this date. Add them in Today’s Team.</td></tr>';
  }
  for(const input of $('hc15Pools').querySelectorAll('input')){if(input!==document.activeElement)input.value=String(data[input.dataset.hc15Pool]??0);input.disabled=!s.verified||s.busy;}
  for(const input of $('hc15Rows').querySelectorAll('input')){const r=hc15Member(data,input.dataset.hc15Name);input.disabled=!s.verified||s.busy||(input.dataset.hc15Clock.endsWith('2')&&r?.shift!=='DOUBLE');if(input!==document.activeElement)input.value=data.staffDetails?.[input.dataset.hc15Name]?.[input.dataset.hc15Clock]||'';}
  for(const b of $('hc15Rows').querySelectorAll('button'))b.disabled=s.busy||(!s.verified&&b.dataset.hc15Action!=='save')||!esAllowed()||currentUser.uid!==s.uid;
  hc15UpdateValues();
}
function hc15UpdateValues(){
  const s=hc15Session;if(!s||!$('hc15Status'))return;
  const data=hc15View(s),q=String($('esSearch')?.value||'').toLowerCase();
  $('hc15Status').textContent=s.error||(!s.verified?'Checking Host / Cashier…':s.writing?'Sharing changes…':Object.keys(s.edits).length?'Draft changes · auto-sync':'Live · Save a row to Final Report');
  $('hc15Status').dataset.error=s.error?'1':'0';$('hc15Conflict').classList.toggle('hidden',!s.conflicts.length);
  try{
    const m=hc15Math(data);for(const cp of ['AM','PM'])$('hc15Pool'+cp).innerHTML='<b>'+esc(esMoney(m['pool'+cp]))+'</b><small>'+m['count'+cp]+' staff</small>';
    for(const row of tt15TeamRows({},data)){
      const tr=$('hc15Rows').querySelector('[data-hc15-row="'+tt15Key(row.name)+'"]');if(!tr)continue;const result=hc15Report(data,row.name),state=hc15Summary(s,row.name),mins=result.totalMinutesWork;
      tr.hidden=!!q&&!(tt15Label(row.name)+' '+row.name).toLowerCase().includes(q);
      const title=tr.querySelector('.es-name>b');if(title)title.textContent=tt15Label(row.name);
      const status=tr.querySelector('[data-hc15-state]');status.textContent=state.text;status.dataset.kind=state.kind;
      for(const [k,v]of Object.entries({am:esMoney(result.hostCashierTipAM),pm:esMoney(result.hostCashierTipPM),total:esMoney(result.totalPaidOut)}))tr.querySelector('[data-hc15-out="'+k+'"]').textContent=v;
    }
  }catch(e){$('hc15Status').textContent=e.message;}
}
async function hc15Commit(name,signature=null,expected=''){
  const s=hc15Session;if(!s?.verified)throw new Error('Checking cloud. Your signature is kept.');tt15Require(s.uid);
  if(!(await hc15Flush(s)))throw new Error(s.error||'Host / Cashier draft could not sync.');
  const view=hc15View(s);for(const f of TT15_POOLS)if(!es14MoneyValid(view[f]))throw new Error('Enter valid '+f+' with at most 2 decimals.');
  if(s.conflicts.length)throw new Error('Review conflicting Host / Cashier edits before saving this pool.');
  // Legacy clock drafts remain stored, but no longer block a tip report.
  const reportRef=doc(db,'hourlyReports','hc15-'+s.date+'-'+tt15Key(name)),ref=doc(db,'hostCashierTipReports',s.date);
  const out=await runTransaction(db,async tx=>{
    const hs=await tx.get(ref),rs=await tx.get(reportRef);tt15Require(s.uid);
    if(!hs.exists())throw new Error('Set this date’s Host / Cashier team first.');
    const data=hs.data(),before=rs.exists()?rs.data():null,r=hc15Report(data,name);
    if(before&&(!tt15IsHostReport(before)||!hourlyReportBelongsTo(before,name,s.date)))throw new Error('Report identity mismatch. No data was replaced.');
    const fp=hc15Fingerprint(r);
    if(signature&&fp!==expected)throw new Error('Amounts or team changed while signing. Cancel, review the updated row, then sign again. Your signature remains visible.');
    const same=hc184SameFingerprint(before?.hostCashierFingerprint,fp),sig=signature||(same?before?.pickupSignature:null);
    const report={...r,hostCashierFingerprint:fp,pickupSignature:sig||null,signatureStatus:sig?'SIGNED':'PENDING',status:'money_ready',employeeSheetBuild:ES_BUILD,employeeKey:fzEmployeeIdentityKey(name),reportIdentityVersion:'13.8.28',updatedAt:serverTimestamp(),updatedBy:currentProfile?.displayName||currentProfile?.username||''};
    const next=tt15Copy(data);next.sheetFinalized ||= {};next.sheetFinalized[tt15Key(name)]={id:reportRef.id,fingerprint:fp,signed:!!sig};next.signatures ||= {AM:{},PM:{}};
    for(const cp of ['AM','PM']){
      next.signatures[cp] ||= {};const amount=r['hostCashierTip'+cp],active=(data['employees'+cp]||[]).includes(name);
      if(signature&&active)next.signatures[cp][name]={...signature,amount,date:s.date,signedAt:signature.signedAtLocal};
      else if(!same&&next.signatures[cp][name]&&Number(next.signatures[cp][name].amount)!==amount)delete next.signatures[cp][name];
    }
    next.sheetRevision=Number(data.sheetRevision||0)+1;next.metrics=hc15Math(data);next.combinedPayout=tt15TeamRows({},data).map(e=>{const x=hc15Report(data,e.name);return {name:e.name,am:x.hostCashierTipAM,pm:x.hostCashierTipPM,total:x.totalPaidOut};});next.savedBy=currentProfile?.displayName||currentProfile?.username||'';next.savedByUid=s.uid;
    if(before)tx.update(reportRef,report);else tx.set(reportRef,{...report,createdAt:serverTimestamp(),createdByUid:s.uid});
    tx.set(ref,{...next,...tt15Stamp()});return {data:next,report:{...(before||{}),...report,id:reportRef.id}};
  });
  if(hc15Session===s)hc15Accept(s,out.data,true);
  latestHourlyReports=[out.report,...latestHourlyReports.filter(r=>r.id!==out.report.id)];frRenderIfOpen();return out.report;
}
async function hc15Action(name,action='save'){
  const s=hc15Session;if(!s||s.busy)return false;let popup=null;
  const android=/Android/i.test(navigator.userAgent||'');if(action==='print'&&!android)popup=es18OpenPrintPreview(null,tt15Label(name)+' — Preparing receipt');
  s.busy=true;hc15Render();
  try{if(action==='save'&&(hc16NeedsDraft(hc15View(s),name)||!s.verified||!es14IsOnline())){await hc16SaveDraft(name);return true;}const report=await hc15Commit(name);if(action==='print')await hc15PrintReport(report,popup);s.error='';esStatus(tt15Label(name)+(action==='print'?' saved · receipt sent to print.':' saved to Final Report.'));return true;}
  catch(e){popup?.close();s.error=e.message||String(e);esStatus(s.error,true);return false;}
  finally{s.busy=false;hc15Render();hc15Schedule(s);}
}
async function hc15PrintReport(report,popup){
  const html=esThermalHtml(report);
  if(/Android/i.test(navigator.userAgent||'')){
    try{await prepareSmallReportPassPrntReturn(report);try{const b=JSON.parse(localStorage.getItem(PASS_PRNT_BRIDGE_KEY)||'{}');b.employeeSheet=true;localStorage.setItem(PASS_PRNT_BRIDGE_KEY,JSON.stringify(b));}catch(e){}
      const link=document.createElement('a');link.href=esPassPrntUri(report,html);link.style.display='none';document.body.appendChild(link);link.click();link.remove();
    }catch(e){await cancelSmallReportPassPrntReturn();throw e;}
  }else{popup?.setHtml(html);}
}
function hc15Sign(name){
  const s=hc15Session;if(!s?.verified||s.busy)return;
  try{const data=hc15View(s),r=hc15Report(data,name);hc15Sig={name,uid:s.uid,date:s.date,fingerprint:hc15Fingerprint(r),strokes:[],current:null,scroll:es14CaptureScroll()};
    $('hc15SignTitle').textContent=tt15Label(name)+' — Host / Cashier';$('hc15SignSummary').textContent=s.date+' · '+r.shift+' · Paid Tip Out '+esMoney(r.totalPaidOut);$('hc15SignStatus').textContent='Save signature returns to this row.';$('hc15SignModal').classList.remove('hidden');hc15Draw();$('hc15SignCancel').focus();
  }catch(e){s.error=e.message;hc15UpdateValues();}
}
function hc15Draw(){const c=$('hc15SignCanvas');if(!c)return;const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.strokeStyle='#10233f';ctx.lineWidth=3.4;ctx.lineCap='round';ctx.lineJoin='round';for(const st of hc15Sig?.strokes||[]){ctx.beginPath();st.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*c.width,p.y*c.height));ctx.stroke();}}
function hc15BindSign(){
  const c=$('hc15SignCanvas'),pt=e=>{const r=c.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
  c.onpointerdown=e=>{if(!hc15Sig||hc15Session?.busy)return;e.preventDefault();c.setPointerCapture(e.pointerId);hc15Sig.current=[pt(e)];hc15Sig.strokes.push(hc15Sig.current);hc15Draw();};
  c.onpointermove=e=>{if(hc15Sig?.current){e.preventDefault();if(hc15Sig.current.length<800)hc15Sig.current.push(pt(e));hc15Draw();}};
  c.onpointerup=c.onpointercancel=()=>{if(hc15Sig)hc15Sig.current=null;};
  $('hc15SignCancel').onclick=()=>{if(hc15Session?.busy)return;hc15Sig=null;$('hc15SignModal').classList.add('hidden');hc15Schedule();};
  $('hc15SignClear').onclick=()=>{if(hc15Sig&&!hc15Session?.busy){hc15Sig.strokes=[];hc15Draw();}};
  $('hc15SignSave').onclick=async()=>{
    const sign=hc15Sig,s=hc15Session;if(!sign||!s||s.busy)return;if(sign.strokes.reduce((n,a)=>n+a.length,0)<4){$('hc15SignStatus').textContent='Please sign first.';return;}
    if(sign.date!==s.date||sign.uid!==s.uid){$('hc15SignStatus').textContent='Work date or login changed. Close and sign again.';return;}
    s.busy=true;hc15Render();$('hc15SignSave').disabled=true;$('hc15SignStatus').textContent='Saving…';
    try{await hc15Commit(sign.name,esSerializeSignature(sign.strokes),sign.fingerprint);hc15Sig=null;$('hc15SignModal').classList.add('hidden');es14RestoreScroll(sign.scroll);esStatus(tt15Label(sign.name)+' signed · Final Report updated.');}
    catch(e){$('hc15SignStatus').textContent=e.message||String(e);}
    finally{s.busy=false;$('hc15SignSave').disabled=false;hc15Render();if(!hc15Sig)es14RestoreScroll(sign.scroll);hc15Schedule(s);}
  };
}
function hc15OpenCredit(cp){
  const s=hc15Session;if(!s?.verified||s.busy)return;const data=hc15View(s),rows=data['creditAccounts'+cp]||[];
  hc15Credit={cp,rows:tt15Copy(rows.length?rows:[{label:'Account 1',amount:data['credit'+cp]||0}])};$('hc15CreditTitle').textContent='Credit '+cp+' — Accounts';$('hc15CreditStatus').textContent='';$('hc15CreditModal').classList.remove('hidden');hc15CreditRender();
}
function hc15CreditRender(){
  if(!hc15Credit)return;$('hc15CreditRows').innerHTML=hc15Credit.rows.map((r,i)=>`<div class="hc15-credit-row"><input data-hc15-account="${i}" data-key="label" value="${esc(r.label||'')}" placeholder="Account name" maxlength="80" aria-label="Account ${i+1}"><input data-hc15-account="${i}" data-key="amount" data-es182-money="1" value="${esc(es182MoneyDisplay(r.amount))}" inputmode="numeric" aria-label="Amount ${i+1}"><button type="button" data-hc15-remove="${i}" aria-label="Remove account ${i+1}">✕</button></div>`).join('');hc15CreditTotal();
}
function hc15CreditTotal(){if(hc15Credit)$('hc15CreditTotal').textContent='Total '+esMoney(hc15Credit.rows.reduce((sum,r)=>sum+Math.round((Number(r.amount)||0)*100),0)/100);}
function hc15BindCredit(){
  $('hc15CreditRows').oninput=e=>{if(e.target.dataset.hc15Account===undefined||!hc15Credit)return;hc15Credit.rows[Number(e.target.dataset.hc15Account)][e.target.dataset.key]=e.target.value;hc15CreditTotal();};
  $('hc15CreditRows').onclick=e=>{const b=e.target.closest('[data-hc15-remove]');if(!b||!hc15Credit)return;hc15Credit.rows.splice(Number(b.dataset.hc15Remove),1);hc15CreditRender();};
  $('hc15CreditAdd').onclick=()=>{if(hc15Credit&&hc15Credit.rows.length<50){hc15Credit.rows.push({label:'Account '+(hc15Credit.rows.length+1),amount:0});hc15CreditRender();}};
  $('hc15CreditCancel').onclick=()=>{hc15Credit=null;$('hc15CreditModal').classList.add('hidden');hc15Schedule();};
  $('hc15CreditUse').onclick=()=>{const c=hc15Credit,s=hc15Session;if(!c||!s)return;if(c.rows.some(r=>!es14MoneyValid(r.amount))){$('hc15CreditStatus').textContent='Enter valid nonnegative amounts, with at most 2 decimals.';return;}
    const total=c.rows.reduce((sum,r)=>sum+Math.round((Number(r.amount)||0)*100),0)/100;hc15Set('','credit'+c.cp,String(total));hc15Set('','creditAccounts'+c.cp,c.rows.map(r=>({label:r.label,amount:Number(r.amount)||0})));hc15Credit=null;$('hc15CreditModal').classList.add('hidden');hc15Render();hc15Schedule(s);
  };
}
function hc15Jump(){
  const target=$('hc15Section'),port=esSheetScrollPort();if(!target||!port)return;
  port.scrollLeft=0;port.scrollTop+=target.getBoundingClientRect().top-port.getBoundingClientRect().top-4;
}

/* Integration stays scoped: host records must never enter server BAR math. */
(function(){
  const prepare=esPrepareBatch,find=esFindReport,accept=esAcceptRead,init=esInit,render=esRenderRows,open=window.employeeSheetOpen;
  esPrepareBatch=function(source,reports,date){const removed=new Set(source?.todayTeamRemoved||[]);return prepare(source,(reports||[]).filter(r=>!tt15IsHostReport(r)&&!removed.has(r.employee)),date);};
  esFindReport=function(reports,name){return find((reports||[]).filter(r=>!tt15IsHostReport(r)),name);};
  esAcceptRead=function(c,kind,value,...rest){
    // Keep the complete verified report list available to legacy Daily paths.
    // BAR calculations still receive only Server/Bartender records.
    if(kind==='reports'&&esReadCurrent(c)&&rest[0]!==false){
      const hosts=(value||[]).filter(r=>r.date===c.session.date&&es16ExportIsHost(r));
      latestHourlyReports=[...hosts,...latestHourlyReports.filter(r=>r.date!==c.session.date||!es16ExportIsHost(r))];
    }
    return accept(c,kind,kind==='reports'?(value||[]).filter(r=>!es16ExportIsHost(r)):value,...rest);
  };
  esRenderRows=function(...a){const out=render(...a);tt15PaintNames();return out;};
  esInit=function(...a){const out=init(...a);hc15Init();
    if($('esToolActions')&&!$('tt15SheetTeam')){const b=document.createElement('button');b.type='button';b.id='tt15SheetTeam';b.textContent="Today's Team";b.onclick=()=>window.fzOpenTodayTeam(esSession?.date);$('esToolActions').prepend(b);}
    if($('esTeamDetails')){$('esTeamDetails').querySelector('summary').textContent='BAR assignments';$('esTeamDetails').querySelector('.es-add')?.classList.add('hidden');}
    if($('esQuickColumns')&&!$('esQuickColumns').querySelector('[value="host-cashier"]')){
      const option=document.createElement('option');option.value='host-cashier';option.textContent='Host / Cashier ↓';$('esQuickColumns').appendChild(option);
      $('esQuickColumns').addEventListener('change',e=>{if(e.target.value==='host-cashier'){e.stopImmediatePropagation();hc15Jump();e.target.value='';}},true);
      $('esSearch').addEventListener('input',()=>{tt15PaintNames();hc15UpdateValues();});
      $('esReload').addEventListener('click',()=>{hc15Stop();hc15Start(esSession?.date);});
    }
    const empty=$('esRows')?.querySelector('.es-empty');if(empty)empty.textContent="Add employees in Today's Team → Update Team.";
    return out;
  };
  window.employeeSheetOpen=async function(...a){if(tt15State?.busy)return;tt15Close();tt15DirectoryStart();const out=await open(...a);if(esAllowed()&&esSession)hc15Start(esSession.date);return out;};
  for(const name of ['fzOpenRoleHome','fzOpenManagerTools','fzOpenTipCalculation','fzOpenFinalReport']){
    const original=window[name];if(typeof original!=='function')continue;
    window[name]=function(...a){tt15Close();hc15Stop();return original(...a);};
  }
  window.fzOpenHostCashier=async function(){if(!esAllowed())return;await window.employeeSheetOpen(esSession?.date||todayLocal());requestAnimationFrame(()=>requestAnimationFrame(hc15Jump));};
})();
window.addEventListener('fz-host-math-ready',()=>hc15Render());
window.addEventListener('online',()=>hc15Schedule());
window.addEventListener('offline',()=>{if(hc15Session){hc15Session.error='Offline · inputs kept on this device';hc15UpdateValues();}});
window.addEventListener('beforeunload',()=>hc15KeepLocal());
try{onAuthStateChanged(auth,user=>{if(!user||!esAllowed()){tt15Close();hc15Stop();tt15Directory.unsub?.();tt15Directory={uid:'',data:{},ready:false,unsub:null};hc15Sig=null;hc15Credit=null;$('hc15SignModal')?.classList.add('hidden');$('hc15CreditModal')?.classList.add('hidden');$('tt15DirectoryPanel')?.classList.add('hidden');}});}catch(e){}

/* ES1.6 — Save accepts unfinished rows. Drafts never write hourlyReports.
 * Sign/Print still use the existing strict final-report commit functions.
 */
function es16RawSource(batch,name){
  const d=batch?.drafts?.[name]||{};
  return es182StableJson([d.values||{},d.entered||{},ES_PERIODS.map(cp=>[batch.bar?.[cp]?.entries?.[name]??null,batch.bar?.[cp]?.excluded?.[name]??null])]);
}
function es16RawValid(d,batch,name){
  if(!d?.employeeSheetRawRow||d.employeeSheetRawRow.name!==name)return false;
  const current=es16RawSource(batch,name);
  if(d.employeeSheetRawSource===current)return true;
  // Firestore maps can return in a different key order. Compare legacy source
  // snapshots semantically; an actual values/entered/BAR change still invalidates.
  try{return es182StableJson(JSON.parse(d.employeeSheetRawSource))===current;}catch(e){return false;}
}
function es16RowMatches(a,b){return !!a&&!!b&&a.name===b.name&&ES_FIELDS.every(f=>es14Same(f,a[f],b[f]));}
function es16KeepDraft(s,name){
  const previous=s.draftSaves?.[name];s.draftSaves ||= {};
  s.draftSaves[name]={row:esClone(s.rows.find(r=>r.name===name)),savedAt:Date.now()};
  if(esPersistLocal())return true;
  if(previous)s.draftSaves[name]=previous;else delete s.draftSaves[name];return false;
}
async function es16PublishRowDraft(s,name){
  const draft=es14DraftSnapshot(s),selected=draft.rows.find(r=>r.name===name),ref=doc(db,'hourlyV1Batches',s.date);
  const out=await runTransaction(db,async tx=>{
    const snap=await tx.get(ref);if(!es14AllowedSession(s))throw new Error('Login changed. No draft was shared.');
    if(!snap.exists()&&draft.hadCloud)throw new Error('This work date was removed. Your device draft is kept.');
    const raw=snap.exists()?snap.data():draft.baseBatch,remote=es14Remote(raw,draft.reports,draft.date,s);
    const routes=es14MergeRoute(draft.baseRouting,draft.routing,remote.routing);
    const dirty=draft.dirty[name]?{[name]:draft.dirty[name]}:{};
    const merged=es14Patch(draft.baseRows,draft.rows,remote.rows,dirty,routes.route,true);
    const routing=esRouting(merged.rows,routes.route),batch=esBuildBatch(remote.batch,merged.rows,draft.date,routing);
    const row=merged.rows.find(r=>r.name===name),conflicts=[...remote.conflicts.filter(c=>c.name===name),...merged.conflicts,...routes.conflicts];
    const shared=!!row&&es16RowMatches(selected,row)&&!conflicts.length;
    if(shared){batch.drafts[name].employeeSheetDraftSaved={row:esClone(row),savedAt:Date.now()};batch.drafts[name].savedAt=Date.now();}
    const changed=shared||Object.keys(merged.applied).length>0||ES_PERIODS.some(cp=>(routing[cp]||'')!==(remote.routing[cp]||''));
    if(changed){batch.employeeSheetRevision=Number(raw.employeeSheetRevision||0)+1;
      tx.set(ref,{...raw,date:draft.date,team:batch.team,drafts:batch.drafts,bar:batch.bar,barManual:batch.barManual||{},employeeSheetRevision:batch.employeeSheetRevision,updatedAt:serverTimestamp(),updatedByUid:s.uid,updatedBy:currentProfile.displayName||currentProfile.username||''});}
    return {batch:changed?batch:remote.batch,rows:merged.rows,fields:merged.applied,routing,shared,conflicts};
  });
  if(esSession===s&&es14AllowedSession(s)){
    es14AcceptCommit(s,out.batch,s.reports,out);es14RecordConflicts(s,[...(s.conflicts||[]),...out.conflicts]);
  }
  return out;
}
async function es16SaveDraft(name){
  const s=esSession;if(!es14AllowedSession(s)||!s.ready)throw new Error('Manager / Owner session required.');
  if(!s.rows.some(r=>r.name===name))throw new Error('Employee row not found.');
  clearTimeout(s.autoTimer);const kept=es16KeepDraft(s,name);
  let shared=false,reason='';
  if(s.cloudReady&&es14IsOnline()){
    try{if(s.autoPromise)await s.autoPromise;if(!es14AllowedSession(s)||esSession!==s)throw new Error('Login or work date changed.');
      const out=await es16PublishRowDraft(s,name);shared=out.shared;
      if(!shared)reason=out.conflicts.length?' Review changes before syncing.':' Finish invalid fields before syncing the entire row.';
    }catch(e){reason=' Not synced: '+(e.message||String(e));}
  }else reason=es14IsOnline()?' Cloud connection is not ready.':' Offline.';
  if(!shared&&!kept)throw new Error('Draft was not saved: device storage is unavailable and the complete draft could not sync. Keep this page open and retry.');
  esStatus(name+(shared?' · Draft saved and synced. Complete the row later.':' · Draft saved on this device only.'+reason));
  return {draft:true,shared,local:kept};
}
function hc16DraftRow(data,name){
  const member=hc15Member(data,name);
  return {member,clocks:tt15Copy(data.staffDetails?.[name]||{}),pools:Object.fromEntries(TT15_POOLS.map(f=>[f,data[f]??0]))};
}
function hc16NeedsDraft(data,name){
  if(TT15_POOLS.some(f=>!es14MoneyValid(data[f])))return true;
  return false; // Clock fields are not part of Host/Cashier tip finalization.
}
async function hc16SaveDraft(name){
  const s=hc15Session;if(!s||!esAllowed()||currentUser.uid!==s.uid)throw new Error('Manager / Owner session required.');if(!hc15Member(hc15View(s),name))throw new Error('Host / Cashier row not found.');
  const previous=s.draftSaves?.[name];s.draftSaves ||= {};
  const captured=hc16DraftRow(hc15View(s),name);s.draftSaves[name]={row:captured,savedAt:Date.now()};
  const kept=hc15KeepLocal(s);if(!kept){if(previous)s.draftSaves[name]=previous;else delete s.draftSaves[name];}
  let shared=false,reason='';
  if(s.verified&&es14IsOnline()){
    try{
      if(!(await hc15Flush(s)))throw new Error(s.error||'Host / Cashier draft could not sync.');
      const pending=Object.keys(s.edits).some(k=>{const [who]=JSON.parse(k);return !who||who===name;});
      if(!pending&&!s.conflicts.length){
        const ref=doc(db,'hostCashierTipReports',s.date);
        const result=await runTransaction(db,async tx=>{
          const snap=await tx.get(ref);tt15Require(s.uid);if(!snap.exists())throw new Error('Host / Cashier team no longer exists on this date.');
          const raw=snap.data();if(!tt15Same(captured,hc16DraftRow(raw,name)))throw new Error('Another device changed this row or pool. Your device draft is kept.');
          const next=tt15Copy(raw);next.sheetDraftSaved ||= {};next.sheetDraftSaved[tt15Key(name)]={row:captured,savedAt:Date.now()};next.sheetRevision=Number(raw.sheetRevision||0)+1;
          tx.set(ref,{...next,...tt15Stamp()});return next;
        });
        if(hc15Session===s)hc15Accept(s,result,true);shared=true;
      }else reason=s.conflicts.length?' Review changes before syncing.':' Finish invalid fields before syncing the entire row.';
    }catch(e){reason=' Not synced: '+(e.message||String(e));}
  }else reason=es14IsOnline()?' Cloud connection is not ready.':' Offline.';
  if(!shared&&!kept)throw new Error('Draft was not saved: device storage is unavailable and the complete draft could not sync. Keep this page open and retry.');
  s.error='';esStatus(tt15Label(name)+(shared?' · Draft saved and synced. Complete the row later.':' · Draft saved on this device only.'+reason));
  return {draft:true,shared,local:kept};
}


/* ES1.6 — date-scoped Daily Report downloads at the bottom of Employee Sheet.
 * Reads saved hourlyReports only. Draft rows, search boxes, and Final Report's
 * hidden employee/date filters are deliberately not used as export sources.
 */
let es16ExportBusy=false;
function es16ExportGroup(group){
  if(group==='server'||group==='host-cashier')return group;
  throw new Error('Choose Server or Host/Cashier.');
}
function es16ExportGroupTitle(group){return es16ExportGroup(group)==='server'?'Server / Bartender':'Host / Cashier';}
function es16ExportIsHost(row){
  return tt15IsHostReport(row)||/^(host|cashier|host\s*[/&]\s*cashier)$/i.test(String(row?.position||'').trim());
}
function es16ExportSession(date){
  const s=esSession;
  if(!esAllowed()||!s?.ready||s.uid!==currentUser?.uid)throw new Error('Open Employee Sheet with your Manager / Owner login first.');
  if(!esDateValid(date)||s.date!==date||($('esDate')&&$('esDate').value!==date))throw new Error('The work date changed. Select the date again, then download.');
  if(s.busy||hc15Session?.busy)throw new Error('Please wait for this save to finish, then download.');
  return s;
}
async function es16DailyExportRows(group,date){
  es16ExportGroup(group);const session=es16ExportSession(date),uid=currentUser.uid;
  const guard=()=>{if(es16ExportSession(date)!==session||currentUser.uid!==uid)throw new Error('The session changed. Please download again.');};
  const all=await es184SavedReports(date,guard);
  let selected=all.filter(r=>group==='host-cashier'?es16ExportIsHost(r):!es16ExportIsHost(r));
  if(group==='host-cashier')selected=await hc184CompleteSavedRows(selected,date,guard);
  guard();return selected.sort((a,b)=>String(a.employee||'').localeCompare(String(b.employee||''))||String(a.shift||'').localeCompare(String(b.shift||''))||String(a.id||'').localeCompare(String(b.id||'')));
}

function es16DailyXlsBlob(rows,group,date){
  const groupTitle=es16ExportGroupTitle(group),host=group==='host-cashier';
  const safe=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  // x:str plus text formatting protects strings in Excel; prefix formula-like
  // employee/position/shift text as a second layer for other spreadsheet apps.
  const textValue=v=>{const s=String(v??'');return safe(/^[\s\u0000-\u001f]*[=+\-@]/.test(s)?"'"+s:s);};
  const num=v=>Number.isFinite(Number(v))?Number(v):0;
  const decimal=v=>num(v).toFixed(2);
  const columns=host?[
    ['Date','text',r=>r.date,115],['Employee','text',r=>r.employee,250],['Shift','text',r=>r.shift,125],
    ['Tip AM','money',r=>hc184TipAmount(r,'AM'),150],['Tip PM','money',r=>hc184TipAmount(r,'PM'),150],
    ['Total Paid Out','money',r=>smallReportPaidOut(r),185],['Signature','signature',r=>r.pickupSignature,280]
  ]:[
    ['Date','text',r=>r.date,115],['Employee','text',r=>r.employee,250],['Shift','text',r=>r.shift,125],
    ['Clock In 1','text',r=>smallReportClockFields(r).in1,130],['Clock Out 1','text',r=>smallReportClockFields(r).out1,130],
    ['Clock In 2','text',r=>smallReportClockFields(r).in2,130],['Clock Out 2','text',r=>smallReportClockFields(r).out2,130],
    ['Total Hours','number',r=>r.totalHoursWork??r.totalHours??0,130],['Paid Tips','money',r=>r.paidTip,155],
    ['Tip Card Fee','money',r=>r.payCardTipFee??r.cardFee,155],['Busser AM','money',r=>r.busserTipOutAM,150],
    ['Busser PM','money',r=>r.busserTipOutPM,150],['Busser Total','money',r=>r.busserTipOut,155],
    ['Bar Tip Out / Received','money',r=>smallReportBarAmount(r),195],
    ['Total Tip Before Meal','money',r=>r.totalBeforeMeal,205],['Cash Tip','money',r=>r.cashTip,150],['Meal','money',r=>r.meal,150],
    ['Total Paid Out','money',r=>smallReportPaidOut(r),185],['Grand Total (Total Before Meal + Cash Tip)','money',r=>smallReportGrandTotal(r),280],
    ['Signature','signature',r=>r.pickupSignature,280]
  ];
  const numericCell=(v,type,extra='')=>`<td class="${type}" x:num="${decimal(v)}"${extra}>${decimal(v)}</td>`;
  const signatureCell=signature=>{
    const svg=smallReportSignatureSvg(signature,240,86);
    if(!svg)return '<td class="signature pending" x:str>PENDING SIGNATURE</td>';
    const uri='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));
    return `<td class="signature" x:str><img alt="Employee signature" src="${uri}" width="240" height="86"><br><b>SIGNED</b></td>`;
  };
  const body=rows.map((r,i)=>'<tr class="data-row" style="background:'+(i%2?'#edf4f8':'#ffffff')+'">'+columns.map(([label,type,value])=>{
    const v=value(r);if(type==='signature')return signatureCell(v);
    if(host&&v==null)return '<td class="text" x:str>Not available</td>';
    if(type==='number'||type==='money')return numericCell(v,type,label==='Total Paid Out'?' style="font-weight:bold;color:#155a46"':'');
    return `<td class="text" x:str>${label==='Employee'?'<b>'+textValue(v)+'</b><br><span>'+textValue(r.position)+'</span>':textValue(v)}</td>`;
  }).join('')+'</tr>').join('');
  const signed=rows.filter(r=>smallReportHasPickupSignature(r)).length;
  const totals='<tr class="totals">'+columns.map(([label,type,value],i)=>{
    if(i===0)return '<td class="text" x:str>TOTAL</td>';
    if(i===1)return `<td class="text" x:str>${rows.length} report${rows.length===1?'':'s'}</td>`;
    if(type==='signature')return `<td class="text" x:str>${signed} of ${rows.length} signed</td>`;
    if(type!=='number'&&type!=='money')return '<td></td>';
    if(host&&rows.some(r=>value(r)==null))return '<td class="text" x:str>Not available</td>';
    const total=type==='money'?rows.reduce((sum,r)=>sum+Math.round(num(value(r))*100),0)/100:rows.reduce((sum,r)=>sum+num(value(r)),0);
    return numericCell(total,type);
  }).join('')+'</tr>';
  const color=host?'#175643':'#143d55';
  const html=`<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><title>Daily Report — ${safe(groupTitle)}</title>
    <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${host?'Host Cashier':'Server Bartender'}</x:Name><x:WorksheetOptions><x:PageSetup><x:Layout x:Orientation="Landscape"/></x:PageSetup><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>4</x:SplitHorizontal><x:TopRowBottomPane>4</x:TopRowBottomPane><x:SplitVertical>2</x:SplitVertical><x:LeftColumnRightPane>2</x:LeftColumnRightPane><x:ActivePane>0</x:ActivePane><x:ProtectObjects>False</x:ProtectObjects><x:ProtectScenarios>False</x:ProtectScenarios></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
    <style>body,table,th,td{font-family:Arial,sans-serif;font-size:14pt}table{border-collapse:collapse}th,td{border:1px solid #bfd0dc;padding:12px 10px;vertical-align:middle}th{background:${color};color:#fff;font-weight:bold;text-align:center;white-space:normal;height:62px}td{color:#183b4e}td.text{mso-number-format:"\\@";text-align:left;white-space:nowrap}.number{mso-number-format:"0.00";text-align:right}.money{mso-number-format:"\\$#,##0.00;[Red]\\-\\$#,##0.00";text-align:right}.title{background:${color};color:white;font-weight:bold;height:44px;border-color:${color}}.subtitle{background:#dcebf2;color:#173f53;font-weight:bold;height:36px}.note{background:#f4f8fb;color:#496778;white-space:normal;height:36px}.data-row{height:104px}.signature{text-align:center;min-width:260px}.signature img{display:block;border:1px solid #c7d6df}.pending{background:#fff8e4;color:#876323;white-space:normal;font-weight:bold}.totals td{background:#dcece6;font-weight:bold;border-top:3px solid #23705c;height:44px}</style></head><body>
    <table><colgroup>${columns.map(c=>`<col width="${c[3]}" style="width:${c[3]}px">`).join('')}</colgroup>
    <thead><tr><td colspan="${columns.length}" class="title" x:str>FRED ZHANG TIP CALCULATOR — DAILY REPORT</td></tr>
    <tr><td colspan="${columns.length}" class="subtitle" x:str>${safe(groupTitle)} · Work date: ${safe(date)} · ${rows.length} saved report${rows.length===1?'':'s'}</td></tr>
    <tr><td colspan="${columns.length}" class="note" x:str>Saved Daily Report values. ${host?'Host / Cashier saved tip reports.':'Server deductions and bartender receipts share the BAR column.'} Draft-only rows are excluded.</td></tr>
    <tr>${columns.map(c=>'<th scope="col" x:str>'+safe(c[0])+'</th>').join('')}</tr></thead><tbody>${body}${totals}</tbody></table></body></html>`;
  // HTML-format .xls is also opened by spreadsheet importers that ignore CSS.
  // Legacy FONT/BGCOLOR attributes retain Arial 14 and the same visual styling
  // there; CSS and x:num remain for Excel. Values and formulas are unchanged.
  const portable=html.replace(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g,(match,trAttrs,cells)=>{
    const isTotals=/class="totals"/.test(trAttrs);
    const stripe=(trAttrs.match(/background:(#[0-9a-f]{6})/i)||[])[1]||'#ffffff';
    const output=cells.replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g,(cell,tag,attrs,content)=>{
      const cls=(attrs.match(/class="([^"]*)"/)||[])[1]||'';
      const has=name=>cls.split(/\s+/).includes(name);
      const dark=tag==='th'||has('title');
      const bg=dark?color:isTotals?'#dcece6':has('subtitle')?'#dcebf2':has('note')?'#f4f8fb':has('pending')?'#fff8e4':stripe;
      const ink=dark?'#ffffff':has('subtitle')?'#173f53':has('note')?'#496778':has('pending')?'#876323':isTotals?'#185343':'#183b4e';
      const bold=dark||isTotals||has('subtitle')||has('pending')||/font-weight:bold/.test(attrs);
      const align=has('money')||has('number')?'right':tag==='th'||has('signature')?'center':'left';
      const body=bold?'<b>'+content+'</b>':content;
      const nowrap=has('text')||has('money')||has('number')?' nowrap':'';
      return '<'+tag+attrs+nowrap+' bgcolor="'+bg+'" align="'+align+'" valign="middle"><font face="Arial" size="4" color="'+ink+'">'+body+'</font></'+tag+'>';
    });
    return '<tr'+trAttrs+'>'+output+'</tr>';
  });
  return new Blob(['\ufeff',portable],{type:'application/vnd.ms-excel;charset=utf-8'});
}
function es16DailyPdfBlob(rows,group,date){
  es16ExportGroup(group);
  const normalized=rows.map(r=>({...r,totalPaidOut:smallReportPaidOut(r),employeeGrandTotal:smallReportGrandTotal(r)}));
  return simplePdfBlob(normalized);
}
function es16ExportMessage(text,error=false){const out=$('es16ExportStatus');if(out){out.textContent=text;out.dataset.error=error?'1':'0';}}
function es16DailyExportControls(){
  const wrap=$('es16DailyExports');if(!wrap)return;
  const s=esSession,disabled=es16ExportBusy||!esAllowed()||!s?.ready||s.busy||s.uid!==currentUser?.uid;
  wrap.setAttribute('aria-busy',String(es16ExportBusy));
  for(const button of wrap.querySelectorAll('button'))button.disabled=disabled;
  const date=$('es16ExportDate');if(date)date.textContent=s?.date||'Select a work date';
}
window.employeeSheetDownload=async function(group,format){
  if(es16ExportBusy)return false;
  try{
    es16ExportGroup(group);if(!['xls','pdf'].includes(format))throw new Error('Choose XLS or PDF.');
    const date=$('esDate')?.value||esSession?.date||'';
    es16ExportSession(date);es16ExportBusy=true;es16DailyExportControls();
    es16ExportMessage('Loading saved '+es16ExportGroupTitle(group)+' reports for '+date+'…');
    if(hc15Session?.writing)await hc15Session.writing;
    const rows=await es16DailyExportRows(group,date);
    if(!rows.length){es16ExportMessage('No saved '+es16ExportGroupTitle(group)+' Daily Reports for '+date+'. Finish and save a row to Final Report, then download. Draft-only rows are not included.');return false;}
    const blob=format==='xls'?es16DailyXlsBlob(rows,group,date):es16DailyPdfBlob(rows,group,date);
    const file='Fred_Zhang_Daily_Report_'+(group==='server'?'Server_Bartender':'Host_Cashier')+'_'+date+'.'+format;
    downloadBlob(blob,file);es16ExportMessage('Downloaded '+rows.length+' saved '+es16ExportGroupTitle(group)+' report'+(rows.length===1?'':'s')+' · '+date+'. Names: '+rows.map(r=>r.employeeDisplayName||r.employee).join(', ')+(group==='host-cashier'&&es184ExportMissing.length?' · NOT included (not finalized): '+es184ExportMissing.join(', ')+'. Save these rows first.':''));return true;
  }catch(e){es16ExportMessage(e.message||'The saved report could not be downloaded. Please try again.',true);return false;}
  finally{es16ExportBusy=false;es16DailyExportControls();}
};
function es16DailyExportsInit(){
  if($('es16DailyExports')||!$('esGrid'))return;
  const section=document.createElement('section');section.id='es16DailyExports';section.className='es16-daily-exports';section.setAttribute('aria-labelledby','es16ExportTitle');
  section.innerHTML='<div class="es16-export-heading"><div><h3 id="es16ExportTitle">Download Daily Report</h3><p>Work date: <b id="es16ExportDate"></b></p></div><span class="es16-export-tag">Saved reports</span></div><p class="es16-export-note">Server includes Bartender. Downloads use the saved Daily Report for this date; draft-only rows are excluded.</p><div class="es16-export-buttons"><button type="button" data-es16-group="server" data-es16-format="xls">Download XLS Server</button><button type="button" data-es16-group="server" data-es16-format="pdf">Download PDF Server</button><button type="button" data-es16-group="host-cashier" data-es16-format="xls">Download XLS Host/Cashier</button><button type="button" data-es16-group="host-cashier" data-es16-format="pdf">Download PDF Host/Cashier</button></div><p id="es16ExportStatus" role="status" aria-live="polite"></p>';
  $('esGrid').appendChild(section);
  section.addEventListener('click',e=>{const b=e.target.closest('button[data-es16-group]');if(b)window.employeeSheetDownload(b.dataset.es16Group,b.dataset.es16Format);});
  es16DailyExportControls();
}
(function(){
  const init=esInit,render=esRenderRows,badge=esCompactReadBadge;
  esInit=function(...a){const out=init(...a);es16DailyExportsInit();return out;};
  esRenderRows=function(...a){const out=render(...a);es16DailyExportControls();return out;};
  esCompactReadBadge=function(...a){const out=badge(...a);es16DailyExportControls();return out;};
})();


/* ES1.7 — Owner recovery works on an explicit work date and the latest server
 * batch. The old recovery snapshot shape is retained for existing backups.
 * No hourlyReports or Host/Cashier documents are written by these actions.
 */
let es17RecoveryBusy=false;
// Final reports are an archive, not a request to recreate a team the Owner has
// explicitly cleared. Active rows added afterwards can still hydrate normally.
const es17PrepareBatchBeforeRecovery=esPrepareBatch;
esPrepareBatch=function(source,reports,date){
  const cleared=source?.trash?.scope==='team'&&(!source.trash.date||source.trash.date===date);
  const active=new Set((source?.team||[]).map(esKey));
  return es17PrepareBatchBeforeRecovery(source,cleared?(reports||[]).filter(r=>active.has(esKey(r.employee))):reports,date);
};
function es17RecoveryOwner(date,uid=currentUser?.uid){
  if(!currentUser||currentUser.isAnonymous||currentProfile?.role!=='owner'||currentUser.uid!==uid)throw new Error('Owner login required. Nothing was changed.');
  if(!esDateValid(date))throw new Error('Choose a valid work date.');
  if(!es14IsOnline())throw new Error('Reconnect before Clear All or Undo Clear All. Nothing was changed.');
  return uid;
}
function es17RecoveryHasBar(bar){
  return Object.values(bar||{}).some(p=>p&&(String(p.bartender||'').trim()||Object.values(p.entries||{}).some(v=>String(v??'').trim()!=='')));
}
function es17RecoveryHasTeam(raw){return !!((raw.team||[]).length||Object.keys(raw.drafts||{}).length||es17RecoveryHasBar(raw.bar));}
function es17RecoveryTrashKey(trash){return JSON.stringify(trash||null);}
function es17RecoverySummary(date,raw,exists=true){
  const trash=raw.trash&&['team','bar'].includes(raw.trash.scope)&&(!raw.trash.date||raw.trash.date===date)?raw.trash:null;
  const occupied=trash?.scope==='bar'?es17RecoveryHasBar(raw.bar):es17RecoveryHasTeam(raw);
  return {date,exists,teamCount:(raw.team||[]).length,draftCount:Object.keys(raw.drafts||{}).length,hasBar:es17RecoveryHasBar(raw.bar),canClear:es17RecoveryHasTeam(raw),canUndo:!!trash&&!occupied,
    trash:trash?{scope:trash.scope,date:trash.date||date,clearedAt:trash.clearedAt||0,clearedBy:trash.clearedBy||'staff'}:null};
}
async function es17RecoveryRead(date,uid){
  es17RecoveryOwner(date,uid);
  return runTransaction(db,async tx=>{
    const snap=await tx.get(doc(db,'hourlyV1Batches',date));es17RecoveryOwner(date,uid);
    if(snap.metadata?.fromCache===true||snap.metadata?.hasPendingWrites===true)throw new Error('The server has not confirmed this work date. Nothing was changed.');
    const raw=snap.exists()?snap.data():{};
    if(raw.date&&raw.date!==date)throw new Error('This batch has a different work date. Nothing was changed.');
    return {raw,exists:snap.exists()};
  });
}
window.es17LoadRecovery=async function(date){
  const uid=es17RecoveryOwner(date),result=await es17RecoveryRead(date,uid);
  return es17RecoverySummary(date,result.raw,result.exists);
};
window.es17PrepareToolsNavigation=async function(){
  if(!currentUser||currentUser.isAnonymous||currentProfile?.role!=='owner')throw new Error('Owner login required.');
  if(esSession?.busy||hc15Session?.busy||tt15State?.busy||esSignature||hc15Sig||hc15Credit)throw new Error('Finish the current save or close its dialog before opening Owner Tools.');
  if(esSession?.ready&&!esPersistLocal()&&(esHasEdits(esSession)||Object.keys(esSession.draftSaves||{}).length))throw new Error('Device draft could not be saved. Keep Employee Sheet open and retry.');
  if(hc15Session&&!hc15KeepLocal(hc15Session)&&(Object.keys(hc15Session.edits||{}).length||Object.keys(hc15Session.draftSaves||{}).length))throw new Error('Host / Cashier draft could not be saved. Keep Employee Sheet open and retry.');
  // Wait for writes already in flight. Invalid or conflicted inputs remain in
  // their device draft; merely opening Owner Tools does not discard them.
  if(esSession?.autoPromise)await esSession.autoPromise;
  if(hc15Session?.writing)await hc15Session.writing;
  return true;
};
function es17RecoveryCheckDeviceDraft(date,uid){
  const message='This date has a device draft waiting to be reviewed. Open Employee Sheet for '+date+' and sync or review it before clearing or restoring. Your draft is kept.';
  let text;try{text=localStorage.getItem(esDraftKey(date,uid));}catch(e){throw new Error('Device drafts could not be checked. Keep this page open and retry before clearing or restoring.');}
  if(!text)return;
  let saved;try{saved=JSON.parse(text);}catch(e){throw new Error(message);}
  // A work date selected in Tools may have a device draft even when another
  // date is currently open, or there is no Employee Sheet session at all.
  // Only an acknowledged, clean snapshot is safe to discard after Clear/Undo.
  if(!saved||typeof saved!=='object'||Array.isArray(saved)||saved.date&&saved.date!==date||!Array.isArray(saved.rows)||!Array.isArray(saved.baseRows))throw new Error(message);
  if(esHasEdits(saved)||saved.rows.some(row=>!row||typeof row.name!=='string'||ES_MONEY.some(field=>!es14MoneyValid(row[field]))||!es16RowMatches(row,saved.baseRows.find(base=>base?.name===row.name))))throw new Error(message);
  if(saved.draftSaves!=null){
    if(typeof saved.draftSaves!=='object'||Array.isArray(saved.draftSaves))throw new Error(message);
    for(const [name,entry]of Object.entries(saved.draftSaves))if(!entry||typeof entry!=='object'||!entry.row||entry.row.name!==name||!saved.rows.some(row=>row.name===name))throw new Error(message);
  }
}
async function es17RecoveryPause(date,uid){
  es17RecoveryOwner(date,uid);
  if(esSession?.busy||hc15Session?.busy||tt15State?.busy||esSignature||hc15Sig||hc15Credit)throw new Error('Finish the current save or close its dialog first.');
  await window.es17PrepareToolsNavigation();es17RecoveryOwner(date,uid);
  // The legacy queue can still contain a write started just before navigation.
  // Drain it before the transaction reads the source of the recovery snapshot.
  await hv1CloudWriteQueue.catch(()=>{});es17RecoveryOwner(date,uid);
  const s=esSession?.date===date&&esSession.uid===uid?esSession:null;
  if(!s){es17RecoveryCheckDeviceDraft(date,uid);return null;}
  clearTimeout(s.autoTimer);
  if(s.autoPromise)await s.autoPromise;
  if(esHasEdits(s)){
    if(!s.cloudReady)throw new Error('This date has device edits waiting to sync. Open Employee Sheet and sync or review them before clearing or restoring.');
    await es14AutoFlush(s);es17RecoveryOwner(date,uid);
    if(esHasEdits(s)||(s.conflicts||[]).length)throw new Error('This date still has unsynced or conflicting edits. Review Employee Sheet before clearing or restoring. Your draft is kept.');
  }
  es17RecoveryCheckDeviceDraft(date,uid);
  clearTimeout(s.autoTimer);s.busy=true;return s;
}
function es17RecoveryCache(date,uid,batch,s){
  // Change caches only after Firebase acknowledged the transaction. They must
  // never restore a cleared team on this device when Employee Sheet reopens.
  if(!currentUser||currentUser.uid!==uid||currentProfile?.role!=='owner')return false;
  let localCacheSaved=true;
  try{localStorage.setItem(HV1_STORAGE_PREFIX+date,JSON.stringify(batch));}catch(e){localCacheSaved=false;}
  for(const key of [esDraftKey(date,uid),esFastCacheKey(date,uid)])try{localStorage.removeItem(key);}catch(e){localCacheSaved=false;}
  if(s&&esSession===s){esStopRead();esSession=null;}
  return localCacheSaved;
}
async function es17RecoveryAction(date,mode){
  const uid=es17RecoveryOwner(date);if(es17RecoveryBusy)throw new Error('A recovery action is already running.');
  es17RecoveryBusy=true;let paused=null;
  try{
    paused=await es17RecoveryPause(date,uid);
    const before=await es17RecoveryRead(date,uid),summary=es17RecoverySummary(date,before.raw,before.exists);
    if(mode==='clear'&&!summary.canClear)return {...summary,changed:false};
    if(mode==='undo'&&!summary.trash)return {...summary,changed:false};
    if(mode==='undo'&&!summary.canUndo)throw new Error('New Team / BAR data exists for this date. Undo would replace it. Review or clear the new data first.');
    const text=mode==='clear'
      ? `Work date: ${date}. Clear the Server / Bartender team, drafts, and BAR data for this date? The current data moves to Recently Cleared${summary.trash?' and replaces its previous backup':''}. Saved Daily Reports and Host / Cashier stay unchanged.`
      : `Work date: ${date}. Restore the ${summary.trash.scope==='bar'?'BAR data':'Server / Bartender team, drafts, and BAR data'} cleared by ${summary.trash.clearedBy}? Saved Daily Reports and Host / Cashier stay unchanged.`;
    if(!await hv1RequireStaffPassword(mode==='clear'?'Clear All — '+date:'Undo Clear All — '+date,text))return {cancelled:true};
    es17RecoveryOwner(date,uid);
    const result=await runTransaction(db,async tx=>{
      const ref=doc(db,'hourlyV1Batches',date),snap=await tx.get(ref);es17RecoveryOwner(date,uid);
      if(snap.metadata?.fromCache===true||snap.metadata?.hasPendingWrites===true)throw new Error('The server has not confirmed this work date. Nothing was changed.');
      if(!snap.exists())throw new Error('This work date was removed. Nothing was changed.');
      const raw=snap.data();if(raw.date&&raw.date!==date)throw new Error('This batch has a different work date. Nothing was changed.');
      let batch={...raw};
      if(mode==='clear'){
        if(!es17RecoveryHasTeam(raw))return {batch:raw,changed:false};
        // Capture the fresh transaction read, never the preview or local cache.
        batch.trash={scope:'team',date,clearedAt:Date.now(),clearedBy:currentProfile.displayName||currentProfile.username||'',clearedByUid:uid,snapshot:{team:esClone(raw.team||[]),drafts:esClone(raw.drafts||{}),bar:esClone(raw.bar||{})}};
        batch.team=[];batch.drafts={};batch.bar={};
      }else{
        const trash=raw.trash;
        if(!trash||es17RecoveryTrashKey(trash)!==es17RecoveryTrashKey(before.raw.trash))throw new Error('Recently Cleared changed on another device. Reload Owner Tools and review the latest backup.');
        if(trash.date&&trash.date!==date)throw new Error('This backup belongs to another work date. Nothing was changed.');
        if(trash.scope==='team'){
          if(es17RecoveryHasTeam(raw))throw new Error('New Team / BAR data was added. Undo stopped to keep those entries.');
          batch.team=esClone(trash.snapshot?.team||[]);batch.drafts=esClone(trash.snapshot?.drafts||{});batch.bar=esClone(trash.snapshot?.bar||{});
        }else if(trash.scope==='bar'){
          if(es17RecoveryHasBar(raw.bar))throw new Error('New BAR data was added. Undo stopped to keep those entries.');
          batch={...raw,drafts:esClone(raw.drafts||{}),barManual:esClone(raw.barManual||{}),bar:esClone(trash.snapshot?.bar||{})};hv1ApplyBarAutomation(batch);
        }else throw new Error('This backup cannot be restored by Undo Clear All.');
        batch.trash=null;
      }
      batch.date=date;batch.employeeSheetRevision=Number(raw.employeeSheetRevision||0)+1;
      tx.set(ref,{...batch,updatedAt:serverTimestamp(),updatedByUid:uid,updatedBy:currentProfile.displayName||currentProfile.username||''});
      return {batch,changed:true};
    });
    const localCacheSaved=result.changed?es17RecoveryCache(date,uid,result.batch,paused):true;
    return {...es17RecoverySummary(date,result.batch,true),changed:result.changed,localCacheSaved};
  }finally{
    if(paused&&esSession===paused){paused.busy=false;es14Schedule(paused);}
    es17RecoveryBusy=false;
  }
}
window.es17ClearTeam=date=>es17RecoveryAction(date,'clear');
window.es17UndoTeam=date=>es17RecoveryAction(date,'undo');

/* ES1.7 — Owner administration beside App Info; daily Home has three cards. */
let es17ToolsState={open:false,section:'recovery',date:'',uid:'',busy:false,loading:false,request:0,summary:null};
const ES17_OWNER_SECTIONS=[['recovery','Clear All / Undo','↶'],['users','Users','♙'],['analytics','Chart','▥'],['history','History','◷'],['deletedItems','Deleted / Undo','↺']];
function es17ToolsAllowed(){return !!currentUser&&currentProfile?.role==='owner';}
function es17ToolsMessage(message,error=false){const n=$('ot17Status');if(n){n.textContent=message;n.dataset.error=error?'1':'0';}}
function es17ToolsControls(){
  const s=es17ToolsState,locked=s.busy||s.loading||!es17ToolsAllowed();
  if($('ot17WorkDate'))$('ot17WorkDate').disabled=s.busy;
  if($('ot17Reload'))$('ot17Reload').disabled=locked;
  if($('ot17Clear'))$('ot17Clear').disabled=locked||!s.summary?.canClear;
  if($('ot17Undo'))$('ot17Undo').disabled=locked||!s.summary?.canUndo;
  $('ownerToolsPage')?.setAttribute('aria-busy',String(s.busy||s.loading));
  for(const button of document.querySelectorAll('#ownerToolsPage [data-ot17-section],#ownerToolsPage [data-ot17-home]'))button.disabled=s.busy;
}
function es17InitOwnerTools(){
  if($('ownerToolsPage'))return;
  const staff=$('staffApp');if(!staff)return;
  const page=document.createElement('section');page.id='ownerToolsPage';page.className='ot17-panel hidden';
  page.innerHTML='<div class="ot17-header"><div class="ot17-heading"><div class="ot17-eyebrow">OWNER ACCESS</div><h2 tabindex="-1" id="ot17Title">Owner Tools</h2><p>Accounts, activity, recovery and work-date controls.</p></div><button type="button" class="btn light" data-ot17-home>‹ Home</button></div>'+
    '<nav class="ot17-grid ot17-nav" aria-label="Owner tools">'+ES17_OWNER_SECTIONS.map(([key,label,icon])=>'<button type="button" class="ot17-action" data-ot17-section="'+key+'"><span aria-hidden="true" class="ot17-action-icon">'+icon+'</span><b>'+label+'</b></button>').join('')+'</nav>'+
    '<div class="ot17-secondary"><button type="button" data-ot17-section="approvals">Employee Approvals</button><button type="button" data-ot17-section="setup">Setup</button></div>'+
    '<div id="ot17Recovery" class="ot17-recovery"><div class="ot17-date-row"><label for="ot17WorkDate">Work date<input type="date" id="ot17WorkDate"></label><button type="button" id="ot17Reload" class="btn light">Refresh</button></div><h3>Clear All &amp; Undo Clear All</h3>'+
    '<p>Clear the Server / Bartender team, input drafts and BAR data for the selected date. Saved Final Reports and Host/Cashier data are kept.</p><div id="ot17RecoverySummary" class="ot17-note" aria-live="polite">Choose a work date to check its team and recovery backup.</div>'+
    '<div class="ot17-clear-actions"><button type="button" id="ot17Clear" class="btn red" disabled>Clear All</button><button type="button" id="ot17Undo" class="btn gold" disabled>Undo Clear All</button></div><p class="ot17-footnote">Your Owner password is required. Undo restores the latest available clear backup for this date.</p></div>'+
    '<p id="ot17Status" role="status" aria-live="polite"></p>';
  staff.insertBefore(page,staff.firstChild);
  page.addEventListener('click',event=>{const home=event.target.closest?.('[data-ot17-home]');if(home){window.fzOpenRoleHome();return;}const b=event.target.closest?.('[data-ot17-section]');if(b)es17ShowOwnerSection(b.dataset.ot17Section);});
  $('ot17WorkDate').addEventListener('change',()=>{if(es17ToolsState.busy)return;es17ToolsState.date=$('ot17WorkDate').value;void es17RefreshRecovery();});
  $('ot17Reload').addEventListener('click',()=>void es17RefreshRecovery());
  $('ot17Clear').addEventListener('click',()=>void es17RunRecoveryAction('clear'));
  $('ot17Undo').addEventListener('click',()=>void es17RunRecoveryAction('undo'));
}
function es17ShowOwnerSection(section='recovery'){
  const s=es17ToolsState;if(!es17ToolsAllowed()||!s.open||s.uid!==currentUser.uid||s.busy)return false;
  if(![...ES17_OWNER_SECTIONS.map(x=>x[0]),'approvals','setup'].includes(section))return false;
  s.section=section;if(section!=='recovery'){++s.request;s.loading=false;}document.querySelectorAll('.staffPanel').forEach(n=>n.classList.add('hidden'));
  $('ot17Recovery').hidden=section!=='recovery';
  for(const b of document.querySelectorAll('#ownerToolsPage [data-ot17-section]')){
    if(b.dataset.ot17Section===section)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  }
  if(section!=='recovery'){
    const target=document.querySelector('[data-stab="'+section+'"]');
    if(target)target.click();else $(section)?.classList.remove('hidden');
    es17ToolsMessage('');
  }else void es17RefreshRecovery();
  $('ownerToolsPage').classList.remove('hidden');es17ToolsControls();return true;
}
async function es17RefreshRecovery(){
  const s=es17ToolsState;if(!es17ToolsAllowed()||!s.open||s.uid!==currentUser.uid)return false;
  const date=$('ot17WorkDate')?.value||s.date,request=++s.request,uid=currentUser.uid;
  s.date=date;s.summary=null;s.loading=true;es17ToolsControls();es17ToolsMessage('Checking saved team and recovery backup…');
  try{
    const summary=await es17LoadRecovery(date);
    if(!s.open||s.request!==request||s.date!==date||!es17ToolsAllowed()||currentUser.uid!==uid)return false;
    s.summary=summary;
    const parts=[date+' · '+summary.teamCount+' team member'+(summary.teamCount===1?'':'s')+' · '+summary.draftCount+' input draft'+(summary.draftCount===1?'':'s')];
    parts.push(summary.trash?'Recovery backup: '+(summary.trash.scope==='bar'?'BAR data':'Team + drafts + BAR')+(summary.trash.clearedBy?' · cleared by '+summary.trash.clearedBy:''):'No Clear All backup for this date.');
    if(summary.trash&&!summary.canUndo)parts.push('New team or BAR inputs exist. Undo is paused to protect those entries.');
    $('ot17RecoverySummary').textContent=parts.join('\n');es17ToolsMessage('');return true;
  }catch(e){if(s.open&&s.request===request){$('ot17RecoverySummary').textContent='The selected date could not be checked. Reconnect and refresh.';es17ToolsMessage(e.message||String(e),true);}return false;}
  finally{if(s.request===request){s.loading=false;es17ToolsControls();}}
}
async function es17RunRecoveryAction(action){
  const s=es17ToolsState;if(!es17ToolsAllowed()||!s.open||s.uid!==currentUser.uid||s.busy||s.loading)return false;
  const date=$('ot17WorkDate')?.value||s.date,uid=currentUser.uid;
  if(date!==s.date||!s.summary||(action==='clear'?!s.summary.canClear:!s.summary.canUndo))return false;
  s.busy=true;es17ToolsControls();es17ToolsMessage(action==='clear'?'Waiting for confirmation to clear '+date+'…':'Waiting for confirmation to restore '+date+'…');
  try{
    const result=await (action==='clear'?es17ClearTeam(date):es17UndoTeam(date));
    if(!s.open||!es17ToolsAllowed()||currentUser.uid!==uid)return false;
    const canceled=result===false||result?.cancelled;
    await es17RefreshRecovery();
    const message=canceled?'Canceled.':result?.changed===false?'Nothing to '+(action==='clear'?'clear':'restore')+' for '+date+'.':action==='clear'?'Team, drafts and BAR cleared for '+date+'. Undo backup saved.':'Clear All undone for '+date+'.';
    es17ToolsMessage(message+(result?.localCacheSaved===false?' Cloud saved. Reopen Employee Sheet online to refresh this device.':''));
    return !canceled;
  }catch(e){es17ToolsMessage(e.message||String(e),true);return false;}
  finally{s.busy=false;es17ToolsControls();}
}
function es17CloseOwnerTools(){
  const s=es17ToolsState;s.open=false;s.loading=false;s.summary=null;++s.request;
  $('ownerToolsPage')?.classList.add('hidden');document.body.classList.remove('ot17-active');
}
window.fzOpenOwnerTools=async function(section='recovery'){
  if(!es17ToolsAllowed()||es17ToolsState.busy)return false;
  if(tt15State?.editing&&!tt15MayLeave())return false;
  const uid=currentUser.uid;
  try{
    await es17PrepareToolsNavigation();
    if(!es17ToolsAllowed()||currentUser.uid!==uid)return false;
    es17InitOwnerTools();if(!$('ownerToolsPage'))return false;
    tt15Close();hc15Stop();esStopRead();frExit();
    $('fzRoleHome')?.classList.add('hidden');$('employeeApp')?.classList.add('hidden');$('staffApp')?.classList.remove('hidden');$('hourlyV1Workspace')?.classList.add('hidden');
    document.body.classList.remove('es-active','hourly-v1-mode','hourly-v1-editing','hourly-v1-small-report','hourly-workspace-mode','small-report-fullscreen');document.documentElement.classList.remove('small-report-fullscreen');
    const s=es17ToolsState;s.open=true;s.uid=uid;s.date=esDateValid(esSession?.date)?esSession.date:esDateValid(s.date)?s.date:todayLocal();
    $('ot17WorkDate').value=s.date;document.body.classList.add('ot17-active');es17ShowOwnerSection(section);window.scrollTo({top:0,left:0,behavior:'instant'});$('ot17Title')?.focus?.();return true;
  }catch(e){if(typeof esStatus==='function'&&esSession?.ready)esStatus(e.message||String(e),true);alert(e.message||String(e));return false;}
};
(function(){
  for(const name of ['fzOpenRoleHome','fzOpenManagerTools','fzOpenFinalReport','fzOpenMonthlyReport','fzOpenTodayTeam','employeeSheetOpen','fzOpenHostCashier','fzOpenTipCalculation']){
    const original=window[name];if(typeof original!=='function')continue;
    window[name]=function(...args){if(es17ToolsState.open&&es17ToolsState.busy)return false;es17CloseOwnerTools();return original(...args);};
  }
  try{onAuthStateChanged(auth,user=>{if(!user||user.uid!==es17ToolsState.uid||!es17ToolsAllowed())es17CloseOwnerTools();});}catch(e){}
})();


/* ES1.8.2 — fixed-cents money entry and acknowledged signature close.
 * No changes to authentication, permissions, payroll engines or stored units.
 * Stored monetary values remain DOLLARS, not cents. Formatting is input-only.
 */
function es182StableJson(value){
  const order=v=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;
  return JSON.stringify(order(value));
}
function es182MoneyDisplay(value){
  const text=String(value??'').trim();
  return text===''?'':es14MoneyValid(text)?Number(text).toFixed(2):text;
}
function es182CentsDisplay(digits){
  let text=String(digits||'0').replace(/^0+(?=\d)/,'');
  if(!/^\d+$/.test(text)||text.length>14)return null;
  text=text.padStart(3,'0');return text.slice(0,-2)+'.'+text.slice(-2);
}
function es182MoneyPaste(text){
  text=String(text??'').trim();
  if(/^\d+$/.test(text))return es182CentsDisplay(text);
  // An explicitly formatted dollar amount keeps its value. Do not strip a
  // minus, letters, an extra decimal or exponent and turn it into different money.
  if(!/^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+|)(?:\.\d{1,2})?$/.test(text)||!/[\d]/.test(text))return null;
  const clean=text.replace(/[$,\s]/g,'');
  if(!es14MoneyValid(clean))return null;
  const [whole,part='']=clean.split('.');return es182CentsDisplay((whole||'0')+part.padEnd(2,'0'));
}
function es182MoneyEdit(value,type,data,start,end,replace=false){
  value=String(value??'');start=Math.max(0,Number(start)||0);end=Math.max(start,Number(end)||0);
  const digits=value.replace(/\D/g,''),a=value.slice(0,start).replace(/\D/g,'').length,b=value.slice(0,end).replace(/\D/g,'').length;
  let result;
  if(type==='insertText'||type==='insertReplacementText'||type==='insertCompositionText'){
    if(!/^\d+$/.test(String(data??'')))return null;
    result=replace?String(data):digits.slice(0,a)+String(data)+digits.slice(b);
  }else if(type==='deleteContentBackward')result=replace?'':a!==b?digits.slice(0,a)+digits.slice(b):digits.slice(0,Math.max(0,a-1))+digits.slice(a);
  else if(type==='deleteContentForward')result=replace?'':a!==b?digits.slice(0,a)+digits.slice(b):digits.slice(0,a)+digits.slice(a+1);
  else if(type==='deleteByCut')result=replace?'':digits.slice(0,a)+digits.slice(b);
  else return null;
  return es182CentsDisplay(result);
}
const es182MoneyStates=new WeakMap();
function es182IsMoneyInput(el){
  if(!el||el.tagName!=='INPUT'||el.disabled||el.readOnly)return false;
  return ES_MONEY.includes(el.dataset?.esField)||!!el.dataset?.hc15Pool||(el.hasAttribute?.('data-hc15-account')&&el.dataset.key==='amount');
}
function es182MoneyState(el){
  let state=es182MoneyStates.get(el);
  if(!state){state={replaceNext:false,before:null};es182MoneyStates.set(el,state);}return state;
}
function es182MoneySnapshot(el,state){return {value:el.value,start:el.selectionStart??el.value.length,end:el.selectionEnd??el.value.length,replace:state.replaceNext};}
function es182SetMoneyInput(el,value,notify=true){
  el.value=value;const state=es182MoneyState(el);state.replaceNext=false;state.before=null;
  try{el.setSelectionRange(value.length,value.length);}catch(e){}
  if(notify){const event=new Event('input',{bubbles:true});event.fz182MoneyReady=true;el.dispatchEvent(event);}
}
function es182InstallMoneyInputs(){
  if(window.__fz182MoneyInstalled)return;window.__fz182MoneyInstalled=true;
  document.addEventListener('focusin',e=>{
    const el=e.target;if(!es182IsMoneyInput(el))return;
    el.inputMode='numeric';el.setAttribute('data-es182-money','1');el.value=es182MoneyDisplay(el.value);
    const state=es182MoneyState(el);state.replaceNext=true;state.before=null;
    try{el.select();}catch(e){}
    if(el.dataset.esField)esStatus('Money: type digits only — 2000 = 20.00, 200 = 2.00. First digit replaces the old amount.');
  },true);
  document.addEventListener('beforeinput',e=>{
    const el=e.target;if(!es182IsMoneyInput(el)||e.isComposing)return;
    const state=es182MoneyState(el),snap=es182MoneySnapshot(el,state);state.before=snap;
    if(e.inputType==='insertFromPaste'||e.inputType==='insertFromDrop')return;
    const value=es182MoneyEdit(snap.value,e.inputType,e.data,snap.start,snap.end,snap.replace);
    if(!e.cancelable)return; // Samsung/IME fallback is handled by the input event.
    if(value!==null){e.preventDefault();es182SetMoneyInput(el,value);}
    else if(/^insert/.test(e.inputType||'')||/^delete/.test(e.inputType||'')){e.preventDefault();state.before=null;}
  },true);
  document.addEventListener('input',e=>{
    const el=e.target;if(!es182IsMoneyInput(el)||e.fz182MoneyReady)return;
    const state=es182MoneyState(el),snap=state.before;state.before=null;
    if(e.isComposing){e.stopImmediatePropagation();return;}
    let value=snap?es182MoneyEdit(snap.value,e.inputType,e.data,snap.start,snap.end,snap.replace):null;
    if(value===null)value=es182MoneyPaste(el.value);
    if(el.value==='')value='0.00';
    if(value===null){el.value=snap?.value??'';e.stopImmediatePropagation();esStatus('Enter digits only, or paste an amount such as 20.00.',true);return;}
    es182SetMoneyInput(el,value,false);
  },true);
  document.addEventListener('paste',e=>{
    const el=e.target;if(!es182IsMoneyInput(el))return;
    const text=e.clipboardData?.getData('text');if(text==null)return;
    e.preventDefault();const value=es182MoneyPaste(text);
    if(value===null){esStatus('Amount not pasted. Use digits or an amount such as 20.00; no negative values.',true);return;}
    es182SetMoneyInput(el,value);
  },true);
  document.addEventListener('compositionend',e=>{
    const el=e.target;if(!es182IsMoneyInput(el))return;
    const value=es182MoneyPaste(el.value);if(value!==null)es182SetMoneyInput(el,value);
  },true);
  document.addEventListener('focusout',e=>{
    const el=e.target;if(!es182IsMoneyInput(el))return;
    es182MoneyState(el).before=null;el.value=es182MoneyDisplay(el.value);
  },true);
}
async function es182PrepareSignature(name){
  const s=esSession;
  if(!es14AllowedSession(s)||!s.ready)throw new Error('Manager / Owner session required.');
  if(!s.cloudReady||!es14IsOnline())throw new Error('Reconnect before signing. Your input stays on this device.');
  clearTimeout(s.autoTimer);await es14AutoFlush(s);
  if(esSession!==s||!es14AllowedSession(s))throw new Error('Login or work date changed.');
  const ref=doc(db,'hourlyV1Batches',s.date),reports=esClone(s.reports);
  const latest=await runTransaction(db,async tx=>{
    const snap=await tx.get(ref);
    if(!es14AllowedSession(s)||esSession!==s)throw new Error('Login or work date changed.');
    if(!snap.exists()&&s.hadCloud)throw new Error('This work date was removed. Your draft is kept.');
    const raw=snap.exists()?snap.data():s.baseBatch;
    const id=raw.drafts?.[name]?.hourlyReportId||esFindReport(reports,name)?.id;
    if(!id)return {raw,reports,exists:snap.exists()};
    const reportRef=doc(db,'hourlyReports',id),reportSnap=await tx.get(reportRef);
    if(!reportSnap.exists())return {raw,reports,exists:snap.exists()};
    const report={...reportSnap.data(),id};
    if(!hourlyReportBelongsTo(report,name,s.date))throw new Error('Saved report belongs to a different employee/date.');
    return {raw,reports:[report,...reports.filter(r=>r.id!==id)],exists:snap.exists()};
  });
  if(esSession!==s||!es14AllowedSession(s))throw new Error('Login or work date changed.');
  if(latest.exists)es14AcceptCommit(s,latest.raw,latest.reports,null);
  else es14Rebase(s,latest.raw,latest.reports);
  const conflicts=(s.conflicts||[]).filter(c=>c.name===name||c.name==='BAR routing');
  if(conflicts.length)throw es14ConflictError(conflicts);
  esRecalculate();
}
async function es182SaveSignature(){
  if(!esSignature||esSession?.busy)return false;
  if(esSignature.strokes.reduce((n,s)=>n+s.length,0)<4){$('esSignStatus').textContent='Please sign inside the box first.';return false;}
  const sign=esSignature,payload=esSerializeSignature(sign.strokes);
  esSetBusy(true);$('esSignStatus').textContent='Saving report and signature…';
  let saved=false;
  try{
    await esCommit(sign.name,payload,sign.fingerprint);
    // This point is reached ONLY after the report + signature transaction is
    // acknowledged. Never close merely because a stroke was drawn or queued.
    saved=true;esSignature=null;$('esSignatureModal').classList.add('hidden');
    $('esConflictModal')?.classList.add('hidden');
    esStatus(sign.name+' saved and signed · Final Report updated.');return true;
  }catch(e){
    es14HandleError(e);$('esSignStatus').textContent=e.message||String(e);
    if(e.esAmountsChanged)$('esSignReview')?.classList.remove('hidden');return false;
  }finally{
    esSetBusy(false);esRenderRows();esRenderRouting();
    if(saved)es14RestoreScroll(sign.scroll,sign.name);
  }
}
(function(){
  const originalSign=window.employeeSheetSign;
  window.employeeSheetSign=async function(name){
    if(!esAllowed()||esSession?.busy||esSignature)return;
    let ready=false;esSetBusy(true);esStatus('Checking latest amounts before signature…');
    try{await es182PrepareSignature(name);ready=true;}
    catch(e){es14HandleError(e);}
    finally{esSetBusy(false);es14Paint();esRenderRouting();}
    if(ready)originalSign(name);
  };
  const hostPaint=hc15UpdateValues;
  hc15UpdateValues=function(...args){
    const result=hostPaint(...args);
    for(const input of document.querySelectorAll('[data-hc15-pool]'))if(input!==document.activeElement){input.inputMode='numeric';input.value=es182MoneyDisplay(input.value);}
    return result;
  };
  es182InstallMoneyInputs();
})();


/* ES1.8.4 — Host/Cashier mobile reads and tip-only reports.
 * Server-only snapshots do not own the Host/Cashier report cache. Export reads
 * the selected work date from the server, never from a device's draft/list.
 * Nothing in this read/recovery path creates or finalizes reports.
 */
let es184ExportMissing=[];
function es184ReadGuard(uid){
  if(!esAllowed()||!currentUser||currentUser.uid!==uid)throw new Error('Login changed. Please reopen the report.');
  if(!es14IsOnline())throw new Error('Reconnect to download the latest saved Daily Report.');
}
function es184CheckSnapshot(snap){
  if(!snap||snap.metadata?.fromCache===true||snap.metadata?.hasPendingWrites===true)throw new Error('Saved reports are still syncing. Please try again when connected.');
  return snap;
}
async function es184HttpRead(kind,date,uid,guard,id=''){
  es184ReadGuard(uid);guard();
  if(typeof currentUser.getIdToken!=='function'||typeof fetch!=='function')throw new Error('Server connection is unavailable. Retry when connected.');
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Server read timed out. No partial report was downloaded. Tap Refresh from server, then retry.'));},10000);}),
    (async()=>{
      const token=await currentUser.getIdToken();es184ReadGuard(uid);guard();
      const prefix='projects/'+FIREBASE_CONFIG.projectId+'/databases/(default)/documents';
      const root='https://firestore.googleapis.com/v1/'+prefix;
      const path=kind==='host'?'hostCashierTipReports/'+date:kind==='report'?'hourlyReports/'+id:'';
      const resource=path?prefix+'/'+path:'';
      const body=kind==='reports'?{structuredQuery:{from:[{collectionId:'hourlyReports'}],where:{fieldFilter:{field:{fieldPath:'date'},op:'EQUAL',value:{stringValue:date}}}}}:{documents:[resource]};
      const response=await fetch(root+(kind==='reports'?':runQuery':':batchGet'),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:controller.signal});
      const json=await response.json();es184ReadGuard(uid);guard();
      if(!response.ok){const error=new Error(json?.error?.message||'Server read failed. No partial report was downloaded.');error.code=response.status===403?'permission-denied':response.status===401?'unauthenticated':String(response.status);throw error;}
      if(!Array.isArray(json)||!json.length||json.some(x=>x.error))throw new Error('Invalid server response. No partial report was downloaded.');
      const decode=d=>esDecodeFirestore({mapValue:{fields:d.fields||{}}});
      if(kind!=='reports'){
        if(json.length!==1)throw new Error('Unexpected server document response.');
        if(json[0].found?.name===resource)return {exists:true,data:decode(json[0].found)};
        if(json[0].missing===resource)return {exists:false,data:{}};
        throw new Error('Server response does not match this work date.');
      }
      if(json.some(x=>!x.document&&!x.readTime))throw new Error('Incomplete report response. Please retry.');
      return json.filter(x=>x.document).map(x=>{
        const doc=x.document;if(!doc.name.startsWith(prefix+'/hourlyReports/'))throw new Error('Unexpected report identity.');
        const row={...decode(doc),id:doc.name.split('/').pop()};if(row.date!==date)throw new Error('Unexpected work date in report response.');return row;
      });
    })()
  ]);}finally{clearTimeout(timer);controller.abort();}
}
async function es184CloudRead(kind,date,guard=()=>{},id=''){
  const uid=currentUser?.uid;es184ReadGuard(uid);guard();
  if(!esDateValid(date)||!['reports','host','report'].includes(kind)||kind==='report'&&(!id||id.includes('/')))throw new Error('Invalid report request.');
  let timer;
  try{
    const ref=kind==='reports'?query(collection(db,'hourlyReports'),where('date','==',date)):doc(db,kind==='host'?'hostCashierTipReports':'hourlyReports',kind==='host'?date:id);
    const read=kind==='reports'?(typeof getDocsFromServer==='function'?getDocsFromServer:getDocs):(typeof getDocFromServer==='function'?getDocFromServer:getDoc);
    const snap=await Promise.race([
      read(ref),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Server connection taking too long.')),4000);})
    ]);
    es184ReadGuard(uid);guard();es184CheckSnapshot(snap);
    if(kind!=='reports')return {exists:snap.exists(),data:snap.exists()?snap.data():{}};
    if(!Array.isArray(snap.docs))throw new Error('Invalid server report list.');
    return snap.docs.map(d=>({...d.data(),id:d.id})).filter(r=>r.date===date);
  }catch(error){
    es184ReadGuard(uid);guard();
    // A rules denial is never treated as an empty date or retried anonymously.
    if(/permission|unauthenticated/i.test(String(error.code||'')))throw error;
    if(typeof fetch!=='function'||typeof currentUser?.getIdToken!=='function')throw error;
    return await es184HttpRead(kind,date,uid,guard,id);
  }finally{clearTimeout(timer);}
}
async function es184SavedReports(date,guard=()=>{}){
  const rows=await es184CloudRead('reports',date,guard);guard();
  // Replace exactly one complete date; neither host nor server rows are omitted.
  latestHourlyReports=[...rows,...latestHourlyReports.filter(r=>r.date!==date)];
  return rows;
}
async function hc184CompleteSavedRows(rows,date,guard=()=>{}){
  es184ExportMissing=[];
  const current=await es184CloudRead('host',date,guard);guard();
  if(!current.exists)return rows;
  const data=current.data;if(data.date&&data.date!==date)throw new Error('Host / Cashier work date mismatch.');
  const map=new Map(rows.map(r=>[r.id,r]));
  // Another device may finish a save between the query and the team read. Read
  // those explicit final-report IDs too; never synthesize a finalized document.
  for(const [key,final]of Object.entries(data.sheetFinalized||{})){
    const id=String(final?.id||'');if(!id||map.has(id))continue;
    const saved=await es184CloudRead('report',date,guard,id);guard();
    if(!saved.exists)throw new Error('A saved Host / Cashier report is unavailable ('+id+'). Refresh the reports and retry; no partial download was created.');
    const r={...saved.data,id};
    if(r.date!==date||!es16ExportIsHost(r)||tt15Key(r.employee)!==key)throw new Error('Host / Cashier report identity mismatch. No partial download was created.');
    map.set(id,r);
  }
  // Read-only enrichment for older saved reports; never changes a payout or signature.
  const output=[...map.values()].map(r=>hc185WithPoolSummary(r,{...data,date:data.date||date}));
  es184ExportMissing=tt15TeamRows({},data).filter(member=>!output.some(r=>r.employee===member.name)).map(member=>tt15Label(member.name));
  if(hc15Session?.date===date&&hc15Session.uid===currentUser.uid&&!hc15Session.busy)hc15Accept(hc15Session,data,true);
  const ids=new Set(output.map(r=>r.id));latestHourlyReports=[...output,...latestHourlyReports.filter(r=>!ids.has(r.id))];
  return output;
}
async function hc184Refresh(s=hc15Session,manual=false){
  if(!s||s!==hc15Session||!esAllowed()||s.uid!==currentUser?.uid||s.busy)return false;
  if(s.refreshing)return s.refreshing;
  const epoch=s.readEpoch=(Number(s.readEpoch)||0)+1;
  const guard=()=>{if(hc15Session!==s||s.readEpoch!==epoch||!esAllowed()||currentUser.uid!==s.uid)throw new Error('Host / Cashier date or login changed.');};
  if(manual){s.error='Refreshing Host / Cashier from server…';hc15UpdateValues();}
  s.refreshing=(async()=>{
    try{
      const result=await es184CloudRead('host',s.date,guard);guard();
      if(s.writing)await s.writing;guard();
      s.loaded=true;s.hadCloud ||= result.exists;
      const data=result.exists?result.data:{date:s.date};
      if(data.date&&data.date!==s.date)throw new Error('Host / Cashier server date mismatch.');
      if(Number(data.sheetRevision||0)<Number(s.data?.sheetRevision||0)&&s.verified)return true;
      s.error='';s.deviceRestored=false;hc15Accept(s,data,true);return true;
    }catch(e){if(hc15Session===s&&s.readEpoch===epoch){s.error=e.message||'Host / Cashier could not sync. Tap Refresh from server.';if(manual)s.verified=false;hc15Render();}return false;}
    finally{if(hc15Session===s){s.refreshing=null;hc15Render();}}
  })();
  return s.refreshing;
}
function hc184Resume(){if(document.visibilityState!=='hidden'&&esAllowed()&&document.body.classList.contains('es-active')&&hc15Session&&!hc15Session.busy)void hc184Refresh(hc15Session);}
window.addEventListener('online',hc184Resume);window.addEventListener('pageshow',hc184Resume);document.addEventListener('visibilitychange',hc184Resume);
async function es184FinalDailyRows(){
  const uid=currentUser?.uid,date=$('smallReportDate')?.value||'',employee=$('smallReportEmployee')?.value||'';
  es184ReadGuard(uid);if(!esDateValid(date))throw new Error('Choose a work date before downloading the Daily Report.');
  const guard=()=>{es184ReadGuard(uid);if(($('smallReportDate')?.value||'')!==date||($('smallReportEmployee')?.value||'')!==employee)throw new Error('Report filter changed. Please download again.');};
  const all=await es184SavedReports(date,guard);
  const host=await hc184CompleteSavedRows(all.filter(es16ExportIsHost),date,guard);guard();
  return [...all.filter(r=>!es16ExportIsHost(r)),...host].filter(r=>!employee||r.employee===employee).sort((a,b)=>String(a.employee).localeCompare(String(b.employee)));
}
function hc184TipAmount(r,period){
  const value=r['hostCashierTip'+period];
  if(value!==undefined&&value!==null&&Number.isFinite(Number(value)))return Number(value);
  // Old single-shift saved reports can be shown without inventing a split.
  const shift=String(r.shift||'').toUpperCase();
  if(shift==='PM')return period==='PM'?smallReportPaidOut(r):0;
  if(shift==='AM'||/10:45|14:00\s*-\s*16:00/.test(shift))return period==='AM'?smallReportPaidOut(r):0;
  return null;
}
/* ES1.8.5 - per-employee Host / Cashier PDF pool summary.
 * New reports retain an immutable, date-scoped pool snapshot at final Save.
 * An old report may use fresh server data only when that period's saved pool,
 * count and personal allocation all match. No inferred Cash/Credit zeros and
 * no count based on the number of reports selected for export.
 */
function hc185MoneyCents(value){
  if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!value.trim()))return null;
  const n=Number(value);if(!Number.isFinite(n)||n<0)return null;
  const cents=Math.round(n*100+1e-7);return Number.isSafeInteger(cents)?cents:null;
}
function hc185Count(value){
  if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!value.trim()))return null;
  const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;
}
function hc185PoolSummaryFromData(data,metrics=hc15Math(data)){
  const summary={version:1,date:String(data.date||'')};
  for(const cp of ['AM','PM']){
    const cash=hc185MoneyCents(data['cash'+cp]??0),credit=hc185MoneyCents(data['credit'+cp]??0);
    if(cash===null||credit===null)throw new Error('Enter a valid Host / Cashier '+cp+' pool amount.');
    summary[cp]={cash:cash/100,credit:credit/100,total:metrics['pool'+cp],employeeCount:metrics['count'+cp],source:'saved'};
  }
  return summary;
}
function hc185SavedPoolPeriod(r,cp){
  const total=hc185MoneyCents(r['hostCashierPool'+cp]),count=hc185Count(r['hostCashierCount'+cp]);
  const raw=r.hostCashierPoolSummary;
  const p=raw?.version===1&&raw.date===r.date?raw[cp]:null;
  if(p){
    const cash=hc185MoneyCents(p.cash),credit=hc185MoneyCents(p.credit),sum=hc185MoneyCents(p.total),n=hc185Count(p.employeeCount);
    if(cash!==null&&credit!==null&&sum!==null&&n!==null&&cash+credit===sum&&(total===null||sum===total)&&(count===null||n===count))
      return {cash:cash/100,credit:credit/100,total:sum/100,employeeCount:n,complete:true,source:p.source==='matched-date'?'matched-date':'saved'};
  }
  return {cash:null,credit:null,total:total===null?null:total/100,employeeCount:count,complete:false};
}
function hc185WithPoolSummary(r,data){
  if(!es16ExportIsHost(r)||!data||data.date!==r.date)return r;
  const missing=['AM','PM'].filter(cp=>!hc185SavedPoolPeriod(r,cp).complete);if(!missing.length)return r;
  let m;try{m=hc15Math(data);}catch(e){return r;}
  let fresh;try{fresh=hc185PoolSummaryFromData(data,m);}catch(e){return r;}
  const summary={version:1,date:r.date};let changed=false;
  for(const cp of ['AM','PM']){
    const saved=hc185SavedPoolPeriod(r,cp);
    if(saved.complete){summary[cp]={cash:saved.cash,credit:saved.credit,total:saved.total,employeeCount:saved.employeeCount,source:saved.source};continue;}
    const sameTotal=hc185MoneyCents(saved.total)!==null&&hc185MoneyCents(saved.total)===hc185MoneyCents(m['pool'+cp]);
    const sameCount=saved.employeeCount!==null&&saved.employeeCount===m['count'+cp];
    const own=hc184TipAmount(r,cp),allocation=m['amounts'+cp]?.[r.employee]??0;
    const sameShare=hc185MoneyCents(own)!==null&&hc185MoneyCents(own)===hc185MoneyCents(allocation);
    if(sameTotal&&sameCount&&sameShare){summary[cp]={...fresh[cp],source:'matched-date'};changed=true;}
  }
  return changed?{...r,hostCashierPoolSummary:summary}:r;
}
function hc185PoolPerEmployee(period){
  const cents=hc185MoneyCents(period.total),n=hc185Count(period.employeeCount);
  if(cents===null||n===null)return {text:'Not recorded',rounding:false};
  if(n===0)return {text:'N/A (no employees)',rounding:false};
  const base=Math.floor(cents/n),extra=cents%n;
  return {text:extra?pdfMoney(base/100)+' - '+pdfMoney((base+1)/100):pdfMoney(base/100),rounding:extra>0};
}
// Standard Helvetica width metrics; no embedded font or external PDF library.
const HC185_PDF_WIDTHS={"F1":[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],"F2":[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]};
function hc185PdfWidth(font,size,value){return [...String(value)].reduce((n,ch)=>n+(HC185_PDF_WIDTHS[font]?.[ch.charCodeAt(0)-32]??556),0)*size/1000;}
function hc185PdfText(font,size,x,y,value,maxWidth=548,right=false){
  let v=String(value??''),width=hc185PdfWidth(font,size,v);
  if(width>maxWidth){size=Math.max(8,size*maxWidth/width);width=hc185PdfWidth(font,size,v);}
  if(width>maxWidth){while(v&&hc185PdfWidth(font,size,v+'...')>maxWidth)v=v.slice(0,-1);v+='...';width=hc185PdfWidth(font,size,v);}
  return `BT /${font} ${size.toFixed(2)} Tf ${(right?x-width:x).toFixed(2)} ${y} Td (${pdfEscape(v)}) Tj ET\n`;
}
function hc184PdfReportContent(r,index,total){
  const text=hc185PdfText;
  const box=(x,y,w,h,color)=>`${color} rg ${x} ${y} ${w} ${h} re f\n0 0 0 rg\n`;
  const line=(y)=>`0.80 0.86 0.85 RG 0.65 w 32 ${y} m 580 ${y} l S\n0 0 0 RG\n`;
  const tip=cp=>{const n=hc184TipAmount(r,cp);return n===null?'Not available':pdfMoney(n);};
  let c=box(0,704,612,88,'0.06 0.20 0.17')+'1 1 1 rg\n';
  c+=text('F2',20,32,757,'FRED ZHANG TIP CALCULATOR');
  c+=text('F1',11,32,734,'HOST / CASHIER - DAILY TIP REPORT');
  c+=text('F1',10,32,716,'Work date: '+String(r.date||'-'));
  c+=text('F1',10,580,716,`REPORT ${index+1} / ${total}`,130,true)+'0 0 0 rg\n';
  let missing=false,rounded=false,matched=false;
  for(const [cp,x]of [['AM',32],['PM',314]]){
    const p=hc185SavedPoolPeriod(r,cp),share=hc185PoolPerEmployee(p);missing ||= !p.complete;rounded ||= share.rounding;matched ||= p.source==='matched-date';
    c+=box(x,500,266,182,'0.95 0.98 0.97');
    c+=box(x,653,266,29,'0.10 0.34 0.27')+'1 1 1 rg\n';
    c+=text('F2',12,x+12,663,cp+' TIP POOL',242)+'0 0 0 rg\n';
    const money=value=>value===null?'Not recorded':pdfMoney(value);
    const fields=[['Cash '+cp,money(p.cash)],['Credit '+cp,money(p.credit)],['Total '+cp,money(p.total)],['Total Employee '+cp,p.employeeCount===null?'Not recorded':String(p.employeeCount)],['Total Tip per employee',share.text]];
    fields.forEach(([label,value],i)=>{
      const y=630-i*25;
      c+=text('F1',10.5,x+12,y,label,137);
      c+=text('F2',11.5,x+254,y,value,100,true);
    });
  }
  c+=text('F1',9,32,483,matched?'Cash / Credit from the matching work-date pool. Saved employee payout is unchanged.':'Pool values saved with this report. Individual payout is shown below.');
  if(missing)c+=text('F1',9,32,469,'Not recorded = historical pool detail unavailable; it is not a zero amount.');
  else if(rounded)c+=text('F1',9,32,469,'Whole-cent rounding: some shares differ by $0.01. Your exact share is below.');
  c+=line(454);
  c+=text('F2',10,32,434,'EMPLOYEE REPORT');
  c+=text('F2',23,32,409,r.employeeDisplayName||r.employee||'Employee');
  c+=text('F1',12,32,386,String(r.position||'Host / Cashier')+'  |  Shift: '+String(r.shift||'-'));
  for(const [cp,x]of [['AM',32],['PM',314]]){
    c+=box(x,334,266,38,'0.96 0.97 0.98');
    c+=text('F1',11,x+12,349,'Tip '+cp);
    c+=text('F2',17,x+254,347,tip(cp),180,true);
  }
  c+=box(32,270,548,53,'0.88 0.95 0.92');
  c+=text('F2',18,46,289,'TOTAL PAID OUT',285);
  c+=text('F2',23,565,287,pdfMoney(smallReportPaidOut(r)),215,true);
  c+=text('F1',9.5,32,253,'Tip AM + Tip PM = Total Paid Out. Cash + credit are included in each share.');
  c+=text('F2',12,32,220,'EMPLOYEE SIGNATURE');
  c+='0.80 0.86 0.85 RG 0.65 w 32 91 548 115 re S\n0 0 0 RG\n';
  c+=pdfSignatureCommands(r.pickupSignature,43,101,526,95);
  if(!smallReportHasPickupSignature(r))c+=text('F1',12,242,143,'PENDING SIGNATURE',190);
  c+=text('F2',10,32,74,smallReportHasPickupSignature(r)?'SIGNED':'NOT SIGNED');
  c+=text('F1',8,32,38,'Generated '+new Date().toLocaleString()+' | '+ES_BUILD+' | Page '+(index+1));
  return c;
}


/* ES1.7 — keep the real mobile table headers above the software keyboard.
 * Chrome/Android can pan its visual viewport while the layout viewport and
 * 100dvh stay tall. Fit the sheet to the visible rectangle instead of cloning
 * headers or moving columns separately. Desktop page scrolling is untouched.
 */
function es17MobileViewportGeometry(viewport,layoutHeight,baseline,editing){
  const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;
  const layout=positive(layoutHeight,1),height=positive(viewport?.height,layout);
  const scale=positive(viewport?.scale,1),top=Math.max(0,Number(viewport?.offsetTop)||0);
  // Respect intentional pinch zoom; resizing a magnified sheet would reflow it
  // beneath the user's fingers and prevent normal viewport panning.
  if(Math.abs(scale-1)>.05)return {enabled:false,height,top,baseline,keyboard:false};
  const full=editing?Math.max(positive(baseline,height),layout,height):height;
  return {enabled:true,height,top,baseline:full,keyboard:!!editing&&(full-height>Math.max(100,full*.18)||height<360)};
}
function es17MobileRevealInput(grid,input){
  if(!grid||!input||!grid.contains(input))return;
  const table=input.closest?.('.es-table');if(!table)return;
  const header=table.querySelector('thead'),box=grid.getBoundingClientRect(),field=input.getBoundingClientRect();
  const headHeight=header?.getBoundingClientRect().height||header?.offsetHeight||50;
  const top=box.top+headHeight+8,bottom=box.bottom-8;
  if(bottom<=top)return;
  // Only move the existing vertical scrollport, never the page/caret or X axis.
  if(field.top<top)grid.scrollTop-=top-field.top;
  else if(field.bottom>bottom)grid.scrollTop+=field.bottom-bottom;
}
function es17InstallMobileViewport(){
  const area=$('employeeSheet'),grid=$('esGrid');if(!area||!grid||area.dataset.es17Viewport)return;
  area.dataset.es17Viewport='1';
  let frame=0,baseline=0,lastWidth=0;
  const viewport=window.visualViewport;
  const setClass=(name,value)=>{if(area.classList.contains(name)!==value)area.classList.toggle(name,value);};
  const setSize=(name,value)=>{if(area.style.getPropertyValue(name)!==value)area.style.setProperty(name,value);};
  function refresh(){
    frame=0;
    const active=!area.classList.contains('hidden')&&!area.classList.contains('es-desktop-page');
    if(!active){setClass('es-mobile-viewport',false);setClass('es-mobile-keyboard',false);return;}
    const input=document.activeElement;
    const editing=!!(grid.contains(input)&&input?.closest?.('.es-table')&&input.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]),textarea,[contenteditable="true"]'));
    const width=document.documentElement.clientWidth||window.innerWidth||0;
    if(lastWidth&&Math.abs(lastWidth-width)>80)baseline=0; // orientation/window change
    lastWidth=width;
    const layout=Math.max(window.innerHeight||0,document.documentElement.clientHeight||0);
    const geometry=es17MobileViewportGeometry(viewport,layout,baseline,editing);
    if(!geometry.enabled){setClass('es-mobile-viewport',false);setClass('es-mobile-keyboard',false);return;}
    baseline=geometry.baseline;
    setSize('--es-visible-top',geometry.top+'px');setSize('--es-visible-height',geometry.height+'px');
    setClass('es-mobile-viewport',true);setClass('es-mobile-keyboard',geometry.keyboard);
    if(editing)es17MobileRevealInput(grid,input);
  }
  function schedule(){if(!frame)frame=window.requestAnimationFrame(refresh);}
  viewport?.addEventListener('resize',schedule,{passive:true});
  viewport?.addEventListener('scroll',schedule,{passive:true});
  window.addEventListener('resize',schedule,{passive:true});
  window.addEventListener('pageshow',schedule,{passive:true});
  area.addEventListener('focusin',schedule);area.addEventListener('focusout',schedule);
  // The sheet opens asynchronously and can switch between desktop/mobile mode.
  // Observe only its class, so setting viewport CSS variables does not loop.
  if(typeof MutationObserver==='function')new MutationObserver(schedule).observe(area,{attributes:true,attributeFilter:['class']});
  schedule();
}
(function(){
  const init=esInit;
  esInit=function(...args){const result=init(...args);es17InstallMobileViewport();return result;};
})();

/* ES1.8 — in-app print return and optional server-verified platform passkeys.
 * No password, PIN, biometric template, or custom token is written to storage.
 * Financial renderers and legacy Firebase Functions are not replaced.
 */
let es18PrintView=null,es18PasskeyBusy=false,es18CredentialAbort=null;
function es18IsAppleMobile(){return /iPad|iPhone|iPod/i.test(navigator.userAgent||'') || (/Mac/i.test(navigator.platform||'')&&Number(navigator.maxTouchPoints)>1);}
function es18InstallUiStyles(){
  if($('fz18UiStyle'))return;
  const style=document.createElement('style');style.id='fz18UiStyle';style.textContent=`
  .fz18-dialog{border:0;border-radius:18px;padding:0;width:min(760px,96vw);max-width:96vw;max-height:94vh;max-height:94dvh;color:#17243b;background:white;box-shadow:0 18px 70px #0008;z-index:2147483000}
  .fz18-dialog::backdrop{background:#0c183bcc}.fz18-dialog[open]{display:flex;flex-direction:column}
  .fz18-dialog-head{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;background:#142948;color:white;flex-shrink:0}
  .fz18-dialog-head h2{font-size:18px;line-height:1.25;margin:0;color:white;word-break:break-word}.fz18-dialog button{min-height:44px;white-space:normal;cursor:pointer;font-size:16px}
  .fz18-dialog button:disabled{opacity:.5;cursor:wait}.fz18-close{border:0;border-radius:10px;padding:10px 15px;background:white;color:#132841;font-weight:800;flex-shrink:0}
  .fz18-actions{display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #dce3ef}.fz18-actions button{padding:10px 20px;border-radius:10px;border:1px solid #26476f;background:#26476f;color:white;font-weight:700}
  .fz18-status{padding:9px 16px;background:#f0f5fb;font-size:14px;line-height:1.4;flex-shrink:0;min-height:20px}.fz18-dialog iframe{width:100%;height:65vh;height:65dvh;min-height:200px;border:0;background:white;display:block}
  .fz18-passkey-body{padding:16px;overflow:auto}.fz18-passkey-body p{font-size:15px;line-height:1.5}.fz18-passkey-body label{display:block;font-weight:700;margin:12px 0 6px}.fz18-passkey-body input{width:100%;box-sizing:border-box;min-height:46px;padding:10px;font-size:17px;border:1px solid #b6c4d8;border-radius:9px}
  .fz18-key-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid #dce3ef}.fz18-key-row small{display:block;color:#52637d;margin-top:5px}.fz18-key-row button{border:1px solid #c93c43;color:#a0262d;background:white;padding:8px 12px;border-radius:9px}
  #fz18PrintDialog{width:min(1100px,98vw);max-width:98vw}#fz18PrintDialog .fz18-dialog-head{position:relative;top:0}
  @media(max-width:600px){.fz18-dialog{max-height:96dvh}.fz18-dialog-head{padding:12px;gap:8px}.fz18-close{max-width:145px}.fz18-dialog iframe{height:64dvh}.fz18-actions{padding:10px 12px}}
  `;document.head.appendChild(style);
}
function es18ShowDialog(dialog){
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
}
function es18OpenPrintPreview(html=null,title='Print preview'){
  es18InstallUiStyles();window.es18ClosePrintPreview?.();
  const focus=document.activeElement,dialog=document.createElement('dialog');dialog.id='fz18PrintDialog';dialog.className='fz18-dialog';dialog.setAttribute('aria-label','Report print preview');
  dialog.innerHTML='<header class="fz18-dialog-head"><h2></h2><button class="fz18-close" type="button">✕ Close / Back to app</button></header><div class="fz18-actions"><button data-print type="button" disabled>Print</button><button data-download type="button" hidden>Download PDF</button></div><div class="fz18-status" role="status">Preparing receipt. Your app stays signed in.</div><iframe title="Report preview"></iframe>';
  dialog.querySelector('h2').textContent=title;
  const frame=dialog.querySelector('iframe'),print=dialog.querySelector('[data-print]'),status=dialog.querySelector('[role="status"]');
  const view={dialog,closed:false,ready:false,objectUrl:'',focus,oldOverflow:document.body.style.overflow,
    close(){if(view.closed)return;view.closed=true;try{dialog.close?.();}catch(e){}dialog.remove();if(view.objectUrl)URL.revokeObjectURL(view.objectUrl);document.body.style.overflow=view.oldOverflow;if(es18PrintView===view)es18PrintView=null;try{focus?.focus?.({preventScroll:true});}catch(e){}},
    setHtml(content){if(view.closed)return;view.ready=false;print.disabled=true;if(view.objectUrl){URL.revokeObjectURL(view.objectUrl);view.objectUrl='';}frame.removeAttribute('src');frame.setAttribute('sandbox','allow-same-origin allow-modals');
      const screen='<style>@media screen{html,body{width:auto!important;max-width:100%!important;overflow:visible!important}body{box-sizing:border-box}}</style>';
      frame.srcdoc=String(content||'').replace('</head>',screen+'</head>');},
    setPdf(blob,filename){if(view.closed)return;view.ready=false;print.disabled=true;if(view.objectUrl)URL.revokeObjectURL(view.objectUrl);frame.removeAttribute('sandbox');frame.removeAttribute('srcdoc');view.objectUrl=URL.createObjectURL(blob);frame.src=view.objectUrl;const b=dialog.querySelector('[data-download]');b.hidden=false;b.onclick=()=>es18DownloadRaw(blob,filename);}
  };
  frame.onload=()=>{if(view.closed)return;view.ready=true;print.disabled=false;status.textContent='Tap Print. After printing or canceling, use Close / Back to app.';try{frame.contentWindow.addEventListener('afterprint',()=>{if(!view.closed)status.textContent='Print dialog closed. Tap Close / Back to app to return to your report.';});}catch(e){}};
  print.onclick=()=>{if(!view.ready||view.closed)return;try{status.textContent='Finish or cancel the system print dialog, then tap Close / Back to app.';frame.contentWindow.focus();frame.contentWindow.print();}catch(e){status.textContent='System print is unavailable in this preview. Use Download PDF when available; Close returns to your app.';}};
  dialog.querySelector('.fz18-close').onclick=()=>view.close();dialog.addEventListener('cancel',e=>{e.preventDefault();view.close();});
  document.body.appendChild(dialog);document.body.style.overflow='hidden';es18PrintView=view;es18ShowDialog(dialog);
  if(html!==null)view.setHtml(html);dialog.querySelector('.fz18-close').focus();return view;
}
window.es18ClosePrintPreview=function(){es18PrintView?.close();};
function es18OpenPdfPreview(blob,filename){
  const view=es18OpenPrintPreview(null,filename||'PDF report');view.setPdf(blob,filename);return view;
}
// An external thermal app is not a logout. If Android returns to the original
// tab instead of opening the callback, remove the temporary LOCAL bridge too.
window.addEventListener('focus',async()=>{
  try{if(!auth.currentUser||auth.currentUser.isAnonymous||!localStorage.getItem(PASS_PRNT_BRIDGE_KEY))return;
    const b=JSON.parse(localStorage.getItem(PASS_PRNT_BRIDGE_KEY)||'{}');if(Date.now()-Number(b.startedAt||0)<1500)return;
    await setPersistence(auth,browserSessionPersistence);localStorage.removeItem(PASS_PRNT_BRIDGE_KEY);
  }catch(e){console.warn('Print session resume:',e);}
});
function es18PasskeySupported(){return !!(window.isSecureContext&&window.PublicKeyCredential&&navigator.credentials?.create&&navigator.credentials?.get);}
function es18Decode64(s){const raw=atob(String(s).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
function es18Encode64(value){const bytes=new Uint8Array(value);let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function es18PublicKeyOptions(options,registration=false){
  // ES1.8.1: Firebase callable encoding converts optional undefined members to
  // null. WebAuthn sequence members cannot be null: OMIT optional null values,
  // but never discard a real allow/exclude list or weaken user verification.
  const invalid=field=>{throw new TypeError('Invalid passkey option: '+field+'. Refresh the app and retry. Password / PIN still works.');};
  const binary=(value,field)=>{
    if(typeof value!=='string'||!value||!/^[-_A-Za-z0-9]+={0,2}$/.test(value)||value.replace(/=+$/,'').length%4===1)invalid(field);
    try{return es18Decode64(value);}catch(e){invalid(field);}
  };
  if(!options||typeof options!=='object'||Array.isArray(options))invalid('publicKey');
  const out={...options,challenge:binary(options.challenge,'challenge')};
  if(registration){
    if(!options.user||typeof options.user!=='object'||Array.isArray(options.user))invalid('user');
    out.user={...options.user,id:binary(options.user.id,'user.id')};
  }
  for(const field of ['allowCredentials','excludeCredentials']){
    const list=options[field];
    if(list==null){delete out[field];continue;}
    if(!Array.isArray(list))invalid(field);
    out[field]=list.map((credential,index)=>{
      const label=field+'['+index+']';
      if(!credential||typeof credential!=='object'||credential.type!=='public-key')invalid(label);
      const copy={...credential,id:binary(credential.id,label+'.id')};
      if(credential.transports==null)delete copy.transports;
      else{
        if(!Array.isArray(credential.transports)||credential.transports.some(t=>typeof t!=='string'))invalid(label+'.transports');
        copy.transports=[...credential.transports];
      }
      return copy;
    });
  }
  // Other optional members may also cross Firebase as null. Preserve all
  // non-null options and constraints; malformed lists are errors, not fallbacks.
  for(const field of ['hints','attestationFormats']){
    if(options[field]==null)delete out[field];
    else{
      if(!Array.isArray(options[field])||options[field].some(v=>typeof v!=='string'))invalid(field);
      out[field]=[...options[field]];
    }
  }
  if(options.extensions==null)delete out.extensions;
  return out;
}
function es18CredentialJson(credential){
  if(typeof credential?.toJSON==='function')return credential.toJSON();
  if(!credential?.rawId||!credential.response)throw new Error('No passkey response was returned.');
  const r=credential.response,response={clientDataJSON:es18Encode64(r.clientDataJSON)};
  for(const key of ['attestationObject','authenticatorData','signature'])if(r[key])response[key]=es18Encode64(r[key]);
  if('userHandle' in r)response.userHandle=r.userHandle?es18Encode64(r.userHandle):null;
  if(typeof r.getTransports==='function')response.transports=r.getTransports();
  return {id:credential.id,rawId:es18Encode64(credential.rawId),type:credential.type,response,clientExtensionResults:credential.getClientExtensionResults?.()||{},authenticatorAttachment:credential.authenticatorAttachment||undefined};
}
async function es18PasskeyApi(name,data={}){const r=await httpsCallable(functions,name)(data);return r.data;}
function es18PasskeyError(e){
  const code=String(e?.code||''),name=String(e?.name||'');
  if(['NotAllowedError','AbortError'].includes(name))return 'Passkey canceled or unavailable. You can still use your password / PIN.';
  if(name==='InvalidStateError')return 'This device already has this account’s passkey. Use Fingerprint / Face ID to sign in.';
  if(code==='functions/not-found'||code==='functions/unavailable'||code==='functions/internal')return 'Fingerprint server is not active or cannot be reached. Password / PIN login still works. Activate BACKEND_PASSKEY once, then retry.';
  if(code==='functions/unauthenticated')return 'Confirm your current password / PIN, then try again.';
  return String(e?.message||'Passkey failed. Password / PIN login is still available.').slice(0,1200);
}
window.es18PasskeyLogin=async function(){
  if(es18PasskeyBusy)return;if(!es18PasskeySupported()){loginMsg('Passkeys need a compatible secure browser. Open the HTTPS app in Chrome or Safari, or use your password / PIN.');return;}
  const role=String($('fzUnifiedRole')?.value||'employee'),button=$('fz18BiometricLogin');
  es18PasskeyBusy=true;if(button)button.disabled=true;const passwordButton=$('fzUnifiedLoginBtn');if(passwordButton)passwordButton.disabled=true;
  loginMsg('Preparing Fingerprint / Face ID… Please wait.');
  try{
    await authSecurityReady;es18CredentialAbort=new AbortController();loginMsg('Choose your saved passkey and confirm with your device.');
    const begin=await es18PasskeyApi('passkeyBeginAuthenticationV1',{role});
    const credential=await navigator.credentials.get({publicKey:es18PublicKeyOptions(begin.options),signal:es18CredentialAbort.signal});
    if(!credential)throw new Error('No passkey selected.');
    const result=await es18PasskeyApi('passkeyFinishAuthenticationV1',{challengeId:begin.challengeId,response:es18CredentialJson(credential)});
    if(typeof result?.token!=='string'||!result.token)throw new Error('Passkey server returned no sign-in token.');
    await setPersistence(auth,browserSessionPersistence);es18LoginAttemptRole=role;
    try{await signInWithCustomToken(auth,result.token);}finally{result.token='';}
  }catch(e){es18LoginAttemptRole=null;loginMsg(es18PasskeyError(e));}
  finally{es18CredentialAbort=null;es18PasskeyBusy=false;if(button)button.disabled=false;if(passwordButton)passwordButton.disabled=false;}
};
function es18DeviceLabel(){return /iPad/i.test(navigator.userAgent||'')||es18IsAppleMobile()&&/Mac/i.test(navigator.platform||'')?'My iPad':/iPhone/i.test(navigator.userAgent||'')?'My iPhone':/Android/i.test(navigator.userAgent||'')?'My Android phone':'My computer';}
function es18PasskeyStatus(text){const n=$('fz18PasskeyStatus');if(n)n.textContent=text;}
async function es18ReauthenticatePasskeys(){
  const user=auth.currentUser,uid=currentUser?.uid,input=$('fz18PasskeyPassword'),secret=String(input?.value||'');
  if(!uid||user?.uid!==uid||!user.email)throw new Error('Sign in to your account first.');
  if(!secret)throw new Error('Enter your current password / PIN to confirm this change.');
  if(input)input.value='';
  const password=currentProfile?.role==='employee'?employeeAuthPassword(secret):secret;
  await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password));await user.getIdToken(true);
  if(auth.currentUser?.uid!==uid)throw new Error('Account changed. Close this panel and try again.');return uid;
}
async function es18RefreshPasskeys(){
  const uid=auth.currentUser?.uid;if(!uid)return;
  const result=await es18PasskeyApi('passkeyListV1');if(auth.currentUser?.uid!==uid)return;
  const list=$('fz18PasskeyList');if(!list)return;list.textContent='';
  if(!result.credentials?.length){const p=document.createElement('p');p.textContent='No passkey registered for this account yet.';list.appendChild(p);return;}
  for(const key of result.credentials){
    const row=document.createElement('div');row.className='fz18-key-row';const text=document.createElement('div'),name=document.createElement('b'),date=document.createElement('small'),revoke=document.createElement('button');
    name.textContent=key.label||'Passkey';date.textContent='Added '+new Date(key.createdAt).toLocaleDateString()+(key.lastUsedAt?' · Used '+new Date(key.lastUsedAt).toLocaleDateString():'');text.append(name,date);
    revoke.type='button';revoke.textContent='Revoke';revoke.onclick=async()=>{if(es18PasskeyBusy||!confirm('Revoke '+(key.label||'this passkey')+'? Password / PIN will still work.'))return;es18PasskeyBusy=true;revoke.disabled=true;
      try{const id=await es18ReauthenticatePasskeys();await es18PasskeyApi('passkeyRevokeV1',{credentialId:key.id});if(auth.currentUser?.uid!==id)return;es18PasskeyStatus('Passkey revoked. Password / PIN still works.');await es18RefreshPasskeys();}
      catch(e){es18PasskeyStatus(es18PasskeyError(e));}finally{es18PasskeyBusy=false;revoke.disabled=false;}};
    row.append(text,revoke);list.appendChild(row);
  }
}
window.es18EnrollPasskey=async function(){
  if(es18PasskeyBusy)return;if(!es18PasskeySupported()){es18PasskeyStatus('This browser does not support platform passkeys. Your password / PIN still works.');return;}
  const button=$('fz18PasskeyAdd');es18PasskeyBusy=true;if(button)button.disabled=true;
  try{const uid=await es18ReauthenticatePasskeys();es18CredentialAbort=new AbortController();es18PasskeyStatus('Confirm Fingerprint / Face ID or device PIN when your device asks.');
    const begin=await es18PasskeyApi('passkeyBeginRegistrationV1');
    const credential=await navigator.credentials.create({publicKey:es18PublicKeyOptions(begin.options,true),signal:es18CredentialAbort.signal});
    if(!credential)throw new Error('Registration canceled.');if(auth.currentUser?.uid!==uid)throw new Error('Account changed. Registration was not completed.');
    await es18PasskeyApi('passkeyFinishRegistrationV1',{challengeId:begin.challengeId,response:es18CredentialJson(credential),label:String($('fz18PasskeyLabel')?.value||es18DeviceLabel()).trim()});
    es18PasskeyStatus('Passkey registered. Next time choose your role and tap Fingerprint / Face ID. Password / PIN remains available.');await es18RefreshPasskeys();
  }catch(e){es18PasskeyStatus(es18PasskeyError(e));}finally{es18CredentialAbort=null;es18PasskeyBusy=false;if(button)button.disabled=false;}
};
window.es18ClosePasskeys=function(){
  es18CredentialAbort?.abort();const d=$('fz18PasskeyDialog');if(!d)return;const input=$('fz18PasskeyPassword');if(input)input.value='';try{d.close?.();}catch(e){}d.remove();
};
window.es18OpenPasskeys=async function(){
  if(!auth.currentUser||!['employee','manager','owner','cashier'].includes(currentProfile?.role))return;
  es18InstallUiStyles();window.es18ClosePasskeys();const d=document.createElement('dialog');d.id='fz18PasskeyDialog';d.className='fz18-dialog';
  d.innerHTML='<header class="fz18-dialog-head"><h2>Fingerprint / Face ID setup</h2><button class="fz18-close" type="button">✕ Close</button></header><div class="fz18-passkey-body"><p><b>Register only on your personal device.</b> Anyone who can unlock this device may be able to use its passkey. Your device chooses fingerprint, face recognition or its screen-lock PIN; the app never stores biometrics or your password.</p><p id="fz18PasskeyAccount"></p><label for="fz18PasskeyPassword">Current password / employee PIN</label><input id="fz18PasskeyPassword" type="password" autocomplete="current-password"><label for="fz18PasskeyLabel">Device name</label><input id="fz18PasskeyLabel" maxlength="60"><div class="fz18-actions"><button id="fz18PasskeyAdd" type="button">Register this device</button></div><p id="fz18PasskeyStatus" role="status">Loading registered passkeys…</p><div id="fz18PasskeyList"></div></div>';
  d.querySelector('.fz18-close').onclick=window.es18ClosePasskeys;d.addEventListener('cancel',e=>{e.preventDefault();window.es18ClosePasskeys();});document.body.appendChild(d);
  $('fz18PasskeyAccount').textContent='Account: '+(currentProfile.displayName||currentProfile.username||auth.currentUser.email)+' · '+currentProfile.role.toUpperCase();$('fz18PasskeyLabel').value=es18DeviceLabel();$('fz18PasskeyAdd').onclick=window.es18EnrollPasskey;es18ShowDialog(d);
  try{await es18RefreshPasskeys();es18PasskeyStatus('Confirm your password / PIN before registering or revoking a passkey.');}catch(e){es18PasskeyStatus(es18PasskeyError(e));}
};
window.es18UpdateBiometricUi=function(){
  if(!document.body)return;es18InstallUiStyles();let b=$('fz18PasskeySetup');const top=$('top');
  if(!b&&top){const logout=[...top.querySelectorAll('button')].find(x=>/logout/i.test(x.textContent||''));if(logout){b=document.createElement('button');b.id='fz18PasskeySetup';b.type='button';b.className='btn light';b.textContent='Fingerprint Setup';b.onclick=window.es18OpenPasskeys;logout.parentNode.style.flexWrap='wrap';logout.parentNode.style.justifyContent='flex-end';logout.parentNode.insertBefore(b,logout);}}
  if(b)b.classList.toggle('hidden',!['employee','manager','owner','cashier'].includes(currentProfile?.role));
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>window.es18UpdateBiometricUi(),{once:true});else window.es18UpdateBiometricUi();
// ES1.8.7 — Employee Daily Detail PDF readability / zebra landscape report.
(function(){
  const money=v=>'$'+monthlyReportRound(v).toFixed(2),num=v=>monthlyReportNum(v),escHtml=v=>esc(String(v??''));
  let detailToken=0,detailRows=[];
  function validDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));}
  function dateList(from,to){if(!validDate(from)||!validDate(to)||from>to)return [];const out=[],d=new Date(from+'T12:00:00'),end=new Date(to+'T12:00:00');while(d<=end&&out.length<=366){out.push(d.toISOString().slice(0,10));d.setDate(d.getDate()+1);}return out;}
  function norm(raw){const r=typeof reportForWorkPosition==='function'?reportForWorkPosition(raw):raw,b=monthlyReportBusserSplit(r),bar=String(r?.position||'').toLowerCase()==='bartender';return {date:String(r?.date||''),shift:String(r?.shift||'-'),position:String(r?.position||'-'),reports:1,sales:num(r?.grandTotal),paidTip:num(r?.paidTip),cardFee:num(r?.payCardTipFee??r?.cardFee),busserAM:b.am,busserPM:b.pm,barOut:bar?0:num(r?.barTipOut),barReceived:bar?num(r?.bartenderBarTipReceived):0,cashTip:num(r?.cashTip),meal:num(r?.meal),adjustment:num(r?.adjustmentSalaryHourly),beforeMeal:num(r?.totalBeforeMeal),paidOut:monthlyReportPaidOut(r),grandTip:monthlyReportGrandTip(r)};}
  const keys=['sales','paidTip','cardFee','busserAM','busserPM','barOut','barReceived','cashTip','meal','adjustment','beforeMeal','paidOut','grandTip'];
  function aggregate(rows){const map=new Map();for(const raw of rows){const r=norm(raw);if(!r.date)continue;if(!map.has(r.date)){map.set(r.date,{...r,shifts:new Set([r.shift]),positions:new Set([r.position])});continue;}const x=map.get(r.date);x.reports++;x.shifts.add(r.shift);x.positions.add(r.position);for(const k of keys)x[k]+=r[k];}return [...map.values()].map(x=>{const o={...x,shift:[...x.shifts].filter(Boolean).join(' + ')||'-',position:[...x.positions].filter(Boolean).join(' + ')||'-'};delete o.shifts;delete o.positions;for(const k of keys)o[k]=monthlyReportRound(o[k]);return o;}).sort((a,b)=>a.date.localeCompare(b.date));}
  function totals(rows){const t={date:'TOTAL',shift:'',position:'',reports:0};for(const k of keys)t[k]=0;for(const r of rows){t.reports+=r.reports||1;for(const k of keys)t[k]+=num(r[k]);}for(const k of keys)t[k]=monthlyReportRound(t[k]);return t;}
  async function fetchRange(from,to){const dates=dateList(from,to);if(!dates.length)throw new Error('Choose a valid date range.');if(dates.length>366)throw new Error('Choose a range of 366 days or less.');try{const q=query(collection(db,'hourlyReports'),where('date','>=',from),where('date','<=',to),orderBy('date','asc'));const snap=await Promise.race([getDocsFromServer(q),new Promise((_,rej)=>setTimeout(()=>rej(new Error('Range read timed out.')),8000))]);if(snap.metadata?.fromCache===true)throw new Error('Server data is not ready.');return snap.docs.map(d=>({id:d.id,...d.data()}));}catch(error){if(typeof es184CloudRead!=='function'||dates.length>62)throw error;const out=[];for(const d of dates)out.push(...await es184CloudRead('reports',d,()=>{}));return out;}}
  function table(rows){const t=totals(rows),row=r=>`<tr><td>${escHtml(r.date)}</td><td>${escHtml(r.shift)}</td><td>${escHtml(r.position)}</td>${keys.map(k=>`<td>${money(r[k])}</td>`).join('')}</tr>`;return `<div class="fz186-scroll"><table class="fz186-table"><thead><tr><th>Date</th><th>Shift</th><th>Position</th><th>Sales</th><th>Paid Tip</th><th>Card Fee</th><th>Busser AM</th><th>Busser PM</th><th>Bar Out</th><th>Bar Received</th><th>Cash Tip</th><th>Meal</th><th>Adjustment</th><th>Before Meal</th><th>Paid Out</th><th>Grand Tip</th></tr></thead><tbody>${rows.map(row).join('')}</tbody><tfoot>${row(t)}</tfoot></table></div>`;}
  async function render(){const host=document.getElementById('fz186DailyDetail');if(!host)return;const {from,to,employee}=monthlyReportRange();if(!employee){detailRows=[];host.innerHTML='<div class="notice">Choose one Employee to see the daily breakdown.</div>';return;}if(!validDate(from)||!validDate(to)||from>to){detailRows=[];host.innerHTML='<div class="notice danger">Choose a valid Start Date and End Date.</div>';return;}const token=++detailToken;host.innerHTML='<div class="notice">Loading finalized daily reports from server…</div>';try{const all=await fetchRange(from,to);if(token!==detailToken)return;const rows=aggregate(all.filter(r=>String(r?.employee||'').trim()===employee));detailRows=rows;if(!rows.length){host.innerHTML='<div class="notice">No finalized Daily Reports found for '+escHtml(employee)+' in this period.</div>';return;}const t=totals(rows);host.innerHTML=`<div class="fz186-detail-head"><div><b>${escHtml(employee)}</b><span>${escHtml(from)} to ${escHtml(to)} · ${rows.length} work day${rows.length===1?'':'s'}</span></div><button class="btn dark" type="button" id="fz186PdfBtn">DOWNLOAD DAILY TABLE PDF</button></div>${table(rows)}<div class="small fz186-note"><b>Paid Out</b> = saved payout after Meal and accepted Hourly Adjustment. <b>Grand Tip</b> = Before Meal + Cash Tip. Cash Tip is already received and is not added to Paid Out.</div>`;document.getElementById('fz186PdfBtn').onclick=()=>window.downloadEmployeeDailyDetailPdf();if(document.getElementById('monthlyReportStatus'))document.getElementById('monthlyReportStatus').innerHTML=`<div class="notice good"><b>${escHtml(employee)}</b> · ${rows.length} daily row${rows.length===1?'':'s'} · Paid Out ${money(t.paidOut)} · Cash Tip ${money(t.cashTip)} · Grand Tip ${money(t.grandTip)}</div>`;}catch(e){if(token!==detailToken)return;detailRows=[];host.innerHTML='<div class="notice danger"><b>Daily detail could not load from server.</b><br>'+escHtml(e?.message||e)+'</div>';}}
  function thisWeek(){const now=new Date(),diff=(now.getDay()+6)%7,a=new Date(now);a.setDate(now.getDate()-diff);const b=new Date(a);b.setDate(a.getDate()+6);const f=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;$('monthlyReportFrom').value=f(a);$('monthlyReportTo').value=f(b);window.renderMonthlyReport?.();render();}
  function pEsc(s){return String(s??'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').normalize('NFKD').replace(/[^\x20-\x7E]/g,' ');}
  function pText(font,size,x,y,s){return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pEsc(s)}) Tj ET\n`;}
  function fit(s,w,size){s=String(s??'');const max=Math.max(2,Math.floor((w-4)/(size*.5)));return s.length>max?s.slice(0,Math.max(1,max-1))+'~':s;}
  function pdfBlob(rows,employee,from,to){
    const cols=[['Date',52,'date','left'],['Shift',43,'shift','left'],['Position',52,'position','left'],['Sales',48,'sales','right'],['Paid Tip',48,'paidTip','right'],['Card Fee',43,'cardFee','right'],['Bus AM',43,'busserAM','right'],['Bus PM',43,'busserPM','right'],['Bar Out',43,'barOut','right'],['Bar Recv',46,'barReceived','right'],['Cash Tip',45,'cashTip','right'],['Meal',42,'meal','right'],['Adj',42,'adjustment','right'],['Before Meal',52,'beforeMeal','right'],['Paid Out',50,'paidOut','right'],['Grand Tip',50,'grandTip','right']];
    const scale=744/cols.reduce((a,c)=>a+c[1],0);cols.forEach(c=>c[1]*=scale);
    const per=15,pages=[];for(let i=0;i<rows.length;i+=per)pages.push(rows.slice(i,i+per));if(!pages.length)pages.push([]);
    const t=totals(rows),obj=[],pageIds=[],contentIds=[];let next=3;for(let p=0;p<pages.length;p++){pageIds.push(next++);contentIds.push(next++);}const f1=next++,f2=next++;
    const headerLabels={date:'DATE',shift:'SHIFT',position:'POSITION',sales:'SALES',paidTip:'PAID TIP',cardFee:'CARD FEE',busserAM:'BUS AM',busserPM:'BUS PM',barOut:'BAR OUT',barReceived:'BAR RECV',cashTip:'CASH TIP',meal:'MEAL',adjustment:'ADJ',beforeMeal:'BEFORE MEAL',paidOut:'PAID OUT',grandTip:'GRAND TIP'};
    for(let p=0;p<pages.length;p++){
      let c='';
      // Dark navy report banner.
      c+='0.055 0.14 0.25 rg 24 548 744 42 re f\n1 1 1 rg\n';
      c+=pText('F2',15,36,573,'Fred Zhang Tip Calculator - Employee Daily Detail');
      c+=pText('F1',8.5,36,558,employee+' | '+from+' to '+to);
      c+=pText('F1',7.5,690,558,`Page ${p+1}/${pages.length}`);
      c+='0 0 0 rg\n';
      let y=526,x=24,h=25;
      // Strong blue header with white labels and visible column dividers.
      c+='0.12 0.32 0.52 rg 24 '+(y-h+4)+' 744 '+h+' re f\n';
      x=24;
      for(const col of cols){
        c+='0.55 0.72 0.86 RG 0.35 w '+x+' '+(y-h+4)+' '+col[1]+' '+h+' re S\n';
        c+='1 1 1 rg\n';
        c+=pText('F2',5.7,x+2,y-11,fit(headerLabels[col[2]]||col[0],col[1],5.7));
        x+=col[1];
      }
      y-=h;
      pages[p].forEach((r,idx)=>{
        x=24;
        // Zebra rows: white and very light blue.
        c+=(idx%2===0?'1 1 1 rg ':'0.92 0.96 0.99 rg ')+`24 ${y-h+4} 744 ${h} re f\n`;
        c+='0.76 0.83 0.90 RG 0.30 w\n';
        for(const col of cols)c+=`${x} ${y-h+4} ${col[1]} ${h} re S\n`,x+=col[1];
        c+='0.05 0.10 0.16 rg\n';x=24;
        for(const col of cols){let v=r[col[2]];if(typeof v==='number')v=money(v);const txt=fit(v,col[1],5.85),approx=txt.length*5.85*.5,tx=col[3]==='right'?Math.max(x+2,x+col[1]-3-approx):x+2;c+=pText('F1',5.85,tx,y-11,txt);x+=col[1];}
        y-=h;
      });
      if(p===pages.length-1){
        x=24;c+='0.82 0.90 0.97 rg 24 '+(y-h+4)+' 744 '+h+' re f\n0.04 0.12 0.22 rg\n';
        for(const col of cols){let v=t[col[2]];if(col[2]==='date')v='TOTAL';else if(['shift','position'].includes(col[2]))v='';else if(typeof v==='number')v=money(v);const txt=fit(v,col[1],5.9),approx=txt.length*5.9*.5,tx=col[3]==='right'?Math.max(x+2,x+col[1]-3-approx):x+2;c+=pText('F2',5.9,tx,y-11,txt);x+=col[1];}
      }
      c+='0.25 0.32 0.40 rg\n';
      c+=pText('F1',6.7,24,34,'Paid Out = saved Daily Report payout (Before Meal - Meal + accepted Hourly Adjustment). Cash Tip is already received.');
      obj[contentIds[p]]=`<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
      obj[pageIds[p]]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentIds[p]} 0 R >>`;
    }
    obj[1]='<< /Type /Catalog /Pages 2 0 R >>';obj[2]=`<< /Type /Pages /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] /Count ${pageIds.length} >>`;obj[f1]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';obj[f2]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';const max=f2;let pdf='%PDF-1.4\n',off=[0];for(let i=1;i<=max;i++){off[i]=pdf.length;pdf+=`${i} 0 obj\n${obj[i]}\nendobj\n`;}const xr=pdf.length;pdf+=`xref\n0 ${max+1}\n0000000000 65535 f \n`;for(let i=1;i<=max;i++)pdf+=String(off[i]).padStart(10,'0')+' 00000 n \n';pdf+=`trailer\n<< /Size ${max+1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`;return new Blob([pdf],{type:'application/pdf'});
  }
  window.downloadEmployeeDailyDetailPdf=async function(){if(!['manager','owner'].includes(currentProfile?.role||''))return;const {from,to,employee}=monthlyReportRange();if(!employee){alert('Choose one Employee first.');return;}try{const all=await fetchRange(from,to),rows=aggregate(all.filter(r=>String(r?.employee||'').trim()===employee));detailRows=rows;if(!rows.length){alert('No finalized Daily Reports found for this employee and period.');return;}const safe=employee.replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'')||'Employee';downloadBlob(pdfBlob(rows,employee,from,to),`Fred_Zhang_Daily_Detail_${safe}_${from}_to_${to}.pdf`);}catch(e){alert('Daily Detail PDF was not created.\n\n'+String(e?.message||e));}};
  function install(){
    const section=$('monthlyReport');if(!section||section.dataset.es186==='1')return false;section.dataset.es186='1';
    const actions=section.querySelector('.fz-monthly-head .actions');if(actions&&!$('fz186ThisWeek')){const b=document.createElement('button');b.id='fz186ThisWeek';b.type='button';b.className='btn light';b.textContent='THIS WEEK';b.onclick=thisWeek;actions.insertBefore(b,actions.firstChild);}
    const body=$('monthlyReportBody');if(body&&!$('fz186DailyDetail')){const wrap=document.createElement('div');wrap.id='fz186DailyDetail';wrap.className='fz186-detail';body.parentNode.insertBefore(wrap,body.nextSibling);}
    const style=document.createElement('style');style.id='fz186Style';style.textContent='.fz186-detail{margin-top:16px}.fz186-detail-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0}.fz186-detail-head b{display:block;font-size:20px;color:#10233f}.fz186-detail-head span{display:block;color:#64748b;margin-top:3px}.fz186-scroll{overflow:auto;border:1px solid #dfe6ef;border-radius:14px;-webkit-overflow-scrolling:touch}.fz186-table{border-collapse:separate;border-spacing:0;min-width:1800px;width:100%;font-size:12px}.fz186-table th,.fz186-table td{padding:9px 8px;border-right:1px solid #e3e9f1;border-bottom:1px solid #e3e9f1;text-align:right;white-space:nowrap}.fz186-table th:nth-child(-n+3),.fz186-table td:nth-child(-n+3){text-align:left}.fz186-table thead th{position:sticky;top:0;background:#10233f;color:white;z-index:2}.fz186-table tfoot td{font-weight:900;background:#eef5ff}.fz186-note{margin-top:8px;color:#64748b;line-height:1.45}';document.head.appendChild(style);
    const employee=$('monthlyReportEmployee'),from=$('monthlyReportFrom'),to=$('monthlyReportTo');employee?.addEventListener('change',render);from?.addEventListener('change',render);to?.addEventListener('change',render);render();return true;
  }
  const oldOpen=window.fzOpenMonthlyReport;window.fzOpenMonthlyReport=function(){const out=oldOpen?.apply(this,arguments);setTimeout(()=>{install();render();},0);return out;};
  if(typeof MutationObserver!=='undefined'){const observer=new MutationObserver(()=>{if(install())observer.disconnect();});if(document.body)observer.observe(document.body,{childList:true,subtree:true});}if(!install()&&typeof setTimeout==='function')setTimeout(install,500);
})();
