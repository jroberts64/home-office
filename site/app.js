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

  // A list of short numbered steps.
  function steps(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return el("ol", { class: "steps" },
      list.map((s) => el("li", null, linkify(String(s)))));
  }

  // A "Full manual" link at the foot of a modal.
  function docsLink(url) {
    if (!url) return "";
    return el("a", { class: "docs-link", href: url, target: "_blank", rel: "noopener noreferrer" },
      ["Full manual ↗"]);
  }

  // --- Section registry ----------------------------------------------------
  // Each entry: emoji, short tile label, tint class, modal title, and a body
  // builder that returns the modal content nodes. `data` is guest[key].
  const SECTIONS = [
    {
      key: "wifi", icon: "📶", label: "WiFi", tint: "t-wifi",
      title: "Join the WiFi", body: wifiBody,
    },
    {
      key: "monitor", icon: "🖥️", label: "Monitor", tint: "t-monitor",
      title: "Dell Monitor", sub: function (d) { return d.model; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "desk", icon: "🪑", label: "Desk", tint: "t-desk",
      title: "Standing Desk", sub: function (d) { return d.model; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "keyboard_mouse", icon: "⌨️🖱️", label: "Keyboard/Mouse", tint: "t-kbd",
      title: "Keyboard & Mouse", sub: function (d) { return d.model; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "sonos", icon: "🔊", label: "Speakers", tint: "t-sonos",
      title: "Sonos Speakers",
      sub: function (d) { return d.room ? "Room: " + d.room : ""; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "home_assistant", icon: "💡", label: "Lights", tint: "t-lights",
      title: "Basement Lights", body: haBody,
    },
  ];

  // WiFi modal body: QR (phones) + copy-password (laptops) + steps.
  function wifiBody(w) {
    const nodes = [];
    nodes.push(el("dl", { class: "kv" }, [
      el("dt", null, ["Network"]),
      el("dd", null, [el("code", null, [w.ssid])]),
    ]));

    if (w.qr) {
      nodes.push(el("img", {
        class: "wifi-qr", src: w.qr, alt: "WiFi join QR code", width: "200", height: "200",
      }, []));
      nodes.push(el("p", { class: "hint" }, ["Scan with your phone camera to join"]));
    }

    if (w.password) {
      const shownPw = el("code", { class: "pw", hidden: "hidden" }, [w.password]);
      const showLink = el("button", { type: "button", class: "linklike" }, ["Show password"]);
      function reveal() { shownPw.hidden = false; showLink.hidden = true; }
      showLink.addEventListener("click", reveal);

      const copyBtn = el("button", { type: "button", class: "primary wide" }, ["Copy password"]);
      copyBtn.addEventListener("click", async function () {
        try {
          await navigator.clipboard.writeText(w.password);
          copyBtn.textContent = "✓ Copied — paste into WiFi settings";
        } catch (e) {
          reveal();
          copyBtn.textContent = "Couldn't copy — shown below";
        }
        setTimeout(function () { copyBtn.textContent = "Copy password"; }, 4000);
      });
      nodes.push(copyBtn);
      nodes.push(el("p", { class: "hint subtle" }, ["On a laptop, copy the password and paste it into your WiFi settings."]));
      nodes.push(el("div", { class: "reveal-row" }, [showLink]));
      nodes.push(shownPw);
    }

    if (Array.isArray(w.steps) && w.steps.length) nodes.push(steps(w.steps));
    return nodes;
  }

  // Home Assistant modal body: steps + a big "Open dashboard" button + docs.
  function haBody(ha) {
    const nodes = [];
    if (Array.isArray(ha.steps) && ha.steps.length) nodes.push(steps(ha.steps));
    if (ha.url) {
      nodes.push(el("a", {
        class: "primary wide", href: ha.url, target: "_blank", rel: "noopener noreferrer",
      }, ["Open lights dashboard ↗"]));
    }
    if (ha.login) {
      nodes.push(el("dl", { class: "kv" }, [
        el("dt", null, ["Login"]), el("dd", null, [el("code", null, [ha.login])]),
      ]));
    }
    nodes.push(docsLink(ha.docs_url));
    return nodes;
  }

  // --- Modal ---------------------------------------------------------------
  const dialog = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalSub = document.getElementById("modal-sub");
  const modalBody = document.getElementById("modal-body");
  document.getElementById("modal-close").addEventListener("click", function () { dialog.close(); });
  // Click on the backdrop (outside the inner panel) closes the modal.
  dialog.addEventListener("click", function (e) {
    if (e.target === dialog) dialog.close();
  });

  function openModal(section, data) {
    modalTitle.textContent = section.title || section.label;
    const sub = section.sub ? section.sub(data) : "";
    modalSub.textContent = sub || "";
    modalSub.hidden = !sub;
    modalBody.innerHTML = "";
    section.body(data).forEach(function (n) { if (n) modalBody.appendChild(n); });
    dialog.showModal();
  }

  // --- Home grid of tiles --------------------------------------------------
  function render(g) {
    content.innerHTML = "";
    content.appendChild(el("p", { class: "grid-hint" }, ["Tap anything to see how to use it."]));
    const grid = el("div", { class: "grid" }, []);

    SECTIONS.forEach(function (section) {
      const data = g[section.key];
      if (!data) return; // only show tiles we have content for
      const tile = el("button", {
        type: "button", class: "tile " + section.tint, "aria-haspopup": "dialog",
      }, [
        el("span", { class: "tile-icon", "aria-hidden": "true" }, [section.icon]),
        el("span", { class: "tile-label" }, [section.label]),
      ]);
      tile.addEventListener("click", function () { openModal(section, data); });
      grid.appendChild(tile);
    });

    content.appendChild(grid);
    content.hidden = false;
    gate.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
})();
