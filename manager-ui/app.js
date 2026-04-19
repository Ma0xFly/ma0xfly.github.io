const state = {
  notes: [],
  selected: new Set(),
  draftState: {},
  liveState: {},
  dirty: false,
  saveInFlight: false,
  saveQueued: false,
  autoSaveTimer: null,
  sourceRoot: "",
  livePollTimer: null,
};

const elements = {
  sourceRoot: document.querySelector("#source-root"),
  noteCount: document.querySelector("#note-count"),
  publishedCount: document.querySelector("#published-count"),
  search: document.querySelector("#search"),
  folderFilter: document.querySelector("#folder-filter"),
  statusFilter: document.querySelector("#status-filter"),
  recentFilter: document.querySelector("#recent-filter"),
  notesBody: document.querySelector("#notes-body"),
  selectVisibleToggle: document.querySelector("#select-visible-toggle"),
  selectionCount: document.querySelector("#selection-count"),
  filteredCount: document.querySelector("#filtered-count"),
  dirtyFlag: document.querySelector("#dirty-flag"),
  livePublishedCount: document.querySelector("#live-published-count"),
  draftPublishedCount: document.querySelector("#draft-published-count"),
  pendingCount: document.querySelector("#pending-count"),
  console: document.querySelector("#console"),
  previewStatus: document.querySelector("#preview-status"),
  previewPublished: document.querySelector("#preview-published"),
  previewAssets: document.querySelector("#preview-assets"),
  previewMissing: document.querySelector("#preview-missing"),
  missingAssets: document.querySelector("#missing-assets"),
  publishedSample: document.querySelector("#published-sample"),
  publishedLinks: document.querySelector("#published-links"),
  syncStatusLabel: document.querySelector("#sync-status-label"),
  syncPublishedCount: document.querySelector("#sync-published-count"),
  syncChangedCount: document.querySelector("#sync-changed-count"),
  syncLastTime: document.querySelector("#sync-last-time"),
  liveStatusBadge: document.querySelector("#live-status-badge"),
  liveStatusText: document.querySelector("#live-status-text"),
  liveStatusLink: document.querySelector("#live-status-link"),
};

await loadNotes();
bindEvents();
render();
await loadPreview();
await loadSyncStatus();

async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers ?? {});

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const payload = await response.json().catch(() => ({
    ok: false,
    error: `Invalid JSON response from ${url}`,
  }));

  if (!response.ok && payload.ok === undefined) {
    payload.ok = false;
  }

  return payload;
}

