// ==UserScript==
// @name         BLP-Black list Panel
// @namespace    blacklist-panel-local
// @version      4.1.2
// @description  登录后自动查询黑名单，支持 BOSS 直聘与前程无忧
// @author       Stephen-Xu-X
// @license      GPLv3
// @match        https://*.zhipin.com/*
// @match        https://*.51job.com/*
// @connect      blacklist-api.20000215.xyz
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://unpkg.com/jquery
// ==/UserScript==

(function () {
  'use strict';

  var CONFIG = {
    apiUrl: 'https://blacklist-api.20000215.xyz/',
    storageKey: 'kxb_cf_session_state_v5',
    noticeStorageKey: 'kxb_cf_notice_state_v1',
    panelCollapseStorageKey: 'kxb_cf_panel_collapsed_v1',
    contactWechat: '_SF0o0_',
    siteUrl: 'https://blp.20000215.xyz/',
    pricingUrl: 'https://blp.20000215.xyz/pricing',
    title: 'Black list panel',
    helpText: '登录 · 绑卡 · 自动查询',
    versionNotes: [
      'v4.1.0：重写查询触发链路，修复登录后不扫描、绑卡后不扫描、重新打开页面不扫描。',
      'v4.1.0：重写面板事件与状态管理，修复输入框无法稳定输入、退出响应慢。'
    ]
  };

  var isBOSS = location.host.indexOf('zhipin.com') !== -1;
  var is51job = location.host.indexOf('51job.com') !== -1;

  var cache = {};
  var inflight = {};
  var processedJobs = {};
  var bossObserver = null;
  var jobObserver = null;
  var bossHistoryHooked = false;
  var bossScanTimer = null;
  var jobScanTimer = null;
  var kickTimers = [];

  var panel = null;
  var dock = null;
  var currentView = 'login';
  var panelCollapsed = GM_getValue(CONFIG.panelCollapseStorageKey, false) === true;
  var autoQueryStarted = false;
  var debugLogs = [];
  var queryQueue = [];
  var queryQueueRunning = false;
  var visibleBossCompanies = {};
  var last51jobListSignature = '';
  var panelBusy = false;
  var lastViewRenderKey = '';
  var noticeState = {
    latestId: 0,
    lastReadId: Number(GM_getValue(CONFIG.noticeStorageKey, 0) || 0),
    items: []
  };
  var panelStylesInjected = false;

  function defaultState() {
    return {
      status: 'guest',
      userId: '',
      username: '',
      password: '',
      sessionToken: '',
      sessionExpireAt: '',
      expireTime: '',
      token: '',
      tokenBound: false,
      tokenStatus: 'unbound',
      contributionCount: 0,
      resetEmail: ''
    };
  }

  function loadState() {
    var state = GM_getValue(CONFIG.storageKey, null);
    return Object.assign(defaultState(), state || {});
  }

  function saveState(nextState, options) {
    var currentState = loadState();
    GM_setValue(CONFIG.storageKey, Object.assign(defaultState(), currentState || {}, nextState || {}));
    if (!options || !options.skipRender) {
      renderPanelState();
    }
  }

  function clearState() {
    var currentState = loadState();
    GM_setValue(CONFIG.storageKey, Object.assign(defaultState(), {
      username: currentState.username || '',
      password: currentState.password || '',
      token: currentState.token || '',
      resetEmail: currentState.resetEmail || ''
    }));
    renderPanelState();
  }

  function saveDraftFields(partial) {
    if (!partial || typeof partial !== 'object') {
      return;
    }
    GM_setValue(CONFIG.storageKey, Object.assign(defaultState(), loadState(), partial));
  }

  function hasUnreadNotice() {
    return Number(noticeState.latestId || 0) > Number(noticeState.lastReadId || 0);
  }

  function saveNoticeReadState(noticeId) {
    noticeState.lastReadId = Number(noticeId || 0);
    GM_setValue(CONFIG.noticeStorageKey, noticeState.lastReadId);
    renderPanelState();
  }

  function savePanelCollapsedState(nextCollapsed) {
    panelCollapsed = !!nextCollapsed;
    GM_setValue(CONFIG.panelCollapseStorageKey, panelCollapsed);
  }

  function isLoggedIn() {
    var state = loadState();
    return state.status === 'active' && !!state.sessionToken;
  }

  function hasActiveSession() {
    var state = loadState();
    return state.status === 'active' && !!state.sessionToken;
  }

  function canQuery() {
    var state = loadState();
    return state.status === 'active' && !!state.sessionToken && !!state.tokenBound && state.tokenStatus === 'active';
  }

  function canAutoScan() {
    return canQuery();
  }

  function createStaleQueryError(message) {
    var error = new Error(message || 'Stale query skipped');
    error.code = 'KXB_STALE_QUERY';
    return error;
  }

  function isStaleQueryError(error) {
    return !!(error && error.code === 'KXB_STALE_QUERY');
  }

  function updateVisibleBossCompanies(names) {
    visibleBossCompanies = {};
    names.forEach(function (name) {
      var normalized = cleanText(name);
      if (normalized) {
        visibleBossCompanies[normalized] = true;
      }
    });
  }

  function isVisibleBossCompany(name) {
    return !!visibleBossCompanies[cleanText(name)];
  }

  function pruneQueryQueue(predicate) {
    var nextQueue = [];
    queryQueue.forEach(function (job) {
      if (predicate(job)) {
        job.reject(createStaleQueryError('Skipped stale query'));
        return;
      }
      nextQueue.push(job);
    });
    queryQueue = nextQueue;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeUsername(value) {
    return cleanText(value).toLowerCase();
  }

  function ensurePanelStyles() {
    if (panelStylesInjected) {
      return;
    }
    panelStylesInjected = true;

    var style = document.createElement('style');
    style.textContent = `
      .kxb-panel,
      .kxb-dock,
      .kxb-toast {
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .kxb-panel {
        position: fixed;
        right: 24px;
        bottom: 24px;
        width: 420px;
        height: 640px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid #cfcdc4;
        border-radius: 16px;
        background: #f7f7f4;
        box-shadow: 0 24px 56px rgba(38, 37, 30, .16);
        color: #26251e;
        z-index: 99999;
      }
      .kxb-panel__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 12px;
        border-bottom: 1px solid #e6e5e0;
        background: #f7f7f4;
        cursor: move;
        user-select: none;
      }
      .kxb-header-copy {
        flex: 1 1 auto;
        min-width: 0;
      }
      .kxb-header-kicker {
        font-size: 11px;
        line-height: 1.4;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #807d72;
      }
      .kxb-header-title {
        margin-top: 4px;
        font-size: 22px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #26251e;
      }
      .kxb-header-subtitle {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.5;
        color: #5a5852;
      }
      .kxb-header-actions {
        display: grid;
        grid-template-columns: repeat(5, 32px);
        gap: 6px;
        flex: 0 0 auto;
      }
      .kxb-icon-button {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #cfcdc4;
        border-radius: 8px;
        background: #ffffff;
        color: #26251e;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        transition: background .15s ease, border-color .15s ease, opacity .15s ease;
      }
      .kxb-icon-button svg {
        width: 17px;
        height: 17px;
        display: block;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .kxb-icon-button:hover {
        background: #fafaf7;
      }
      .kxb-icon-button--hot {
        position: relative;
      }
      .kxb-icon-button--hot::after {
        content: "";
        position: absolute;
        top: 5px;
        right: 5px;
        width: 7px;
        height: 7px;
        border-radius: 9999px;
        background: #cf2d56;
      }
      .kxb-panel__body {
        flex: 1;
        min-height: 0;
        padding: 12px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: hidden;
      }
      .kxb-status-card {
        flex: 0 0 auto;
        padding: 12px;
        border: 1px solid #e6e5e0;
        border-radius: 12px;
        background: #ffffff;
      }
      .kxb-status-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .kxb-status-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 28px;
        padding: 0 12px;
        border-radius: 9999px;
        background: #e6e5e0;
        color: #26251e;
        font-size: 12px;
        font-weight: 600;
      }
      .kxb-status-chip__dot {
        width: 8px;
        height: 8px;
        border-radius: 9999px;
        background: currentColor;
        flex: 0 0 auto;
      }
      .kxb-status-side {
        font-size: 11px;
        line-height: 1.4;
        color: #807d72;
        text-transform: uppercase;
        letter-spacing: .08em;
      }
      .kxb-status-line {
        margin-top: 8px;
        font-size: 13px;
        line-height: 1.45;
        color: #26251e;
      }
      .kxb-view-root {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        overflow-x: hidden;
      }
      .kxb-screen {
        display: grid;
        gap: 8px;
        height: 100%;
        min-height: 0;
        align-content: start;
        animation: kxb-view-in .22s ease-out both;
      }
      .kxb-screen > * {
        animation: kxb-item-in .2s ease-out both;
      }
      .kxb-screen > *:nth-child(2) { animation-delay: .025s; }
      .kxb-screen > *:nth-child(3) { animation-delay: .05s; }
      .kxb-screen > *:nth-child(4) { animation-delay: .075s; }
      .kxb-screen > *:nth-child(5) { animation-delay: .1s; }
      @keyframes kxb-view-in {
        from { opacity: .6; transform: translateY(5px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes kxb-item-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .kxb-screen-head {
        display: grid;
        gap: 5px;
      }
      .kxb-screen-kicker {
        font-size: 11px;
        line-height: 1.4;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #807d72;
      }
      .kxb-screen-title-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .kxb-screen-title {
        font-size: 19px;
        line-height: 1.25;
        font-weight: 400;
        letter-spacing: 0;
        color: #26251e;
      }
      .kxb-screen-note {
        margin-top: 2px;
        font-size: 12px;
        line-height: 1.45;
        color: #5a5852;
      }
      .kxb-segmented {
        display: inline-grid;
        grid-auto-flow: column;
        gap: 6px;
        padding: 4px;
        border: 1px solid #e6e5e0;
        border-radius: 10px;
        background: #ffffff;
      }
      .kxb-segmented__item {
        min-width: 64px;
        height: 30px;
        padding: 0 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #5a5852;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background .2s ease, color .2s ease, transform .2s ease;
      }
      .kxb-segmented__item[data-active="true"] {
        background: #26251e;
        color: #f7f7f4;
        transform: translateY(-1px);
      }
      .kxb-card {
        border: 1px solid #e6e5e0;
        border-radius: 12px;
        background: #ffffff;
      }
      .kxb-form-card,
      .kxb-summary-card,
      .kxb-action-card,
      .kxb-side-card {
        padding: 12px;
      }
      .kxb-form-grid,
      .kxb-stack {
        display: grid;
        gap: 8px;
      }
      .kxb-form-grid--compact {
        gap: 7px;
      }
      .kxb-form-grid--compact .kxb-input {
        height: 34px;
      }
      .kxb-form-grid--compact .kxb-btn {
        min-height: 34px;
        padding: 8px 12px;
      }
      .kxb-form-pair {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .kxb-field {
        display: grid;
        gap: 4px;
      }
      .kxb-field__label {
        font-size: 11px;
        line-height: 1.4;
        font-weight: 600;
        color: #5a5852;
      }
      .kxb-input {
        width: 100%;
        height: 38px;
        padding: 0 12px;
        border: 1px solid #cfcdc4;
        border-radius: 8px;
        background: #ffffff;
        color: #26251e;
        font-size: 14px;
        box-sizing: border-box;
        outline: none;
        transition: border-color .15s ease, box-shadow .15s ease;
      }
      .kxb-input:focus {
        border-color: #f54e00;
        box-shadow: 0 0 0 3px rgba(245, 78, 0, .12);
      }
      .kxb-button-row {
        display: grid;
        gap: 8px;
      }
      .kxb-button-row--two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .kxb-btn {
        width: 100%;
        min-height: 38px;
        padding: 9px 12px;
        border-radius: 8px;
        border: 1px solid transparent;
        font-size: 14px;
        line-height: 1.1;
        font-weight: 600;
        cursor: pointer;
        transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
      }
      .kxb-btn:disabled,
      .kxb-icon-button:disabled {
        opacity: .68;
        cursor: wait;
        filter: grayscale(.08);
      }
      .kxb-btn--primary {
        background: #f54e00;
        border-color: #f54e00;
        color: #ffffff;
      }
      .kxb-btn--secondary {
        background: #ffffff;
        border-color: #cfcdc4;
        color: #26251e;
      }
      .kxb-btn--ghost {
        background: #f7f7f4;
        border-color: #e6e5e0;
        color: #26251e;
      }
      .kxb-btn__alert-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-left: 8px;
        border-radius: 9999px;
        background: #cf2d56;
        vertical-align: middle;
      }
      .kxb-text-link-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .kxb-text-link {
        border: 0;
        background: transparent;
        color: #26251e;
        font-size: 13px;
        line-height: 1.5;
        font-weight: 600;
        cursor: pointer;
        padding: 0;
      }
      .kxb-summary-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .kxb-stat {
        padding: 9px;
        border: 1px solid #efeee8;
        border-radius: 10px;
        background: #fafaf7;
      }
      .kxb-stat--wide {
        grid-column: 1 / -1;
      }
      .kxb-stat__label {
        font-size: 11px;
        line-height: 1.4;
        font-weight: 600;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: #807d72;
      }
      .kxb-stat__value {
        margin-top: 4px;
        font-size: 13px;
        line-height: 1.35;
        font-weight: 600;
        color: #26251e;
        word-break: break-word;
      }
      .kxb-pill-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      .kxb-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 24px;
        padding: 3px 9px;
        border-radius: 9999px;
        border: 1px solid transparent;
        font-size: 11px;
        line-height: 1.3;
        font-weight: 600;
        color: #26251e;
        white-space: nowrap;
      }
      .kxb-pill__dot {
        width: 7px;
        height: 7px;
        border-radius: 9999px;
        background: currentColor;
      }
      .kxb-pill--success {
        background: rgba(31, 138, 101, .12);
        color: #1f8a65;
      }
      .kxb-pill--warn {
        background: #fff7f2;
        color: #c08532;
        border-color: #efeee8;
      }
      .kxb-pill--muted {
        background: #e6e5e0;
        color: #5a5852;
      }
      .kxb-pill--read {
        background: #9fbbe0;
      }
      .kxb-pill--edit {
        background: #c0a8dd;
      }
      .kxb-pill--done {
        background: #c08532;
        color: #ffffff;
      }
      .kxb-mark {
        display: grid;
        grid-template-columns: 7px 1fr;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        padding: 7px 9px;
        border-radius: 10px;
        border: 1px solid #efeee8;
        background: #fafaf7;
        font-size: 12px;
        line-height: 1.35;
        color: #5a5852;
      }
      .kxb-mark::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 9999px;
        background: #f54e00;
      }
      .kxb-action-strip {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
      }
      .kxb-mini-timeline {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }
      .kxb-mini-timeline .kxb-pill {
        justify-content: center;
      }
      .kxb-utility-list {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .kxb-utility-button {
        display: grid;
        align-items: center;
        gap: 4px;
        width: 100%;
        min-height: 48px;
        padding: 9px;
        border: 1px solid #e6e5e0;
        border-radius: 10px;
        background: #fafaf7;
        color: #26251e;
        font-size: 12px;
        line-height: 1.4;
        font-weight: 500;
        cursor: pointer;
        text-align: center;
      }
      .kxb-utility-meta {
        font-size: 11px;
        line-height: 1.4;
        color: #807d72;
      }
      .kxb-banner {
        padding: 9px 11px;
        border-radius: 10px;
        border: 1px solid #e6e5e0;
        background: #fafaf7;
        color: #5a5852;
        font-size: 12px;
        line-height: 1.45;
      }
      .kxb-banner--warn {
        background: #fff7f2;
      }
      .kxb-banner--success {
        background: #f4fbf8;
        color: #1f8a65;
      }
      .kxb-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(38, 37, 30, .18);
        backdrop-filter: blur(4px);
        z-index: 4;
      }
      .kxb-overlay__card {
        width: 100%;
        max-width: 360px;
        max-height: 520px;
        display: flex;
        flex-direction: column;
        border: 1px solid #cfcdc4;
        border-radius: 14px;
        background: #ffffff;
        overflow: hidden;
      }
      .kxb-overlay__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 12px;
        border-bottom: 1px solid #e6e5e0;
      }
      .kxb-overlay__title {
        font-size: 18px;
        line-height: 1.3;
        font-weight: 400;
        color: #26251e;
      }
      .kxb-overlay__body {
        padding: 14px;
        overflow-y: auto;
        overflow-x: hidden;
        font-size: 13px;
        line-height: 1.7;
        color: #5a5852;
      }
      .kxb-notice-item {
        padding: 12px 0;
        border-bottom: 1px solid #efeee8;
      }
      .kxb-notice-item:last-child {
        border-bottom: 0;
      }
      .kxb-notice-item__title {
        font-size: 14px;
        line-height: 1.5;
        font-weight: 600;
        color: #26251e;
      }
      .kxb-notice-item__meta {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: #807d72;
      }
      .kxb-notice-item__body {
        margin-top: 8px;
        white-space: pre-wrap;
      }
      .kxb-dock {
        display: none;
        align-items: center;
        gap: 10px;
        position: fixed;
        right: 24px;
        bottom: 24px;
        padding: 10px 12px;
        border: 1px solid #cfcdc4;
        border-radius: 12px;
        background: #f7f7f4;
        box-shadow: 0 18px 42px rgba(38, 37, 30, .12);
        z-index: 99999;
      }
      .kxb-dock__label {
        font-size: 13px;
        line-height: 1.4;
        font-weight: 600;
        color: #26251e;
      }
      .kxb-toast {
        position: fixed;
        right: 22px;
        bottom: 22px;
        padding: 12px 14px;
        border: 1px solid #cfcdc4;
        border-radius: 10px;
        background: #26251e;
        color: #f7f7f4;
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 14px 34px rgba(38, 37, 30, .24);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity .18s ease, transform .18s ease;
        z-index: 100001;
        pointer-events: none;
      }
      @media (max-width: 520px) {
        .kxb-panel {
          right: 10px;
          bottom: 10px;
          width: calc(100vw - 20px);
          height: min(640px, calc(100vh - 20px));
        }
        .kxb-panel__body {
          padding: 12px;
        }
        .kxb-screen-title-row {
          display: grid;
        }
        .kxb-header-actions {
          grid-template-columns: repeat(4, 30px);
          gap: 5px;
        }
        .kxb-icon-button {
          width: 30px;
          height: 30px;
        }
        .kxb-button-row--two,
        .kxb-summary-grid,
        .kxb-form-pair {
          grid-template-columns: 1fr;
        }
        .kxb-dock {
          right: 10px;
          bottom: 10px;
          max-width: calc(100vw - 20px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(message, duration) {
    duration = duration || 2200;
    ensurePanelStyles();
    var node = document.createElement('div');
    node.className = 'kxb-toast';
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(function () {
      node.style.opacity = '1';
      node.style.transform = 'translateY(0)';
    }, 16);
    setTimeout(function () {
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(function () {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }, 200);
    }, duration);
  }

  function parseJsonResponse(status, text) {
    try {
      return {
        status: status,
        data: text ? JSON.parse(text) : {}
      };
    } catch (error) {
      throw new Error('API returned invalid JSON');
    }
  }

  function buildResponseError(response, fallbackMessage) {
    var message = fallbackMessage || 'Request failed';
    if (response && response.data && response.data.error) {
      message = String(response.data.error);
    }
    var error = new Error(message);
    error.response = response || null;
    return error;
  }

  function getTokenStatusMessage(tokenStatus) {
    if (tokenStatus === 'expired') {
      return '当前绑定卡密已过期，请更换新卡密';
    }
    if (tokenStatus === 'disabled') {
      return '当前绑定卡密已失效，请更换可用卡密';
    }
    if (tokenStatus === 'active') {
      return '';
    }
    return '当前账号还没有有效卡密';
  }

  function getTokenStatusTip(tokenStatus) {
    if (tokenStatus === 'expired') {
      return '卡密到期后自动扫描会停止，重新绑定有效卡密后才会恢复。';
    }
    if (tokenStatus === 'disabled') {
      return '这张卡密当前已不可用，自动扫描不会继续。';
    }
    if (tokenStatus === 'active') {
      return '';
    }
    return '自动扫描只有在登录且绑定有效卡密后才会启动。';
  }

  function isSessionErrorMessage(message) {
    var text = String(message || '').toLowerCase();
    return text.indexOf('session') !== -1 && (
      text.indexOf('expired') !== -1 ||
      text.indexOf('invalid') !== -1 ||
      text.indexOf('log in again') !== -1
    );
  }

  function getTokenStatusFromQueryError(message) {
    var text = String(message || '').toLowerCase();
    if (text.indexOf('bound token has expired') !== -1) {
      return 'expired';
    }
    if (text.indexOf('bound token is disabled') !== -1) {
      return 'disabled';
    }
    if (text.indexOf('please bind a token before querying') !== -1) {
      return 'unbound';
    }
    return '';
  }

  function stopQueryQueue(message, nextState) {
    autoQueryStarted = false;
    queryQueueRunning = false;
    while (queryQueue.length) {
      var pendingJob = queryQueue.shift();
      pendingJob.reject(createStaleQueryError(message || 'Query queue stopped'));
    }
    if (nextState) {
      saveState(nextState);
    } else {
      renderPanelState();
    }
  }

  function applyQueryAccessErrorState(message) {
    var tokenStatus = getTokenStatusFromQueryError(message);
    if (!tokenStatus) {
      return false;
    }
    var nextState = loadState();
    nextState.tokenBound = false;
    nextState.tokenStatus = tokenStatus;
    stopQueryQueue(message, nextState);
    setPanelMessage(getTokenStatusMessage(tokenStatus) || message, true);
    syncTokenStatusFeedback(nextState);
    return true;
  }

  function requestJson(payload) {
    return new Promise(function (resolve, reject) {
      pushDebugLog('request:start ' + (payload.action || 'query'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.apiUrl,
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(payload),
        onload: function (response) {
          try {
            pushDebugLog('request:done ' + (payload.action || 'query') + ' status=' + response.status);
            resolve(parseJsonResponse(response.status, response.responseText || ''));
          } catch (error) {
            pushDebugLog('request:parse-error ' + (payload.action || 'query') + ' ' + error.message);
            reject(error);
          }
        },
        onerror: function (response) {
          var detail = response && typeof response.status !== 'undefined'
            ? ' status=' + response.status + ' readyState=' + response.readyState
            : '';
          pushDebugLog('request:error ' + (payload.action || 'query') + detail);
          reject(new Error('Request failed'));
        },
        ontimeout: function () {
          pushDebugLog('request:timeout ' + (payload.action || 'query'));
          reject(new Error('Request timeout'));
        }
      });
    });
  }

  function loadNotices() {
    return requestJson({
      action: 'public_notices',
      limit: 10
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Load notices failed');
      }
      noticeState.items = Array.isArray(response.data.items) ? response.data.items : [];
      noticeState.latestId = noticeState.items.length ? Number(noticeState.items[0].id || 0) : 0;
      renderPanelState();
      return noticeState.items;
    }).catch(function () {
      noticeState.items = [];
      noticeState.latestId = 0;
      renderPanelState();
      return [];
    });
  }

  function buildSearchUrl(companyName) {
    var sourceHost = ['kj', 'xb', '.org'].join('');
    return 'https://' + sourceHost + '/?s=' + encodeURIComponent(companyName) + '&post_type=question';
  }

  function normalizeCompareText(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[()（）\[\]【】\-—_·.,，。:：;；"'`“”‘’]/g, '')
      .replace(/\s+/g, '');
  }

  function extractMatchedQuestionFromDoc(doc, companyName) {
    var normalizedCompanyName = normalizeCompareText(companyName);
    var links = doc.querySelectorAll('.ap-questions-hyperlink, .ap-question-title');
    var matchedLink = null;

    Array.prototype.some.call(links, function (link) {
      var titleText = cleanText(link.textContent || link.innerText || '');
      var normalizedTitle = normalizeCompareText(titleText);
      if (!normalizedCompanyName || !normalizedTitle) {
        return false;
      }
      if (normalizedTitle.indexOf(normalizedCompanyName) === -1) {
        return false;
      }
      matchedLink = link;
      return true;
    });

    if (!matchedLink) {
      return {
        href: '',
        container: null
      };
    }

    return {
      href: matchedLink.getAttribute('href') || '',
      container: matchedLink.closest('.question-list-item, .ap-questions-item, article, .question, .item') || matchedLink.parentElement || null
    };
  }

  function extractQuestionTagsFromDoc(scopeNode) {
    var tags = [];
    if (!scopeNode || !scopeNode.querySelectorAll) {
      return tags;
    }
    var nodes = scopeNode.querySelectorAll('.question-tags a, .question-tags > a');
    Array.prototype.forEach.call(nodes, function (node) {
      var text = cleanText(node.textContent || node.innerText || '');
      if (text && tags.indexOf(text) === -1) {
        tags.push(text);
      }
    });
    return tags;
  }

  function requestKjxb(companyName) {
    var searchUrl = buildSearchUrl(companyName);
    pushDebugLog('query:source-start ' + companyName);
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: searchUrl,
        timeout: 8000,
        onload: function (response) {
          try {
            var html = response.responseText || '';
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');
            var matched = extractMatchedQuestionFromDoc(doc, companyName);
            var href = matched.href || '';
            var tags = extractQuestionTagsFromDoc(matched.container || doc);
            var result = {
              found: !!href,
              href: href || '',
              searchUrl: searchUrl,
              tags: tags
            };
            pushDebugLog('query:source-ok ' + companyName + ' found=' + String(!!result.found));
            resolve(result);
          } catch (error) {
            pushDebugLog('query:source-parse-error ' + companyName + ' ' + error.message);
            reject(error);
          }
        },
        onerror: function (response) {
          var detail = response && typeof response.status !== 'undefined'
            ? ' status=' + response.status + ' readyState=' + response.readyState
            : '';
          pushDebugLog('query:source-error ' + companyName + detail);
          reject(new Error('Blacklist source request failed'));
        },
        ontimeout: function () {
          pushDebugLog('query:source-timeout ' + companyName);
          reject(new Error('Blacklist source request timeout'));
        }
      });
    });
  }

  function buildSessionState(data) {
    return {
      status: 'active',
      userId: data.user_id || '',
      username: data.username || '',
      sessionToken: data.session_token || '',
      sessionExpireAt: data.session_expire_at || '',
      expireTime: data.expire_time || '',
      tokenBound: !!data.token_bound,
      tokenStatus: data.token_status || (data.token_bound ? 'active' : 'unbound'),
      contributionCount: Number(data.contribution_count || 0),
      resetEmail: data.reset_email || ''
    };
  }

  function registerAccount(form) {
    return requestJson({
      action: 'register',
      username: normalizeUsername(form.username),
      password: String(form.password || ''),
      reset_email: cleanText(form.resetEmail)
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Register failed');
      }
      var nextState = buildSessionState(response.data);
      saveState(nextState);
      return nextState;
    });
  }

  function loginAccount(form) {
    return requestJson({
      action: 'login',
      username: normalizeUsername(form.username),
      password: String(form.password || '')
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Login failed');
      }
      var nextState = buildSessionState(response.data);
      saveState(nextState);
      return nextState;
    });
  }

  function bindToken(form) {
    var state = loadState();
    return requestJson({
      action: 'bind_token',
      session_token: state.sessionToken,
      token: cleanText(form.token)
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Bind token failed');
      }
      var nextState = buildSessionState(response.data);
      saveState(nextState);
      return nextState;
    });
  }

  function syncSession() {
    var state = loadState();
    if (!state.sessionToken) {
      return Promise.reject(new Error('Not logged in'));
    }
    return requestJson({
      action: 'session',
      session_token: state.sessionToken
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Session invalid');
      }
      var nextState = buildSessionState(response.data);
      saveState(nextState);
      return nextState;
    });
  }

  function forgotPassword(form) {
    return requestJson({
      action: 'forgot_password',
      username: normalizeUsername(form.username),
      reset_email: cleanText(form.resetEmail)
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Submit failed');
      }
      return response.data;
    });
  }

  function resetPassword(form) {
    return requestJson({
      action: 'reset_password',
      username: normalizeUsername(form.username),
      reset_code: cleanText(form.resetCode).toUpperCase(),
      new_password: String(form.newPassword || '')
    }).then(function (response) {
      if (response.status !== 200 || !response.data.ok) {
        throw buildResponseError(response, 'Reset failed');
      }
      return response.data;
    });
  }

  function logoutAccount() {
    var state = loadState();
    if (!state.sessionToken) {
      clearState();
      return Promise.resolve();
    }
    clearState();
    return requestJson({
      action: 'logout',
      session_token: state.sessionToken
    }).catch(function () {
      return null;
    });
  }

  function queryCompany(companyName) {
    var name = cleanText(companyName);
    var state = loadState();
    if (!name) {
      return Promise.reject(new Error('Company name is empty'));
    }
    if (!state.sessionToken || state.status !== 'active') {
      return Promise.reject(new Error('Please log in first'));
    }
    if (!canQuery()) {
      return Promise.reject(new Error(getTokenStatusMessage(state.tokenStatus) || 'Please bind a valid token before querying'));
    }
    if (cache[name]) {
      return Promise.resolve(cache[name]);
    }
    if (inflight[name]) {
      return inflight[name];
    }

    inflight[name] = new Promise(function (resolve, reject) {
      queryQueue.push({
        name: name,
        resolve: resolve,
        reject: reject
      });
      runQueryQueue();
    }).finally(function () {
      delete inflight[name];
    });

    return inflight[name];
  }

  function runQueryQueue() {
    if (queryQueueRunning || !queryQueue.length) {
      return;
    }
    if (!canAutoScan()) {
      stopQueryQueue('Auto scan stopped');
      return;
    }
    queryQueueRunning = true;

    var job = queryQueue.shift();
    if (isBOSS && !isVisibleBossCompany(job.name)) {
      queryQueueRunning = false;
      job.reject(createStaleQueryError('Skipped stale boss query'));
      if (queryQueue.length) {
        setTimeout(runQueryQueue, 0);
      }
      return;
    }
    var state = loadState();
    pushDebugLog('query:submit ' + job.name);
    requestJson({
      action: 'query',
      session_token: state.sessionToken,
      company_name: job.name
    }).then(function (response) {
      if (response.status !== 200) {
        if (response.status === 403 && isSessionErrorMessage(response.data && response.data.error)) {
          stopQueryQueue((response.data && response.data.error) || 'Session invalid');
          clearState();
        }
        if (response.status === 403 && applyQueryAccessErrorState(response.data && response.data.error)) {
          throw buildResponseError(response, 'Query blocked');
        }
        pushDebugLog('query:error ' + job.name + ' status=' + response.status + ' msg=' + ((response.data && response.data.error) || 'Query failed'));
        throw buildResponseError(response, 'Query failed');
      }
      var result = {
        found: !!response.data.found,
        href: response.data.href || '',
        searchUrl: response.data.searchUrl || '',
        tags: Array.isArray(response.data.tags) ? response.data.tags : [],
        expireTime: response.data.expire_time || '',
        tokenBound: typeof response.data.token_bound === 'boolean' ? response.data.token_bound : !!state.tokenBound,
        tokenStatus: response.data.token_status || state.tokenStatus || 'unbound',
        contributionCount: Number(response.data.contribution_count || 0)
      };
      if (isBOSS && !isVisibleBossCompany(job.name)) {
        throw createStaleQueryError('Skipped stale boss result');
      }
      if (!response.data.cache_hit && response.data.needs_fetch) {
        return requestKjxb(job.name).then(function (liveResult) {
          return requestJson({
            action: 'report_query_result',
            session_token: state.sessionToken,
            company_name: job.name,
            found: !!liveResult.found,
            href: liveResult.href || '',
            searchUrl: liveResult.searchUrl || '',
            tags: Array.isArray(liveResult.tags) ? liveResult.tags : []
          }).then(function (reportResponse) {
            if (reportResponse.status === 200 && reportResponse.data && reportResponse.data.ok) {
              liveResult.expireTime = reportResponse.data.expire_time || response.data.expire_time || '';
              liveResult.tokenBound = typeof reportResponse.data.token_bound === 'boolean'
                ? reportResponse.data.token_bound
                : (typeof response.data.token_bound === 'boolean' ? response.data.token_bound : !!state.tokenBound);
              liveResult.tokenStatus = reportResponse.data.token_status || response.data.token_status || state.tokenStatus || 'unbound';
              liveResult.contributionCount = Number(reportResponse.data.contribution_count || 0);
              pushDebugLog('query:report-ok ' + job.name + ' found=' + String(!!liveResult.found));
              return liveResult;
            }

            pushDebugLog('query:report-warn ' + job.name + ' status=' + reportResponse.status);
            liveResult.expireTime = response.data.expire_time || '';
            liveResult.tokenBound = typeof response.data.token_bound === 'boolean' ? response.data.token_bound : !!state.tokenBound;
            liveResult.tokenStatus = response.data.token_status || state.tokenStatus || 'unbound';
            liveResult.contributionCount = Number(response.data.contribution_count || 0);
            return liveResult;
          }).catch(function (error) {
            pushDebugLog('query:report-warn ' + job.name + ' ' + error.message);
            liveResult.expireTime = response.data.expire_time || '';
            liveResult.tokenBound = typeof response.data.token_bound === 'boolean' ? response.data.token_bound : !!state.tokenBound;
            liveResult.tokenStatus = response.data.token_status || state.tokenStatus || 'unbound';
            liveResult.contributionCount = Number(response.data.contribution_count || 0);
            return liveResult;
          });
        });
      }
      cache[job.name] = result;
      return result;
    }).then(function (result) {
      cache[job.name] = result;
      var nextState = loadState();
      if (nextState.status === 'active') {
        nextState.expireTime = result.expireTime || nextState.expireTime;
        nextState.tokenBound = typeof result.tokenBound === 'boolean' ? result.tokenBound : nextState.tokenBound;
        nextState.tokenStatus = result.tokenStatus || nextState.tokenStatus || 'unbound';
        nextState.contributionCount = Number(result.contributionCount || 0);
        saveState(nextState, { skipRender: true });
        refreshPanelChrome();
      }
      pushDebugLog('query:ok ' + job.name + ' found=' + String(!!result.found));
      job.resolve(result);
    }).catch(function (error) {
      job.reject(error);
    }).finally(function () {
      queryQueueRunning = false;
      if (queryQueue.length && canAutoScan()) {
        setTimeout(runQueryQueue, 120);
      }
    });
  }

  function iconButtonStyle() {
    return '';
  }

  function svgIcon(name) {
    var icons = {
      contact: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M44 6H4V36H13V41L23 36H44V6Z"></path><path d="M14 21H34"></path></svg>',
      notice: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="15" width="40" height="26" rx="2"></rect><path d="M24 7L16 15H32L24 7Z"></path><path d="M12 24H30"></path><path d="M12 32H20"></path></svg>',
      pricing: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M4 12H44V20L42.6015 20.8391C40.3847 22.1692 37.6153 22.1692 35.3985 20.8391L34 20L32.6015 20.8391C30.3847 22.1692 27.6153 22.1692 25.3985 20.8391L24 20L22.6015 20.8391C20.3847 22.1692 17.6153 22.1692 15.3985 20.8391L14 20L12.6015 20.8391C10.3847 22.1692 7.61531 22.1692 5.39853 20.8391L4 20V12Z"></path><path d="M8 22.4889V44H40V22"></path><path d="M8 11.8222V4H40V12"></path><rect x="19" y="32" width="10" height="12"></rect></svg>',
      guide: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="8" width="40" height="32" rx="3"></rect><path d="M4 11C4 9.34315 5.34315 8 7 8H41C42.6569 8 44 9.34315 44 11V20H4V11Z"></path><circle cx="10" cy="14" r="2" fill="currentColor" stroke="none"></circle><circle cx="16" cy="14" r="2" fill="currentColor" stroke="none"></circle></svg>',
      minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"></path></svg>',
      expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>'
    };
    return icons[name] || '';
  }

  function iconButton(action, iconName, title, hot) {
    return '' +
      '<button type="button" class="kxb-icon-button' + (hot ? ' kxb-icon-button--hot' : '') + '" data-action="' + action + '" title="' + title + '" aria-label="' + title + '" style="' + iconButtonStyle() + '">' +
        svgIcon(iconName) +
      '</button>';
  }

  function modeTabs(activeView) {
    return '' +
      '<div class="kxb-segmented">' +
        '<button type="button" class="kxb-segmented__item" data-action="show-login" data-active="' + String(activeView === 'login') + '">登录</button>' +
        '<button type="button" class="kxb-segmented__item" data-action="show-register" data-active="' + String(activeView === 'register') + '">注册</button>' +
        '<button type="button" class="kxb-segmented__item" data-action="show-forgot" data-active="' + String(activeView === 'forgot_password') + '">找回</button>' +
      '</div>';
  }

  function screenTitle(title, note) {
    return '' +
      '<div class="kxb-screen-head">' +
        '<div class="kxb-screen-title-row">' +
          '<div>' +
            '<div class="kxb-screen-title">' + title + '</div>' +
            (note ? '<div class="kxb-screen-note">' + note + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function inputRow(label, role, type) {
    return '' +
      '<label class="kxb-field">' +
        '<span class="kxb-field__label">' + label + '</span>' +
        '<input class="kxb-input" data-role="' + role + '" type="' + (type || 'text') + '" autocomplete="off" />' +
      '</label>';
  }

  function actionButton(action, label, secondary) {
    return '<button type="button" class="kxb-btn ' + (secondary ? 'kxb-btn--secondary' : 'kxb-btn--primary') + '" data-action="' + action + '">' + label + '</button>';
  }

  function announcementButton() {
    var dot = hasUnreadNotice()
      ? '<span class="kxb-btn__alert-dot"></span>'
      : '';
    return '' +
      '<button type="button" class="kxb-utility-button" data-action="show-announcement">' +
        '<span>查看公告' + dot + '</span>' +
        '<span class="kxb-utility-meta">最新通知</span>' +
      '</button>';
  }

  function utilityButton(action, label, meta) {
    return '' +
      '<button type="button" class="kxb-utility-button" data-action="' + action + '">' +
        '<span>' + label + '</span>' +
        '<span class="kxb-utility-meta">' + meta + '</span>' +
      '</button>';
  }

  function textButton(action, label) {
    return '<button type="button" class="kxb-text-link" data-action="' + action + '">' + label + '</button>';
  }

  function statRow(label, value, wide) {
    return '' +
      '<div class="kxb-stat' + (wide ? ' kxb-stat--wide' : '') + '">' +
        '<div class="kxb-stat__label">' + label + '</div>' +
        '<div class="kxb-stat__value">' + (value || '-') + '</div>' +
      '</div>';
  }

  function statusPill(label, tone) {
    return '' +
      '<span class="kxb-pill kxb-pill--' + (tone || 'muted') + '">' +
        '<span class="kxb-pill__dot"></span>' +
        '<span>' + label + '</span>' +
      '</span>';
  }

  function statusPillWithRole(role, label, tone) {
    return '' +
      '<span class="kxb-pill kxb-pill--' + (tone || 'muted') + '" data-role="' + role + '">' +
        '<span class="kxb-pill__dot"></span>' +
        '<span data-role="' + role + '-text">' + label + '</span>' +
      '</span>';
  }

  function tokenStatusPill(state) {
    if (state && state.tokenBound) {
      return statusPill('卡密有效', 'success');
    }
    if (state && (state.tokenStatus === 'expired' || state.tokenStatus === 'disabled')) {
      return statusPill('卡密异常', 'warn');
    }
    return statusPill('未绑定卡密', 'muted');
  }

  function formatPlainTime(value) {
    if (!value) {
      return '未绑定';
    }
    var date = new Date(String(value).replace(' ', 'T'));
    return isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function getInputValue(role) {
    var node = panel && panel.querySelector('[data-role="' + role + '"]');
    return node ? node.value : '';
  }

  function sectionCard(innerHtml, extraClass) {
    return '<div class="kxb-card ' + (extraClass || '') + '">' + innerHtml + '</div>';
  }

  function panelMarkup() {
    return '' +
      '<div data-role="panel-shell" class="kxb-panel">' +
        '<div data-role="panel-header" class="kxb-panel__header">' +
          '<div class="kxb-header-copy">' +
            '<div class="kxb-header-kicker">Account Console</div>' +
            '<div class="kxb-header-title">' + CONFIG.title + '</div>' +
            '<div data-role="header-subtitle" class="kxb-header-subtitle">' + CONFIG.helpText + '</div>' +
          '</div>' +
          '<div class="kxb-header-actions">' +
            iconButton('open-contact', 'contact', '联系', false) +
            iconButton('show-announcement', 'notice', '公告', hasUnreadNotice()) +
            iconButton('open-pricing', 'pricing', '价格', false) +
            iconButton('open-guide', 'guide', '指导', false) +
            iconButton('collapse', 'minimize', '最小化/最大化', false) +
          '</div>' +
        '</div>' +
        '<div data-role="panel-body" class="kxb-panel__body">' +
          '<div class="kxb-status-card">' +
            '<div class="kxb-status-top">' +
              '<div data-role="status-chip" class="kxb-status-chip">' +
                '<span class="kxb-status-chip__dot"></span>' +
                '<span data-role="status-chip-text">未登录</span>' +
              '</div>' +
            '</div>' +
            '<div data-role="status-line" class="kxb-status-line">登录后才会自动查询。</div>' +
          '</div>' +
          '<div data-role="view-root" class="kxb-view-root"></div>' +
        '</div>' +
      '</div>';
  }

  function renderLoginView() {
    return '' +
      '<div class="kxb-screen">' +
        screenTitle('登录账户', '') +
        '<div class="kxb-pill-row">' +
          statusPill('账号登录', 'read') +
          statusPill('卡密独立绑定', 'muted') +
        '</div>' +
        modeTabs('login') +
        sectionCard(
          '<div class="kxb-form-card">' +
            '<div class="kxb-form-grid">' +
              inputRow('用户名', 'username') +
              inputRow('密码', 'password', 'password') +
              '<div class="kxb-button-row">' + actionButton('login', '登录并启用面板', false) + '</div>' +
            '</div>' +
          '</div>'
        ) +
        '<div class="kxb-text-link-row">' +
          textButton('show-register', '没有账号？去注册') +
          textButton('show-forgot', '忘记密码') +
        '</div>' +
      '</div>';
  }

  function renderRegisterView() {
    return '' +
      '<div class="kxb-screen">' +
        screenTitle('注册账号', '') +
        '<div class="kxb-pill-row">' +
          statusPill('创建账号', 'edit') +
          statusPill('保存找回邮箱', 'muted') +
        '</div>' +
        modeTabs('register') +
        sectionCard(
          '<div class="kxb-form-card">' +
            '<div class="kxb-form-grid">' +
              inputRow('用户名', 'username') +
              inputRow('密码', 'password', 'password') +
              inputRow('找回邮箱', 'reset-email', 'email') +
              '<div class="kxb-button-row">' + actionButton('register', '注册并自动登录', false) + '</div>' +
            '</div>' +
          '</div>'
        ) +
        '<div class="kxb-text-link-row" style="justify-content:flex-end;">' + textButton('show-login', '返回登录') + '</div>' +
      '</div>';
  }

  function renderForgotView() {
    return '' +
      '<div class="kxb-screen">' +
        screenTitle('找回密码', '') +
        '<div class="kxb-mini-timeline">' +
          statusPill('申请', 'read') +
          statusPill('重置码', 'edit') +
          statusPill('改密', 'done') +
        '</div>' +
        modeTabs('forgot_password') +
        sectionCard(
          '<div class="kxb-form-card">' +
            '<div class="kxb-form-grid kxb-form-grid--compact">' +
              inputRow('用户名', 'username') +
              inputRow('找回邮箱', 'reset-email', 'email') +
              '<div class="kxb-button-row">' + actionButton('forgot', '提交找回申请', true) + '</div>' +
              '<div class="kxb-form-pair">' +
                inputRow('重置码', 'reset-code') +
                inputRow('新密码', 'new-password', 'password') +
              '</div>' +
              '<div class="kxb-button-row">' + actionButton('reset-password', '提交重置密码', false) + '</div>' +
            '</div>' +
          '</div>'
        ) +
        '<div class="kxb-text-link-row" style="justify-content:flex-end;">' + textButton('show-login', '返回登录') + '</div>' +
      '</div>';
  }

  function legacyRenderLoggedInView(state) {
    return renderLoggedInView(state);
  }

  function legacyRenderBindTokenView(state) {
    return renderBindTokenView(state);
  }

  function renderCurrentView() {
    if (!panel) {
      return;
    }
    var state = loadState();
    var root = panel.querySelector('[data-role="view-root"]');
    if (!root) {
      return;
    }

    if (isLoggedIn() && (currentView === 'login' || currentView === 'register' || currentView === 'forgot_password')) {
      currentView = 'logged_in';
    }
    if (!isLoggedIn() && (currentView === 'logged_in' || currentView === 'bind_token')) {
      currentView = 'login';
    }

    var nextRenderKey = [
      currentView,
      state.status,
      state.username,
      state.userId,
      state.tokenBound,
      state.tokenStatus,
      state.expireTime
    ].join('|');

    if (lastViewRenderKey === nextRenderKey && root.firstChild) {
      patchCurrentViewState(state);
      return;
    }

    if (currentView === 'register') {
      root.innerHTML = renderRegisterView();
    } else if (currentView === 'forgot_password') {
      root.innerHTML = renderForgotView();
    } else if (currentView === 'logged_in') {
      root.innerHTML = renderLoggedInView(state);
    } else if (currentView === 'bind_token') {
      root.innerHTML = renderBindTokenView(state);
    } else {
      root.innerHTML = renderLoginView();
    }

    lastViewRenderKey = nextRenderKey;
    patchCurrentViewState(state);
    fillKnownFields(state);
  }

  function patchCurrentViewState(state) {
    if (!panel) {
      return;
    }
    var contributionText = panel.querySelector('[data-role="account-contribution-text"]');
    var expireValue = panel.querySelector('[data-role="account-expire-value"]');
    var bindExpireText = panel.querySelector('[data-role="bind-expire-pill-text"]');

    if (contributionText) {
      contributionText.textContent = '贡献 ' + String(state.contributionCount || 0);
    }
    if (expireValue) {
      expireValue.textContent = state.tokenBound
        ? formatPlainTime(state.expireTime)
        : (getTokenStatusMessage(state.tokenStatus) || '未绑定卡密');
    }
    if (bindExpireText) {
      bindExpireText.textContent = state.tokenBound
        ? '到期 ' + formatPlainTime(state.expireTime)
        : '等待激活';
    }
  }

  // Override the legacy panel text branch so token status can distinguish
  // unbound / expired / disabled without relying on older garbled copy.
  function renderLoggedInView(state) {
    var tokenStatusText = state.tokenBound
      ? formatPlainTime(state.expireTime)
      : (getTokenStatusMessage(state.tokenStatus) || '未绑定卡密');
    return '' +
      '<div class="kxb-screen">' +
        screenTitle('账户概览', '') +
        '<div class="kxb-pill-row">' +
          statusPill('已登录', 'success') +
          tokenStatusPill(state) +
          statusPillWithRole('account-contribution', '贡献 ' + String(state.contributionCount || 0), 'muted') +
        '</div>' +
        sectionCard(
          '<div class="kxb-summary-card">' +
            '<div class="kxb-summary-grid">' +
              statRow('当前用户', state.username || '-') +
              statRow('用户 ID', state.userId || '-') +
              '<div class="kxb-stat kxb-stat--wide">' +
                '<div class="kxb-stat__label">卡密到期</div>' +
                '<div class="kxb-stat__value" data-role="account-expire-value">' + tokenStatusText + '</div>' +
              '</div>' +
            '</div>' +
          '</div>'
        ) +
        sectionCard(
          '<div class="kxb-action-card">' +
            '<div class="kxb-button-row kxb-button-row--two">' +
              (state.tokenBound ? actionButton('show-bind-token', '查看绑定状态', true) : actionButton('show-bind-token', '去绑定卡密', false)) +
              '<button type="button" class="kxb-btn kxb-btn--ghost" data-action="logout">退出登录</button>' +
            '</div>' +
          '</div>'
        ) +
        sectionCard(
          '<div class="kxb-side-card">' +
            '<div class="kxb-mark">辅助入口已移到右上角，当前页只保留账号和卡密主操作。</div>' +
          '</div>'
        ) +
      '</div>';
  }

  function renderBindTokenView(state) {
    var tokenStatusNotice = getTokenStatusMessage(state.tokenStatus);
    var statusBlock = '';
    if (state.tokenBound) {
      statusBlock = '<div class="kxb-banner kxb-banner--success">已绑定，到期时间：' + formatPlainTime(state.expireTime) + '</div>';
    } else if (tokenStatusNotice) {
      statusBlock = '<div class="kxb-banner kxb-banner--warn">' + escapeHtml(tokenStatusNotice) + '</div>';
    }
    return '' +
      '<div class="kxb-screen">' +
        screenTitle('绑定卡密', '') +
        '<div class="kxb-pill-row">' +
          tokenStatusPill(state) +
          (state.tokenBound ? statusPillWithRole('bind-expire-pill', '到期 ' + formatPlainTime(state.expireTime), 'done') : statusPillWithRole('bind-expire-pill', '等待激活', 'warn')) +
        '</div>' +
        sectionCard(
          '<div class="kxb-form-card">' +
            '<div class="kxb-form-grid">' +
              statusBlock +
              inputRow('卡密', 'token') +
              '<div class="kxb-button-row">' + actionButton('bind-token', '绑定卡密', false) + '</div>' +
            '</div>' +
          '</div>'
        ) +
        '<div class="kxb-text-link-row" style="justify-content:flex-end;">' + textButton('show-logged-in', '返回账户概览') + '</div>' +
      '</div>';
  }

  function legacyRenderPanelState() {
    renderPanelState();
  }

  function refreshPanelChrome() {
    if (!panel || !dock) {
      return;
    }
    var state = loadState();
    var loggedIn = isLoggedIn();
    var chip = panel.querySelector('[data-role="status-chip"]');
    var chipText = panel.querySelector('[data-role="status-chip-text"]');
    var line = panel.querySelector('[data-role="status-line"]');
    var noticeButton = panel.querySelector('[data-action="show-announcement"]');

    if (chipText) {
      chipText.textContent = loggedIn ? '已登录' : '未登录';
    }
    if (chip) {
      chip.style.background = loggedIn ? 'rgba(31,138,101,.12)' : '#e6e5e0';
      chip.style.color = loggedIn ? '#1f8a65' : '#26251e';
    }
    if (noticeButton) {
      noticeButton.classList.toggle('kxb-icon-button--hot', hasUnreadNotice());
    }

    if (!line) {
      return;
    }
    if (!loggedIn) {
      line.textContent = '未登录时不会自动查询。';
      line.style.color = '#26251e';
    } else if (!state.tokenBound) {
      line.textContent = '已登录，等待有效卡密；未绑定时不会继续自动扫描。';
      line.style.color = '#26251e';
    } else {
      line.textContent = '已登录，自动查询已启用。';
      line.style.color = '#26251e';
    }

    dock.querySelector('[data-role="dock-text"]').textContent = CONFIG.title + ' · ' + (loggedIn ? state.username : '未登录');
  }

  function renderPanelState() {
    refreshPanelChrome();
    if (!panel || !dock) {
      return;
    }
    renderCurrentView();
  }

  function fillKnownFields(state) {
    if (!panel) {
      return;
    }
    var usernameNode = panel.querySelector('[data-role="username"]');
    var passwordNode = panel.querySelector('[data-role="password"]');
    var tokenNode = panel.querySelector('[data-role="token"]');
    var resetEmailNode = panel.querySelector('[data-role="reset-email"]');
    if (usernameNode && state.username && !usernameNode.value) {
      usernameNode.value = state.username;
    }
    if (passwordNode && state.password && !passwordNode.value) {
      passwordNode.value = state.password;
    }
    if (tokenNode && state.token && !tokenNode.value) {
      tokenNode.value = state.token;
    }
    if (resetEmailNode && state.resetEmail && !resetEmailNode.value) {
      resetEmailNode.value = state.resetEmail;
    }
  }

  function setPanelMessage(text, isError) {
    createPanel();
    var line = panel.querySelector('[data-role="status-line"]');
    line.textContent = text;
    line.style.color = isError ? '#cf2d56' : '#26251e';
  }

  function setPanelTip(text) {
    return text;
  }

  function syncTokenStatusFeedback(state) {
    var message = getTokenStatusMessage(state && state.tokenStatus);
    var tip = getTokenStatusTip(state && state.tokenStatus);
    if (state && state.tokenBound) {
      setPanelTip('');
      return '';
    }
    setPanelTip(tip);
    return message;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closePanelOverlay() {
    if (!panel) {
      return;
    }
    var overlay = panel.querySelector('[data-role="panel-overlay"]');
    if (overlay) {
      overlay.parentNode.removeChild(overlay);
    }
  }

  function showPanelOverlay(title, bodyHtml) {
    createPanel();
    closePanelOverlay();
    var overlay = document.createElement('div');
    overlay.setAttribute('data-role', 'panel-overlay');
    overlay.className = 'kxb-overlay';
    overlay.innerHTML = '' +
      '<div class="kxb-overlay__card">' +
        '<div class="kxb-overlay__head">' +
          '<strong class="kxb-overlay__title">' + escapeHtml(title) + '</strong>' +
          '<button type="button" class="kxb-icon-button" data-action="close-overlay">×</button>' +
        '</div>' +
        '<div class="kxb-overlay__body">' + bodyHtml + '</div>' +
      '</div>';
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) {
        closePanelOverlay();
      }
    });
    panel.appendChild(overlay);
  }

  function openContactLink() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(CONFIG.contactWechat).then(function () {
        showToast('已复制微信号 ' + CONFIG.contactWechat + '，添加我购买卡密');
      }).catch(function () {
        showToast('请手动添加微信号 ' + CONFIG.contactWechat + ' 购买卡密');
      });
      return;
    }
    showToast('请手动添加微信号 ' + CONFIG.contactWechat + ' 购买卡密');
  }

  function openPricingLink() {
    window.open(CONFIG.pricingUrl, '_blank', 'noopener,noreferrer');
  }

  function openGuideLink() {
    window.open(CONFIG.siteUrl, '_blank', 'noopener,noreferrer');
  }

  function showAnnouncementDialog() {
    var items = noticeState.items || [];
    if (!items.length) {
      showPanelOverlay('公告', '<div>当前暂无公告。</div>');
      return;
    }
    var bodyHtml = items.map(function (item) {
      return '<div class="kxb-notice-item">' +
        '<div class="kxb-notice-item__title">' + escapeHtml(item.title || '未命名公告') + '</div>' +
        '<div class="kxb-notice-item__meta">' + escapeHtml(item.published_at || '') + '</div>' +
        '<div class="kxb-notice-item__body">' + escapeHtml(item.content || '') + '</div>' +
      '</div>';
    }).join('');
    showPanelOverlay('公告', bodyHtml);
    saveNoticeReadState(noticeState.latestId);
  }

  function pushDebugLog(message) {
    var timestamp = new Date().toLocaleTimeString();
    debugLogs.unshift('[' + timestamp + '] ' + message);
    debugLogs = debugLogs.slice(0, 18);
  }

  function readForm() {
    return {
      username: getInputValue('username'),
      password: getInputValue('password'),
      token: getInputValue('token'),
      resetEmail: getInputValue('reset-email'),
      resetCode: getInputValue('reset-code'),
      newPassword: getInputValue('new-password')
    };
  }

  function createPanel() {
    if (panel) {
      return;
    }
    ensurePanelStyles();
    var wrapper = document.createElement('div');
    wrapper.innerHTML = panelMarkup();
    panel = wrapper.firstChild;
    document.body.appendChild(panel);

    dock = document.createElement('div');
    dock.className = 'kxb-dock';
    dock.innerHTML = '' +
      '<span data-role="dock-text" class="kxb-dock__label">' + CONFIG.title + '</span>' +
      '<button type="button" class="kxb-icon-button" data-action="show" title="展开面板" aria-label="展开面板">' + svgIcon('expand') + '</button>';
    document.body.appendChild(dock);

    bindPanelEvents();
    enableDrag(panel, panel.querySelector('[data-role="panel-header"]'));
    syncCollapseState();
    renderPanelState();
  }

  function syncCollapseState() {
    if (!panel) {
      return;
    }
    var body = panel.querySelector('[data-role="panel-body"]');
    var button = panel.querySelector('[data-action="collapse"]');
    if (!body || !button) {
      return;
    }
    body.style.display = 'flex';
    button.innerHTML = svgIcon('minimize');
    button.title = panelCollapsed ? '展开面板' : '最小化面板';
    button.setAttribute('aria-label', button.title);
    panel.style.height = '640px';
    panel.style.display = panelCollapsed ? 'none' : 'flex';
    if (dock) {
      dock.style.display = panelCollapsed ? 'flex' : 'none';
    }
  }

  function setPanelBusy(nextBusy) {
    panelBusy = !!nextBusy;
    if (!panel) {
      return;
    }
    Array.prototype.forEach.call(panel.querySelectorAll('button[data-action]'), function (button) {
      var action = button.getAttribute('data-action') || '';
      if (action === 'collapse' || action === 'show' || action === 'close-overlay') {
        return;
      }
      button.disabled = panelBusy;
    });
  }

  function bindPanelEvents() {
    panel.querySelector('[data-action="collapse"]').addEventListener('click', function (event) {
      event.preventDefault();
      savePanelCollapsedState(true);
      syncCollapseState();
    });

    dock.querySelector('[data-action="show"]').addEventListener('click', function (event) {
      event.preventDefault();
      savePanelCollapsedState(false);
      syncCollapseState();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closePanelOverlay();
      }
    });

    panel.addEventListener('click', function (event) {
      var target = event.target.closest('[data-action]');
      if (!target || !panel.contains(target)) {
        return;
      }
      event.preventDefault();
      handlePanelAction(target.getAttribute('data-action'));
    });

    panel.addEventListener('input', function (event) {
      var target = event.target;
      if (!target || !target.matches('input[data-role]')) {
        return;
      }
      var role = target.getAttribute('data-role');
      if (role === 'username') {
        saveDraftFields({ username: target.value });
      } else if (role === 'password') {
        saveDraftFields({ password: target.value });
      } else if (role === 'token') {
        saveDraftFields({ token: target.value });
      } else if (role === 'reset-email') {
        saveDraftFields({ resetEmail: target.value });
      }
    });
  }

  function handlePanelAction(action) {
    if (action === 'show-login') {
      currentView = 'login';
      renderCurrentView();
      return;
    }
    if (action === 'show-register') {
      currentView = 'register';
      renderCurrentView();
      return;
    }
    if (action === 'show-forgot') {
      currentView = 'forgot_password';
      renderCurrentView();
      return;
    }
    if (action === 'show-bind-token') {
      currentView = 'bind_token';
      renderCurrentView();
      return;
    }
    if (action === 'show-logged-in') {
      currentView = 'logged_in';
      renderCurrentView();
      return;
    }
    if (action === 'show-announcement') {
      showAnnouncementDialog();
      return;
    }
    if (action === 'open-contact') {
      openContactLink();
      return;
    }
    if (action === 'open-pricing') {
      openPricingLink();
      return;
    }
    if (action === 'open-guide') {
      openGuideLink();
      return;
    }
    if (action === 'close-overlay') {
      closePanelOverlay();
      return;
    }
    if (action === 'register') {
      submitRegister();
      return;
    }
    if (action === 'login') {
      submitLogin();
      return;
    }
    if (action === 'bind-token') {
      submitBindToken();
      return;
    }
    if (action === 'logout') {
      submitLogout();
      return;
    }
    if (action === 'forgot') {
      submitForgot();
      return;
    }
    if (action === 'reset-password') {
      submitResetPassword();
    }
  }

  function submitRegister() {
    var form = readForm();
    if (!form.username || !form.password || !form.resetEmail) {
      showToast('注册需要用户名、密码和找回邮箱');
      return;
    }
    saveDraftFields({
      username: form.username,
      password: form.password,
      resetEmail: form.resetEmail
    });
    setPanelBusy(true);
    setPanelMessage('正在注册...');
    registerAccount(form).then(function () {
      currentView = 'logged_in';
      setPanelMessage('注册成功，已自动登录');
      setPanelTip('');
      showToast('注册成功');
      refreshAll();
    }).catch(function (error) {
      setPanelMessage(error.message, true);
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function submitLogin() {
    var form = readForm();
    if (!form.username || !form.password) {
      showToast('登录需要用户名和密码');
      return;
    }
    saveDraftFields({
      username: form.username,
      password: form.password
    });
    setPanelBusy(true);
    setPanelMessage('正在登录...');
    pushDebugLog('login:submit ' + normalizeUsername(form.username));
    loginAccount(form).then(function (state) {
      autoQueryStarted = false;
      currentView = 'logged_in';
      pushDebugLog('login:ok tokenBound=' + String(!!state.tokenBound));
      setPanelMessage(state.tokenBound ? '登录成功，正在开始扫描...' : (syncTokenStatusFeedback(state) || '登录成功，请先绑定卡密'));
      if (state.tokenBound) {
        setPanelTip('');
      }
      showToast('登录成功');
      refreshAll();
      kickAutoQuery();
    }).catch(function (error) {
      setPanelMessage(error.message, true);
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function submitBindToken() {
    var form = readForm();
    if (!form.token) {
      showToast('请输入卡密');
      return;
    }
    saveDraftFields({
      token: form.token
    });
    setPanelBusy(true);
    setPanelMessage('正在绑定卡密...');
    pushDebugLog('bind:submit');
    bindToken(form).then(function () {
      autoQueryStarted = false;
      currentView = 'logged_in';
      pushDebugLog('bind:ok');
      setPanelMessage('卡密已绑定，正在开始扫描...');
      setPanelTip('');
      showToast('绑定成功');
      refreshAll();
      kickAutoQuery();
    }).catch(function (error) {
      setPanelMessage(error.message, true);
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function submitLogout() {
    autoQueryStarted = false;
    currentView = 'login';
    setPanelBusy(true);
    setPanelTip('');
    setPanelMessage('正在退出...');
    pushDebugLog('logout:submit');
    logoutAccount().then(function () {
      pushDebugLog('logout:ok');
      showToast('已退出登录');
      refreshAll();
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function submitForgot() {
    var form = readForm();
    if (!form.username || !form.resetEmail) {
      showToast('提交找回申请需要用户名和找回邮箱');
      return;
    }
    saveDraftFields({
      username: form.username,
      resetEmail: form.resetEmail
    });
    setPanelBusy(true);
    setPanelMessage('正在提交找回申请...');
    forgotPassword(form).then(function () {
      setPanelMessage('申请已提交，请在后台生成重置码后再改密');
      setPanelTip('这一步只负责提交申请；真正的重置码仍需要后台生成。');
      showToast('找回申请已提交');
    }).catch(function (error) {
      setPanelMessage(error.message, true);
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function submitResetPassword() {
    var form = readForm();
    if (!form.username || !form.resetCode || !form.newPassword) {
      showToast('改密需要用户名、重置码和新密码');
      return;
    }
    setPanelBusy(true);
    setPanelMessage('正在重置密码...');
    resetPassword(form).then(function () {
      currentView = 'login';
      setPanelMessage('密码已重置，请重新登录');
      setPanelTip('');
      showToast('密码已重置');
      renderCurrentView();
    }).catch(function (error) {
      setPanelMessage(error.message, true);
    }).finally(function () {
      setPanelBusy(false);
    });
  }

  function createBossLinkBadge(result) {
    if (!result || !result.found) {
      return '';
    }
    return '<span class="kxb-blacklist-entry" style="display:inline-block;margin-left:10px;color:#ff3b30;text-decoration:none;font-size:16px;line-height:1;" title="命中黑名单">🚨</span>';
  }

  function createBossIconBadge() {
    return '<span class="kxb-blacklist-entry" style="display:inline-block;margin-left:10px;color:#f00;font-size:16px;line-height:1;">⚠️</span>';
  }

  function createBossPassBadge() {
    return '<span class="kxb-blacklist-entry" style="display:inline-block;margin-left:10px;color:#16a34a;font-size:16px;line-height:1;">✅</span>';
  }

  function createBossPillBadge() {
    return '<span class="kxb-blacklist-entry" style="display:inline-block;margin-left:10px;padding:3px 8px;border-radius:999px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:600;line-height:1.2;">黑名单</span>';
  }

  function createBossTagsBlock(tags) {
    if (!tags || !tags.length) {
      return '';
    }
    var items = tags.map(function (tag) {
      return '<div class="kxb-boss-tag-item" style="margin-top:6px;font-size:12px;line-height:1.4;color:#ef4444;">' + escapeHtml(tag) + '</div>';
    }).join('');
    return '<div class="kxb-boss-tags" style="display:block;margin-top:8px;">' + items + '</div>';
  }

  function insertBossTags(node, result, selector) {
    if (selector !== '.boss-name' || !result || !result.found || !result.tags || !result.tags.length) {
      return;
    }
    var card = $(node).closest('li, .job-card-wrapper, .job-card-item, .job-card, .job-list-item, .job-card-left, .job-info');
    var tagList = card.find('.job-info > .tag-list, .tag-list').first();
    var tagsText = result.tags.join('<span style="color:#2563eb"> / </span>');
    var hoverTitle = escapeHtml(result.tags.join(' | '));
    if (tagList.length) {
      if (tagList.find('.kxb-tags-entry').length) {
        return;
      }
      var tagsHtml = $('<li class="kxb-tags-entry" title="' + hoverTitle + '"><span style="color:#ff3b30">' + tagsText + '</span></li>');
      tagList.prepend(tagsHtml);
      return;
    }
    if (card.find('.kxb-boss-tags-inline').length) {
      return;
    }
    $(node).after('<div class="kxb-boss-tags-inline" title="' + hoverTitle + '" style="margin-top:6px;font-size:12px;line-height:1.4;color:#ef4444;">' + tagsText + '</div>');
  }

  function insertGongsiTopResult(node, result) {
    if (!result) {
      return;
    }
    var $node = $(node);
    var $focus = $node.find('.icon-focus').first();
    var $titleRow = $node.closest('.info, .info-primary').first();
    var badgeHtml = result.found ? createBossPillBadge() : createBossPassBadge();
    var tagsHtml = createBossTagsBlock(result.tags || []);
    if (!$focus.length) {
      if (!$node.find('.kxb-blacklist-entry').length) {
        $node.append(badgeHtml);
      }
      if (result.found && tagsHtml && $titleRow.length && !$titleRow.next('.kxb-boss-tags').length) {
        $titleRow.after(tagsHtml);
      }
      return;
    }
    if (!$focus.next('.kxb-blacklist-entry').length) {
      $focus.after(badgeHtml);
    }
    if (result.found && tagsHtml && $titleRow.length && !$titleRow.next('.kxb-boss-tags').length) {
      $titleRow.after(tagsHtml);
    }
  }

  function insertGongsiBusinessResult(node, result) {
    if (!result) {
      return;
    }
    var $node = $(node);
    if (!$node.find('.kxb-blacklist-entry').length) {
      $node.append(result.found ? createBossPillBadge() : createBossPassBadge());
    }
  }

  function extractGongsiTopCompanyName(node) {
    if (!node) {
      return '';
    }
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.icon-focus, .icon-brand, .salary, .badge'), function (child) {
      if (child && child.parentNode) {
        child.parentNode.removeChild(child);
      }
    });
    return cleanText((clone.textContent || '').replace(/收藏/g, ''));
  }

  function extractGongsiBusinessCompanyName(node) {
    if (!node) {
      return '';
    }
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.t'), function (child) {
      if (child && child.parentNode) {
        child.parentNode.removeChild(child);
      }
    });
    return cleanText(clone.textContent || '');
  }

  function extractBossCompanyName(node, route, selector) {
    if (route.paths.indexOf('/gongsi') !== -1 && selector === '.info-primary > .info > .name') {
      return extractGongsiTopCompanyName(node);
    }
    if (route.paths.indexOf('/gongsi') !== -1 && selector === '.business-detail-name') {
      return extractGongsiBusinessCompanyName(node);
    }
    return cleanText(node.textContent || node.innerText || '');
  }

  function insertNode(node, mode, html) {
    var $node = $(node);
    var $html = $(html);
    if (mode === 'append') {
      $node.append($html);
    } else if (mode === 'prepend') {
      $node.prepend($html);
    } else if (mode === 'before') {
      $node.before($html);
    } else {
      $node.after($html);
    }
  }

  function startBossFeatures() {
    var routes = [
      { paths: ['/web/geek'], mode: 'after', selectors: ['.boss-name'] },
      { paths: ['/web/geek/chat'], mode: 'after', selectors: ['.title-box .name-box > span:nth-child(2)'] },
      { paths: ['/job_detail'], mode: 'append', selectors: ['.level-list > .company-name', 'a[ka="job-detail-company_custompage"]'] },
      { paths: ['/web/geek'], mode: 'append', selectors: ['.base-info.fl > span:nth-child(2)', '.name-box > span:nth-child(2)', '.name-box .name', '.base-info .name', '.base-info .company-name'] },
      { paths: ['/gongsi'], mode: 'append', selectors: ['.info-primary > .info > .name', '.business-detail-name'] }
    ];

    function routeActive(route) {
      if (location.pathname.indexOf('/web/geek/chat') !== -1 && route.paths.indexOf('/web/geek/chat') === -1) {
        return false;
      }
      return route.paths.some(function (path) {
        return location.pathname.indexOf(path) !== -1;
      });
    }

    function handleBossNode(node, route, selector) {
      if (!canAutoScan()) {
        return;
      }
      var $node = $(node);
      if ($node.siblings('.kxb-blacklist-entry').length || $node.find('.kxb-blacklist-entry').length) {
        if (node.dataset) {
          node.dataset.kxbBossProcessed = '1';
        }
        return;
      }
      var nodeClass = node.getAttribute('class') || '';
      if (nodeClass.indexOf('kxb-blacklist-entry') !== -1 || nodeClass.indexOf('base-title') !== -1) {
        return;
      }
      if (node.dataset && node.dataset.kxbBossProcessed === '1') {
        return;
      }
      if (node.dataset) {
        node.dataset.kxbBossProcessed = '1';
      }

      var companyName = extractBossCompanyName(node, route, selector);
      if (!companyName) {
        return;
      }

      queryCompany(companyName).then(function (result) {
        if (route.paths.indexOf('/gongsi') !== -1) {
          if (selector === '.business-detail-name') {
            insertGongsiBusinessResult(node, result);
          } else if (selector === '.info-primary > .info > .name') {
            insertGongsiTopResult(node, result);
          }
          return;
        }
        if (!result) {
          return;
        }
        var insertHtml;
        if (result.found) {
          insertHtml = (route.paths.indexOf('/job_detail') !== -1 || route.paths.indexOf('/web/geek/chat') !== -1)
            ? createBossIconBadge()
            : createBossLinkBadge(result);
        } else {
          insertHtml = createBossPassBadge();
        }
        insertNode(node, route.mode, insertHtml);
        insertBossTags(node, result, selector);
      }).catch(function (error) {
        if (node.dataset) {
          node.dataset.kxbBossProcessed = '';
        }
        if (isStaleQueryError(error)) {
          return;
        }
        setPanelMessage((error && error.message) || '查询失败', true);
      });
    }

    function scanBoss() {
      if (!canAutoScan()) {
        return;
      }
      var visibleNames = [];
      routes.forEach(function (route) {
        if (!routeActive(route)) {
          return;
        }
        route.selectors.forEach(function (selector) {
          var nodes = document.querySelectorAll(selector);
          Array.prototype.forEach.call(nodes, function (node) {
            var companyName = extractBossCompanyName(node, route, selector);
            if (companyName) {
              visibleNames.push(companyName);
            }
          });
        });
      });

      updateVisibleBossCompanies(visibleNames);
      pruneQueryQueue(function (job) {
        return !isVisibleBossCompany(job.name);
      });

      routes.forEach(function (route) {
        if (!routeActive(route)) {
          return;
        }
        route.selectors.forEach(function (selector) {
          var nodes = document.querySelectorAll(selector);
          Array.prototype.forEach.call(nodes, function (node) {
            handleBossNode(node, route, selector);
          });
        });
      });
    }

    function scheduleBossScan(force) {
      if (bossScanTimer && !force) {
        return;
      }
      if (bossScanTimer) {
        clearTimeout(bossScanTimer);
      }
      bossScanTimer = setTimeout(function () {
        bossScanTimer = null;
        scanBoss();
      }, force ? 0 : 250);
    }

    if (!bossHistoryHooked) {
      bossHistoryHooked = true;
      var pushState = history.pushState;
      var replaceState = history.replaceState;
      history.pushState = function () {
        var result = pushState.apply(this, arguments);
        scheduleBossScan(true);
        return result;
      };
      history.replaceState = function () {
        var result = replaceState.apply(this, arguments);
        scheduleBossScan(true);
        return result;
      };
      window.addEventListener('popstate', function () {
        scheduleBossScan(true);
      });
      window.addEventListener('hashchange', function () {
        scheduleBossScan(true);
      });
    }

    if (bossObserver) {
      bossObserver.disconnect();
    }
    bossObserver = new MutationObserver(function () {
      scheduleBossScan();
    });
    bossObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
    scheduleBossScan(true);
    setTimeout(function () {
      scheduleBossScan(true);
    }, 300);
  }

  function extractJobInfo(element) {
    try {
      var sensorsdata = element.getAttribute('sensorsdata');
      if (!sensorsdata) {
        return null;
      }
      var data = JSON.parse(sensorsdata);
      return {
        jobId: data.jobId,
        jobTime: data.jobTime,
        jobYear: data.jobYear,
        jobDegree: data.jobDegree
      };
    } catch (error) {
      return null;
    }
  }

  function extract51jobCompanyName(element) {
    var cnameElement = element.querySelector('.cname');
    if (!cnameElement) {
      return '';
    }
    return cleanText(cnameElement.textContent);
  }

  function build51jobListSignature(jobElements) {
    return Array.prototype.map.call(jobElements, function (element) {
      var info = extractJobInfo(element);
      return info && info.jobId ? info.jobId : '';
    }).filter(Boolean).join('|');
  }

  function create51jobResultDecoration(result) {
    var wrap = document.createElement('span');
    wrap.className = 'kxb-company-badge';
    wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:8px;border-radius:999px;font-size:13px;cursor:default;vertical-align:middle;';
    wrap.textContent = result.found ? '⚠️' : '✅';
    wrap.style.background = result.found ? '#fee2e2' : '#dcfce7';
    wrap.style.color = result.found ? '#b91c1c' : '#15803d';
    if (result.found && result.tags && result.tags.length) {
      wrap.title = result.tags.join(' / ');
    } else {
      wrap.title = result.found ? '命中黑名单' : '未命中';
    }
    return wrap;
  }

  function ensure51jobSearchTags(jobElement, result) {
    if (!result.found || !result.tags || !result.tags.length) {
      return;
    }
    if (jobElement.querySelector('.kxb-51job-tags')) {
      return;
    }
    var anchor = jobElement.querySelector('.el, .er');
    if (!anchor || !anchor.parentNode) {
      return;
    }
    var tagsWrap = document.createElement('div');
    tagsWrap.className = 'kxb-51job-tags';
    tagsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:flex-start;max-width:220px;margin-left:12px;';
    tagsWrap.title = result.tags.join(' / ');
    result.tags.forEach(function (tag) {
      var item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:#fff1f2;color:#be123c;font-size:12px;line-height:1.2;white-space:nowrap;';
      item.textContent = tag;
      tagsWrap.appendChild(item);
    });
    anchor.parentNode.appendChild(tagsWrap);
  }

  function process51jobCompanyTitle() {
    if (!canQuery() || location.host.indexOf('jobs.51job.com') === -1 || location.pathname.indexOf('/all/co') === -1) {
      return;
    }
    var titleNode = document.querySelector('h1');
    if (!titleNode || titleNode.querySelector('.kxb-company-badge')) {
      return;
    }
    var companyName = cleanText(titleNode.textContent || titleNode.innerText || '');
    if (!companyName) {
      return;
    }
    queryCompany(companyName).then(function (result) {
      if (titleNode.querySelector('.kxb-company-badge')) {
        return;
      }
      titleNode.style.display = 'flex';
      titleNode.style.alignItems = 'center';
      titleNode.style.flexWrap = 'wrap';
      var badgeNode = create51jobResultDecoration(result);
      badgeNode.style.marginLeft = '10px';
      titleNode.appendChild(badgeNode);
    }).catch(function () {
      return null;
    });
  }

  function badge(text, background) {
    return '<span style="display:inline-block;margin-right:6px;padding:3px 8px;border-radius:999px;background:' + background + ';color:#fff;font-size:12px;">' + text + '</span>';
  }

  function formatJobTime(timeStr) {
    if (!timeStr) {
      return '';
    }
    var date = new Date(timeStr);
    if (isNaN(date.getTime())) {
      return timeStr;
    }
    var diffHours = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60));
    if (diffHours < 24) {
      return badge(date.toLocaleDateString(), '#ef4444');
    }
    if (diffHours < 72) {
      return badge(date.toLocaleDateString(), '#f59e0b');
    }
    return badge(Math.floor(diffHours / 24) + '天前', '#94a3b8');
  }

  function process51jobJobCard(jobElement) {
    if (!canQuery()) {
      return;
    }
    var jobInfo = extractJobInfo(jobElement);
    if (!jobInfo || processedJobs[jobInfo.jobId]) {
      return;
    }
    processedJobs[jobInfo.jobId] = true;

    var titleNode = jobElement.querySelector('.jname');
    if (!titleNode) {
      return;
    }

    if (!jobElement.querySelector('.kxb-job-meta')) {
      var metaNode = document.createElement('div');
      metaNode.className = 'kxb-job-meta';
      metaNode.style.display = 'inline-block';
      metaNode.style.marginLeft = '12px';
      metaNode.innerHTML = [
        formatJobTime(jobInfo.jobTime),
        jobInfo.jobDegree ? badge(jobInfo.jobDegree, '#3b82f6') : '',
        jobInfo.jobYear ? badge(jobInfo.jobYear, '#8b5cf6') : ''
      ].join('');
      titleNode.parentNode.insertBefore(metaNode, titleNode.nextSibling);
    }

    var companyName = extract51jobCompanyName(jobElement);
    var cnameElement = jobElement.querySelector('.cname');
    if (!companyName || !cnameElement || jobElement.querySelector('.kxb-company-badge')) {
      return;
    }

    queryCompany(companyName).then(function (result) {
      if (jobElement.querySelector('.kxb-company-badge')) {
        return;
      }
      var badgeWrap = create51jobResultDecoration(result);
      cnameElement.parentNode.insertBefore(badgeWrap, cnameElement.nextSibling);
      ensure51jobSearchTags(jobElement, result);
    }).catch(function () {
      processedJobs[jobInfo.jobId] = false;
    });
  }

  function scan51jobJobCards() {
    if (!canQuery()) {
      return;
    }
    var jobElements = document.querySelectorAll('[sensorsname="JobShortExposure"]');
    var nextSignature = build51jobListSignature(jobElements);
    if (nextSignature !== last51jobListSignature) {
      processedJobs = {};
      last51jobListSignature = nextSignature;
      document.querySelectorAll('.kxb-company-badge, .kxb-51job-tags').forEach(function (node) {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      });
    }
    jobElements.forEach(function (element) {
      process51jobJobCard(element);
    });
  }

  function schedule51jobScan(force) {
    if (jobScanTimer && !force) {
      return;
    }
    if (jobScanTimer) {
      clearTimeout(jobScanTimer);
    }
    jobScanTimer = setTimeout(function () {
      jobScanTimer = null;
      process51jobCompanyTitle();
      scan51jobJobCards();
    }, force ? 0 : 180);
  }

  function get51jobObserveRoot() {
    return document.querySelector('[class*="joblist"], .joblist, .joblist-wrapper, .search-result, .joblist-container, #app') || document.body;
  }

  function start51jobFeatures() {
    if (jobObserver) {
      jobObserver.disconnect();
    }
    schedule51jobScan(true);
    jobObserver = new MutationObserver(function () {
      schedule51jobScan();
    });
    jobObserver.observe(get51jobObserveRoot(), {
      childList: true,
      subtree: true
    });
    setTimeout(function () {
      schedule51jobScan(true);
    }, 300);
  }

  function refreshAll() {
    cache = {};
    inflight = {};
    processedJobs = {};
    last51jobListSignature = '';
    if (jobScanTimer) {
      clearTimeout(jobScanTimer);
      jobScanTimer = null;
    }

    document.querySelectorAll('.kxb-job-meta, .kxb-company-badge, .kxb-blacklist-entry, .kxb-tags-entry, .kxb-51job-tags, .kxb-boss-tags, .kxb-boss-tag-item').forEach(function (node) {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });

    document.querySelectorAll('[data-kxb-boss-processed], [data-kxbBossProcessed]').forEach(function (node) {
      try {
        node.removeAttribute('data-kxb-boss-processed');
        node.removeAttribute('data-kxbBossProcessed');
      } catch (error) {}
      if (node.dataset && Object.prototype.hasOwnProperty.call(node.dataset, 'kxbBossProcessed')) {
        node.dataset.kxbBossProcessed = '';
      }
    });

    renderPanelState();
    startActiveFeatures();
  }

  function clearKickTimers() {
    kickTimers.forEach(function (timerId) {
      clearTimeout(timerId);
    });
    kickTimers = [];
  }

  function kickAutoQuery() {
    if (!canAutoScan() || autoQueryStarted) {
      return;
    }
    autoQueryStarted = true;
    clearKickTimers();
    kickTimers.push(setTimeout(function () {
      if (canAutoScan()) {
        startActiveFeatures();
      }
    }, 0));
  }

  function startActiveFeatures() {
    if (isBOSS) {
      startBossFeatures();
    }
    if (is51job) {
      start51jobFeatures();
    }
  }

  function enableDrag(element, handle) {
    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;
    var frameId = 0;
    var nextLeft = 0;
    var nextTop = 0;

    handle.addEventListener('mousedown', function (event) {
      if (event.target.closest('button, input, textarea, a')) {
        return;
      }
      var rect = element.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.left = rect.left + 'px';
      element.style.top = rect.top + 'px';
      element.style.transform = 'translate3d(0,0,0)';
      nextLeft = rect.left;
      nextTop = rect.top;
      event.preventDefault();
    });

    document.addEventListener('mousemove', function (event) {
      if (!dragging) {
        return;
      }
      nextLeft = Math.max(0, Math.min(window.innerWidth - 120, event.clientX - offsetX));
      nextTop = Math.max(0, Math.min(window.innerHeight - 120, event.clientY - offsetY));
      if (frameId) {
        return;
      }
      frameId = window.requestAnimationFrame(function () {
        frameId = 0;
        element.style.left = nextLeft + 'px';
        element.style.top = nextTop + 'px';
      });
    });

    document.addEventListener('mouseup', function () {
      dragging = false;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
    });
  }

  function bootstrap() {
    createPanel();
    autoQueryStarted = false;
    loadNotices();
    syncSession().then(function (state) {
      if (state.tokenBound) {
        setPanelMessage('会话已恢复，正在开始扫描...');
        setPanelTip('');
      } else {
        setPanelMessage(syncTokenStatusFeedback(state) || '会话已恢复，请先绑定卡密');
      }
    }).catch(function (error) {
      if (isSessionErrorMessage(error && error.message)) {
        clearState();
      }
      renderPanelState();
    }).finally(function () {
      if (canAutoScan()) {
        kickAutoQuery();
        return;
      }
      refreshAll();
    });
  }

  GM_registerMenuCommand('打开 Black list panel', function () {
    createPanel();
    savePanelCollapsedState(false);
    syncCollapseState();
  });

  GM_registerMenuCommand('打开官网', function () {
    window.open(CONFIG.siteUrl, '_blank', 'noopener,noreferrer');
  });

  GM_registerMenuCommand('价格页面', function () {
    window.open(CONFIG.pricingUrl, '_blank', 'noopener,noreferrer');
  });

  if (document.body) {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap);
  }
})();
