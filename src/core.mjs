export const MODULE_ID = 'trace-memory';
export const STATE_KEY = 'trace_memory_v1';
export const PROMPT_KEY = 'trace-memory.prompt.v1';
export const HIDDEN_MARKER = 'trace_memory_hidden_v1';
export const PACKET_TAG = 'TraceMemoryUpdate';
export const SCHEMA_VERSION = 1;

export const MODES = Object.freeze({
  INLINE: 'inline',
  BACKGROUND: 'background',
  HYBRID: 'hybrid',
});

export const DEFAULT_SETTINGS = Object.freeze({
  defaultEnabled: true,
  defaultMode: MODES.INLINE,
  batchSize: 15,
  autoHide: true,
  keepVisible: 6,
  collapseOwnedHidden: true,
  maxPromptCharacters: 14000,
  showToasts: true,
});

const PERMANENT_BUCKETS = Object.freeze({
  promise: 'promises',
  gift: 'gifts',
  agreement_pending: 'pendingAgreements',
  agreement_completed: 'completedAgreements',
  clue: 'clues',
});

const GENERATION_TYPES_TO_SKIP = new Set(['quiet', 'impersonate']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value, maximum = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, maximum);
}

function normalizeForDedupe(value) {
  return asText(value, 2000).replace(/\s+/g, '').replace(/[，。！？；：、“”‘’（）()【】\[\]]/g, '').toLowerCase();
}

export function normalizeSettings(input = {}) {
  const mode = Object.values(MODES).includes(input.defaultMode) ? input.defaultMode : DEFAULT_SETTINGS.defaultMode;
  return {
    ...clone(DEFAULT_SETTINGS),
    ...input,
    defaultEnabled: asBoolean(input.defaultEnabled, DEFAULT_SETTINGS.defaultEnabled),
    defaultMode: mode,
    batchSize: asInteger(input.batchSize, DEFAULT_SETTINGS.batchSize, 3, 50),
    autoHide: asBoolean(input.autoHide, DEFAULT_SETTINGS.autoHide),
    keepVisible: asInteger(input.keepVisible, DEFAULT_SETTINGS.keepVisible, 2, 50),
    collapseOwnedHidden: asBoolean(input.collapseOwnedHidden, DEFAULT_SETTINGS.collapseOwnedHidden),
    maxPromptCharacters: asInteger(input.maxPromptCharacters, DEFAULT_SETTINGS.maxPromptCharacters, 3000, 50000),
    showToasts: asBoolean(input.showToasts, DEFAULT_SETTINGS.showToasts),
  };
}

export function createState(settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: settings.defaultEnabled,
    mode: settings.defaultMode,
    config: {
      batchSize: settings.batchSize,
      autoHide: settings.autoHide,
      keepVisible: settings.keepVisible,
      collapseOwnedHidden: settings.collapseOwnedHidden,
      maxPromptCharacters: settings.maxPromptCharacters,
    },
    short: [],
    permanent: {
      promises: [],
      gifts: [],
      pendingAgreements: [],
      completedAgreements: [],
      clues: [],
    },
    archives: [],
    pending: [],
    ledger: {},
    nextIds: {
      promise: 1,
      gift: 1,
      agreement: 1,
      clue: 1,
    },
    captureStart: 1,
    batchNumber: 1,
    archiveDue: false,
    needsReview: false,
    reviewReason: '',
    hidden: {
      indices: [],
      through: -1,
    },
    runtime: {
      lastGenerationType: '',
      lastProcessedSource: '',
      lastStoryTime: '',
      lastError: '',
      lastSuccessAt: '',
    },
  };
}

