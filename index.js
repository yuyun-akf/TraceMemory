import {
  HIDDEN_MARKER,
  MODES,
  MODULE_ID,
  PROMPT_KEY,
  STATE_KEY,
  addPending,
  applyMemoryPayload,
  buildArchivePrompt,
  buildBackgroundTurnPrompt,
  buildInlinePrompt,
  buildMemoryProjection,
  chooseHideRange,
  clearReview,
  commitArchive,
  contiguousRanges,
  createState,
  detectMemoryDrift,
  discardUnarchivedSources,
  editableMemoryRecords,
  hashText,
  isEligibleAssistantMessage,
  markNeedsReview,
  migrateState,
  normalizeSettings,
  parseLooseJson,
  shouldSkipGenerationType,
  sourceIdentity,
  stateStats,
  stripMemoryPacket,
  updateMemoryRecord,
} from './src/core.mjs';

const VERSION = '0.1.0-alpha.2';
const PANEL_ID = 'trace-memory-settings';
const MESSAGE_PANEL_CLASS = 'trace-memory-message-panel';
const CUSTOM_STYLE_ID = 'trace-memory-custom-message-style';
const INSTANCE_KEY = '__traceMemoryExtensionV1';
const IN_CHAT_PROMPT_POSITION = 1;
const SYSTEM_PROMPT_ROLE = 0;

let initialized = false;
let active = true;
let processingMessage = false;
let backgroundBusy = false;
let hideBusy = false;
let lastGenerationType = '';
let listeners = [];
let initializeTimer = null;
let cardConflictCache = new WeakMap();
let memoryEditBusy = false;
let chatTokenCounter = 0;
let chatTokens = new WeakMap();

function getContext() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function notify(level, message) {
  const ctx = getContext();
  const settings = ctx ? getSettings(ctx, false) : normalizeSettings();
  if (!settings.showToasts && level !== 'error') return;
  const toast = globalThis.toastr?.[level];
  if (typeof toast === 'function') toast(message, '留痕记忆');
  else if (level === 'error') console.error(`[${MODULE_ID}] ${message}`);
  else console.info(`[${MODULE_ID}] ${message}`);
}

