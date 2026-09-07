import { getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, setPersistence,
  browserLocalPersistence, browserSessionPersistence, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const slugFor=v=>String(v||"").trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
const emailFor=v=>`${slugFor(v)}@juicytip.app`;

function aliases(username,role){
  const given=String(username||"").trim();
  const list=[given];
  if(role==="owner"){
    list.push("Fred1985","fred1985","Fred Zhang","fredzhang");
  }else if(role==="manager"){
    list.push("Ekky","ekky","manager-ekky","managerekky");
  }
  return [...new Set(list.filter(Boolean))];
}

window.fzDirectStaffLogin=async function({username,password,remember=false,role=""}={}){
  try{
    if(!getApps().length){
      return {ok:false,message:"Firebase is still loading. Tap Login again."};
    }
    const app=getApp();
    const auth=getAuth(app);
    const db=getFirestore(app);

    try{
      await setPersistence(auth,remember?browserLocalPersistence:browserSessionPersistence);
    }catch(e){
      console.warn("P20 persistence:",e);
    }

    let lastErr=null;
    for(const candidate of aliases(username,role)){
      try{
        const cred=await signInWithEmailAndPassword(auth,emailFor(candidate),String(password||""));
        const snap=await getDoc(doc(db,"users",cred.user.uid));
        if(!snap.exists()){
          await signOut(auth);
          return {ok:false,message:"Account exists, but no user profile was found."};
        }
        const profile=snap.data()||{};
        const actualRole=String(profile.role||"").toLowerCase();

        if(!["manager","owner"].includes(actualRole)){
          await signOut(auth);
          return {ok:false,message:"This account does not have Manager / Owner access."};
        }
        if(role==="owner" && actualRole!=="owner"){
          await signOut(auth);
          return {ok:false,message:"This is not an Owner account."};
        }
        if(profile.active===false){
          await signOut(auth);
          return {ok:false,message:"This account is disabled."};
        }
        return {ok:true,role:actualRole,username:candidate};
      }catch(e){
        lastErr=e;
        try{if(auth.currentUser)await signOut(auth)}catch(_){}
      }
    }
    return {ok:false,message:`Login failed: ${lastErr?.code||"invalid-credential"}`};
  }catch(e){
    return {ok:false,message:`Login failed: ${e?.code||e?.message||"unknown-error"}`};
  }
};
