import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import SharedMonitorView from "./components/SharedMonitorView.jsx";
import SharedStatusPageView from "./components/SharedStatusPageView.jsx";
import "./App.css";

// Belt-and-braces for the "no copying UI text" behavior set up in
// App.css: CSS user-select handles most browsers, but Android/Chrome
// can still pop the long-press context menu (Copy/Share/Select all)
// on top of a non-selectable element. Block that event globally,
// except on the actual form fields where typing/copying should work
// normally.
window.addEventListener(
  "contextmenu",
  (e) => {
    const el = e.target;
    const isEditable =
      el.closest &&
      el.closest('input, textarea, [contenteditable="true"], .pl-selectable');
    if (!isEditable) e.preventDefault();
  },
  { passive: false }
);

// Registered unconditionally at boot (not just when someone opens
// Settings and usePush.js runs) so the offline fallback page in sw.js
// gets cached on the very first visit, for everyone - not only people
// who've turned push notifications on. register() is safe to call
// again later from usePush.js; the browser just returns the existing
// registration.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Installed PWAs can sit backgrounded for a long time without
        // the browser ever re-checking sw.js on its own, which is
        // exactly the "reopen after a while, still looks old" case.
        // Force a check whenever the app comes back to the
        // foreground, not just on the initial load.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch(() => {
        // Offline fallback just won't be available this session (e.g.
        // private browsing) - not worth surfacing to the user.
      });

    // Once a new service worker actually takes control (i.e. an
    // update was found and activated), the JS/CSS already loaded in
    // this tab is the OLD version - reload once so the new one takes
    // effect immediately instead of silently staying stale until the
    // next manual close/reopen.
    let refreshedOnce = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshedOnce) return;
      refreshedOnce = true;
      window.location.reload();
    });
  });
}

// A share link is #/share/<token>, a combined status page link is
// #/status/<token> - both checked here, before App (and its
// getMe()/session check) ever mounts, so opening either never triggers
// a login prompt or touches the authed app at all.
const shareMatch = window.location.hash.match(/^#\/share\/(.+)$/);
const statusPageMatch = window.location.hash.match(/^#\/status\/(.+)$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {shareMatch ? (
      <SharedMonitorView token={decodeURIComponent(shareMatch[1])} />
    ) : statusPageMatch ? (
      <SharedStatusPageView token={decodeURIComponent(statusPageMatch[1])} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);

// Splash screen lives in index.html so it's visible before this file
// even finishes loading. Once React has painted the real UI, fade it
// out and drop it from the DOM.
//
// Two things are being balanced here: React might mount almost
// instantly (nothing to fade from truncated-looking), or slowly on a
// bad connection. So this waits for BOTH React to have committed AND
// paint AND a minimum time for the trace/settle/glow sequence in
// index.html to actually finish playing (~1.7s) - whichever finishes
// last - so the cinematic animation is never cut short, but a slow
// load also never gets held hostage past when the app is ready.
const MIN_SPLASH_MS = 1700;
const splashStart = window.__plSplashStart || performance.now();

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const elapsed = performance.now() - splashStart;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      const splash = document.getElementById("pl-splash");
      if (!splash) return;
      splash.classList.add("pl-splash-hidden");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    }, remaining);
  });
});
