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
// out and drop it from the DOM. Double rAF: one to let React commit,
// one to let the browser actually paint that commit, so the fade
// never starts a frame early and flashes unstyled content.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById("pl-splash");
    if (!splash) return;
    splash.classList.add("pl-splash-hidden");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  });
});