export function migrateState(input, settingsInput = {}) {
  const fresh = createState(settingsInput);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fresh;
  const merged = {
    ...fresh,
    ...clone(input),
    config: { ...fresh.config, ...(input.config ?? {}) },
    permanent: { ...fresh.permanent, ...(input.permanent ?? {}) },
    nextIds: { ...fresh.nextIds, ...(input.nextIds ?? {}) },
    hidden: { ...fresh.hidden, ...(input.hidden ?? {}) },
    runtime: { ...fresh.runtime, ...(input.runtime ?? {}) },
  };
  merged.schemaVersion = SCHEMA_VERSION;
  merged.mode = Object.values(MODES).includes(merged.mode) ? merged.mode : fresh.mode;
  merged.enabled = asBoolean(merged.enabled, fresh.enabled);
  merged.captureStart = asInteger(merged.captureStart, fresh.captureStart, 1, Number.MAX_SAFE_INTEGER);
  merged.batchNumber = asInteger(merged.batchNumber, fresh.batchNumber, 1, Number.MAX_SAFE_INTEGER);
  merged.config.batchSize = asInteger(merged.config.batchSize, fresh.config.batchSize, 3, 50);
  merged.config.keepVisible = asInteger(merged.config.keepVisible, fresh.config.keepVisible, 2, 50);
  merged.config.autoHide = asBoolean(merged.config.autoHide, fresh.config.autoHide);
  merged.config.collapseOwnedHidden = asBoolean(merged.config.collapseOwnedHidden, fresh.config.collapseOwnedHidden);
  merged.config.maxPromptCharacters = asInteger(merged.config.maxPromptCharacters, fresh.config.maxPromptCharacters, 3000, 50000);
  for (const field of ['short', 'archives', 'pending']) {
    if (!Array.isArray(merged[field])) merged[field] = [];
  }
  for (const field of Object.values(PERMANENT_BUCKETS)) {
    if (!Array.isArray(merged.permanent[field])) merged.permanent[field] = [];
  }
  if (!merged.ledger || typeof merged.ledger !== 'object' || Array.isArray(merged.ledger)) merged.ledger = {};
  if (!Array.isArray(merged.hidden.indices)) merged.hidden.indices = [];
  merged.hidden.indices = [...new Set(merged.hidden.indices.filter(Number.isInteger))].sort((a, b) => a - b);
  merged.hidden.through = asInteger(merged.hidden.through, merged.captureStart - 1, -1, Number.MAX_SAFE_INTEGER);
  for (const key of Object.keys(fresh.nextIds)) {
    merged.nextIds[key] = asInteger(merged.nextIds[key], fresh.nextIds[key], 1, 999999);
  }
  merged.archiveDue = merged.short.length >= merged.config.batchSize;
  merged.needsReview = asBoolean(merged.needsReview, fresh.needsReview);
  return merged;
}

export function hashText(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function precedingUserFingerprint(chat, messageIndex) {
  if (!Array.isArray(chat)) return '';
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = chat[index];
    if (message?.is_user === true) return hashText(stripMemoryPacket(String(message.mes ?? '')).cleanText.trim());
    if (message && message.is_user === false && message.is_system !== true) break;
  }
  return '';
}

export function sourceIdentity(message, messageIndex, chat = null) {
  const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
  const clean = stripMemoryPacket(String(message?.mes ?? '')).cleanText.trim();
  const fingerprint = hashText(clean);
  const userFingerprint = precedingUserFingerprint(chat, messageIndex);
  return {
    key: `m${messageIndex}:s${swipeId}:u${userFingerprint || 'none'}:${fingerprint}`,
    messageIndex,
    swipeId,
    fingerprint,
    userFingerprint,
  };
}

export function shouldSkipGenerationType(type) {
  return GENERATION_TYPES_TO_SKIP.has(String(type ?? '').toLowerCase());
}

export function isEligibleAssistantMessage(message) {
  return Boolean(
    message
    && message.is_user !== true
    && message.is_system !== true
    && asText(message.mes, 100000),
  );
}

function parseJsonCandidate(raw) {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const candidates = [withoutFence];
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(withoutFence.slice(start, end + 1));
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate), error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { value: null, error: lastError?.message ?? '没有找到合法JSON' };
}

export function stripMemoryPacket(textInput) {
  const text = String(textInput ?? '');
  const completePattern = new RegExp(`<${PACKET_TAG}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${PACKET_TAG}>`, 'gi');
  const matches = [...text.matchAll(completePattern)];
  if (matches.length > 0) {
    const raw = matches.at(-1)[1];
    const parsed = parseJsonCandidate(raw);
    return {
      found: true,
      cleanText: text.replace(completePattern, '').trimEnd(),
      raw,
      payload: parsed.value,
      error: parsed.error,
    };
  }
  const orphanPattern = new RegExp(`\\n?\\s*<${PACKET_TAG}(?:\\s[^>]*)?>[\\s\\S]*$`, 'i');
  if (orphanPattern.test(text)) {
    return {
      found: true,
      cleanText: text.replace(orphanPattern, '').trimEnd(),
      raw: '',
      payload: null,
      error: '记忆包缺少闭合标签，已从正文移除并等待补写',
    };
  }
  return { found: false, cleanText: text, raw: '', payload: null, error: null };
}

