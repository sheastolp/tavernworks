// "Sign in with Google" for the admin pages (/tips/ and /hushwave/suggestions/).
// Uses the same OAuth Client ID as TwitchBotSandbox (bot-sandbox/app/config.js,
// loaded first). Call:
//   window.googleSignIn(el, (credential) => { ... })
// to put Google's button in el; credential is the ID token for the server.
// The journal's Drive sync uses window.googleLoad() to load Google's script.
(function () {
  let loading = null;
  const load = () => {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { loading = null; reject(new Error("Couldn't load Google sign-in. Check your connection or ad blocker.")); };
        document.head.appendChild(s);
      });
    }
    return loading;
  };

  window.googleSignIn = async function (el, onCredential) {
    const clientId = window.TBS_GOOGLE_CLIENT_ID || "";
    if (!clientId) throw new Error("Google sign-in isn't set up on this site yet.");
    await load();
    google.accounts.id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential), auto_select: false });
    el.innerHTML = "";
    google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with" });
  };
  window.googleLoad = load;
  window.googleSignOut = () => { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); };
})();