async function loadNotes() {
  const payload = await apiFetch("/api/notes");
  if (!payload.ok && payload.error) {
    log(`加载笔记失败: ${payload.error}`);
    return;
  }

  state.notes = Array.isArray(payload.notes) ? payload.notes : [];
  state.sourceRoot = payload.sourceRoot ?? "";
  state.liveState = payload.liveState && typeof payload.liveState === "object" ? payload.liveState : {};
  state.draftState = Object.fromEntries(
    state.notes.map((note) => [note.relativePath, { publish: note.draftPublish === true }]),
  );

  elements.sourceRoot.textContent = state.sourceRoot || "-";
  elements.noteCount.textContent = String(payload.noteCount ?? state.notes.length);
  elements.publishedCount.textContent = String(payload.livePublishedCount ?? payload.publishedCount ?? 0);
  if (elements.livePublishedCount) {
    elements.livePublishedCount.textContent = `线上生效 ${payload.livePublishedCount ?? payload.publishedCount ?? 0} 篇`;
  }
  if (elements.draftPublishedCount) {
    elements.draftPublishedCount.textContent = `草稿计划 ${payload.draftPublishedCount ?? 0} 篇`;
  }
  if (elements.pendingCount) {
    elements.pendingCount.textContent = `待部署 ${payload.pendingCount ?? 0} 篇`;
  }

  const folders = [...new Set(state.notes.map((note) => note.topLevel))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  elements.folderFilter.innerHTML =
    '<option value="">全部目录</option>' +
    folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("");

  log(`已加载 ${state.notes.length} 篇笔记。线上已生效 ${payload.livePublishedCount ?? payload.publishedCount ?? 0} 篇，待部署 ${payload.pendingCount ?? 0} 篇。`);
}

function bindEvents() {
  elements.search.addEventListener("input", render);
  elements.folderFilter.addEventListener("change", render);
  elements.statusFilter.addEventListener("change", render);
  elements.recentFilter.addEventListener("change", render);

  elements.selectVisibleToggle.addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;

    const filtered = getFilteredNotes();
    filtered.forEach((note) => {
      if (input.checked) state.selected.add(note.relativePath);
      else state.selected.delete(note.relativePath);
    });
    render();
    log(
      input.checked
        ? `已全选当前列表中的 ${filtered.length} 篇笔记。`
        : `已取消当前列表中的 ${filtered.length} 篇笔记选择。`,
    );
  });

  document.querySelector("#clear-selection").addEventListener("click", () => {
    const count = state.selected.size;
    state.selected.clear();
    render();
    log(count > 0 ? `已清空 ${count} 篇已选笔记。` : "当前没有已选笔记。");
  });

  document.querySelector("#publish-selected").addEventListener("click", async () => {
    await applyPublishToSelection(true);
  });
  document.querySelector("#unpublish-selected").addEventListener("click", async () => {
    await applyPublishToSelection(false);
  });
  document.querySelector("#save-state").addEventListener("click", saveState);
  document.querySelector("#preview-state").addEventListener("click", loadPreview);
  document.querySelector("#build-site").addEventListener("click", () => runAction("/api/actions/build", "构建"));
  document.querySelector("#check-site").addEventListener("click", () => runAction("/api/actions/check", "检查"));
  document.querySelector("#update-published").addEventListener("click", updatePublishedChanges);
  document.querySelector("#deploy-site").addEventListener("click", () => runAction("/api/actions/deploy", "部署"));
  document.querySelector("#publish-deploy-selected").addEventListener("click", publishAndDeploySelection);
  document.querySelector("#open-local-home").addEventListener("click", () => openUrl("http://127.0.0.1:4321/"));
  document.querySelector("#open-live-home").addEventListener("click", () => openUrl("https://ma0xfly.github.io/"));
  document.querySelector("#open-selected-local").addEventListener("click", () => openSelectedPosts("local"));
  document.querySelector("#open-selected-live").addEventListener("click", () => openSelectedPosts("live"));
  document.querySelector("#clear-console").addEventListener("click", () => {
    elements.console.textContent = "";
  });
}

function getFilteredNotes() {
  const search = elements.search.value.trim().toLowerCase();
  const folder = elements.folderFilter.value;
  const status = elements.statusFilter.value;
  const recentDays = Number(elements.recentFilter.value || 0);
  const now = Date.now();

  return state.notes.filter((note) => {
    const livePublished = state.liveState[note.relativePath]?.publish === true;
    if (folder && note.topLevel !== folder) return false;
    if (status === "published" && !livePublished) return false;
    if (status === "draft" && livePublished) return false;
    if (recentDays > 0) {
      const diff = now - new Date(note.updatedAt).getTime();
      if (diff > recentDays * 24 * 60 * 60 * 1000) return false;
    }

    if (!search) return true;
    const haystack = `${note.title} ${note.relativePath} ${note.tags.join(" ")}`.toLowerCase();
    return haystack.includes(search);
  });
}