function normalizePermanent(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const kind = String(item.kind ?? '').trim().toLowerCase();
  if (!Object.hasOwn(PERMANENT_BUCKETS, kind)) return null;
  const text = asText(item.text, 500);
  if (!text) return null;
  const normalized = { kind, text };
  if (kind === 'clue') {
    const allowed = new Set(['未触发', '已露线索', '角色怀疑中', '已确认', '已回收']);
    normalized.status = allowed.has(item.status) ? item.status : '已露线索';
  }
  if (kind === 'agreement_completed') normalized.refId = asText(item.refId, 40);
  return normalized;
}

export function normalizeMemoryPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { time: '', short: '', permanent: [], archive: null };
  }
  const permanent = Array.isArray(input.permanent)
    ? input.permanent.map(normalizePermanent).filter(Boolean).slice(0, 12)
    : [];
  let archive = null;
  if (input.archive && typeof input.archive === 'object' && !Array.isArray(input.archive)) {
    const summary = asText(input.archive.summary, 2000);
    const diary = asText(input.archive.diary, 1600);
    if (summary && diary) archive = { summary, diary };
  }
  return {
    time: asText(input.time, 80),
    short: asText(input.short, 500),
    permanent,
    archive,
  };
}

function nextRecordId(state, kind) {
  const key = kind === 'agreement_pending' || kind === 'agreement_completed' ? 'agreement' : kind;
  const prefix = { promise: 'P', gift: 'G', agreement: 'Y', clue: 'A' }[key];
  const current = asInteger(state.nextIds[key], 1, 1, 999999);
  state.nextIds[key] = current + 1;
  return `${prefix}${String(current).padStart(2, '0')}`;
}

function appendPermanent(state, item, storyTime, createdAt, source) {
  const bucket = PERMANENT_BUCKETS[item.kind];
  const existing = state.permanent[bucket];
  const signature = normalizeForDedupe(item.text);
  if (existing.some(record => normalizeForDedupe(record.text) === signature)) return null;
  const record = {
    id: nextRecordId(state, item.kind),
    at: storyTime,
    createdAt,
    sourceKey: source.key,
    text: item.text,
  };
  if (item.status) record.status = item.status;
  if (item.refId) record.refId = item.refId;
  existing.push(record);
  return record;
}

function addOrReplaceShort(state, shortText, source, storyTime, createdAt) {
  if (!shortText) return { added: false, replaced: false, record: null };
  const record = {
    id: source.key,
    at: storyTime,
    createdAt,
    text: shortText,
    source,
  };
  const sameFloorIndex = state.short.findIndex(item => item?.source?.messageIndex === source.messageIndex);
  if (sameFloorIndex !== -1) {
    const old = state.short[sameFloorIndex];
    delete state.ledger[old.id];
    state.short[sameFloorIndex] = record;
    state.ledger[record.id] = { source, status: 'short', at: storyTime, createdAt };
    return { added: false, replaced: true, record };
  }
  state.short.push(record);
  state.short.sort((left, right) => left.source.messageIndex - right.source.messageIndex);
  state.ledger[record.id] = { source, status: 'short', at: storyTime, createdAt };
  return { added: true, replaced: false, record };
}

export function commitArchive(state, archiveInput, timestamp = new Date().toISOString(), forceCount = null) {
  const archive = archiveInput && typeof archiveInput === 'object' ? archiveInput : null;
  if (!archive?.summary || !archive?.diary) return null;
  const batchSize = state.config.batchSize;
  const count = forceCount == null ? batchSize : asInteger(forceCount, batchSize, 1, batchSize);
  if (state.short.length < count) return null;
  const sources = state.short.slice(0, count);
  const sourceIndices = sources.map(item => item.source.messageIndex);
  const entry = {
    batch: state.batchNumber,
    createdAt: timestamp,
    startAt: sources[0]?.at ?? timestamp,
    endAt: sources.at(-1)?.at ?? timestamp,
    sourceStart: Math.min(...sourceIndices),
    sourceEnd: Math.max(...sourceIndices),
    sources: sources.map(item => ({ ...item.source })),
    shortRecords: sources.map(item => ({ at: item.at, text: item.text })),
    summary: asText(archive.summary, 2000),
    diary: asText(archive.diary, 1600),
  };
  state.archives.push(entry);
  for (const item of sources) {
    if (state.ledger[item.id]) state.ledger[item.id].status = `archive:${entry.batch}`;
  }
  state.short = state.short.slice(count);
  state.batchNumber += 1;
  state.archiveDue = state.short.length >= batchSize;
  return entry;
}

