import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODES,
  addPending,
  applyMemoryPayload,
  buildInlinePrompt,
  chooseHideRange,
  createState,
  detectMemoryDrift,
  discardUnarchivedSources,
  migrateState,
  normalizeSettings,
  shouldSkipGenerationType,
  sourceIdentity,
  stateStats,
  stripMemoryPacket,
} from '../src/core.mjs';

function assistant(text, swipeId = 0) {
  return { is_user: false, is_system: false, mes: text, swipe_id: swipeId };
}

function user(text) {
  return { is_user: true, is_system: false, mes: text };
}

test('strips and parses a valid inline memory packet', () => {
  const input = '正文。\n<TraceMemoryUpdate>{"short":"发生了一件事","permanent":[],"archive":null}</TraceMemoryUpdate>';
  const result = stripMemoryPacket(input);
  assert.equal(result.found, true);
  assert.equal(result.cleanText, '正文。');
  assert.equal(result.payload.short, '发生了一件事');
  assert.equal(result.error, null);
});

test('removes an orphan packet without deleting preceding prose', () => {
  const result = stripMemoryPacket('正文还在。\n<TraceMemoryUpdate>{"short":"坏包"}');
  assert.equal(result.found, true);
  assert.equal(result.cleanText, '正文还在。');
  assert.match(result.error, /闭合标签/);
});

test('archives exactly one configured batch and leaves later records', () => {
  const state = createState({ batchSize: 3 });
  const chat = [assistant('开场')];
  for (let index = 1; index <= 2; index += 1) {
    chat[index] = assistant(`回复${index}`);
    applyMemoryPayload(state, { short: `事件${index}`, permanent: [], archive: null }, sourceIdentity(chat[index], index), `2026-01-0${index}T00:00:00Z`);
  }
  chat[3] = assistant('回复3');
  const result = applyMemoryPayload(state, {
    short: '事件3',
    permanent: [],
    archive: { summary: '前三条的客观归档', diary: '角色知道的前三条日记' },
  }, sourceIdentity(chat[3], 3), '2026-01-03T00:00:00Z');
  assert.equal(result.archive.batch, 1);
  assert.equal(state.archives.length, 1);
  assert.equal(state.short.length, 0);
  assert.equal(state.batchNumber, 2);
  assert.deepEqual(state.archives[0].sources.map(item => item.messageIndex), [1, 2, 3]);
});

test('deduplicates permanent facts while keeping independent buckets', () => {
  const state = createState();
  const message = assistant('回复');
  const source = sourceIdentity(message, 1);
  applyMemoryPayload(state, {
    short: '一个有效事件',
    permanent: [
      { kind: 'promise', text: '答应明天一起吃饭。' },
      { kind: 'promise', text: '答应明天一起吃饭' },
      { kind: 'gift', text: '送出一枚胸针' },
    ],
  }, source, '2026-01-01T00:00:00Z');
  const stats = stateStats(state);
  assert.equal(stats.permanent, 2);
  assert.equal(state.permanent.promises[0].id, 'P01');
  assert.equal(state.permanent.gifts[0].id, 'G01');
});

test('replaces a current-batch memory when the same floor is re-rolled', () => {
  const state = createState();
  const first = assistant('版本一', 0);
  applyMemoryPayload(state, {
    short: '旧事件',
    permanent: [{ kind: 'promise', text: '答应保留旧版本' }],
  }, sourceIdentity(first, 4));
  const second = assistant('版本二', 1);
  const result = applyMemoryPayload(state, {
    short: '新事件',
    permanent: [{ kind: 'gift', text: '新版本送出书签' }],
  }, sourceIdentity(second, 4));
  assert.equal(result.shortReplaced, true);
  assert.equal(state.short.length, 1);
  assert.equal(state.short[0].text, '新事件');
  assert.equal(state.short[0].source.swipeId, 1);
  assert.equal(state.permanent.promises.length, 0);
  assert.equal(state.permanent.gifts.length, 1);
});

test('replaces permanent-only unarchived facts from the same floor', () => {
  const state = createState();
  applyMemoryPayload(state, {
    short: '',
    permanent: [{ kind: 'promise', text: '旧版本的承诺' }],
  }, sourceIdentity(assistant('版本一', 0), 7));
  applyMemoryPayload(state, {
    short: '新版本发生了剧情',
    permanent: [],
  }, sourceIdentity(assistant('版本二', 1), 7));
  assert.equal(state.permanent.promises.length, 0);
  assert.equal(state.short.length, 1);
});

