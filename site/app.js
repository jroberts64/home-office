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

  function render(g) {
    content.innerHTML = "";
    const frag = document.createDocumentFragment();

    if (g.wifi) {
      const kv = el("dl", { class: "kv" }, [
        el("dt", null, ["Network"]), el("dd", null, [el("code", null, [g.wifi.ssid || ""])]),
        el("dt", null, ["Password"]), el("dd", null, [el("code", null, [g.wifi.password || ""])]),
      ]);
      frag.appendChild(card("📶", "WiFi", null, [kv, instr(g.wifi.notes)]));
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