function render() {
  pruneSelection();

  const filtered = getFilteredNotes();
  elements.filteredCount.textContent = `当前筛选 ${filtered.length} 篇`;
  elements.selectionCount.textContent = `已选 ${state.selected.size} 篇`;
  elements.dirtyFlag.textContent = state.saveInFlight ? "自动保存中" : (state.dirty ? "有未保存修改" : "未修改");
  syncVisibleSelectionToggle(filtered);

  const publishedCount = Object.values(state.draftState).filter((entry) => entry.publish === true).length;
  const livePublishedCount = Object.values(state.liveState).filter((entry) => entry?.publish === true).length;
  const pendingCount = state.notes.filter((note) => {
    const draftPublish = state.draftState[note.relativePath]?.publish === true;
    const livePublish = state.liveState[note.relativePath]?.publish === true;
    return draftPublish !== livePublish;
  }).length;

  elements.publishedCount.textContent = String(livePublishedCount);
  if (elements.livePublishedCount) {
    elements.livePublishedCount.textContent = `线上生效 ${livePublishedCount} 篇`;
  }
  if (elements.draftPublishedCount) {
    elements.draftPublishedCount.textContent = `草稿计划 ${publishedCount} 篇`;
  }
  if (elements.pendingCount) {
    elements.pendingCount.textContent = `待部署 ${pendingCount} 篇`;
  }

  elements.notesBody.innerHTML = filtered
    .map((note) => {
      const published = state.draftState[note.relativePath]?.publish === true;
      const livePublished = state.liveState[note.relativePath]?.publish === true;
      const pendingDeploy = published !== livePublished;
      const selected = state.selected.has(note.relativePath);
      const sourceFileName = getSourceFileName(note.relativePath);
      const baseName = stripExtension(sourceFileName);
      const titleAlias = note.title && note.title !== baseName ? note.title : "";

      return `
        <tr class="note-row ${selected ? "is-selected" : ""}" data-row-select="${escapeHtml(note.relativePath)}">
          <td>
            <input data-select="${escapeHtml(note.relativePath)}" type="checkbox" ${selected ? "checked" : ""} />
          </td>
          <td>
            <button data-toggle="${escapeHtml(note.relativePath)}" class="status ${published ? "published" : "draft"}">
              ${published ? "草稿上线" : "草稿下线"}
            </button>
            <div>${pendingDeploy ? "待部署" : "与线上一致"}</div>
          </td>
          <td>
            <div class="title-cell">
              <strong>${escapeHtml(sourceFileName)}</strong>
              <span>${escapeHtml(note.relativePath)}</span>
              <span>线上：${livePublished ? "已上线" : "已下线"}</span>
              ${titleAlias ? `<em>标题：${escapeHtml(titleAlias)}</em>` : ""}
            </div>
          </td>
          <td>${escapeHtml(note.directory)}</td>
          <td>${note.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</td>
          <td>${formatDate(note.updatedAt)}</td>
        </tr>
      `;
    })
    .join("");

  for (const checkbox of elements.notesBody.querySelectorAll("[data-select]")) {
    checkbox.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) return;
      toggleSelection(input.dataset.select, input.checked);
      render();
    });
  }

  for (const row of elements.notesBody.querySelectorAll("[data-row-select]")) {
    row.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button, input, a")) return;
      const relativePath = row.getAttribute("data-row-select");
      if (!relativePath) return;
      toggleSelection(relativePath);
      render();
    });
  }

  for (const button of elements.notesBody.querySelectorAll("[data-toggle]")) {
    button.addEventListener("click", async () => {
      const relativePath = button.getAttribute("data-toggle");
      if (!relativePath) return;
      const current = state.draftState[relativePath]?.publish === true;
      state.draftState[relativePath] = { publish: !current };
      markDraftDirty();
      render();
      log(`已将 ${relativePath} 设为${!current ? "上线" : "下线"}（已加入自动保存，未部署前不会影响线上）。`);
      await loadPreview();
    });
  }
}

function pruneSelection() {
  const available = new Set(state.notes.map((note) => note.relativePath));
  for (const relativePath of [...state.selected]) {
    if (!available.has(relativePath)) {
      state.selected.delete(relativePath);
    }
  }
}

function syncVisibleSelectionToggle(filtered) {
  if (!(elements.selectVisibleToggle instanceof HTMLInputElement)) return;

  const filteredCount = filtered.length;
  const selectedCount = filtered.filter((note) => state.selected.has(note.relativePath)).length;
  elements.selectVisibleToggle.checked = filteredCount > 0 && selectedCount === filteredCount;
  elements.selectVisibleToggle.indeterminate = selectedCount > 0 && selectedCount < filteredCount;
  elements.selectVisibleToggle.disabled = filteredCount === 0;
}