export function applyMemoryPayload(stateInput, payloadInput, source, createdAt = new Date().toISOString()) {
  const state = stateInput;
  const payload = normalizeMemoryPayload(payloadInput);
  const replacedKeys = new Set(
    Object.entries(state.ledger)
      .filter(([key, entry]) => (
        key !== source.key
        && entry?.status === 'short'
        && entry?.source?.messageIndex === source.messageIndex
      ))
      .map(([key]) => key),
  );
  if (replacedKeys.size) discardUnarchivedSources(state, replacedKeys);
  const storyTime = payload.time || state.runtime.lastStoryTime || '时间未明';
  if (payload.time) state.runtime.lastStoryTime = payload.time;
  const shortResult = addOrReplaceShort(state, payload.short, source, storyTime, createdAt);
  const permanentAdded = payload.permanent
    .map(item => appendPermanent(state, item, storyTime, createdAt, source))
    .filter(Boolean);
  if (permanentAdded.length && !state.ledger[source.key]) {
    state.ledger[source.key] = { source, status: 'short', at: storyTime, createdAt };
  }
  let archive = null;
  if (payload.archive && state.short.length >= state.config.batchSize) {
    archive = commitArchive(state, payload.archive, createdAt);
  }
  state.archiveDue = state.short.length >= state.config.batchSize;
  state.runtime.lastProcessedSource = source.key;
  state.runtime.lastSuccessAt = createdAt;
  state.runtime.lastError = '';
  state.pending = state.pending.filter(item => item.messageIndex !== source.messageIndex);
  return {
    payload,
    shortAdded: shortResult.added && replacedKeys.size === 0,
    shortReplaced: shortResult.replaced || (replacedKeys.size > 0 && Boolean(shortResult.record)),
    permanentAdded,
    archive,
    archiveDue: state.archiveDue,
  };
}

export function addPending(state, source, reason, excerpt = '') {
  const entry = {
    messageIndex: source.messageIndex,
    source,
    reason: asText(reason, 300) || '本轮没有收到可解析的记忆包',
    excerpt: asText(excerpt, 800),
    at: new Date().toISOString(),
  };
  state.pending = state.pending.filter(item => item.messageIndex !== source.messageIndex);
  state.pending.push(entry);
  state.pending = state.pending.slice(-10);
  state.runtime.lastError = entry.reason;
  return entry;
}

export function discardUnarchivedSources(state, sourceKeysInput) {
  const sourceKeys = sourceKeysInput instanceof Set ? sourceKeysInput : new Set(sourceKeysInput ?? []);
  const beforeShort = state.short.length;
  const beforePermanent = Object.values(state.permanent).reduce((sum, records) => sum + records.length, 0);
  state.short = state.short.filter(item => !sourceKeys.has(item.id));
  for (const bucket of Object.keys(state.permanent)) {
    state.permanent[bucket] = state.permanent[bucket].filter(item => !sourceKeys.has(item.sourceKey));
  }
  for (const key of sourceKeys) {
    if (state.ledger[key]?.status === 'short') delete state.ledger[key];
  }
  state.archiveDue = state.short.length >= state.config.batchSize;
  const afterPermanent = Object.values(state.permanent).reduce((sum, records) => sum + records.length, 0);
  return { shortRemoved: beforeShort - state.short.length, permanentRemoved: beforePermanent - afterPermanent };
}

function permanentLines(state) {
  const sections = [
    ['承诺', state.permanent.promises],
    ['礼物', state.permanent.gifts],
    ['待完成约定', state.permanent.pendingAgreements],
    ['已完成约定', state.permanent.completedAgreements],
    ['暗线与伏笔', state.permanent.clues],
  ];
  return sections
    .filter(([, records]) => records.length)
    .map(([title, records]) => `${title}:\n${records.map(item => `- ${item.id}｜${item.at}｜${item.text}${item.status ? `｜${item.status}` : ''}`).join('\n')}`)
    .join('\n');
}

