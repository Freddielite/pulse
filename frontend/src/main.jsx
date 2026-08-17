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
