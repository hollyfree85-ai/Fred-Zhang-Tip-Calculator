/* V13.8.25: The Check Tip / Cashier UI module is retired. Core Tip Calculation, report, archive, and sound code lives in app-v13820.js. */
(()=>{
  const fix=()=>{ document.querySelectorAll('[data-fz-retired]').forEach(e=>{e.hidden=true;e.setAttribute('inert','');}); };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fix,{once:true});else fix();
})();

// Measure the top bar once and on resize; avoid quick navigation covering the title.
(()=>{const init=()=>{const top=document.getElementById('top');if(!top)return;const measure=()=>document.documentElement.style.setProperty('--fz-header-height',top.getBoundingClientRect().height+'px');measure();if('ResizeObserver' in window)new ResizeObserver(measure).observe(top);window.addEventListener('resize',measure,{passive:true});};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();})();
