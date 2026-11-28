import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  applyLiveOp,
  buildLiveShareContent,
  compactLabel,
  isOnBreak,
  mergeHistory,
  parseBreakState,
  planLiveActivity,
  planShortcutStart,
  rankFrequentContacts,
  remainingFraction,
  startBreak,
  type LiveBuildInput,
  type LiveRuntime,
  type ShareHistoryEntry,
} from '../src';

const T = 1_800_000_000_000;
const h = (uid: string, ago: number, minutes: number | null = 60, id = `${uid}-${ago}`): ShareHistoryEntry => ({ share_id: id, receiver_id: uid, started_at: T - ago, minutes });

describe('Faz 12 · sık paylaşılan kişiler', () => {
  it('yakın ve sık paylaşım önde; favori geçmişsiz de görünür ama sık paylaşılanı geçmez', () => {
    const history = [h('ayse', 1 * DAY), h('ayse', 2 * DAY), h('ayse', 3 * DAY), h('mehmet', 40 * DAY), h('mehmet', 41 * DAY), h('can', 2 * HOUR, 15)];
    const r = rankFrequentContacts({ history, favorites: ['zeynep'], friendIds: new Set(['ayse', 'mehmet', 'can', 'zeynep']), now: T });
    expect(r.map((x) => x.uid)).toEqual(['ayse', 'can', 'zeynep', 'mehmet']);
    expect(r.find((x) => x.uid === 'can')!.usual).toBe('m15');
    expect(r.find((x) => x.uid === 'zeynep')!.favorite).toBe(true);
  });

  it('arkadaş olmayan elenir, sınır 4', () => {
    const history = ['a', 'b', 'c', 'd', 'e', 'x'].map((u, k) => h(u, k * HOUR));
    const r = rankFrequentContacts({ history, favorites: [], friendIds: new Set(['a', 'b', 'c', 'd', 'e']), now: T });
    expect(r).toHaveLength(4);
    expect(r.map((x) => x.uid)).not.toContain('x');
  });

  it('geçmiş tekilleşir ve 60 günden eskisi budanır', () => {
    const m = mergeHistory([h('a', 70 * DAY), h('a', DAY, 60, 's1')], [h('a', DAY, 60, 's1'), h('b', 0)], T);
    expect(m.map((e) => e.share_id)).toEqual(['s1', 'b-0']);
  });
});

describe('Faz 12 · kısayol başlatma kararı', () => {
  const base = { invisible: false, consentRequired: false, grantToThem: true, grantFromThem: true, activeUntil: undefined, onBreak: false, now: T, minutes: 15 };
  it('görünmez / izin eksik / zaten açık / mola', () => {
    expect(planShortcutStart(base)).toEqual({ kind: 'start', endsBreak: false });
    expect(planShortcutStart({ ...base, invisible: true }).kind).toBe('invisible');
    expect(planShortcutStart({ ...base, grantToThem: false })).toEqual({ kind: 'needs_grant', endsBreak: false });
    expect(planShortcutStart({ ...base, activeUntil: T + 40 * MINUTE }).kind).toBe('already');
    expect(planShortcutStart({ ...base, activeUntil: T + 5 * MINUTE }).kind).toBe('start');
    expect(planShortcutStart({ ...base, activeUntil: T + 40 * MINUTE, minutes: 60 }).kind).toBe('start');
    expect(planShortcutStart({ ...base, activeUntil: null, minutes: 60 }).kind).toBe('already');
    expect(planShortcutStart({ ...base, onBreak: true })).toEqual({ kind: 'start', endsBreak: true });
  });
});

