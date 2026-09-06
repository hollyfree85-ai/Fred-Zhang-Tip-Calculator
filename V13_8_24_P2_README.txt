V13.8.24-P2 — CINEMATIC INTRO ONLY

ROLLBACK POINT:
V13.8.24-P1 remains the stable rollback checkpoint.

WHAT CHANGED:
- Added cinematic startup overlay only:
  1) rotating futuristic globe
  2) sunrise animation
  3) title "Just Tip Calculator"
  4) voice attempt: "Welcome to Fred Zhang Just Tip Calculator."
  5) then the normal main page appears
- Added a 7-second safety timeout so the splash can never trap the app.

WHAT DID NOT CHANGE:
- app-v13824p1.js is byte-for-byte identical to V13.8.24-P1
- simple-ui-v13824p1.js is byte-for-byte identical to V13.8.24-P1
- Login/auth, Show Password, BAR formulas, cash-tip adjustment, reports,
  historical sync, Undo/Recovery, and permanent user deletion are untouched.

NOTE:
Some browsers may block speech/audio on page load until the user interacts with the page.
The visual animation will still complete and the app will open normally.
