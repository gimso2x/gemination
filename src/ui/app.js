(function () {
  "use strict";

  const csrfMeta = document.querySelector('meta[name="gemination-csrf"]');
  const CSRF_TOKEN = csrfMeta ? csrfMeta.getAttribute("content") || "" : "";

  const VIEW_TITLES = {
    workspace: "워크스페이스",
    connect: "연결 및 로그인",
    files: "파일 및 Git",
    activity: "활동 로그",
    settings: "설정 및 보안",
  };

  let state = null;
  let currentView = "workspace";
  let explorerRoot = "";
  let explorerPath = "";
  let explorerParent = null;
  let tunnelRadioInitialized = false;
  let toastTimer = null;
  let consecutiveFailures = 0;
  let lastRootsKey = "";
  let lastClientsKey = "";
  let lastEventsKey = "";
  let lastProcessesKey = "";
  let lastRecentAuditKey = "";
  let lastFullAuditKey = "";
  let lastAuditFilterKey = "";
  let lastLocalClientsKey = "";
  let lastSnippetJson = "";

  const shellEl = document.getElementById("appShell");
  const sidebarEl = document.getElementById("sidebar");
  const sidebarToggleEl = document.getElementById("sidebarToggle");
  const drawerBackdropEl = document.getElementById("drawerBackdrop");
  const toastEl = document.getElementById("toast");
  const mobileMedia = window.matchMedia("(max-width: 900px)");

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2800);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gemination-theme", theme);
    const useEl = document.querySelector("#themeIcon use");
    if (useEl) {
      useEl.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    }
  }

  const savedTheme = localStorage.getItem("gemination-theme") || "dark";
  applyTheme(savedTheme === "light" ? "light" : "dark");

  function syncSidebarAccessibility() {
    if (mobileMedia.matches) {
      const open = shellEl.classList.contains("is-mobile-open");
      drawerBackdropEl.hidden = !open;
      sidebarEl.setAttribute("aria-hidden", open ? "false" : "true");
      if ("inert" in sidebarEl) {
        sidebarEl.inert = !open;
      }
      sidebarToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
    } else {
      const collapsed = shellEl.classList.contains("is-collapsed");
      shellEl.classList.remove("is-mobile-open");
      drawerBackdropEl.hidden = true;
      sidebarEl.setAttribute("aria-hidden", collapsed ? "true" : "false");
      if ("inert" in sidebarEl) {
        sidebarEl.inert = collapsed;
      }
      sidebarToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  function closeMobileDrawer(returnFocus = false) {
    if (!shellEl.classList.contains("is-mobile-open")) return;
    shellEl.classList.remove("is-mobile-open");
    syncSidebarAccessibility();
    if (returnFocus) {
      sidebarToggleEl.focus();
    }
  }

  mobileMedia.addEventListener("change", () => {
    syncSidebarAccessibility();
  });
  syncSidebarAccessibility();

  async function apiGet(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "요청 실패");
    }
    return data;
  }

  async function apiPost(path, body = {}) {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gemination-Local-Token": CSRF_TOKEN,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "요청 실패");
    }
    return data;
  }

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (btn.classList.contains("btn-icon")) {
      btn.disabled = busy;
      btn.setAttribute("aria-busy", busy ? "true" : "false");
      return;
    }
    if (busy) {
      const span = btn.querySelector("span");
      btn.dataset.origLabel = span ? span.textContent || "" : btn.textContent || "";
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      if (busyText) {
        if (span) span.textContent = busyText;
        else btn.textContent = busyText;
      }
    } else {
      btn.disabled = false;
      btn.setAttribute("aria-busy", "false");
      if (btn.dataset.origLabel !== undefined) {
        const span = btn.querySelector("span");
        if (span) span.textContent = btn.dataset.origLabel;
        else btn.textContent = btn.dataset.origLabel;
        delete btn.dataset.origLabel;
      }
    }
  }

  function switchView(viewName) {
    if (!VIEW_TITLES[viewName]) return;
    currentView = viewName;
    document.getElementById("topbarTitle").textContent = VIEW_TITLES[viewName];

    document.querySelectorAll(".nav-item").forEach((btn) => {
      const active = btn.getAttribute("data-view") === viewName;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view").forEach((panel) => {
      const match = panel.getAttribute("data-view-panel") === viewName;
      panel.classList.toggle("is-active", match);
      panel.hidden = !match;
    });

    closeMobileDrawer(false);

    if (viewName === "files" && state && state.config.roots.length > 0) {
      if (!explorerRoot || !state.config.roots.includes(explorerRoot)) {
        explorerRoot = state.config.roots[0];
        explorerPath = explorerRoot;
        explorerParent = null;
      }
      void loadExplorer();
    }
  }

  function renderAuditRows(tbody, entries, emptyMessage) {
    tbody.replaceChildren();
    if (!entries || entries.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted-meta";
      td.textContent = emptyMessage || "기록된 도구 호출이 없습니다.";
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const entry of entries) {
      const tr = document.createElement("tr");
      const tdTime = document.createElement("td");
      tdTime.textContent = new Date(entry.ts).toLocaleTimeString();

      const tdTool = document.createElement("td");
      tdTool.textContent = entry.tool;

      const tdOk = document.createElement("td");
      tdOk.className = entry.ok ? "cell-ok" : "cell-err";
      tdOk.textContent = entry.ok ? "OK" : "ERR";

      const tdDur = document.createElement("td");
      tdDur.textContent = `${entry.durationMs}ms`;

      const tdSum = document.createElement("td");
      let summaryText = entry.summary || "";
      if (entry.maskedSecrets && entry.maskedSecrets.length > 0) {
        summaryText += ` [시크릿 가림: ${entry.maskedSecrets.join(", ")}]`;
      }
      if (entry.error) {
        summaryText += ` — ${entry.error}`;
      }
      tdSum.textContent = summaryText;

      tr.append(tdTime, tdTool, tdOk, tdDur, tdSum);
      tbody.append(tr);
    }
  }

  function formatRootOptionLabel(rootPath) {
    if (!rootPath || rootPath.length <= 32) return rootPath;
    const sep = rootPath.includes("\\") ? "\\" : "/";
    const parts = rootPath.split(/[/\\]+/).filter(Boolean);
    if (parts.length <= 2) return rootPath;
    const tail = parts.slice(-2).join(sep);
    return tail.length <= 28 ? `...${sep}${tail}` : parts[parts.length - 1];
  }

  function formatTunnelLabel(mode) {
    switch (mode) {
      case "tailscale":
        return "Tailscale Funnel";
      case "quick":
        return "Quick Tunnel";
      case "custom":
        return "고정 URL";
      default:
        return "로컬 전용";
    }
  }

  function renderOfflineState() {
    document.getElementById("railStatusDot").className = "status-dot is-err";
    document.getElementById("railStatusTitle").textContent = "서버 연결 끊김";
    document.getElementById("railStatusSub").textContent = "로컬 서버가 종료되었거나 응답하지 않습니다";
    const pillEl = document.getElementById("topbarTunnelPill");
    pillEl.className = "status-pill is-err";
    pillEl.textContent = "오프라인 (연결 끊김)";
    document.getElementById("readyTunnelText").textContent = "연결 끊김";
    document.getElementById("readyTunnelSub").textContent = "터미널에서 서버 상태를 확인하세요.";
  }

  function renderStatus(data) {
    consecutiveFailures = 0;
    state = data;
    const roots = data.config.roots || [];
    const primaryRoot = roots[0] || "-";
    document.getElementById("topbarRoot").textContent = primaryRoot;

    // Rail & Topbar tunnel status
    const tState = data.tunnelState || { state: "idle", mode: data.tunnelMode || "none" };
    const dotEl = document.getElementById("railStatusDot");
    const pillEl = document.getElementById("topbarTunnelPill");
    const modeLabel = formatTunnelLabel(tState.mode || data.tunnelMode);

    if (tState.state === "connected" && tState.mode !== "none") {
      dotEl.className = "status-dot is-ok";
      pillEl.className = "status-pill is-ok";
      pillEl.textContent = `${modeLabel} 연결됨`;
      document.getElementById("railStatusTitle").textContent = `${modeLabel} 활성`;
      document.getElementById("railStatusSub").textContent = data.publicBaseUrl;
    } else if (tState.state === "starting") {
      dotEl.className = "status-dot is-warn";
      pillEl.className = "status-pill is-warn";
      pillEl.textContent = "터널 시작 중...";
      document.getElementById("railStatusTitle").textContent = "터널 연결 중...";
      document.getElementById("railStatusSub").textContent = modeLabel;
    } else if (tState.state === "error") {
      dotEl.className = "status-dot is-err";
      pillEl.className = "status-pill is-err";
      pillEl.textContent = "터널 오류";
      document.getElementById("railStatusTitle").textContent = "터널 연결 오류";
      document.getElementById("railStatusSub").textContent = tState.error || "연결 탭 확인";
    } else {
      dotEl.className = "status-dot";
      pillEl.className = "status-pill";
      pillEl.textContent = "로컬 전용";
      document.getElementById("railStatusTitle").textContent = "로컬 대기 중";
      document.getElementById("railStatusSub").textContent = data.localBaseUrl;
    }

    // Rail allowed roots & selectors (only rebuild when roots actually change)
    const rootsKey = roots.join("\0");
    if (rootsKey !== lastRootsKey) {
      lastRootsKey = rootsKey;

      const railRoots = document.getElementById("railRoots");
      railRoots.replaceChildren();
      for (const root of roots) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rail-root-btn";
        btn.title = root;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "ico");
        svg.setAttribute("viewBox", "0 0 24 24");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#i-folder");
        svg.append(use);
        const span = document.createElement("span");
        span.textContent = root.split(/[/\\]+/).filter(Boolean).pop() || root;
        btn.append(svg, span);
        btn.onclick = () => {
          explorerRoot = root;
          explorerPath = root;
          explorerParent = null;
          switchView("files");
        };
        railRoots.append(btn);
      }

      const settingsRoots = document.getElementById("settingsRootsList");
      settingsRoots.replaceChildren();
      for (const root of roots) {
        const row = document.createElement("div");
        row.className = "root-manage-row";
        const code = document.createElement("code");
        code.textContent = root;
        const rmBtn = document.createElement("button");
        rmBtn.type = "button";
        rmBtn.className = "btn btn-compact";
        rmBtn.textContent = "제거";
        rmBtn.disabled = roots.length <= 1;
        rmBtn.onclick = async () => {
          try {
            await apiPost("/_local/roots", { action: "remove", path: root });
            showToast("작업 폴더를 제거했습니다.");
            await refresh();
          } catch (err) {
            showToast(err.message);
          }
        };
        row.append(code, rmBtn);
        settingsRoots.append(row);
      }
    }

    // Nav running processes count
    const procCount = Number(data.activeProcesses || 0);
    const navProc = document.getElementById("navProcCount");
    navProc.hidden = procCount === 0;
    navProc.textContent = String(procCount);

    // Readiness Strip
    const lcClients = Array.isArray(data.localClients?.clients) ? data.localClients.clients : [];
    const registeredLocalClients = lcClients.filter((c) => c.registered);
    const hasLocalClient = registeredLocalClients.length > 0;
    const isExternallyConnected = tState.state === "connected" && tState.mode !== "none";

    if (isExternallyConnected) {
      document.getElementById("readyTunnelText").textContent = `${modeLabel} 연결됨`;
      document.getElementById("readyTunnelSub").textContent =
        data.probeStatus && data.probeStatus.detail ? data.probeStatus.detail : data.publicBaseUrl;
    } else if (hasLocalClient) {
      document.getElementById("readyTunnelText").textContent = "로컬 MCP 연동됨 (한국 OK)";
      document.getElementById("readyTunnelSub").textContent =
        `${registeredLocalClients.map((c) => c.id).join(", ")} · 터널 불필요`;
    } else {
      document.getElementById("readyTunnelText").textContent = modeLabel;
      document.getElementById("readyTunnelSub").textContent =
        data.probeStatus && data.probeStatus.detail ? data.probeStatus.detail : data.publicBaseUrl;
    }

    const bp = data.browserProfile || {};
    document.getElementById("readyBrowserText").textContent = bp.initialized
      ? "전용 프로필 로그인 저장됨"
      : bp.chromeAvailable
        ? "전용 프로필 미로그인"
        : "기본 브라우저 사용";
    document.getElementById("readyBrowserSub").textContent = bp.chromeAvailable
      ? "전용 Chrome 프로필 지원"
      : "Chrome 미감지 (시스템 브라우저로 열림)";

    const activeTokens = Number(data.oauthSummary?.activeTokenCount || 0);
    document.getElementById("readyOAuthText").textContent =
      activeTokens > 0
        ? `연결됨 (토큰 ${activeTokens}개)`
        : hasLocalClient
          ? `로컬 stdio ${registeredLocalClients.length}개 활성`
          : "아직 미연결";
    document.getElementById("readyOAuthSub").textContent = data.latestPin
      ? `PIN: ${data.latestPin}`
      : hasLocalClient
        ? "웹 맞춤 앱 없이 사용 가능"
        : "필요 시 새 PIN 발급";

    // Probe badge
    const probeBadge = document.getElementById("probeBadge");
    if (data.probeStatus && data.probeStatus.ok && !data.probeStatus.skipped) {
      probeBadge.className = "status-pill is-ok";
      probeBadge.textContent = data.probeStatus.detail;
    } else if (data.probeStatus && !data.probeStatus.ok) {
      probeBadge.className = "status-pill is-warn";
      probeBadge.textContent = data.probeStatus.detail;
    } else {
      probeBadge.className = "status-pill";
      probeBadge.textContent = tState.mode === "none" ? "로컬 전용" : "HTTPS 점검 대기";
    }

    // Shared MCP URL & PIN
    document.getElementById("wsMcpUrl").textContent = data.mcpUrl;
    document.getElementById("connMcpUrl").textContent = data.mcpUrl;
    const pinLabel = data.latestPin || "기존 PIN 유지됨 (새로 발급하려면 버튼 클릭)";
    document.getElementById("wsPinValue").textContent = pinLabel;
    document.getElementById("connPinValue").textContent = pinLabel;

    // Workspace primary onboarding CTA & Quick / Tailscale / first-run notice
    document.getElementById("btnGoConnect").classList.toggle("btn-primary", !isExternallyConnected && !hasLocalClient);

    const noticeEl = document.getElementById("wsTunnelNotice");
    if (tState.mode === "quick") {
      noticeEl.hidden = false;
      noticeEl.className = "notice";
      noticeEl.textContent =
        "주의: Quick Tunnel 주소는 서버를 껐다 켜면 새로 발급되므로, 재시작할 때마다 커넥터를 다시 등록해야 합니다.";
    } else if (tState.mode === "tailscale" && tState.state === "connected") {
      noticeEl.hidden = false;
      noticeEl.className = "notice is-ok";
      noticeEl.textContent =
        "고정 주소 활성: Tailscale Funnel URL은 서버를 껐다 켜도 동일하게 유지됩니다.";
    } else if (!isExternallyConnected && tState.mode === "none" && hasLocalClient) {
      noticeEl.hidden = false;
      noticeEl.className = "notice is-ok";
      noticeEl.textContent =
        "한국 리전 로컬 MCP(stdio) 연동 완료: gemini.google.com 웹 맞춤 앱이 없어도 Gemini CLI(`gemini`) 등에서 바로 도구를 쓸 수 있습니다. 일반 웹 채팅에서는 아래 '파일 트리 + Git diff 자동 첨부'를 켜고 프롬프트를 보내세요.";
    } else if (!isExternallyConnected && tState.mode === "none") {
      noticeEl.hidden = false;
      noticeEl.className = "notice";
      if (data.tailscaleStatus && data.tailscaleStatus.running && data.tailscaleStatus.dnsName) {
        noticeEl.textContent =
          "외부 HTTPS 터널이 꺼져 있습니다. 한국 리전에서 웹 '맞춤 앱'이 막힌 경우 '연결 및 로그인'에서 Gemini CLI 1클릭 연동을 쓰거나, Developer Mode 계정은 Tailscale Funnel을 켜세요.";
      } else {
        noticeEl.textContent =
          "한국 리전에서는 gemini.google.com 웹 '맞춤 앱'이 제한될 수 있습니다. '연결 및 로그인'에서 Gemini CLI 1클릭 연동(터널 불필요) 또는 외부 HTTPS 터널 설정을 진행하세요.";
      }
    } else {
      noticeEl.hidden = true;
    }

    // Composer root select (memoized)
    const compSelect = document.getElementById("composerRootSelect");
    const compKey = Array.from(compSelect.options).map((o) => o.value).join("\0");
    if (compKey !== rootsKey) {
      const prevCompVal = compSelect.value;
      compSelect.replaceChildren();
      for (const root of roots) {
        const opt = document.createElement("option");
        opt.value = root;
        opt.textContent = formatRootOptionLabel(root);
        opt.title = root;
        compSelect.append(opt);
      }
      if (prevCompVal && roots.includes(prevCompVal)) {
        compSelect.value = prevCompVal;
      }
    }
    document.getElementById("composerContextBadge").textContent = `허용 폴더 ${roots.length}개`;

    // Connect & Login view (local stdio MCP clients)
    renderLocalClients(data.localClients);

    const bpBadge = document.getElementById("browserProfileBadge");
    bpBadge.className = bp.initialized ? "status-pill is-ok" : "status-pill";
    bpBadge.textContent = bp.initialized ? "전용 프로필 초기화됨" : "첫 로그인 대기";
    document.getElementById("browserProfilePath").textContent = bp.profileDir || "-";

    const clients = data.oauthClients || [];
    const clientsKey = JSON.stringify(clients);
    if (clientsKey !== lastClientsKey) {
      lastClientsKey = clientsKey;
      const clientsUl = document.getElementById("oauthClientsList");
      clientsUl.replaceChildren();
      if (clients.length === 0) {
        const li = document.createElement("li");
        li.textContent = "등록된 OAuth 클라이언트 없음";
        clientsUl.append(li);
      } else {
        for (const c of clients) {
          const li = document.createElement("li");
          li.textContent = `${c.clientName} · ${c.clientId}${c.isStatic ? " (정적)" : " (DCR)"}`;
          clientsUl.append(li);
        }
      }
    }

    const events = data.oauthEvents || [];
    const eventsKey = JSON.stringify(events.slice(0, 8));
    if (eventsKey !== lastEventsKey) {
      lastEventsKey = eventsKey;
      const eventsUl = document.getElementById("oauthEventsList");
      eventsUl.replaceChildren();
      if (events.length === 0) {
        const li = document.createElement("li");
        li.textContent = "아직 인증 이벤트 없음";
        eventsUl.append(li);
      } else {
        for (const ev of events.slice(0, 8)) {
          const li = document.createElement("li");
          li.textContent = `${new Date(ev.ts).toLocaleTimeString()} · ${ev.detail}`;
          eventsUl.append(li);
        }
      }
    }

    // Tunnel Options meta & radio selection
    const pm = data.platformMeta || {};
    const cfHint = pm.cloudflaredInstallHint || "brew install cloudflared";
    const tsHint = pm.tailscaleInstallHint || "brew install --cask tailscale";
    const tsMeta = document.getElementById("optTailscaleMeta");
    tsMeta.textContent = data.tailscaleStatus ? `상태: ${data.tailscaleStatus.detail}` : "확인 중";
    const cfMeta = document.getElementById("optQuickMeta");
    cfMeta.textContent = data.cloudflaredInstalled
      ? "상태: cloudflared 준비됨"
      : `상태: cloudflared 미설치 (${cfHint})`;

    const keepAwakeTitleEl = document.getElementById("keepAwakeTitle");
    if (keepAwakeTitleEl && pm.keepAwakeLabel) {
      keepAwakeTitleEl.textContent = pm.keepAwakeLabel;
    }
    const pickerLabelEl = document.getElementById("btnPickRootFinderLabel");
    if (pickerLabelEl && pm.folderPickerLabel) {
      pickerLabelEl.textContent = pm.folderPickerLabel;
    }
    const railPickEl = document.getElementById("railPickRoot");
    if (railPickEl && pm.folderPickerLabel) {
      railPickEl.title = pm.folderPickerLabel;
      railPickEl.setAttribute("aria-label", pm.folderPickerLabel);
    }
    const svcTitleEl = document.getElementById("servicePanelTitle");
    if (svcTitleEl && pm.serviceTitle) {
      svcTitleEl.textContent = pm.serviceTitle;
    }

    const connPill = document.getElementById("connTunnelStatePill");
    connPill.className = pillEl.className;
    connPill.textContent = pillEl.textContent;

    if (!tunnelRadioInitialized) {
      let desired = tState.mode || data.tunnelMode || "none";
      if (desired === "none") {
        if (data.tailscaleStatus && data.tailscaleStatus.running && data.tailscaleStatus.dnsName) {
          desired = "tailscale";
        } else if (data.cloudflaredInstalled) {
          desired = "quick";
        } else {
          desired = "tailscale";
        }
      }
      document.querySelectorAll('input[name="tunnelMode"]').forEach((el) => {
        if (el.value === desired) el.checked = true;
      });
      if (tState.publicUrl && desired === "custom") {
        document.getElementById("customUrlInput").value = tState.publicUrl;
      }
      tunnelRadioInitialized = true;
    }

    const tsNotice = document.getElementById("tailscaleActionNotice");
    if (
      typeof tState.tailscaleEnableUrl === "string"
      && tState.tailscaleEnableUrl.startsWith("https://login.tailscale.com/")
    ) {
      tsNotice.hidden = false;
      tsNotice.className = "notice";
      tsNotice.replaceChildren();
      const span = document.createElement("span");
      span.textContent = "Tailscale 계정에서 최초 1회 Funnel 활성화가 필요합니다: ";
      const a = document.createElement("a");
      a.href = tState.tailscaleEnableUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = tState.tailscaleEnableUrl;
      tsNotice.append(span, a);
    } else if (tState.state === "error" && tState.error) {
      tsNotice.hidden = false;
      tsNotice.className = "notice";
      tsNotice.textContent = `터널 오류: ${tState.error}`;
    } else if (!data.tailscaleStatus?.installed && !data.cloudflaredInstalled) {
      tsNotice.hidden = false;
      tsNotice.className = "notice";
      tsNotice.textContent =
        `외부 터널 도구가 아직 설치되어 있지 않습니다. 터미널에서 '${tsHint}' (추천·고정주소) 또는 '${cfHint}' 실행 후 다시 시도하세요.`;
    } else {
      tsNotice.hidden = true;
    }

    // Settings toggles & preset highlight
    const w = Boolean(data.config.allowWrite);
    const s = Boolean(data.config.allowShell);
    document.getElementById("setAllowWrite").checked = w;
    document.getElementById("setAllowShell").checked = s;
    document.getElementById("setShieldSecrets").checked = Boolean(data.config.shieldSecrets);
    document.getElementById("setKeepAwake").checked = Boolean(data.config.keepAwake);

    document.getElementById("presetDev").classList.toggle("is-active-preset", w && s);
    document.getElementById("presetSafe").classList.toggle("is-active-preset", !w && !s);
    document.getElementById("presetEditOnly").classList.toggle("is-active-preset", w && !s);

    // Service status
    const svc = data.serviceStatus || {};
    const svcBadge = document.getElementById("serviceBadge");
    const svcPath = svc.servicePath || svc.plistPath;
    if (!svc.supported) {
      svcBadge.className = "status-pill";
      svcBadge.textContent = "미지원 OS";
    } else if (svc.loaded) {
      svcBadge.className = "status-pill is-ok";
      svcBadge.textContent = "자동 실행 활성";
    } else if (svc.installed && svc.checked === false) {
      svcBadge.className = "status-pill";
      svcBadge.textContent = "등록됨";
    } else if (svc.installed) {
      svcBadge.className = "status-pill is-warn";
      svcBadge.textContent = "설치됨 (미실행)";
    } else {
      svcBadge.className = "status-pill";
      svcBadge.textContent = "미등록";
    }
    document.getElementById("serviceDetailText").textContent = svcPath
      ? `서비스 라벨: ${svc.label} (${svcPath})`
      : "시스템 로그인 시 자동으로 백그라운드 실행되도록 등록할 수 있습니다.";

    // Files root selector sync (memoized; reset explorerPath when active root disappears)
    const filesSelect = document.getElementById("filesRootSelect");
    const filesSelectKey = Array.from(filesSelect.options).map((o) => o.value).join("\0");
    if (filesSelectKey !== rootsKey) {
      const prevFilesVal = filesSelect.value;
      filesSelect.replaceChildren();
      for (const root of roots) {
        const opt = document.createElement("option");
        opt.value = root;
        opt.textContent = formatRootOptionLabel(root);
        opt.title = root;
        filesSelect.append(opt);
      }
      if (explorerRoot && roots.includes(explorerRoot)) {
        filesSelect.value = explorerRoot;
      } else if (prevFilesVal && roots.includes(prevFilesVal)) {
        filesSelect.value = prevFilesVal;
        explorerRoot = prevFilesVal;
        explorerPath = explorerRoot;
        explorerParent = null;
      } else if (roots.length > 0) {
        explorerRoot = roots[0];
        explorerPath = explorerRoot;
        explorerParent = null;
        filesSelect.value = explorerRoot;
      }
    }

    // Activity: Processes & Filtered Audit (memoized to avoid clobbering focus/selection)
    const recent = data.recentAudit || [];
    const recentSlice = recent.slice(0, 6);
    const recentKey = JSON.stringify(recentSlice);
    renderProcesses(data.processes || []);
    if (recentKey !== lastRecentAuditKey) {
      lastRecentAuditKey = recentKey;
      renderAuditRows(document.getElementById("wsAuditBody"), recentSlice);
    }
    renderFilteredAudit(recent);
  }

  function renderLocalClients(localClients) {
    const lc = localClients || { clients: [], snippetJson: "" };
    const clients = Array.isArray(lc.clients) ? lc.clients : [];
    const registeredCount = clients.filter((c) => c.registered).length;
    const badge = document.getElementById("localClientsBadge");
    if (badge) {
      badge.className = registeredCount > 0 ? "status-pill is-ok" : "status-pill";
      badge.textContent = registeredCount > 0 ? `${registeredCount}개 클라이언트 연동됨` : "미등록";
    }
    const snippetBox = document.getElementById("stdioSnippetBox");
    if (snippetBox && typeof lc.snippetJson === "string" && lc.snippetJson !== lastSnippetJson) {
      lastSnippetJson = lc.snippetJson;
      snippetBox.textContent = lc.snippetJson.trimEnd();
    }

    const listEl = document.getElementById("localClientsList");
    if (!listEl) return;
    const key = JSON.stringify(clients);
    if (key === lastLocalClientsKey) return;
    lastLocalClientsKey = key;

    listEl.replaceChildren();
    for (const c of clients) {
      const row = document.createElement("div");
      row.className = "client-row";

      const info = document.createElement("div");
      info.className = "client-info";

      const head = document.createElement("div");
      head.className = "client-head";

      const title = document.createElement("strong");
      title.textContent = c.label;

      const pill = document.createElement("span");
      if (c.registered && c.upToDate) {
        pill.className = "status-pill is-ok";
        pill.textContent = "연동됨";
      } else if (c.registered) {
        pill.className = "status-pill is-warn";
        pill.textContent = "경로 갱신 필요";
      } else {
        pill.className = "status-pill";
        pill.textContent = "미등록";
      }
      head.append(title, pill);

      if (typeof c.cliInstalled === "boolean") {
        const cliTag = document.createElement("span");
        cliTag.className = "tag";
        cliTag.textContent = c.cliInstalled ? "CLI 설치됨" : "CLI 미설치";
        head.append(cliTag);
      }

      const pathEl = document.createElement("div");
      pathEl.className = "client-path";
      pathEl.textContent = c.configPath;

      info.append(head, pathEl);

      const actions = document.createElement("div");
      actions.className = "row-actions";

      const regBtn = document.createElement("button");
      regBtn.type = "button";
      regBtn.className = c.registered && c.upToDate ? "btn btn-compact" : "btn btn-primary btn-compact";
      regBtn.textContent = c.registered ? (c.upToDate ? "재적용" : "경로 갱신") : "자동 등록";
      regBtn.onclick = async () => {
        setBusy(regBtn, true, "등록 중...");
        try {
          await apiPost("/_local/clients/register", { client: c.id });
          showToast(
            c.id === "gemini-cli"
              ? "Gemini CLI 등록 완료! 터미널에서 `gemini` 실행 후 `/mcp`로 연결하세요."
              : `${c.label}에 Gemination stdio MCP를 등록했습니다.`,
          );
          await refresh();
        } catch (err) {
          showToast(err.message);
        } finally {
          setBusy(regBtn, false);
        }
      };

      const unregBtn = document.createElement("button");
      unregBtn.type = "button";
      unregBtn.className = "btn btn-compact";
      unregBtn.textContent = "해제";
      unregBtn.disabled = !c.registered;
      unregBtn.onclick = async () => {
        setBusy(unregBtn, true, "해제 중...");
        try {
          await apiPost("/_local/clients/unregister", { client: c.id });
          showToast(`${c.label} 연동을 해제했습니다.`);
          await refresh();
        } catch (err) {
          showToast(err.message);
        } finally {
          setBusy(unregBtn, false);
        }
      };

      actions.append(regBtn, unregBtn);
      row.append(info, actions);
      listEl.append(row);
    }
  }

  function renderFilteredAudit(entries) {
    const q = (document.getElementById("auditSearchInput").value || "").trim().toLowerCase();
    const filter = document.getElementById("auditStatusFilter").value;
    const nextAuditKey = JSON.stringify(entries);
    const nextFilterKey = `${filter}\0${q}`;
    if (nextAuditKey === lastFullAuditKey && nextFilterKey === lastAuditFilterKey) {
      return;
    }
    lastFullAuditKey = nextAuditKey;
    lastAuditFilterKey = nextFilterKey;

    const filtered = entries.filter((item) => {
      if (filter === "ok" && !item.ok) return false;
      if (filter === "err" && item.ok) return false;
      if (q) {
        const hay = `${item.tool} ${item.summary || ""} ${item.error || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const emptyMsg = entries.length > 0
      ? "검색 또는 필터 조건에 일치하는 로그가 없습니다."
      : "기록된 도구 호출이 없습니다.";
    renderAuditRows(document.getElementById("fullAuditBody"), filtered, emptyMsg);
  }

  function renderProcesses(processes) {
    const nextProcessesKey = JSON.stringify(processes);
    if (nextProcessesKey === lastProcessesKey) {
      return;
    }
    lastProcessesKey = nextProcessesKey;
    document.getElementById("processCountLabel").textContent = `${processes.length}개`;
    const tbody = document.getElementById("processesBody");
    tbody.replaceChildren();
    if (processes.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "muted-meta";
      td.textContent = "현재 세션에서 시작한 백그라운드 프로세스가 없습니다.";
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const p of processes) {
      const tr = document.createElement("tr");
      const tdId = document.createElement("td");
      tdId.textContent = p.id;
      const tdPid = document.createElement("td");
      tdPid.textContent = String(p.pid);
      const tdStatus = document.createElement("td");
      tdStatus.textContent = p.status;
      tdStatus.className = p.status === "running" ? "cell-ok" : "";
      const tdCwd = document.createElement("td");
      tdCwd.textContent = p.cwd;
      const tdCmd = document.createElement("td");
      tdCmd.textContent = p.command;
      const tdAct = document.createElement("td");
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "btn btn-danger btn-compact";
      stopBtn.textContent = "중지";
      stopBtn.disabled = p.status !== "running";
      stopBtn.onclick = async () => {
        setBusy(stopBtn, true, "중지 중...");
        try {
          await apiPost("/_local/processes/stop", { id: p.id });
          showToast(`프로세스 ${p.id}를 중지했습니다.`);
          await refresh();
        } catch (err) {
          showToast(err.message);
        } finally {
          setBusy(stopBtn, false);
        }
      };
      tdAct.append(stopBtn);
      tr.append(tdId, tdPid, tdStatus, tdCwd, tdCmd, tdAct);
      tbody.append(tr);
    }
  }

  async function loadExplorer() {
    if (!explorerRoot) return;
    const dirToLoad = explorerPath || explorerRoot;
    const refreshBtn = document.getElementById("btnFilesRefresh");
    setBusy(refreshBtn, true, "로딩 중...");
    try {
      const [filesRes, gitRes] = await Promise.all([
        apiGet(`/_local/files?path=${encodeURIComponent(dirToLoad)}&root=${encodeURIComponent(explorerRoot)}`),
        apiGet(`/_local/git?root=${encodeURIComponent(explorerRoot)}`),
      ]);
      explorerPath = filesRes.directory;
      explorerParent = filesRes.parent || null;
      document.getElementById("filesCurrentPath").textContent = filesRes.directory;
      document.getElementById("btnFilesUp").disabled = !explorerParent;

      const tree = document.getElementById("fileTreeList");
      tree.replaceChildren();
      if (!filesRes.entries || filesRes.entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "muted-meta";
        empty.textContent = "비어 있는 폴더입니다.";
        tree.append(empty);
      } else {
        for (const item of filesRes.entries) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "tree-row";
          const left = document.createElement("span");
          left.className = "tree-row-left";
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("class", "ico");
          svg.setAttribute("viewBox", "0 0 24 24");
          const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute("href", item.type === "directory" ? "#i-folder" : "#i-file");
          svg.append(use);
          const nameSpan = document.createElement("span");
          nameSpan.textContent = item.name;
          left.append(svg, nameSpan);

          const right = document.createElement("span");
          right.className = "tree-size";
          right.textContent = item.type === "directory" ? "DIR" : item.size !== undefined ? `${item.size}B` : "";

          btn.append(left, right);
          btn.onclick = () => {
            if (item.type === "directory") {
              explorerPath = item.path;
              void loadExplorer();
            } else {
              void loadFilePreview(item.path);
            }
          };
          tree.append(btn);
        }
      }

      document.getElementById("gitStatusOut").textContent = gitRes.status || "(변경 사항 없음)";
      document.getElementById("gitDiffOut").textContent = gitRes.diff || "(diff 없음)";
    } catch (err) {
      document.getElementById("gitStatusOut").textContent = `조회 오류: ${err.message}`;
      showToast(err.message);
    } finally {
      setBusy(refreshBtn, false);
    }
  }

  async function loadFilePreview(filePath) {
    document.getElementById("previewPath").textContent = filePath;
    document.getElementById("filePreviewContent").textContent = "파일 읽는 중...";
    setInspectorTab("preview");
    try {
      const res = await apiGet(
        `/_local/file-content?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(explorerRoot)}`,
      );
      document.getElementById("previewPath").textContent = res.path + (res.truncated ? " (일부만 표시)" : "");
      document.getElementById("filePreviewContent").textContent = res.content || "(빈 파일)";
    } catch (err) {
      document.getElementById("filePreviewContent").textContent = `미리보기 불가: ${err.message}`;
      showToast(err.message);
    }
  }

  function setInspectorTab(tab) {
    const isGit = tab === "git";
    const gitBtn = document.getElementById("tabBtnGit");
    const prevBtn = document.getElementById("tabBtnPreview");
    gitBtn.classList.toggle("is-active", isGit);
    gitBtn.setAttribute("aria-selected", isGit ? "true" : "false");
    prevBtn.classList.toggle("is-active", !isGit);
    prevBtn.setAttribute("aria-selected", !isGit ? "true" : "false");
    document.getElementById("gitPane").hidden = !isGit;
    document.getElementById("previewPane").hidden = isGit;
  }

  async function refresh() {
    if (document.hidden && state) return;
    try {
      const data = await apiGet("/_local/status");
      renderStatus(data);
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 1) {
        renderOfflineState();
      }
    }
  }

  // Navigation & Topbar bindings
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.getAttribute("data-view")));
  });
  document.getElementById("btnGoConnect").addEventListener("click", () => switchView("connect"));
  document.getElementById("stepCardTunnel").addEventListener("click", () => {
    switchView("connect");
    const tState = state?.tunnelState || {};
    const isExt = tState.state === "connected" && tState.mode && tState.mode !== "none";
    const hasLocal = Array.isArray(state?.localClients?.clients) && state.localClients.clients.some((c) => c.registered);
    const targetId = !isExt && hasLocal ? "connectLocalClientsPanel" : "connectTunnelPanel";
    document.getElementById(targetId).scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("stepCardBrowser").addEventListener("click", () => {
    switchView("connect");
    document.getElementById("connectLoginPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("stepCardOAuth").addEventListener("click", () => {
    switchView("connect");
    const activeTokens = Number(state?.oauthSummary?.activeTokenCount || 0);
    const hasLocal = Array.isArray(state?.localClients?.clients) && state.localClients.clients.some((c) => c.registered);
    const targetId = activeTokens === 0 && hasLocal ? "connectLocalClientsPanel" : "connectGuidePanel";
    document.getElementById(targetId).scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("btnSeeAllActivity").addEventListener("click", () => switchView("activity"));

  sidebarToggleEl.addEventListener("click", () => {
    if (mobileMedia.matches) {
      shellEl.classList.remove("is-collapsed");
      const open = shellEl.classList.toggle("is-mobile-open");
      syncSidebarAccessibility();
      if (open) {
        document.getElementById("sidebarClose").focus();
      }
    } else {
      shellEl.classList.toggle("is-collapsed");
      syncSidebarAccessibility();
    }
  });
  document.getElementById("sidebarClose").addEventListener("click", () => closeMobileDrawer(true));
  drawerBackdropEl.addEventListener("click", () => closeMobileDrawer(true));

  document.getElementById("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  async function openGemini(mode, extraMessagePrefix, urlOverride) {
    try {
      const res = await apiPost("/_local/browser/open-gemini", {
        mode,
        ...(urlOverride ? { url: urlOverride } : {}),
      });
      const msg = res.usedMode === "dedicated-chrome"
        ? "전용 Chrome 창으로 Gemini를 열었습니다."
        : res.usedMode === "system-browser"
          ? "기본 브라우저로 Gemini를 열었습니다."
          : "브라우저 실행이 현재 환경(헤드리스/CI)에서 건너뛰어졌습니다.";
      showToast(extraMessagePrefix ? `${extraMessagePrefix} ${msg}` : msg);
      await refresh();
    } catch (err) {
      window.open(urlOverride || "https://gemini.google.com/app", "_blank", "noopener,noreferrer");
      showToast(err.message);
    }
  }

  document.getElementById("topbarOpenGemini").addEventListener("click", () => void openGemini("dedicated"));
  document.getElementById("btnOpenDedicatedGemini").addEventListener("click", () => void openGemini("dedicated"));
  document.getElementById("btnOpenGeminiDevMode").addEventListener("click", () =>
    void openGemini("dedicated", "", "https://gemini.google.com/devmode"),
  );
  document.getElementById("btnOpenDefaultGemini").addEventListener("click", () => void openGemini("default"));

  document.getElementById("btnCopyGeminiInstall").addEventListener("click", async () => {
    const cmd = document.getElementById("geminiInstallCmd")?.textContent || "npm install -g @google/gemini-cli";
    try {
      await navigator.clipboard.writeText(cmd);
      showToast("Gemini CLI 설치 명령을 복사했습니다.");
    } catch {
      showToast(cmd);
    }
  });

  document.getElementById("btnCopyStdioSnippet").addEventListener("click", async () => {
    const snippet = state?.localClients?.snippetJson || document.getElementById("stdioSnippetBox")?.textContent || "";
    try {
      await navigator.clipboard.writeText(snippet);
      showToast("stdio MCP JSON 설정을 복사했습니다.");
    } catch {
      showToast("JSON 복사 실패 — 위 박스 내용을 직접 복사하세요.");
    }
  });

  document.getElementById("btnResetBrowserProfile").addEventListener("click", async (e) => {
    if (!window.confirm("전용 Chrome 프로필(Google 로그인 세션 포함)을 초기화할까요?")) return;
    const btn = e.currentTarget;
    setBusy(btn, true, "초기화 중...");
    try {
      const res = await apiPost("/_local/browser/reset-profile");
      showToast(res.removed ? "전용 브라우저 로그인 프로필을 초기화했습니다." : "초기화할 프로필이 없습니다.");
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  async function copyMcpUrl() {
    if (!state) return;
    const isLocalOnly = typeof state.mcpUrl === "string" && state.mcpUrl.startsWith("http://127.0.0.1");
    try {
      await navigator.clipboard.writeText(state.mcpUrl);
      showToast(
        isLocalOnly
          ? "로컬 주소가 복사되었습니다. gemini.google.com 연결에는 외부 HTTPS 터널이 필요합니다."
          : "MCP URL을 클립보드에 복사했습니다.",
      );
    } catch {
      showToast(`URL: ${state.mcpUrl}`);
    }
  }
  document.getElementById("btnWsCopyUrl").addEventListener("click", () => void copyMcpUrl());
  document.getElementById("btnConnCopyUrl").addEventListener("click", () => void copyMcpUrl());

  async function rotatePinAction(btn) {
    setBusy(btn, true, "발급 중...");
    try {
      const res = await apiPost("/_local/rotate-pin");
      try { await navigator.clipboard.writeText(res.pin); } catch {}
      showToast(`새 승인 PIN 발급됨: ${res.pin}`);
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  }
  document.getElementById("btnWsRotatePin").addEventListener("click", (e) => void rotatePinAction(e.currentTarget));
  document.getElementById("btnConnRotatePin").addEventListener("click", (e) => void rotatePinAction(e.currentTarget));

  async function revokeAllAction(btn) {
    if (!window.confirm("연결된 모든 OAuth 액세스/리프레시 토큰을 즉시 폐기할까요?")) return;
    setBusy(btn, true, "차단 중...");
    try {
      const res = await apiPost("/_local/revoke-all");
      showToast(`모든 OAuth 토큰을 폐기했습니다 (${res.revokedCount}건).`);
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  }
  document.getElementById("btnRailKill").addEventListener("click", (e) => void revokeAllAction(e.currentTarget));
  document.getElementById("btnConnRevokeAll").addEventListener("click", (e) => void revokeAllAction(e.currentTarget));

  document.getElementById("btnLaunchTask").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const prompt = (document.getElementById("composerInput").value || "").trim();
    const targetRoot = document.getElementById("composerRootSelect").value || "";
    const attachContext = Boolean(document.getElementById("chkAttachContext")?.checked);
    let composed = prompt
      ? `[로컬 작업 폴더: ${targetRoot}]\n${prompt}`
      : `[로컬 작업 폴더: ${targetRoot}] local_info와 list_directory로 프로젝트 구조를 먼저 파악해줘.`;
    let prefix = "";
    let contextAttached = false;
    let packFailed = false;
    if (attachContext) {
      setBusy(btn, true, "컨텍스트 생성 중...");
      try {
        const pack = await apiPost("/_local/context-pack", { root: targetRoot, prompt });
        if (pack && typeof pack.composedPrompt === "string") {
          composed = pack.composedPrompt;
          contextAttached = true;
        }
      } catch (err) {
        packFailed = true;
        showToast(`컨텍스트 첨부 실패 (기본 프롬프트로 대체): ${err.message}`);
      } finally {
        setBusy(btn, false);
      }
    }
    try {
      await navigator.clipboard.writeText(composed);
      prefix = contextAttached
        ? "컨텍스트+프롬프트를 복사했고"
        : packFailed
          ? "기본 프롬프트를 복사했고"
          : "프롬프트를 복사했고";
    } catch {
      prefix = "";
    }
    await openGemini("dedicated", prefix);
  });

  // Tunnel controls
  document.getElementById("btnTunnelApply").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const checked = document.querySelector('input[name="tunnelMode"]:checked');
    const mode = checked ? checked.value : "none";
    const customUrl = document.getElementById("customUrlInput").value.trim();

    setBusy(btn, true, "연결 중...");
    try {
      await apiPost("/_local/tunnel/start", {
        mode,
        ...(mode === "custom" ? { publicUrl: customUrl } : {}),
      });
      showToast(`${formatTunnelLabel(mode)} 연결 완료`);
      await refresh();
    } catch (err) {
      showToast(err.message);
      await refresh();
    } finally {
      setBusy(btn, false);
    }
  });

  document.getElementById("btnTunnelStop").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, "중지 중...");
    try {
      await apiPost("/_local/tunnel/stop");
      tunnelRadioInitialized = false;
      showToast("외부 터널을 중지했습니다.");
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  document.getElementById("btnOpenTailscaleApp").addEventListener("click", async () => {
    try {
      await apiPost("/_local/tunnel/open-tailscale");
      showToast("Tailscale 앱 열기 요청 완료");
    } catch (err) {
      showToast(err.message);
    }
  });

  // Settings controls
  async function updateSettings(patch) {
    try {
      await apiPost("/_local/settings", patch);
      showToast("설정이 저장되었습니다.");
      await refresh();
    } catch (err) {
      showToast(err.message);
    }
  }
  document.getElementById("setAllowWrite").addEventListener("change", (e) =>
    void updateSettings({ allowWrite: e.target.checked }),
  );
  document.getElementById("setAllowShell").addEventListener("change", (e) =>
    void updateSettings({ allowShell: e.target.checked }),
  );
  document.getElementById("setShieldSecrets").addEventListener("change", (e) =>
    void updateSettings({ shieldSecrets: e.target.checked }),
  );
  document.getElementById("setKeepAwake").addEventListener("change", (e) =>
    void updateSettings({ keepAwake: e.target.checked }),
  );

  document.getElementById("presetDev").addEventListener("click", () =>
    void updateSettings({ allowWrite: true, allowShell: true, shieldSecrets: true }),
  );
  document.getElementById("presetSafe").addEventListener("click", () =>
    void updateSettings({ allowWrite: false, allowShell: false, shieldSecrets: true }),
  );
  document.getElementById("presetEditOnly").addEventListener("click", () =>
    void updateSettings({ allowWrite: true, allowShell: false, shieldSecrets: true }),
  );

  async function pickFolderViaFinder(btn) {
    setBusy(btn, true, "폴더 선택 중...");
    try {
      const res = await apiPost("/_local/roots/pick");
      if (res.unsupported) {
        showToast("네이티브 폴더 선택기가 없어 직접 경로 입력창으로 이동합니다.");
        switchView("settings");
        const inputEl = document.getElementById("settingsAddRootInput");
        if (inputEl) inputEl.focus();
      } else if (res.cancelled) {
        showToast("폴더 선택이 취소되었습니다.");
      } else {
        showToast(`작업 폴더 추가됨: ${res.added}`);
      }
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  }
  document.getElementById("railPickRoot").addEventListener("click", (e) => void pickFolderViaFinder(e.currentTarget));
  document.getElementById("btnPickRootFinder").addEventListener("click", (e) => void pickFolderViaFinder(e.currentTarget));

  async function submitAddRoot() {
    const input = document.getElementById("settingsAddRootInput");
    const btn = document.getElementById("btnSettingsAddRoot");
    const pathVal = input.value.trim();
    if (!pathVal) return;
    setBusy(btn, true, "추가 중...");
    try {
      await apiPost("/_local/roots", { action: "add", path: pathVal });
      input.value = "";
      showToast("작업 폴더를 추가했습니다.");
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(btn, false);
    }
  }
  document.getElementById("btnSettingsAddRoot").addEventListener("click", () => void submitAddRoot());
  document.getElementById("settingsAddRootInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitAddRoot();
    }
  });

  // Files & Git bindings
  document.getElementById("filesRootSelect").addEventListener("change", (e) => {
    explorerRoot = e.target.value;
    explorerPath = explorerRoot;
    explorerParent = null;
    void loadExplorer();
  });
  document.getElementById("btnFilesRefresh").addEventListener("click", () => void loadExplorer());
  document.getElementById("btnFilesUp").addEventListener("click", () => {
    if (explorerParent) {
      explorerPath = explorerParent;
      void loadExplorer();
    }
  });
  document.getElementById("tabBtnGit").addEventListener("click", () => setInspectorTab("git"));
  document.getElementById("tabBtnPreview").addEventListener("click", () => setInspectorTab("preview"));

  // Activity filter bindings
  document.getElementById("btnActivityRefresh").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, "갱신 중...");
    try {
      await refresh();
    } finally {
      setBusy(btn, false);
    }
  });
  document.getElementById("auditSearchInput").addEventListener("input", () => {
    if (state) renderFilteredAudit(state.recentAudit || []);
  });
  document.getElementById("auditStatusFilter").addEventListener("change", () => {
    if (state) renderFilteredAudit(state.recentAudit || []);
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMobileDrawer(true);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      sidebarToggleEl.click();
    }
    if (e.metaKey || e.ctrlKey) {
      const views = ["workspace", "connect", "files", "activity", "settings"];
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < views.length) {
        e.preventDefault();
        switchView(views[idx]);
      }
    }
  });

  void refresh();
  setInterval(() => void refresh(), 3000);
})();
