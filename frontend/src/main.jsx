import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import SharedMonitorView from "./components/SharedMonitorView.jsx";
import SharedStatusPageView from "./components/SharedStatusPageView.jsx";
import "./App.css";

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