function toggleSelection(relativePath, forceValue) {
  if (!relativePath) return;

  if (typeof forceValue === "boolean") {
    if (forceValue) state.selected.add(relativePath);
    else state.selected.delete(relativePath);
    return;
  }

  if (state.selected.has(relativePath)) state.selected.delete(relativePath);
  else state.selected.add(relativePath);
}

async function applyPublishToSelection(publish) {
  if (state.selected.size === 0) {
    log("当前没有选中文章。");
    return;
  }

  let changed = 0;
  for (const relativePath of state.selected) {
    const current = state.draftState[relativePath]?.publish === true;
    if (current !== publish) {
      state.draftState[relativePath] = { publish };
      changed += 1;
    }
  }

  markDraftDirty();
  render();
  log(`已将 ${state.selected.size} 篇选中文章设为${publish ? "上线" : "下线"}草稿，其中 ${changed} 篇状态发生变化。`);
  log(`涉及文件：${[...state.selected].join("，")}`);
  await loadPreview();
}

function markDraftDirty() {
  state.dirty = true;
  scheduleAutoSave();
}

function scheduleAutoSave() {
  if (state.autoSaveTimer) {
    window.clearTimeout(state.autoSaveTimer);
  }

  state.autoSaveTimer = window.setTimeout(() => {
    state.autoSaveTimer = null;
    void saveState({ silent: true });
  }, 500);
}

async function flushAutoSave() {
  if (state.autoSaveTimer) {
    window.clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }

  if (state.dirty || state.saveQueued) {
    await saveState({ silent: true, force: true });
  }
}

async function saveState(options = {}) {
  const { silent = false, force = false } = options;

  if (state.saveInFlight) {
    state.saveQueued = true;
    return false;
  }

  if (!state.dirty && !force) {
    return true;
  }

  state.saveInFlight = true;
  if (state.autoSaveTimer) {
    window.clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }
  render();

  const payload = await apiFetch("/api/state", {
    method: "POST",
    body: JSON.stringify({ notes: state.draftState }),
  });

  if (payload.ok) {
    state.dirty = false;
    if (!silent) {
      log("草稿状态已保存。提示：线上内容不会立即变化，需执行部署并通过线上校验。");
    }
    render();
    await loadSyncStatus();
  } else {
    log(`保存失败: ${payload.error ?? "unknown error"}`);
  }

  state.saveInFlight = false;
  render();

  if (state.saveQueued) {
    state.saveQueued = false;
    if (state.dirty) {
      return saveState({ silent: true, force: true });
    }
  }

  return payload.ok === true;
}

async function loadPreview() {
  elements.previewStatus.textContent = "正在计算...";
  const payload = await apiFetch("/api/preview", {
    method: "POST",
    body: JSON.stringify({ notes: state.draftState }),
  });

  if (!payload.ok) {
    elements.previewStatus.textContent = "预览失败";
    log(`预览失败: ${payload.error ?? "unknown error"}`);
    return;
  }

  const { preview } = payload;
  elements.previewStatus.textContent = "已更新";
  elements.previewPublished.textContent = String(preview.publishedCount);
  elements.previewAssets.textContent = String(preview.assetCount);
  elements.previewMissing.textContent = String(preview.missingAssetCount);
  elements.missingAssets.innerHTML = preview.missingAssets.length
    ? preview.missingAssets.slice(0, 12).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>没有缺失图片</li>";
  elements.publishedSample.innerHTML = preview.publishedPaths.length
    ? preview.publishedPaths.slice(0, 12).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>当前没有计划发布的文章</li>";
}

async function loadSyncStatus() {
  elements.syncStatusLabel.textContent = "正在检测...";
  const payload = await apiFetch("/api/sync-status");

  if (!payload.ok) {
    elements.syncStatusLabel.textContent = "检测失败";
    return;
  }

  elements.syncPublishedCount.textContent = String(payload.publishedCount ?? 0);
  elements.syncChangedCount.textContent = String(payload.changedCount ?? 0);
  elements.syncLastTime.textContent = payload.lastSyncedAt ? formatDate(payload.lastSyncedAt) : "-";
  elements.syncStatusLabel.textContent = payload.pendingCount > 0
    ? `有 ${payload.pendingCount} 篇草稿待部署`
    : payload.changedCount > 0
    ? `检测到 ${payload.changedCount} 篇线上变更`
    : "草稿与线上一致，且没有检测到线上内容变更";
}

