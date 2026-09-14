// Reuses .pl-splash-glow/.pl-splash-icon/.pl-splash-path directly -
// those are defined as plain (non-scoped) classes in index.html's
// inline <style>, which loads into every page this app ever renders,
// so referencing them here replays the exact same trace/glow animation
// the app opens with rather than a separately-maintained copy of it.
// The outer wrapper is this component's own (.pl-logout-transition in
// App.css) since index.html's positioning/background is on an ID
// (#pl-splash) tied to that one static element, not reusable as-is.
export default function LogoutTransition({ fading = false }) {
  return (
    <div className={`pl-logout-transition${fading ? " pl-logout-transition--hidden" : ""}`}>
      <div className="pl-splash-glow" />
      <svg className="pl-splash-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <path className="pl-splash-path" d="M8 50 H32 L40 28 L54 72 L64 50 H92" />
      </svg>
    </div>
  );
}
