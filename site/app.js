(function () {
  "use strict";

  const API_BASE = (window.HOME_OFFICE_CONFIG || {}).API_BASE || "";
  const content = document.getElementById("content");

  // Load the public guide (everything except WiFi) on page load — no PIN.
  // WiFi is fetched later, only after a valid PIN, from inside its own tile.
  async function loadGuide() {
    content.hidden = false;
    content.innerHTML = "";
    content.appendChild(el("p", { class: "grid-hint" }, ["Loading…"]));
    try {
      const res = await fetch(API_BASE + "/guide", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "bad response");
      render(data.guest || {});
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("p", { class: "grid-hint error" },
        ["Couldn't load the guide. Are you on the WiFi? Try refreshing."]));
      if (window.console) console.error("guide load failed:", err);
    }
  }

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
      // Gated: the tile opens a PIN prompt; a valid PIN swaps in wifiBody().
      title: "Join the WiFi", body: function () { return wifiLockedBody(); },
    },
    {
      key: "monitor", icon: "🖥️", label: "Monitor", tint: "t-monitor",
      title: "Dell Monitor", sub: function (d) { return d.model; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "desk", icon: "🪑", label: "Standing Desk", tint: "t-desk",
      title: "Standing Desk", sub: function (d) { return d.model; },
      body: function (d) { return [steps(d.steps), docsLink(d.docs_url)]; },
    },
    {
      key: "keyboard_mouse", icon: "⌨️🖱️", label: "Keyboard / Mouse", tint: "t-kbd",
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

  // WiFi is the one gated section: it has no public data, so its tile opens a
  // PIN prompt. A correct PIN fetches /unlock and swaps in the WiFi details.
  function wifiLockedBody() {
    const nodes = [];
    nodes.push(el("p", { class: "hint subtle" },
      ["WiFi is protected. Enter the rotating 6-digit PIN from the desk gadget."]));

    const input = el("input", {
      id: "wifi-pin", inputmode: "numeric", pattern: "[0-9]*",
      maxlength: "6", placeholder: "000000", "aria-label": "6-digit PIN",
      autocomplete: "off",
    }, []);
    const submit = el("button", { type: "submit", class: "primary wide" }, ["Unlock WiFi"]);
    const errP = el("p", { class: "error", role: "alert", hidden: "hidden" }, []);

    const formEl = el("form", { class: "pin-form-modal", autocomplete: "off" },
      [input, submit, errP]);

    formEl.addEventListener("submit", async function (e) {
      e.preventDefault();
      errP.hidden = true;
      const pin = input.value.trim();
      if (!/^\d{6}$/.test(pin)) {
        errP.textContent = "Enter the 6-digit PIN from the desk.";
        errP.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = "Checking…";
      try {
        const res = await fetch(API_BASE + "/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          errP.textContent = "Too many tries. Wait a few seconds and try again.";
          errP.hidden = false;
          return;
        }
        if (!res.ok) {
          errP.textContent = data.error || "Something went wrong. Try again.";
          errP.hidden = false;
          return;
        }
        // Unlocked — replace the modal body with the WiFi details.
        setModalBody(wifiBody(data.wifi || {}));
      } catch (err) {
        errP.textContent = "Couldn't reach the server. Are you on the WiFi?";
        errP.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = "Unlock WiFi";
      }
    });

    nodes.push(formEl);
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

  function setModalBody(nodes) {
    modalBody.innerHTML = "";
    nodes.forEach(function (n) { if (n) modalBody.appendChild(n); });
  }

  function openModal(section, data) {
    modalTitle.textContent = section.title || section.label;
    const sub = section.sub ? section.sub(data || {}) : "";
    modalSub.textContent = sub || "";
    modalSub.hidden = !sub;
    setModalBody(section.body(data));
    dialog.showModal();
    // Focus the PIN field when WiFi opens.
    const pin = modalBody.querySelector("#wifi-pin");
    if (pin) pin.focus();
  }

  // --- Home grid of tiles --------------------------------------------------
  function render(g) {
    content.innerHTML = "";
    content.appendChild(el("p", { class: "grid-hint" }, ["Tap anything to see how to use it."]));
    const grid = el("div", { class: "grid" }, []);

    SECTIONS.forEach(function (section) {
      // WiFi always shows (it's gated, not in the public payload). Other tiles
      // show only if the public guide included their data.
      const data = g[section.key];
      if (section.key !== "wifi" && !data) return;

      const iconNodes = [el("span", { class: "tile-icon", "aria-hidden": "true" }, [section.icon])];
      if (section.key === "wifi") {
        iconNodes.push(el("span", { class: "tile-lock", "aria-hidden": "true" }, ["🔒"]));
      }
      const tile = el("button", {
        type: "button", class: "tile " + section.tint, "aria-haspopup": "dialog",
      }, [
        el("span", { class: "tile-icon-wrap" }, iconNodes),
        el("span", { class: "tile-label" }, [section.label]),
      ]);
      tile.addEventListener("click", function () { openModal(section, data); });
      grid.appendChild(tile);
    });

    content.appendChild(grid);
    content.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  loadGuide();
})();