async function runAction(endpoint, label) {
  await flushAutoSave();
  if (state.dirty || state.saveInFlight) {
    log(`自动保存尚未完成，暂不能执行${label}。请稍后重试。`);
    return;
  }

  if (label === "部署") {
    setLiveStatus("waiting", "等待线上生效", "正在等待 GitHub Pages 与 CDN 刷新。");
  }

  log(`开始${label}...`);
  const payload = await apiFetch(endpoint, { method: "POST" });
  if (payload.ok) {
    log(`${label}完成。`);
    if (payload.stdout) log(payload.stdout.trim());
    if (payload.stderr) log(payload.stderr.trim());
    applyLiveStatusFromPayload(payload, `${label}已推送，但尚未确认线上是否已刷新。`);
    await loadSyncStatus();
  } else {
    if (label === "部署") {
      setLiveStatus("timeout", "部署失败", payload.error ?? payload.stderr ?? "部署失败。");
    }
    log(`${label}失败: ${payload.error ?? payload.stderr ?? "unknown error"}`);
  }
}

async function updatePublishedChanges() {
  await flushAutoSave();
  if (state.dirty || state.saveInFlight) {
    log("自动保存尚未完成，暂不能执行更新已上线变更。请稍后重试。");
    return;
  }

  setLiveStatus("waiting", "等待线上生效", "正在等待 GitHub Pages 与 CDN 刷新。");
  log("开始检测已上线文章是否有本地修改...");
  const payload = await apiFetch("/api/actions/update-published", { method: "POST" });

  if (!payload.ok) {
    setLiveStatus("timeout", "更新失败", payload.error ?? payload.stderr ?? "更新已上线变更失败。");
    log(`更新已上线变更失败: ${payload.error ?? payload.stderr ?? "unknown error"}`);
    await loadSyncStatus();
    return;
  }

  if (!payload.changed) {
    setLiveStatus("idle", "无需更新", "没有检测到已上线文章的本地变更。");
    log("没有检测到已上线文章的本地变更。");
    await loadSyncStatus();
    return;
  }

  log(`已更新 ${payload.changedCount ?? payload.changedPaths?.length ?? 0} 篇已上线文章。`);
  if (Array.isArray(payload.changedPaths) && payload.changedPaths.length > 0) {
    log(`涉及文件：${payload.changedPaths.join("，")}`);
  }
  if (payload.stdout) log(payload.stdout.trim());
  if (payload.stderr) log(payload.stderr.trim());
  applyLiveStatusFromPayload(payload, "已更新并推送，但尚未确认线上是否已刷新。");
  await loadNotes();
  render();
  await loadPreview();
  await loadSyncStatus();
}

async function publishAndDeploySelection() {
  if (state.selected.size === 0) {
    log("当前没有选中文章。");
    return;
  }

  for (const relativePath of state.selected) {
    state.draftState[relativePath] = { publish: true };
  }

  markDraftDirty();
  await flushAutoSave();
  if (state.dirty || state.saveInFlight) {
    log("自动保存尚未完成，暂不能执行一键发布。请稍后重试。");
    return;
  }
  render();
  setLiveStatus("waiting", "等待线上生效", "正在等待 GitHub Pages 与 CDN 刷新。");
  log("开始一键发布选中文章并部署...");

  const payload = await apiFetch("/api/actions/publish-and-deploy", {
    method: "POST",
    body: JSON.stringify({ notes: state.draftState, selectedPaths: [...state.selected] }),
  });

  if (payload.ok) {
    log("一键发布并部署完成。");
    if (payload.stdout) log(payload.stdout.trim());
    if (payload.stderr) log(payload.stderr.trim());
    if (payload.liveValidationSummary) log(`线上内容校验：${payload.liveValidationSummary}`);
    applyLiveStatusFromPayload(payload, "已发布并推送，但尚未确认线上是否已刷新。");
    elements.publishedLinks.innerHTML = payload.newlyPublishedUrls?.length
      ? payload.newlyPublishedUrls.map((url) => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></li>`).join("")
      : "<li>本次没有新增上线的文章链接。</li>";
    await loadNotes();
    render();
    await loadPreview();
    await loadSyncStatus();
  } else {
    setLiveStatus("timeout", "发布失败", payload.error ?? payload.stderr ?? "一键发布失败。");
    log(`一键发布失败: ${payload.error ?? payload.stderr ?? "unknown error"}`);
    await loadSyncStatus();
  }
}

function openSelectedPosts(mode) {
  if (state.selected.size === 0) {
    log("当前没有选中文章。");
    return;
  }

  const selectedNotes = state.notes.filter((note) => state.selected.has(note.relativePath));
  selectedNotes.forEach((note) => {
    const articlePath = note.relativePath.replace(/\.[^.]+$/, "").replace(/\\/g, "/");
    const url = mode === "local"
      ? `http://127.0.0.1:4321/posts/${articlePath}/`
      : `https://ma0xfly.github.io/posts/${articlePath}/`;
    openUrl(url);
  });
}