function sameJson(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getSettings(ctx, persist = true) {
  if (!ctx?.extensionSettings || typeof ctx.extensionSettings !== 'object') return normalizeSettings();
  const previous = ctx.extensionSettings[MODULE_ID] ?? {};
  const normalized = normalizeSettings(previous);
  if (!sameJson(previous, normalized)) {
    ctx.extensionSettings[MODULE_ID] = normalized;
    if (persist) ctx.saveSettingsDebounced?.();
  }
  return ctx.extensionSettings[MODULE_ID];
}

function updateSettings(ctx, patch) {
  const current = getSettings(ctx, false);
  ctx.extensionSettings[MODULE_ID] = normalizeSettings({ ...current, ...patch });
  ctx.saveSettingsDebounced?.();
  return ctx.extensionSettings[MODULE_ID];
}

function isSoloChat(ctx) {
  return Array.isArray(ctx?.chat) && !ctx?.groupId && ctx?.characterId !== undefined && ctx?.characterId !== null;
}

function hasChatStorage(ctx) {
  return ctx?.chatMetadata && typeof ctx.chatMetadata === 'object' && typeof ctx.saveMetadata === 'function';
}

function captureChatBinding(ctx) {
  return {
    chat: ctx?.chat,
    metadata: ctx?.chatMetadata,
    characterId: ctx?.characterId,
    groupId: ctx?.groupId ?? null,
  };
}

function isCurrentChatBinding(binding) {
  const current = getContext();
  return Boolean(
    current
    && current.chat === binding.chat
    && current.chatMetadata === binding.metadata
    && current.characterId === binding.characterId
    && (current.groupId ?? null) === binding.groupId,
  );
}

function assertCurrentChatBinding(binding) {
  if (!isCurrentChatBinding(binding)) throw new Error('操作期间聊天已切换；本次异步结果已丢弃，没有写入其他聊天');
}

function chatBindingToken(ctx) {
  const metadata = ctx?.chatMetadata;
  if (!metadata || typeof metadata !== 'object') return '';
  if (!chatTokens.has(metadata)) chatTokens.set(metadata, `${ctx?.characterId ?? 'unknown'}:${++chatTokenCounter}`);
  return chatTokens.get(metadata);
}

function getState(ctx, create = true) {
  if (!isSoloChat(ctx) || !hasChatStorage(ctx)) return null;
  const settings = getSettings(ctx);
  const existing = ctx.chatMetadata[STATE_KEY];
  if (!existing && !create) return null;
  const migrated = existing ? migrateState(existing, settings) : createState(settings);
  if (!existing) {
    migrated.captureStart = Math.max(1, ctx.chat.length);
    migrated.hidden.through = migrated.captureStart - 1;
  }
  if (!sameJson(existing, migrated)) ctx.chatMetadata[STATE_KEY] = migrated;
  return ctx.chatMetadata[STATE_KEY];
}

async function saveState(ctx) {
  if (typeof ctx?.saveMetadata !== 'function') throw new Error('当前宿主缺少 saveMetadata，无法安全保存记忆');
  await ctx.saveMetadata();
}

function messageSaveFunction(ctx) {
  for (const name of ['saveChat', 'saveChatConditional', 'saveChatDebounced']) {
    if (typeof ctx?.[name] === 'function') return { name, call: ctx[name].bind(ctx) };
  }
  return null;
}

function slashCommandFunction(ctx) {
  for (const name of ['executeSlashCommandsWithOptions', 'executeSlashCommands']) {
    if (typeof ctx?.[name] === 'function') return { name, call: ctx[name].bind(ctx) };
  }
  return null;
}

async function persistMessageChanges(ctx) {
  const saver = messageSaveFunction(ctx);
  if (!saver) throw new Error('当前宿主没有可识别的聊天保存函数；同轮模式已阻止，避免隐藏记忆包在重载后重新出现');
  await Promise.resolve(saver.call());
}

function characterName(ctx) {
  const character = ctx?.characters?.[ctx.characterId];
  return String(character?.name ?? character?.data?.name ?? ctx?.name2 ?? '{{char}}');
}

function possibleCardMemoryConflict(ctx) {
  const character = ctx?.characters?.[ctx.characterId];
  if (!character) return false;
  if (cardConflictCache.has(character)) return cardConflictCache.get(character);
  let text = '';
  try {
    text = JSON.stringify({
      description: character.description ?? character.data?.description,
      systemPrompt: character.system_prompt ?? character.data?.system_prompt,
      postHistory: character.post_history_instructions ?? character.data?.post_history_instructions,
      characterBook: character.character_book ?? character.data?.character_book,
      extensions: character.data?.extensions,
    });
  } catch {
    return false;
  }
  const result = /记忆区.{0,20}短期记忆|长期记忆与日记|每满\s*15\s*条.{0,20}归档|TraceMemoryUpdate/i.test(text);
  cardConflictCache.set(character, result);
  return result;
}

function clearPrompt(ctx = getContext()) {
  if (typeof ctx?.setExtensionPrompt !== 'function') return;
  ctx.setExtensionPrompt(PROMPT_KEY, '', IN_CHAT_PROMPT_POSITION, 0, false, SYSTEM_PROMPT_ROLE);
}

function continuityPrompt(state) {
  return `[留痕记忆｜连续性资料]\n${buildMemoryProjection(state)}\n\n仅将以上内容用于保持剧情连续；不得把记忆标签、归档机制或角色未知信息写进正文，不得据此补造user未表达的动机与心理。`;
}

function preflight(ctx = getContext()) {
  const symbols = [];
  const observe = (symbol, condition) => {
    if (condition) symbols.push(symbol);
    return Boolean(condition);
  };
  const checks = {
    context: observe('SillyTavern.getContext', Boolean(ctx)),
    chatMetadata: observe('SillyTavern.getContext.chatMetadata', Boolean(ctx?.chatMetadata && typeof ctx.chatMetadata === 'object')),
    saveMetadata: observe('SillyTavern.getContext.saveMetadata', typeof ctx?.saveMetadata === 'function'),
    setExtensionPrompt: observe('SillyTavern.getContext.setExtensionPrompt', typeof ctx?.setExtensionPrompt === 'function'),
    generateQuietPrompt: observe('SillyTavern.getContext.generateQuietPrompt', typeof ctx?.generateQuietPrompt === 'function'),
    executeSlashCommandsWithOptions: observe('SillyTavern.getContext.executeSlashCommandsWithOptions', typeof ctx?.executeSlashCommandsWithOptions === 'function'),
    executeSlashCommands: observe('SillyTavern.getContext.executeSlashCommands', typeof ctx?.executeSlashCommands === 'function'),
    persistMessage: Boolean(messageSaveFunction(ctx)),
    eventSource: observe('SillyTavern.getContext.eventSource', Boolean(ctx?.eventSource && typeof ctx.eventSource.on === 'function')),
    eventTypes: observe('SillyTavern.getContext.event_types', Boolean(ctx?.event_types && typeof ctx.event_types === 'object')),
    messageDom: observe('SillyTavern DOM #chat with .mes message nodes', typeof document !== 'undefined' && Boolean(document.querySelector('#chat'))),
    soloChat: isSoloChat(ctx),
    possibleCardMemoryConflict: possibleCardMemoryConflict(ctx),
  };
  if (checks.persistMessage) {
    symbols.push(`SillyTavern.getContext.${messageSaveFunction(ctx).name}`);
    symbols.push('TraceMemory.messageSaveAdapter');
  }
  if (slashCommandFunction(ctx)) symbols.push('TraceMemory.slashCommandAdapter');
  return {
    schemaVersion: 1,
    extension: { id: MODULE_ID, version: VERSION },
    capturedAt: new Date().toISOString(),
    versions: {
      sillytavern: String(ctx?.version ?? globalThis.SillyTavern?.version ?? 'unknown'),
      tavernHelper: String(globalThis.TavernHelper?.version ?? 'unknown'),
    },
    symbols,
    checks,
    readiness: {
      core: checks.context && checks.chatMetadata && checks.saveMetadata && checks.setExtensionPrompt && checks.eventSource && checks.eventTypes,
      inline: checks.persistMessage,
      background: checks.generateQuietPrompt,
      autoHide: Boolean(slashCommandFunction(ctx)),
      messageMemory: checks.messageDom,
    },
    notes: [
      '通过自检只代表接口名称存在；实机行为仍需跑一轮验证。',
      '群聊在0.1版只保留结构，不启用写入或自动隐藏。',
    ],
  };
}

function modeCapabilityError(mode, report = preflight()) {
  if ((mode === MODES.BACKGROUND || mode === MODES.HYBRID) && !report.readiness.background) {
    return '当前宿主未检测到后台生成接口，不能启用这个模式';
  }
  if ((mode === MODES.INLINE || mode === MODES.HYBRID) && !report.readiness.inline) {
    return '当前宿主未检测到聊天保存接口，不能安全启用同轮模式';
  }
  return '';
}

function panelHtml() {
  return `
    <div id="${PANEL_ID}" data-extension-id="${MODULE_ID}" class="trace-memory-panel">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>留痕记忆 <small>TraceMemory ${VERSION}</small></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content trace-memory-content">
          <p class="trace-memory-lead">记忆跟聊天走，不要求角色卡自带MVU。自动隐藏只处理已成功归档、且由本扩展登记的楼层。</p>
          <section class="trace-memory-section">
            <div class="trace-memory-row trace-memory-row--switch"><label for="trace-memory-current-enabled"><b>当前聊天启用</b></label><input id="trace-memory-current-enabled" type="checkbox"></div>
            <label for="trace-memory-mode">当前聊天模式</label>
            <select id="trace-memory-mode" class="text_pole"><option value="inline">同轮随写 · 0额外调用</option><option value="background">后台总结 · 每轮1次额外调用</option><option value="hybrid">混合归档 · 同轮短记忆，满批后台归档</option></select>
          </section>
          <section class="trace-memory-section trace-memory-grid">
            <label>每批条数<input id="trace-memory-batch-size" class="text_pole" type="number" min="3" max="50" inputmode="numeric"></label>
            <label>保留最近消息<input id="trace-memory-keep-visible" class="text_pole" type="number" min="2" max="50" inputmode="numeric"></label>
            <label class="trace-memory-check"><input id="trace-memory-auto-hide" type="checkbox"> 自动隐藏已归档楼层</label>
            <label class="trace-memory-check"><input id="trace-memory-collapse-hidden" type="checkbox"> 页面内折叠本扩展隐藏楼层</label>
            <label class="trace-memory-check"><input id="trace-memory-show-message-memory" type="checkbox"> 在对应正文下显示记忆折叠栏</label>
          </section>
          <section class="trace-memory-section">
            <div class="trace-memory-row trace-memory-row--switch"><label for="trace-memory-default-enabled">新聊天默认启用</label><input id="trace-memory-default-enabled" type="checkbox"></div>
            <label for="trace-memory-default-mode">新聊天默认模式</label>
            <select id="trace-memory-default-mode" class="text_pole"><option value="inline">同轮随写</option><option value="background">后台总结</option><option value="hybrid">混合归档</option></select>
            <label class="trace-memory-check trace-memory-default-message-toggle"><input id="trace-memory-default-show-message-memory" type="checkbox"> 新聊天默认显示正文记忆栏</label>
          </section>
          <div id="trace-memory-status" class="trace-memory-status" role="status"></div>
          <div class="trace-memory-actions">
            <button id="trace-memory-preflight" class="menu_button">环境自检</button><button id="trace-memory-repair-last" class="menu_button">补写漏记（额外调用）</button><button id="trace-memory-archive-now" class="menu_button">归档到期批次</button><button id="trace-memory-restore-hidden" class="menu_button">恢复本扩展隐藏楼层</button><button id="trace-memory-export" class="menu_button">导出当前记忆</button><button id="trace-memory-reset" class="menu_button trace-memory-danger">重置当前聊天记忆</button>
          </div>
          <details id="trace-memory-editor-details" class="trace-memory-details"><summary>记忆编辑器</summary><div id="trace-memory-editor" class="trace-memory-editor"></div></details>
          <details class="trace-memory-details"><summary>正文折叠栏美化</summary>
            <div class="trace-memory-style-editor">
              <p>已自带简洁样式。需要自定义时，可在下面填写 CSS；建议只使用 <code>.trace-memory-message-panel</code> 开头的选择器。</p>
              <textarea id="trace-memory-custom-css" class="text_pole" rows="7" spellcheck="false" placeholder=".trace-memory-message-panel {\n  --tm-accent: #b99a7a;\n  --tm-radius: 10px;\n}"></textarea>
              <div class="trace-memory-style-actions"><button id="trace-memory-apply-css" class="menu_button" type="button">应用自定义样式</button><button id="trace-memory-reset-css" class="menu_button" type="button">恢复默认样式</button></div>
            </div>
          </details>
          <details class="trace-memory-details"><summary>环境报告</summary><pre id="trace-memory-preflight-output">尚未运行</pre></details>
        </div>
      </div>
    </div>`;
}

function byId(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function mountPanel() {
  if (typeof document === 'undefined') return false;
  if (byId(PANEL_ID)) return true;
  const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
  if (!host) return false;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = panelHtml().trim();
  host.append(wrapper.firstElementChild);
  bindPanelActions();
  refreshPanel();
  return true;
}

function setDisabled(id, disabled) {
  const element = byId(id);
  if (element) element.disabled = disabled;
}

function normalizeCustomCss(value) {
  const css = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (css.length > 20000) throw new Error('自定义样式最多20000字');
  if (/@import\b|url\s*\(|expression\s*\(|javascript\s*:|-moz-binding\b|behavior\s*:/i.test(css)) {
    throw new Error('自定义样式不能包含外部资源、脚本式表达式或浏览器行为规则');
  }
  return css;
}

function applyCustomMessageCss(settingsInput = null) {
  if (typeof document === 'undefined') return;
  const ctx = getContext();
  const settings = settingsInput ?? (ctx ? getSettings(ctx, false) : normalizeSettings());
  let css = '';
  try {
    css = normalizeCustomCss(settings.customMessageCss ?? '');
  } catch {
    byId(CUSTOM_STYLE_ID)?.remove();
    return;
  }
  let style = byId(CUSTOM_STYLE_ID);
  if (!css.trim()) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    document.head?.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function createMemoryRecordEditor(descriptor, compact = false, chatToken = '') {
  const form = document.createElement('form');
  form.className = `trace-memory-record-editor${compact ? ' trace-memory-record-editor--compact' : ''}`;
  form.dataset.recordLocator = JSON.stringify(descriptor.locator);
  form.dataset.dirty = 'false';
  form.dataset.chatToken = chatToken;

  const header = document.createElement('div');
  header.className = 'trace-memory-record-header';
  const title = document.createElement('strong');
  title.textContent = descriptor.title;
  header.append(title);
  if (descriptor.subtitle) {
    const subtitle = document.createElement('span');
    subtitle.textContent = descriptor.subtitle;
    header.append(subtitle);
  }
  form.append(header);

  for (const field of descriptor.fields) {
    const label = document.createElement('label');
    label.className = 'trace-memory-record-field';
    const caption = document.createElement('span');
    caption.textContent = field.label;
    label.append(caption);
    let control;
    if (Array.isArray(field.options)) {
      control = document.createElement('select');
      for (const optionValue of field.options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        control.append(option);
      }
      control.value = field.value;
    } else if (field.multiline) {
      control = document.createElement('textarea');
      control.rows = compact ? (field.name === 'text' ? 2 : 3) : (field.name === 'text' ? 3 : 5);
    } else {
      control = document.createElement('input');
      control.type = 'text';
    }
    control.classList.add('text_pole');
    control.dataset.memoryField = field.name;
    control.value = field.value;
    if (field.maximum) control.maxLength = field.maximum;
    label.append(control);
    form.append(label);
  }

  const actions = document.createElement('div');
  actions.className = 'trace-memory-record-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'menu_button';
  save.textContent = '保存修改';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'menu_button';
  cancel.textContent = '放弃未保存';
  const hint = document.createElement('span');
  hint.textContent = '保存后两处同步';
  actions.append(save, cancel, hint);
  form.append(actions);

  form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
  form.addEventListener('change', () => { form.dataset.dirty = 'true'; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveMemoryRecordForm(form).catch(error => notify('error', error.message));
  });
  cancel.addEventListener('click', () => {
    form.dataset.dirty = 'false';
    const container = form.parentElement;
    if (container) delete container.dataset.renderKey;
    refreshPanel();
  });
  return form;
}

async function saveMemoryRecordForm(form) {
  if (memoryEditBusy) throw new Error('上一条记忆仍在保存，请稍等');
  const ctx = getContext();
  if (!form.dataset.chatToken || form.dataset.chatToken !== chatBindingToken(ctx)) {
    throw new Error('聊天已经切换，这个编辑框属于上一段聊天；请在当前聊天重新打开记忆编辑器');
  }
  const current = getState(ctx, false);
  if (!current) throw new Error('当前没有可编辑的单人聊天记忆');
  const binding = captureChatBinding(ctx);
  const previous = ctx.chatMetadata[STATE_KEY];
  const draft = migrateState(previous, getSettings(ctx, false));
  let locator;
  try {
    locator = JSON.parse(form.dataset.recordLocator ?? '');
  } catch {
    throw new Error('记忆记录定位信息损坏，请重新打开面板');
  }
  const patch = {};
  for (const control of form.querySelectorAll('[data-memory-field]')) patch[control.dataset.memoryField] = control.value;
  updateMemoryRecord(draft, locator, patch);
  assertCurrentChatBinding(binding);

  const button = form.querySelector('button[type="submit"]');
  memoryEditBusy = true;
  if (button) button.disabled = true;
  ctx.chatMetadata[STATE_KEY] = draft;
  try {
    await saveState(ctx);
    form.dataset.dirty = 'false';
    notify('success', '记忆修改已同步');
  } catch (error) {
    ctx.chatMetadata[STATE_KEY] = previous;
    throw error;
  } finally {
    memoryEditBusy = false;
    if (button) button.disabled = false;
    refreshPanel();
  }
}

function renderRecordList(container, descriptors, options = {}) {
  if (!container) return;
  const chatToken = String(options.chatToken ?? '');
  if (container.dataset.chatToken === chatToken && container.querySelector('[data-dirty="true"]')) return;
  const renderKey = hashText(JSON.stringify({ descriptors, notice: options.notice ?? '', intro: options.intro ?? '', chatToken }));
  if (container.dataset.renderKey === renderKey) return;
  const fragment = document.createDocumentFragment();
  if (options.intro) {
    const intro = document.createElement('p');
    intro.className = 'trace-memory-editor-intro';
    intro.textContent = options.intro;
    fragment.append(intro);
  }
  if (options.notice) {
    const notice = document.createElement('p');
    notice.className = 'trace-memory-record-notice';
    notice.textContent = options.notice;
    fragment.append(notice);
  }
  if (!descriptors.length) {
    const empty = document.createElement('p');
    empty.className = 'trace-memory-editor-empty';
    empty.textContent = options.emptyText ?? '当前还没有可编辑的记忆记录。';
    fragment.append(empty);
  } else {
    let previousSection = '';
    for (const descriptor of descriptors) {
      if (!options.compact && descriptor.section !== previousSection) {
        const heading = document.createElement('h4');
        heading.textContent = descriptor.section;
        fragment.append(heading);
        previousSection = descriptor.section;
      }
      fragment.append(createMemoryRecordEditor(descriptor, Boolean(options.compact), chatToken));
    }
  }
  container.replaceChildren(fragment);
  container.dataset.renderKey = renderKey;
  container.dataset.chatToken = chatToken;
}

function renderBackendMemoryEditor(state) {
  const details = byId('trace-memory-editor-details');
  const container = byId('trace-memory-editor');
  if (!container || !details?.open) return;
  const descriptors = editableMemoryRecords(state);
  const notice = state?.pending?.length
    ? `另有${state.pending.length}条待补写：${state.pending.map(item => `第${item.messageIndex}楼`).join('、')}`
    : (state?.needsReview ? `当前有源消息变更锁：${state.reviewReason}` : '');
  renderRecordList(container, descriptors, {
    chatToken: chatBindingToken(getContext()),
    intro: '这里与正文下方折叠栏读取同一份聊天记忆；任意一边保存，另一边会同步刷新。',
    notice,
    emptyText: state ? '当前还没有可编辑的记忆记录。' : '当前没有可用的单人角色聊天。',
  });
}

function findMessageNode(messageIndex) {
  if (typeof document === 'undefined') return null;
  return document.querySelector(`.mes[mesid="${messageIndex}"]`)
    ?? document.querySelector(`.mes[data-message-id="${messageIndex}"]`);
}

function removeMessageMemoryPanels() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`.${MESSAGE_PANEL_CLASS}`).forEach(node => node.remove());
}

function syncMessageMemoryPanels(ctx, state) {
  if (typeof document === 'undefined') return;
  if (!state?.config.showMessageMemory || !Array.isArray(ctx?.chat) || ctx?.groupId) {
    removeMessageMemoryPanels();
    return;
  }

  const descriptorsByMessage = new Map();
  for (const descriptor of editableMemoryRecords(state)) {
    for (const messageIndex of descriptor.messageIndices) {
      if (!isEligibleAssistantMessage(ctx.chat[messageIndex])) continue;
      const rows = descriptorsByMessage.get(messageIndex) ?? [];
      rows.push(descriptor);
      descriptorsByMessage.set(messageIndex, rows);
    }
  }
  const pendingByMessage = new Map();
  for (const pending of state.pending ?? []) {
    if (Number.isInteger(pending?.messageIndex) && isEligibleAssistantMessage(ctx.chat[pending.messageIndex])) {
      pendingByMessage.set(pending.messageIndex, pending);
    }
  }
  const relevant = new Set([...descriptorsByMessage.keys(), ...pendingByMessage.keys()]);

  for (const panel of document.querySelectorAll(`.${MESSAGE_PANEL_CLASS}`)) {
    const messageIndex = Number.parseInt(panel.dataset.messageIndex, 10);
    if (!relevant.has(messageIndex) || !findMessageNode(messageIndex)?.contains(panel)) panel.remove();
  }

  for (const messageIndex of [...relevant].sort((left, right) => left - right)) {
    const messageNode = findMessageNode(messageIndex);
    if (!messageNode) continue;
    let panel = messageNode.querySelector(`.${MESSAGE_PANEL_CLASS}[data-message-index="${messageIndex}"]`);
    if (!panel) {
      panel = document.createElement('details');
      panel.className = MESSAGE_PANEL_CLASS;
      panel.dataset.messageIndex = String(messageIndex);
      const summary = document.createElement('summary');
      const content = document.createElement('div');
      content.className = 'trace-memory-message-content';
      panel.append(summary, content);
      const messageText = messageNode.querySelector('.mes_text');
      if (messageText) messageText.insertAdjacentElement('afterend', panel);
      else (messageNode.querySelector('.mes_block') ?? messageNode).append(panel);
    }
    const descriptors = descriptorsByMessage.get(messageIndex) ?? [];
    const pending = pendingByMessage.get(messageIndex);
    const labels = [...new Set(descriptors.map(item => item.section))];
    const summary = panel.firstElementChild;
    if (summary) summary.textContent = `留痕记忆${labels.length ? ` · ${labels.join(' / ')}` : ' · 待补写'}`;
    const notice = pending ? `这轮记忆待补写：${pending.reason}` : '';
    renderRecordList(panel.querySelector('.trace-memory-message-content'), descriptors, {
      chatToken: chatBindingToken(ctx),
      compact: true,
      notice,
      emptyText: '本轮暂时没有可编辑的记忆。',
    });
  }
}

function refreshPanel() {
  if (typeof document === 'undefined') return;
  const ctx = getContext();
  const settings = ctx ? getSettings(ctx) : normalizeSettings();
  const state = ctx ? getState(ctx, false) : null;
  const report = preflight(ctx);
  const supported = Boolean(state);
  const assign = (id, property, value) => { const element = byId(id); if (element) element[property] = value; };
  assign('trace-memory-current-enabled', 'checked', state?.enabled ?? false);
  assign('trace-memory-mode', 'value', state?.mode ?? settings.defaultMode);
  assign('trace-memory-batch-size', 'value', state?.config.batchSize ?? settings.batchSize);
  assign('trace-memory-keep-visible', 'value', state?.config.keepVisible ?? settings.keepVisible);
  assign('trace-memory-auto-hide', 'checked', state?.config.autoHide ?? settings.autoHide);
  assign('trace-memory-collapse-hidden', 'checked', state?.config.collapseOwnedHidden ?? settings.collapseOwnedHidden);
  assign('trace-memory-show-message-memory', 'checked', state?.config.showMessageMemory ?? settings.showMessageMemory);
  assign('trace-memory-default-enabled', 'checked', settings.defaultEnabled);
  assign('trace-memory-default-mode', 'value', settings.defaultMode);
  assign('trace-memory-default-show-message-memory', 'checked', settings.showMessageMemory);
  for (const id of ['trace-memory-current-enabled', 'trace-memory-mode', 'trace-memory-batch-size', 'trace-memory-keep-visible', 'trace-memory-auto-hide', 'trace-memory-collapse-hidden', 'trace-memory-show-message-memory']) setDisabled(id, !supported);
  setDisabled('trace-memory-repair-last', !supported || !report.readiness.background || !state?.pending.length);
  setDisabled('trace-memory-archive-now', !supported || !report.readiness.background || !state?.archiveDue);
  setDisabled('trace-memory-restore-hidden', !supported || !report.readiness.autoHide || !ownedHiddenIndices(ctx).length);
  setDisabled('trace-memory-export', !supported);
  setDisabled('trace-memory-reset', !supported);
  const status = byId('trace-memory-status');
  if (status) {
    if (!ctx) status.textContent = '宿主上下文尚未就绪。';
    else if (ctx.groupId) status.textContent = '0.1版暂不在群聊写入记忆；不会隐藏任何群聊消息。';
    else if (!supported) status.textContent = '请选择一个单人角色聊天后，扩展会自动初始化。';
    else {
      const stats = stateStats(state);
      const modeName = { inline: '同轮随写', background: '后台总结', hybrid: '混合归档' }[state.mode];
      const issues = [];
      if ((state.mode === MODES.INLINE || state.mode === MODES.HYBRID) && !report.readiness.inline) issues.push('同轮记忆缺少安全保存接口');
      if ((state.mode === MODES.BACKGROUND || state.mode === MODES.HYBRID) && !report.readiness.background) issues.push('后台调用接口不可用');
      if (state.config.autoHide && !report.readiness.autoHide) issues.push('自动隐藏接口不可用');
      if (state.config.showMessageMemory && !report.readiness.messageMemory) issues.push('未检测到聊天消息区域，正文记忆栏暂不显示');
      if (report.checks.possibleCardMemoryConflict) issues.push('卡内可能仍有另一套记忆规则，请确认已关闭对应词条');
      if (state.needsReview) issues.push(`源消息变更锁：${state.reviewReason}`);
      status.textContent = `${state.enabled ? '已启用' : '已暂停'}｜${modeName}｜短记忆 ${stats.short}/${stats.batchSize}｜归档 ${stats.archives}批｜隐藏 ${ownedHiddenIndices(ctx).length}条${issues.length ? `\n⚠ ${issues.join('；')}` : ''}`;
    }
  }
  const customCss = byId('trace-memory-custom-css');
  if (customCss && customCss.dataset.dirty !== 'true' && document.activeElement !== customCss) customCss.value = settings.customMessageCss;
  applyCustomMessageCss(settings);
  renderBackendMemoryEditor(state);
  syncMessageMemoryPanels(ctx, state);
  applyOwnedHiddenDom(ctx, state);
}

async function updateCurrentState(mutator) {
  const ctx = getContext();
  const state = getState(ctx);
  if (!state) return;
  mutator(state);
  await saveState(ctx);
  refreshPanel();
}

function bindPanelActions() {
  const onChange = (id, handler) => byId(id)?.addEventListener('change', event => { Promise.resolve(handler(event)).catch(error => notify('error', error.message)); });
  onChange('trace-memory-current-enabled', async event => {
    await updateCurrentState(state => { state.enabled = event.target.checked; });
    if (!event.target.checked) clearPrompt();
  });
  onChange('trace-memory-mode', async event => {
    const mode = event.target.value;
    const error = modeCapabilityError(mode);
    if (error) { refreshPanel(); throw new Error(error); }
    await updateCurrentState(state => { state.mode = mode; });
  });
  onChange('trace-memory-batch-size', event => updateCurrentState(state => { state.config.batchSize = Math.min(50, Math.max(3, Number.parseInt(event.target.value, 10) || 15)); state.archiveDue = state.short.length >= state.config.batchSize; }));
  onChange('trace-memory-keep-visible', event => updateCurrentState(state => { state.config.keepVisible = Math.min(50, Math.max(2, Number.parseInt(event.target.value, 10) || 6)); }));
  onChange('trace-memory-auto-hide', event => updateCurrentState(state => { state.config.autoHide = event.target.checked; }));
  onChange('trace-memory-collapse-hidden', event => updateCurrentState(state => { state.config.collapseOwnedHidden = event.target.checked; }));
  onChange('trace-memory-show-message-memory', event => updateCurrentState(state => { state.config.showMessageMemory = event.target.checked; }));
  onChange('trace-memory-default-enabled', event => { const ctx = getContext(); updateSettings(ctx, { defaultEnabled: event.target.checked }); refreshPanel(); });
  onChange('trace-memory-default-mode', event => {
    const error = modeCapabilityError(event.target.value);
    if (error) { refreshPanel(); throw new Error(error); }
    const ctx = getContext();
    updateSettings(ctx, { defaultMode: event.target.value });
    refreshPanel();
  });
  onChange('trace-memory-default-show-message-memory', event => {
    const ctx = getContext();
    updateSettings(ctx, { showMessageMemory: event.target.checked });
    refreshPanel();
  });
  byId('trace-memory-editor-details')?.addEventListener('toggle', refreshPanel);
  const customCss = byId('trace-memory-custom-css');
  customCss?.addEventListener('input', () => { customCss.dataset.dirty = 'true'; });
  byId('trace-memory-apply-css')?.addEventListener('click', () => {
    try {
      const ctx = getContext();
      const css = normalizeCustomCss(customCss?.value ?? '');
      const settings = updateSettings(ctx, { customMessageCss: css });
      if (customCss) customCss.dataset.dirty = 'false';
      applyCustomMessageCss(settings);
      notify('success', '正文记忆栏样式已应用');
      refreshPanel();
    } catch (error) {
      notify('error', error.message);
    }
  });
  byId('trace-memory-reset-css')?.addEventListener('click', () => {
    const ctx = getContext();
    const settings = updateSettings(ctx, { customMessageCss: '' });
    if (customCss) {
      customCss.value = '';
      customCss.dataset.dirty = 'false';
    }
    applyCustomMessageCss(settings);
    notify('success', '已恢复正文记忆栏默认样式');
    refreshPanel();
  });
  byId('trace-memory-preflight')?.addEventListener('click', () => { const output = byId('trace-memory-preflight-output'); if (output) output.textContent = JSON.stringify(preflight(), null, 2); });
  byId('trace-memory-repair-last')?.addEventListener('click', () => repairLastPending().catch(error => notify('error', error.message)));
  byId('trace-memory-archive-now')?.addEventListener('click', () => archiveDueBatch().catch(error => notify('error', error.message)));
  byId('trace-memory-restore-hidden')?.addEventListener('click', () => restoreOwnedHidden().catch(error => notify('error', error.message)));
  byId('trace-memory-export')?.addEventListener('click', exportCurrentMemory);
  byId('trace-memory-reset')?.addEventListener('click', () => resetCurrentMemory().catch(error => notify('error', error.message)));
}

function resolveAssistantIndex(ctx, args = []) {
  const candidates = [];
  for (const value of args) {
    if (Number.isInteger(value)) candidates.push(value);
    if (value && typeof value === 'object') for (const key of ['index', 'messageId', 'message_id', 'mesId']) if (Number.isInteger(value[key])) candidates.push(value[key]);
  }
  for (const index of candidates) if (isEligibleAssistantMessage(ctx.chat[index])) return index;
  for (let index = ctx.chat.length - 1; index >= 0; index -= 1) if (isEligibleAssistantMessage(ctx.chat[index])) return index;
  return -1;
}

function archivedSourceAtFloor(state, messageIndex) {
  for (const archive of state.archives) {
    const source = archive.sources?.find(item => item.messageIndex === messageIndex);
    if (source) return { archive, source };
  }
  return null;
}

function responseText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.message === 'string') return result.message;
  return String(result ?? '');
}

async function runBackgroundTurn(ctx, state, messageIndex) {
  if (backgroundBusy) return null;
  if (typeof ctx.generateQuietPrompt !== 'function') throw new Error('当前宿主不支持后台生成');
  const binding = captureChatBinding(ctx);
  backgroundBusy = true;
  try {
    clearPrompt(ctx);
    const result = await ctx.generateQuietPrompt({ quietPrompt: buildBackgroundTurnPrompt(state, ctx.chat, messageIndex, characterName(ctx)) });
    assertCurrentChatBinding(binding);
    const parsed = parseLooseJson(responseText(result));
    const message = ctx.chat[messageIndex];
    const source = sourceIdentity(message, messageIndex, ctx.chat);
    if (!parsed.value) {
      addPending(state, source, `后台记忆JSON解析失败：${parsed.error}`, message?.mes ?? '');
      await saveState(ctx);
      return null;
    }
    const applied = applyMemoryPayload(state, parsed.value, source);
    await saveState(ctx);
    if (applied.archive) await hideArchiveSafely(ctx, state, applied.archive);
    return applied;
  } finally {
    backgroundBusy = false;
    refreshPanel();
  }
}

async function runArchiveQuiet(ctx, state) {
  if (backgroundBusy) return null;
  if (!state.archiveDue || state.short.length < state.config.batchSize) return null;
  if (typeof ctx.generateQuietPrompt !== 'function') throw new Error('当前宿主不支持后台生成，无法补归档');
  const binding = captureChatBinding(ctx);
  backgroundBusy = true;
  try {
    clearPrompt(ctx);
    const result = await ctx.generateQuietPrompt({ quietPrompt: buildArchivePrompt(state, characterName(ctx)) });
    assertCurrentChatBinding(binding);
    const parsed = parseLooseJson(responseText(result));
    if (!parsed.value?.summary || !parsed.value?.diary) throw new Error(`归档JSON解析失败：${parsed.error ?? '缺少summary或diary'}`);
    const archive = commitArchive(state, parsed.value);
    if (!archive) throw new Error('短期记忆尚未达到归档门槛');
    await saveState(ctx);
    await hideArchiveSafely(ctx, state, archive);
    return archive;
  } finally {
    backgroundBusy = false;
    refreshPanel();
  }
}

async function handleMessageReceived(...args) {
  if (!active || processingMessage || backgroundBusy) return;
  const ctx = getContext();
  const state = getState(ctx, false);
  if (!state?.enabled || state.needsReview || shouldSkipGenerationType(lastGenerationType)) return;
  const messageIndex = resolveAssistantIndex(ctx, args);
  if (messageIndex < 0) return;
  const message = ctx.chat[messageIndex];
  const binding = captureChatBinding(ctx);
  processingMessage = true;
  try {
    const parsed = stripMemoryPacket(message.mes);
    if (parsed.found) {
      message.mes = parsed.cleanText;
      await persistMessageChanges(ctx);
      assertCurrentChatBinding(binding);
    }
    const source = sourceIdentity(message, messageIndex, ctx.chat);
    if (state.ledger[source.key] || state.runtime.lastProcessedSource === source.key) return;
    const archived = archivedSourceAtFloor(state, messageIndex);
    if (archived && (archived.source.fingerprint !== source.fingerprint || (archived.source.userFingerprint ?? '') !== source.userFingerprint || archived.source.swipeId !== source.swipeId)) {
      markNeedsReview(state, `第${messageIndex}楼已在第${archived.archive.batch}批归档后发生重roll、编辑或替换；已停止自动隐藏。`);
      await restoreOwnedHidden(ctx, state, false);
      await saveState(ctx);
      return;
    }
    if (state.mode === MODES.BACKGROUND) {
      await runBackgroundTurn(ctx, state, messageIndex);
      return;
    }
    if (!parsed.found || !parsed.payload) {
      addPending(state, source, parsed.error ?? '本轮未收到记忆包', message.mes);
      await saveState(ctx);
      return;
    }
    const applied = applyMemoryPayload(state, parsed.payload, source);
    await saveState(ctx);
    if (applied.archive) await hideArchiveSafely(ctx, state, applied.archive);
    else if (state.mode === MODES.HYBRID && state.archiveDue) await runArchiveQuiet(ctx, state);
  } catch (error) {
    if (isCurrentChatBinding(binding)) {
      const stateNow = getState(ctx, false);
      if (stateNow) { stateNow.runtime.lastError = error.message; await saveState(ctx).catch(() => {}); }
    }
    notify('error', error.message);
  } finally {
    processingMessage = false;
    refreshPanel();
  }
}

async function handleHistoryMutation() {
  if (!active || hideBusy || processingMessage) return;
  await new Promise(resolve => setTimeout(resolve, 0));
  const ctx = getContext();
  const state = getState(ctx, false);
  if (!state) return;
  const mismatches = detectMemoryDrift(state, ctx.chat);
  if (!mismatches.length) return;
  const archivedMismatch = mismatches.some(item => String(state.ledger[item.source.key]?.status ?? '').startsWith('archive:'));
  if (archivedMismatch) {
    markNeedsReview(state, `检测到已归档记忆的来源被编辑、删除或切换重roll；为防止记忆与楼层错位，已暂停写入和自动隐藏。`);
    await restoreOwnedHidden(ctx, state, false).catch(() => {});
  } else {
    const staleKeys = new Set(mismatches.map(item => item.source.key));
    discardUnarchivedSources(state, staleKeys);
    for (const item of mismatches) {
      const message = ctx.chat[item.source.messageIndex];
      if (isEligibleAssistantMessage(message)) {
        const currentSource = sourceIdentity(message, item.source.messageIndex, ctx.chat);
        addPending(state, currentSource, '本批来源刚刚被编辑或重roll，等待新版本记忆包或手动补写', message.mes);
      }
    }
  }
  await saveState(ctx);
  refreshPanel();
}

function ownedHiddenIndices(ctx = getContext()) {
  if (!Array.isArray(ctx?.chat)) return [];
  const result = [];
  for (let index = 0; index < ctx.chat.length; index += 1) if (ctx.chat[index]?.extra?.[HIDDEN_MARKER]) result.push(index);
  return result;
}

async function executeSlash(ctx, command) {
  const executor = slashCommandFunction(ctx);
  if (!executor) throw new Error('当前宿主未提供安全的/hide执行接口');
  return executor.call(command);
}

async function hideArchiveSafely(ctx, state, archive) {
  if (!state.config.autoHide || state.needsReview || hideBusy) return null;
  const range = chooseHideRange(ctx.chat.length, archive, state.config.keepVisible, state.hidden.through, state.captureStart);
  if (!range) return null;
  if (!slashCommandFunction(ctx)) {
    state.runtime.lastError = '归档已保存，但宿主缺少自动隐藏接口；没有隐藏任何楼层。';
    await saveState(ctx);
    return null;
  }
  const binding = captureChatBinding(ctx);
  hideBusy = true;
  const newlyOwned = [];
  try {
    for (let index = range.start; index <= range.end; index += 1) {
      const message = ctx.chat[index];
      if (!message || message.is_system === true) continue;
      message.extra ??= {};
      message.extra[HIDDEN_MARKER] = { batch: archive.batch, hiddenAt: new Date().toISOString() };
      newlyOwned.push(index);
    }
    assertCurrentChatBinding(binding);
    await executeSlash(ctx, `/hide ${range.start}-${range.end}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    assertCurrentChatBinding(binding);
    const failed = newlyOwned.filter(index => ctx.chat[index]?.is_system !== true);
    if (failed.length) throw new Error(`/hide执行后仍有${failed.length}条消息未进入隐藏状态`);
    state.hidden.indices = ownedHiddenIndices(ctx);
    state.hidden.through = Math.max(state.hidden.through, range.end);
    await saveState(ctx);
    applyOwnedHiddenDom(ctx, state);
    return range;
  } catch (error) {
    if (isCurrentChatBinding(binding)) {
      const partiallyHidden = newlyOwned.filter(index => ctx.chat[index]?.is_system === true);
      let rollbackError = '';
      for (const range of contiguousRanges(partiallyHidden)) {
        const commandRange = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
        try {
          await executeSlash(ctx, `/unhide ${commandRange}`);
        } catch (rollback) {
          rollbackError = rollback.message;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (isCurrentChatBinding(binding)) {
        for (const index of newlyOwned) {
          const message = ctx.chat[index];
          if (message?.is_system !== true && message?.extra) delete message.extra[HIDDEN_MARKER];
        }
        state.hidden.indices = ownedHiddenIndices(ctx);
        state.runtime.lastError = `自动隐藏失败：${error.message}${rollbackError ? `；回滚也失败：${rollbackError}（仍保留所有权标记，可用“恢复”重试）` : ''}`;
        await persistMessageChanges(ctx).catch(() => {});
        await saveState(ctx).catch(() => {});
      }
    }
    throw error;
  } finally {
    hideBusy = false;
  }
}

async function restoreOwnedHidden(ctxInput = getContext(), stateInput = null, showNotice = true) {
  const ctx = ctxInput;
  const state = stateInput ?? getState(ctx, false);
  if (!ctx || !state || hideBusy) return 0;
  const owned = ownedHiddenIndices(ctx);
  if (!owned.length) return 0;
  if (!slashCommandFunction(ctx)) throw new Error('当前宿主缺少/unhide执行接口，未改动聊天');
  const binding = captureChatBinding(ctx);
  hideBusy = true;
  let restored = 0;
  try {
    for (const range of contiguousRanges(owned)) {
      assertCurrentChatBinding(binding);
      const commandRange = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
      await executeSlash(ctx, `/unhide ${commandRange}`);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    assertCurrentChatBinding(binding);
    for (const index of owned) {
      const message = ctx.chat[index];
      if (message?.is_system === true) throw new Error(`第${index}楼未能恢复，已保留所有权标记以便重试`);
      if (message?.extra) delete message.extra[HIDDEN_MARKER];
      restored += 1;
    }
    state.hidden.indices = [];
    state.hidden.through = state.captureStart - 1;
    await persistMessageChanges(ctx).catch(() => {});
    await saveState(ctx);
    applyOwnedHiddenDom(ctx, state);
    if (showNotice) notify('success', `已恢复${restored}条由留痕记忆隐藏的消息`);
    return restored;
  } finally {
    hideBusy = false;
    refreshPanel();
  }
}

function applyOwnedHiddenDom(ctx = getContext(), state = getState(ctx, false)) {
  if (typeof document === 'undefined' || !Array.isArray(ctx?.chat)) return;
  document.querySelectorAll('.trace-memory-owned-hidden').forEach(node => node.classList.remove('trace-memory-owned-hidden'));
  if (!state?.config.collapseOwnedHidden) return;
  for (const index of ownedHiddenIndices(ctx)) {
    const selector = `.mes[mesid="${index}"], .mes[data-message-id="${index}"]`;
    document.querySelectorAll(selector).forEach(node => node.classList.add('trace-memory-owned-hidden'));
  }
}

async function repairLastPending() {
  const ctx = getContext();
  const state = getState(ctx, false);
  const pending = state?.pending.at(-1);
  if (!pending) return;
  const message = ctx.chat[pending.messageIndex];
  if (!isEligibleAssistantMessage(message)) throw new Error('待补写楼层已不存在或不再是角色回复');
  await runBackgroundTurn(ctx, state, pending.messageIndex);
  notify('success', `已尝试补写第${pending.messageIndex}楼记忆`);
}

async function archiveDueBatch() {
  const ctx = getContext();
  const state = getState(ctx, false);
  if (!state?.archiveDue) throw new Error('当前短期记忆尚未达到归档门槛');
  await runArchiveQuiet(ctx, state);
  notify('success', '到期批次已归档');
}

function exportCurrentMemory() {
  const ctx = getContext();
  const state = getState(ctx, false);
  if (!state || typeof document === 'undefined') return;
  const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), extension: { id: MODULE_ID, version: VERSION }, character: characterName(ctx), state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `trace-memory-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function resetCurrentMemory() {
  const ctx = getContext();
  const oldState = getState(ctx, false);
  if (!oldState) return;
  const confirmed = globalThis.confirm?.('这会删除当前聊天中由留痕记忆保存的全部记忆记录，并先恢复本扩展隐藏的楼层。原聊天正文不会删除。确定继续吗？');
  if (!confirmed) return;
  await restoreOwnedHidden(ctx, oldState, false);
  const settings = getSettings(ctx);
  ctx.chatMetadata[STATE_KEY] = createState(settings);
  ctx.chatMetadata[STATE_KEY].captureStart = Math.max(1, ctx.chat.length);
  ctx.chatMetadata[STATE_KEY].hidden.through = ctx.chatMetadata[STATE_KEY].captureStart - 1;
  clearReview(ctx.chatMetadata[STATE_KEY]);
  await saveState(ctx);
  clearPrompt(ctx);
  refreshPanel();
  notify('success', '当前聊天的插件记忆已重置；正文未删除');
}

function bindHostEvent(ctx, typeName, handler) {
  const type = ctx?.event_types?.[typeName];
  if (!type || typeof ctx?.eventSource?.on !== 'function') return;
  ctx.eventSource.on(type, handler);
  listeners.push({ source: ctx.eventSource, type, handler });
}

function bindHostEvents(ctx) {
  if (listeners.length) return;
  bindHostEvent(ctx, 'MESSAGE_RECEIVED', handleMessageReceived);
  for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) bindHostEvent(ctx, name, handleHistoryMutation);
  bindHostEvent(ctx, 'CHAT_CHANGED', () => { clearPrompt(ctx); const next = getContext(); getState(next, true); setTimeout(refreshPanel, 0); });
  bindHostEvent(ctx, 'CHARACTER_EDITED', () => { cardConflictCache = new WeakMap(); setTimeout(refreshPanel, 0); });
  for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) bindHostEvent(ctx, name, () => setTimeout(refreshPanel, 0));
}

function unbindHostEvents() {
  for (const item of listeners.splice(0)) item.source?.off?.(item.type, item.handler);
}

async function initialize() {
  if (initialized || !active) return;
  const ctx = getContext();
  if (!ctx) { scheduleInitialize(500); return; }
  getSettings(ctx);
  getState(ctx, true);
  if (!mountPanel()) { scheduleInitialize(500); return; }
  bindHostEvents(ctx);
  initialized = true;
  refreshPanel();
}

function scheduleInitialize(delay = 0) {
  if (initializeTimer) clearTimeout(initializeTimer);
  initializeTimer = setTimeout(() => { initializeTimer = null; initialize().catch(error => notify('error', error.message)); }, delay);
}

async function dispose() {
  active = false;
  initialized = false;
  if (initializeTimer) clearTimeout(initializeTimer);
  initializeTimer = null;
  clearPrompt();
  unbindHostEvents();
  byId(PANEL_ID)?.remove();
  removeMessageMemoryPanels();
  byId(CUSTOM_STYLE_ID)?.remove();
  memoryEditBusy = false;
  chatTokens = new WeakMap();
  chatTokenCounter = 0;
  if (typeof document !== 'undefined') document.querySelectorAll('.trace-memory-owned-hidden').forEach(node => node.classList.remove('trace-memory-owned-hidden'));
}

globalThis.traceMemoryPromptInterceptor = async function traceMemoryPromptInterceptor(_chat, _contextSize, _abort, type) {
  lastGenerationType = String(type ?? 'normal').toLowerCase();
  if (!active) return;
  const ctx = getContext();
  const state = getState(ctx, false);
  if (!ctx || typeof ctx.setExtensionPrompt !== 'function' || !state?.enabled || state.needsReview || shouldSkipGenerationType(lastGenerationType)) { clearPrompt(ctx); return; }
  state.runtime.lastGenerationType = lastGenerationType;
  let prompt;
  if (state.mode === MODES.INLINE || state.mode === MODES.HYBRID) {
    if (!messageSaveFunction(ctx)) { state.runtime.lastError = '同轮模式缺少安全保存接口，已停止注入记忆包指令。'; clearPrompt(ctx); return; }
    prompt = buildInlinePrompt(state, characterName(ctx), state.mode);
  } else {
    prompt = continuityPrompt(state);
  }
  ctx.setExtensionPrompt(PROMPT_KEY, prompt, IN_CHAT_PROMPT_POSITION, 0, false, SYSTEM_PROMPT_ROLE);
};

export function onActivate() {
  active = true;
  scheduleInitialize();
}

export function onEnable() {
  active = true;
  scheduleInitialize();
}

export async function onDisable() {
  await dispose();
}

const previous = globalThis[INSTANCE_KEY];
if (previous?.dispose) Promise.resolve(previous.dispose()).catch(() => {});
globalThis[INSTANCE_KEY] = { dispose, version: VERSION };
if (globalThis.SillyTavern?.getContext) scheduleInitialize();
