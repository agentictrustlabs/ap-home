// First thing in every page's head, before anything paints: mark the document when THIS TAB holds a Home session, so the
// steward's menu and pages show only to someone signed in. It decides nothing — what a session may do is the runtime's answer.
try { if (JSON.parse(sessionStorage.getItem('estate.home-session') ?? 'null')?.token) document.documentElement.dataset.connected = ''; } catch { /* no storage: not connected */ }