function getSourceFileName(relativePath) {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}

function openUrl(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function log(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  elements.console.textContent += `${elements.console.textContent ? "\n" : ""}[${time}] ${message}`;
  elements.console.scrollTop = elements.console.scrollHeight;
}

function applyLiveStatusFromPayload(payload, fallbackMessage) {
  if (payload.liveUrl && elements.liveStatusLink instanceof HTMLAnchorElement) {
    elements.liveStatusLink.href = payload.liveUrl;
  }

  if (payload.liveVerified === true) {
    stopLiveStatusPolling();
    if (payload.liveContentVerified === false) {
      setLiveStatus("timeout", "内容未通过校验", payload.liveValidationSummary || "部署标记已更新，但内容校验失败。");
      return;
    }
    setLiveStatus("live", "已生效", payload.liveValidationSummary || "线上站点已确认刷新到本次部署版本。内容校验通过。");
    return;
  }

  if (payload.liveVerified === false) {
    setLiveStatus("timeout", "未确认生效", fallbackMessage || "已推送，但在等待时间内未确认线上生效。");
    if (payload.liveToken) {
      startLiveStatusPolling(payload.liveToken);
    }
    return;
  }

  stopLiveStatusPolling();
  setLiveStatus("idle", "未检测", fallbackMessage || "这次操作没有触发线上生效检测。");
}

function setLiveStatus(kind, badgeText, detailText) {
  if (!(elements.liveStatusBadge instanceof HTMLElement) || !(elements.liveStatusText instanceof HTMLElement)) {
    return;
  }

  elements.liveStatusBadge.className = `live-badge is-${kind}`;
  elements.liveStatusBadge.textContent = badgeText;
  elements.liveStatusText.textContent = detailText;
}

function startLiveStatusPolling(expectedToken) {
  stopLiveStatusPolling();

  let attempts = 0;
  const maxAttempts = 45;

  state.livePollTimer = window.setInterval(async () => {
    attempts += 1;
    const payload = await apiFetch(`/api/live-check?token=${encodeURIComponent(expectedToken)}`);

    if (payload.liveUrl && elements.liveStatusLink instanceof HTMLAnchorElement) {
      elements.liveStatusLink.href = payload.liveUrl;
    }

    if (payload.liveVerified) {
      stopLiveStatusPolling();
      setLiveStatus(
        "live",
        "已生效",
        payload.deployedAt
          ? `线上站点已确认刷新，部署时间：${formatDate(payload.deployedAt)}`
          : "线上站点已确认刷新到本次部署版本。",
      );
      log("线上站点已确认刷新到本次部署版本。");
      return;
    }

    if (attempts >= maxAttempts) {
      stopLiveStatusPolling();
      setLiveStatus("timeout", "未确认生效", "超过等待时间，仍未确认线上站点刷新到本次部署版本。");
    }
  }, 4000);
}

function stopLiveStatusPolling() {
  if (state.livePollTimer) {
    window.clearInterval(state.livePollTimer);
    state.livePollTimer = null;
  }
}

function formatDate(value) {
  return new Date(value).toLocaleString("zh-CN");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