export function buildMemoryProjection(stateInput, maximumCharacters = null) {
  const state = stateInput;
  const limit = maximumCharacters ?? state.config.maxPromptCharacters;
  const fixed = permanentLines(state);
  const short = state.short.length
    ? `本批短期记忆（${state.short.length}/${state.config.batchSize}）:\n${state.short.map((item, index) => `${index + 1}. ${item.at}｜${item.text}`).join('\n')}`
    : '本批短期记忆：暂无';
  const archiveBlocks = state.archives.map(entry => (
    `第${String(entry.batch).padStart(2, '0')}批｜${entry.startAt}—${entry.endAt}\n长期记忆：${entry.summary}\n角色日记：${entry.diary}`
  ));
  const mandatory = [fixed, short].filter(Boolean).join('\n\n');
  const selected = [];
  let used = mandatory.length;
  for (let index = archiveBlocks.length - 1; index >= 0; index -= 1) {
    const block = archiveBlocks[index];
    if (used + block.length + 2 > limit) break;
    selected.unshift(block);
    used += block.length + 2;
  }
  const omitted = archiveBlocks.length - selected.length;
  const archiveText = selected.length
    ? `长期归档${omitted ? `（较早${omitted}批因注入上限未展开）` : ''}:\n${selected.join('\n\n')}`
    : (omitted ? `长期归档：已有${omitted}批，本轮因注入上限未展开。` : '长期归档：暂无');
  return [archiveText, mandatory].filter(Boolean).join('\n\n').slice(-limit);
}

function outputContract(state, allowInlineArchive = true) {
  if (!allowInlineArchive) return '本模式的长期归档由扩展另行处理，本轮archive必须为null。\n';
  const dueBeforeCurrent = state.short.length >= state.config.batchSize;
  const dueWithCurrent = state.short.length === state.config.batchSize - 1;
  const archiveInstruction = dueBeforeCurrent
    ? `本批已达到${state.config.batchSize}条：archive必须总结上方最早${state.config.batchSize}条短期记忆；本轮short属于下一批。`
    : dueWithCurrent
      ? `加入本轮short后正好达到${state.config.batchSize}条：archive必须同时生成，summary为150—180字客观事实，diary为80—120字且使用当前角色第一人称、只写角色有合理来源知道的事。`
      : '本轮archive必须为null。';
  return `${archiveInstruction}\n`;
}

export function buildInlinePrompt(state, characterName = '{{char}}', mode = MODES.INLINE) {
  const projection = buildMemoryProjection(state);
  return `[留痕记忆｜仅供模型与扩展读取]\n${projection}\n\n[本轮记忆任务]\n在完整正文之后追加且只追加一个<${PACKET_TAG}>JSON</${PACKET_TAG}>；扩展会在显示前移除它，不得在正文提及记忆包、规则或归档。\n- 只记录本轮叙事中已经发生或被明确说出的事实；不得补写动机、心理、关系结论或隐藏因果。叙述、对白、内心与线上消息的区分服从当前角色卡规则，不得把未说出口的内容改成角色听见。\n- 纯OOC、规则讨论、重发旧内容或没有新剧情事实：short写空字符串，permanent写[]。否则short用30—45字客观概括本轮新增事件，恰好一条。\n- permanent只收录本轮明确成立的新事实；kind只能是promise、gift、agreement_pending、agreement_completed、clue。承诺/约定须双方可理解且明确，礼物须确实交付；伏笔用叙事者视角，但${characterName}没有信息来源时不得知情。没有则[]。\n- time写当前剧情内时间；有明确纪年则沿用其格式，没有可靠时间写空字符串，不得拿现实系统时间冒充剧情时间。\n- ${outputContract(state, mode === MODES.INLINE)}\n严格输出单行合法JSON，键固定为time、short、permanent、archive：\n<${PACKET_TAG}>{"time":"","short":"","permanent":[],"archive":null}</${PACKET_TAG}>`;
}

function recentTurn(chat, assistantIndex) {
  const rows = [];
  const start = Math.max(0, assistantIndex - 2);
  for (let index = start; index <= assistantIndex; index += 1) {
    const message = chat[index];
    if (!message || message.is_system === true) continue;
    const role = message.is_user === true ? 'user' : 'character';
    rows.push(`#${index} [${role}] ${asText(stripMemoryPacket(message.mes).cleanText, 5000)}`);
  }
  return rows.join('\n');
}

