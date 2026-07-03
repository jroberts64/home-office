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
    try {
      const res = await fetch(API_BASE + "/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || "Something went wrong. Try again.");
        return;
      }
      render(data.guest || {});
    } catch (err) {
      showError("Couldn't reach the server. Are you on the WiFi?");
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  });

  // --- Rendering -----------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) =>
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return node;
  }

  function card(icon, title, model, bodyNodes) {
    const head = [el("span", { class: "icon" }, [icon]), title];
    const nodes = [el("h3", null, head)];
    if (model) nodes.push(el("p", { class: "model" }, [model]));
    bodyNodes.forEach((n) => nodes.push(n));
    return el("section", { class: "card item" }, nodes);
  }

  function instr(text) {
    return text ? el("p", null, [text]) : "";
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
      const kv = el("dl", { class: "kv" }, [
        el("dt", null, ["URL"]),
        el("dd", null, [ha.url ? el("a", { href: ha.url, target: "_blank", rel: "noopener" }, [ha.url]) : ""]),
        el("dt", null, ["Login"]), el("dd", null, [el("code", null, [ha.login || ""])]),
      ]);
      frag.appendChild(card("💡", "Lights (Home Assistant)", null, [kv, instr(ha.instructions)]));
    }

    content.appendChild(frag);
    content.hidden = false;
    gate.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
})();
