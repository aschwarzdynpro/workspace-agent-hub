// Webview script for the overview panel. No framework on purpose: state in, DOM out.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") render(e.data.state);
  });

  function render(state) {
    const c = state.counts;
    $("subtitle").textContent = `${state.roots.length} workspaces · updated ${new Date(state.generatedAt).toLocaleTimeString()}`;
    $("kpis").replaceChildren(
      kpi(c.working, "working"),
      kpi(c.waiting, "waiting for you", c.waiting > 0 ? "wait" : ""),
      kpi(c.done, "done"),
      kpi(c.idle, "idle")
    );
    $("cards").replaceChildren(...state.roots.map(card));
    $("footer").textContent = "Source: Claude Code hooks → NDJSON spool + ~/.claude/projects transcripts. Read-only; no API calls.";
  }

  function kpi(n, label, cls) {
    const d = el("div", "kpi " + (cls || ""));
    d.append(el("div", "n", String(n)), el("div", "l", label));
    return d;
  }

  function card(root) {
    const waiting = root.sessions.some((s) => s.status === "waiting");
    const d = el("div", "card" + (waiting ? " wait" : ""));
    const head = el("div", "head");
    const top = root.sessions[0];
    head.append(
      el("span", "dot " + (top ? top.status : "idle")),
      el("span", "name", root.name),
      el("span", "chip" + (waiting ? " wait" : ""), waiting ? "waiting for you" : top ? top.status : "idle")
    );
    const p = el("div", "path", root.kind === "coordinator" ? "coordinator · no repo" : root.displayPath);
    p.title = root.path;
    d.append(head, p);

    if (!root.sessions.length) d.append(el("div", "empty", "No active session."));
    for (const s of root.sessions) {
      const sd = el("div", "session");
      sd.addEventListener("click", () => vscode.postMessage({ type: "focus", sessionId: s.id }));
      const t = el("div", "t");
      t.append(el("span", "dot " + s.status), el("span", "", s.title || "(untitled)"));
      sd.append(t);
      if (s.status === "waiting" && s.lastMessage) sd.append(el("div", "msg", s.lastMessage));
      const sub = [s.status];
      if (s.currentTool) sub.push(s.currentTool + (s.currentToolHint ? " " + s.currentToolHint : ""));
      sub.push(rel(s.lastEventAt));
      sd.append(el("div", "sub", sub.join(" · ")));
      d.append(sd);
    }

    const row = el("div", "row");
    const b1 = el("button", "btn pri", root.sessions.length ? "Open" : "New session");
    b1.addEventListener("click", () =>
      vscode.postMessage(root.sessions.length ? { type: "focus", sessionId: root.sessions[0].id } : { type: "newSession", rootId: root.id })
    );
    const b2 = el("button", "btn", root.sessions.length ? "New session" : "Resume…");
    b2.addEventListener("click", () => vscode.postMessage(root.sessions.length ? { type: "newSession", rootId: root.id } : { type: "resume", rootId: root.id }));
    row.append(b1, b2);
    d.append(row);
    return d;
  }

  function rel(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.round(d / 60000) + " min ago";
    if (d < 86400000) return Math.round(d / 3600000) + " h ago";
    return Math.round(d / 86400000) + " d ago";
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
})();