export function buildBackgroundTurnPrompt(state, chat, assistantIndex, characterName = '{{char}}') {
  return `[任务]\n为留痕记忆生成一次机器可读更新。只输出JSON，不要代码围栏或解释。\n\n[现有记忆]\n${buildMemoryProjection(state)}\n\n[本轮原文]\n${recentTurn(chat, assistantIndex)}\n\n[规则]\n只记录原文明确发生/说出的新事实，不推断user动机、心理或关系结论；未说出口的内心不能算${characterName}听见。纯OOC、规则讨论或无新剧情事实时short为空。有效剧情时short为30—45字客观事件。time写剧情内时间；没有可靠时间写空字符串，不得用现实系统时间代替。permanent仅收明确的新承诺、已交付礼物、具体可执行约定、约定完成或真实伏笔，kind限promise、gift、agreement_pending、agreement_completed、clue。${outputContract(state)}\n输出：{"time":"","short":"","permanent":[],"archive":null}`;
}

export function buildArchivePrompt(state, characterName = '{{char}}') {
  const count = Math.min(state.config.batchSize, state.short.length);
  const records = state.short.slice(0, count).map((item, index) => `${index + 1}. ${item.at}｜${item.text}`).join('\n');
  return `[任务]\n把以下${count}条短期记忆归档。只输出JSON，不要代码围栏或解释。\n[短期记忆]\n${records}\n[规则]\nsummary写150—180字客观事实，不新增、不美化、不推断隐藏动机；diary写80—120字，使用${characterName}第一人称且只写其有合理信息来源知道的事。\n输出：{"summary":"...","diary":"..."}`;
}

export function parseLooseJson(textInput) {
  return parseJsonCandidate(String(textInput ?? ''));
}

export function chooseHideRange(chatLength, archive, keepVisible, hiddenThrough = -1, captureStart = 1) {
  if (!archive || !Number.isInteger(archive.sourceStart) || !Number.isInteger(archive.sourceEnd)) return null;
  const lastHideable = chatLength - asInteger(keepVisible, 6, 2, 50) - 1;
  const through = asInteger(hiddenThrough, -1, -1, Number.MAX_SAFE_INTEGER);
  const start = Math.max(1, asInteger(captureStart, 1, 1, Number.MAX_SAFE_INTEGER), through + 1);
  const end = Math.min(archive.sourceEnd, lastHideable);
  return end >= start ? { start, end } : null;
}

export function detectMemoryDrift(state, chat) {
  const mismatches = [];
  for (const entry of Object.values(state.ledger)) {
    const source = entry?.source;
    if (!source || !Number.isInteger(source.messageIndex)) continue;
    const message = chat[source.messageIndex];
    if (!message) {
      mismatches.push({ source, reason: 'source-message-missing' });
      continue;
    }
    const current = sourceIdentity(message, source.messageIndex, chat);
    if (current.fingerprint !== source.fingerprint || current.userFingerprint !== (source.userFingerprint ?? '') || current.swipeId !== source.swipeId) {
      mismatches.push({ source, current, reason: 'source-message-changed' });
    }
  }
  return mismatches;
}

export function markNeedsReview(state, reason) {
  state.needsReview = true;
  state.reviewReason = asText(reason, 500) || '检测到源消息发生变化';
  state.runtime.lastError = state.reviewReason;
}

export function clearReview(state) {
  state.needsReview = false;
  state.reviewReason = '';
}

export function contiguousRanges(indicesInput) {
  const indices = [...new Set(indicesInput.filter(Number.isInteger))].sort((a, b) => a - b);
  const ranges = [];
  for (const index of indices) {
    const current = ranges.at(-1);
    if (current && index === current.end + 1) current.end = index;
    else ranges.push({ start: index, end: index });
  }
  return ranges;
}

export function stateStats(state) {
  const permanentCount = Object.values(state.permanent).reduce((sum, records) => sum + records.length, 0);
  return {
    short: state.short.length,
    batchSize: state.config.batchSize,
    archives: state.archives.length,
    permanent: permanentCount,
    pending: state.pending.length,
    hidden: state.hidden.indices.length,
    needsReview: state.needsReview,
  };
}