test('hide range never touches greeting or the configured visible tail', () => {
  const archive = { sourceStart: 2, sourceEnd: 16 };
  assert.deepEqual(chooseHideRange(20, archive, 6, 0, 1), { start: 1, end: 13 });
  assert.deepEqual(chooseHideRange(8, { sourceStart: 2, sourceEnd: 4 }, 6, 0, 1), { start: 1, end: 1 });
  assert.deepEqual(chooseHideRange(40, { sourceStart: 22, sourceEnd: 32 }, 6, 19, 20), { start: 20, end: 32 });
  assert.equal(chooseHideRange(40, { sourceStart: 22, sourceEnd: 32 }, 6, 32, 20), null);
});

test('detects edited, deleted, and swiped source messages', () => {
  const state = createState();
  const chat = [assistant('开场'), assistant('原文')];
  const source = sourceIdentity(chat[1], 1);
  applyMemoryPayload(state, { short: '原事件' }, source);
  assert.equal(detectMemoryDrift(state, chat).length, 0);
  chat[1].mes = '改文';
  assert.equal(detectMemoryDrift(state, chat)[0].reason, 'source-message-changed');
  chat.splice(1, 1);
  assert.equal(detectMemoryDrift(state, chat)[0].reason, 'source-message-missing');
});

test('source custody also detects an edited preceding user turn', () => {
  const state = createState();
  const chat = [assistant('开场'), user('我去了车站'), assistant('角色跟着去了')];
  const source = sourceIdentity(chat[2], 2, chat);
  applyMemoryPayload(state, { time: '第三日午时', short: '两人抵达车站' }, source);
  assert.equal(state.short[0].at, '第三日午时');
  assert.equal(detectMemoryDrift(state, chat).length, 0);
  chat[1].mes = '我去了码头';
  assert.equal(detectMemoryDrift(state, chat)[0].reason, 'source-message-changed');
});

test('discarding an unarchived source also rolls back its permanent facts', () => {
  const state = createState();
  const message = assistant('回复');
  const source = sourceIdentity(message, 3);
  applyMemoryPayload(state, {
    short: '发生了一件事',
    permanent: [{ kind: 'promise', text: '答应稍后回来' }],
  }, source);
  const removed = discardUnarchivedSources(state, new Set([source.key]));
  assert.deepEqual(removed, { shortRemoved: 1, permanentRemoved: 1 });
  assert.equal(state.ledger[source.key], undefined);
  assert.equal(state.permanent.promises.length, 0);
});

test('missing packets are queued without creating fictional memory', () => {
  const state = createState();
  const source = sourceIdentity(assistant('正文'), 2);
  addPending(state, source, '没有记忆包', '正文');
  assert.equal(state.short.length, 0);
  assert.equal(state.pending.length, 1);
});

test('prompt is generic, carries epistemic boundaries, and supports all three modes', () => {
  const state = createState();
  const prompt = buildInlinePrompt(state, '角色占位测试');
  assert.match(prompt, /角色占位测试/);
  assert.match(prompt, /不得把未说出口的内容改成角色听见/);
  assert.match(prompt, /TraceMemoryUpdate/);
  assert.match(prompt, /不得拿现实系统时间冒充剧情时间/);
  const hybridPrompt = buildInlinePrompt(state, '角色占位测试', MODES.HYBRID);
  assert.match(hybridPrompt, /长期归档由扩展另行处理/);
  assert.deepEqual(Object.values(MODES).sort(), ['background', 'hybrid', 'inline']);
});

test('settings and state migration clamp unsafe numeric values', () => {
  const settings = normalizeSettings({ batchSize: 999, keepVisible: 0, defaultMode: 'bad' });
  assert.equal(settings.batchSize, 50);
  assert.equal(settings.keepVisible, 2);
  assert.equal(settings.defaultMode, MODES.INLINE);
  const state = migrateState({
    schemaVersion: 0,
    config: { batchSize: 1 },
    short: 'bad',
    hidden: { indices: [4, 2, 4, '3'], through: '5' },
    nextIds: { promise: -8 },
  }, settings);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.config.batchSize, 3);
  assert.deepEqual(state.short, []);
  assert.deepEqual(state.hidden.indices, [2, 4]);
  assert.equal(state.hidden.through, 5);
  assert.equal(state.nextIds.promise, 1);
});

test('quiet and impersonate generations never request memory packets', () => {
  assert.equal(shouldSkipGenerationType('quiet'), true);
  assert.equal(shouldSkipGenerationType('impersonate'), true);
  assert.equal(shouldSkipGenerationType('normal'), false);
});