describe('Faz 12 · canlı sayaç', () => {
  const people: LiveBuildInput['people'] = (uid) => (uid === 'ayse' ? { name: 'Ayşe Yılmaz', gender: 'female', avatar_key: 'ayse' } : { name: 'Mehmet Kaya', gender: 'male', avatar_key: null });
  const input = (over: Partial<LiveBuildInput> = {}): LiveBuildInput => ({
    sessions: [
      { session_id: 's1', started_at: T - 18 * MINUTE, expires_at: T + 42 * MINUTE, receiver_ids: ['ayse'] },
      { session_id: 's2', started_at: T - HOUR, expires_at: T + 7 * HOUR, receiver_ids: ['mehmet'] },
    ],
    people,
    breakUntil: null,
    invisible: false,
    eta: { label: 'Ayşe', kind: 'friend', arrive_at: T + 12 * MINUTE, computed_at: T },
    now: T,
    ...over,
  });

  it('öndeki kişi en kısa süresi kalan; metin, çerçeve, ETA, ilerleme', () => {
    const c = buildLiveShareContent(input())!;
    expect(c.lead).toMatchObject({ uid: 'ayse', initials: 'AY', ring: 'female' });
    expect(c.receivers).toBe(2);
    expect(c.title).toBe('Ayşe +1 konumunu görüyor');
    expect(c.subtitle).toBe('42 dk kaldı');
    expect(c.eta?.label).toBe('Ayşe');
    expect(compactLabel(c, T)).toBe('42 dk');
    expect(remainingFraction(c, T)).toBeCloseTo(0.7);
  });

  it('mola, son 5 dk, görünmez, eski ETA', () => {
    expect(buildLiveShareContent(input({ breakUntil: T + 15 * MINUTE }))!.phase).toBe('paused');
    expect(buildLiveShareContent(input({ now: T + 38 * MINUTE }))!.phase).toBe('expiring');
    expect(buildLiveShareContent(input({ invisible: true }))).toBeNull();
    expect(buildLiveShareContent(input({ eta: { label: 'Ev', kind: 'destination', arrive_at: T + 30 * MINUTE, computed_at: T - 25 * MINUTE } }))!.eta).toBeNull();
  });

  it('başlat → değişmeyen içerikte güncelleme yok → bitince "sona erdi" kalır → süre sonunda kapanır; görünmez hemen kapatır', () => {
    let rt: LiveRuntime = { active: null, dismiss_at: null };
    const c = buildLiveShareContent(input())!;
    const start = planLiveActivity({ rt, next: c, reason: null, now: T, newId: () => 'a1' });
    expect(start.op).toBe('start');
    rt = applyLiveOp(rt, start);
    const later = buildLiveShareContent(input({ now: T + 10_000 }))!;
    expect(planLiveActivity({ rt, next: later, reason: null, now: T + 10_000, newId: () => 'x' }).op).toBe('none');
    const end = planLiveActivity({ rt, next: null, reason: 'stopped', now: T + MINUTE, newId: () => 'x' });
    expect(end).toMatchObject({ op: 'end', immediate: false });
    rt = applyLiveOp(rt, end);
    expect(rt.active!.content.phase).toBe('ended');
    expect(planLiveActivity({ rt, next: null, reason: 'stopped', now: T + 2 * MINUTE, newId: () => 'x' }).op).toBe('none');
    expect(planLiveActivity({ rt, next: null, reason: 'stopped', now: T + 10 * MINUTE, newId: () => 'x' })).toMatchObject({ op: 'end', immediate: true });
    rt = applyLiveOp({ active: null, dismiss_at: null }, start);
    expect(planLiveActivity({ rt, next: null, reason: 'invisible', now: T, newId: () => 'x' })).toMatchObject({ op: 'end', immediate: true });
  });
});

describe('Faz 12 · mola', () => {
  it('başlar, biter, bozuk kayıt yok sayılır', () => {
    const b = startBreak(T, 15);
    expect(isOnBreak(b, T + 14 * MINUTE)).toBe(true);
    expect(isOnBreak(b, T + 15 * MINUTE)).toBe(false);
    expect(parseBreakState({ started_at: T, until: T + 2 * HOUR })).toBeNull();
    expect(parseBreakState(b)).toEqual(b);
  });
});
