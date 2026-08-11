import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import SharedMonitorView from "./components/SharedMonitorView.jsx";
import "./App.css";

// A share link is #/share/<token> - checked here, before App (and its
// getMe()/session check) ever mounts, so opening one never triggers a
// login prompt or touches the authed app at all.
const shareMatch = window.location.hash.match(/^#\/share\/(.+)$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {shareMatch ? <SharedMonitorView token={decodeURIComponent(shareMatch[1])} /> : <App />}
  </React.StrictMode>
);
