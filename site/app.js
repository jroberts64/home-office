(function () {
  "use strict";

  const API_BASE = (window.HOME_OFFICE_CONFIG || {}).API_BASE || "";
  const form = document.getElementById("pin-form");
  const pinInput = document.getElementById("pin");
  const btn = document.getElementById("unlock-btn");
  const errorEl = document.getElementById("error");
  const gate = document.getElementById("gate");
  const content = document.getElementById("content");

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearError();
    const pin = pinInput.value.trim();
    if (!/^\d{6}$/.test(pin)) {
      showError("Enter the 6-digit PIN from the desk.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Checking…";
    let data;
    try {
      const res = await fetch(API_BASE + "/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || "Something went wrong. Try again.");
        return;
      }
    } catch (err) {
      // Only genuine fetch failures reach here (DNS, offline, CORS).
      showError("Couldn't reach the server. Are you on the WiFi?");
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }

    // Render outside the network try so a display bug isn't mislabeled as a
    // connection problem.
    try {
      render(data.guest || {});
    } catch (err) {
      showError("Unlocked, but something went wrong showing the guide. Tell Jack.");
      if (window.console) console.error("render failed:", err);
    }
  });

  // --- Rendering -----------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => {
      if (c == null || c === "") return;
      // Coerce anything that isn't already a DOM node to text, so a value that
      // arrives as a number/boolean (e.g. an all-digit SSID) renders instead of
      // throwing inside appendChild and blanking the page.
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function card(icon, title, model, bodyNodes) {
    const head = [el("span", { class: "icon" }, [icon]), title];
    const nodes = [el("h3", null, head)];
    if (model) nodes.push(el("p", { class: "model" }, [model]));
    bodyNodes.forEach((n) => nodes.push(n));
    return el("section", { class: "card item" }, nodes);
  }

  // Split a string into text + clickable-link nodes. Only http(s) URLs are
  // linkified; everything is inserted as text/DOM nodes (never innerHTML), so
  // there's no injection risk even though the source is our own SSM config.
  function linkify(text) {
    const parts = [];
    const re = /(https?:\/\/[^\s<>"')]+)/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      let url = m[0];
      // Don't swallow a trailing sentence period into the URL.
      let trailer = "";
      while (url && ".,;:!?".includes(url[url.length - 1])) {
        trailer = url[url.length - 1] + trailer;
        url = url.slice(0, -1);
      }
      parts.push(el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, [url]));
      if (trailer) parts.push(trailer);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  function instr(text) {
    return text ? el("p", null, linkify(text)) : "";
  }

  // WiFi card: connect without seeing the password.
  //  - Phones: scan the QR (camera offers "Join network").
  //  - Laptops: "Copy password" writes it to the clipboard without showing it.
  //  - Optional "Show" reveals it as a last resort.
  function wifiCard(w) {
    const nodes = [];

    const kv = el("dl", { class: "kv" }, [
      el("dt", null, ["Network"]),
      el("dd", null, [el("code", null, [w.ssid || ""])]),
    ]);
    nodes.push(kv);

    // QR for phones.
    if (w.qr) {
      const img = el("img", {
        class: "wifi-qr", src: w.qr, alt: "WiFi join QR code", width: "180", height: "180",
      }, []);
      nodes.push(el("p", { class: "hint" }, ["📷 Scan with your phone camera to join"]));
      nodes.push(img);
    }

    // Copy button + optional reveal for laptops. Only if there is a password.
    if (w.password) {
      const actions = el("div", { class: "actions" }, []);

      const copyBtn = el("button", { type: "button", class: "secondary" }, ["📋 Copy password"]);
      copyBtn.addEventListener("click", async function () {
        try {
          await navigator.clipboard.writeText(w.password);
          copyBtn.textContent = "✓ Copied — paste into WiFi settings";
        } catch (e) {
          // Clipboard API needs HTTPS + a user gesture; we have both, but if it
          // fails, fall back to revealing so the guest isn't stuck.
          revealPw();
          copyBtn.textContent = "Couldn't copy — shown below";
        }
        setTimeout(() => { copyBtn.textContent = "📋 Copy password"; }, 4000);
      });
      actions.appendChild(copyBtn);

      const shownPw = el("code", { class: "pw", hidden: "hidden" }, [w.password]);
      const showLink = el("button", { type: "button", class: "linklike" }, ["Show password"]);
      function revealPw() {
        shownPw.hidden = false;
        showLink.hidden = true;
      }
      showLink.addEventListener("click", revealPw);
      actions.appendChild(showLink);

      nodes.push(actions);
      nodes.push(shownPw);
      nodes.push(el("p", { class: "hint subtle" }, ["On a laptop? Copy the password, then paste it into your WiFi settings — no need to read it."]));
    }

    if (w.notes) nodes.push(instr(w.notes));
    return card("📶", "WiFi", null, nodes);
  }

  function render(g) {
    content.innerHTML = "";
    const frag = document.createDocumentFragment();

    if (g.wifi) {
      frag.appendChild(wifiCard(g.wifi));
    }
    if (g.monitor) {
      frag.appendChild(card("🖥️", "Dell Monitor", g.monitor.model, [instr(g.monitor.instructions)]));
    }
    if (g.desk) {
      frag.appendChild(card("🪑", "Vivo Standing Desk", g.desk.model, [instr(g.desk.instructions)]));
    }
    if (g.keyboard_mouse) {
      frag.appendChild(card("⌨️", "Keyboard & Mouse", g.keyboard_mouse.model, [instr(g.keyboard_mouse.instructions)]));
    }
    if (g.sonos) {
      const room = g.sonos.room ? el("p", { class: "model" }, ["Room: " + g.sonos.room]) : "";
      frag.appendChild(card("🔊", "Sonos Speakers", null, [room, instr(g.sonos.instructions)]));
    }
    if (g.home_assistant) {
      const ha = g.home_assistant;
      const rows = [
        el("dt", null, ["URL"]),
        el("dd", null, [ha.url ? el("a", { href: ha.url, target: "_blank", rel: "noopener" }, [ha.url]) : ""]),
      ];
      // Only show a Login row if one is configured (guest may use URL-only access).
      if (ha.login) {
        rows.push(el("dt", null, ["Login"]), el("dd", null, [el("code", null, [ha.login])]));
      }
      const kv = el("dl", { class: "kv" }, rows);
      frag.appendChild(card("💡", "Lights (Home Assistant)", null, [kv, instr(ha.instructions)]));
    }

    content.appendChild(frag);
    content.hidden = false;
    gate.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
})();
