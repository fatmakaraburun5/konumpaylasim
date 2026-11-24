import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateLinkToken, linkTokenHash } from '@konum/core';
import { STRIPPED_PATH, appLinkUrl, consumeToken, tokenFromPath, type HistoryLike, type StorageLike } from '../src/token';

const TOKEN = generateLinkToken((n) => new Uint8Array(randomBytes(n)));

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function spyHistory(): HistoryLike & { urls: string[] } {
  const urls: string[] = [];
  return { urls, replaceState: (_d, _u, url) => void urls.push(String(url)) };
}

describe('tokenFromPath', () => {
  it('/s/<token> ve /s/<token>/ kabul, başka her şey null', () => {
    expect(tokenFromPath(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/s/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromPath('/')).toBeNull();
    expect(tokenFromPath('/s/')).toBeNull();
    expect(tokenFromPath(STRIPPED_PATH)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN.slice(1)}`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN}x`)).toBeNull();
    expect(tokenFromPath(`/x/${TOKEN}`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN}/extra`)).toBeNull();
    expect(tokenFromPath('/s/%E0%A4%A')).toBeNull(); // bozuk yüzde kodlaması
  });
});

describe('consumeToken: token adresten silinir, yalnızca özeti dışarı çıkar', () => {
  it('yoldan token: saklanır, adres /s/canli olur, özet = SHA-256 hex', () => {
    const storage = memStorage();
    const history = spyHistory();
    const r = consumeToken({ pathname: `/s/${TOKEN}` }, storage, history);
    expect(r).toEqual({ token: TOKEN, hash: linkTokenHash(TOKEN), source: 'path' });
    expect(r.hash).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    expect(history.urls).toEqual([STRIPPED_PATH]);
    expect(history.urls.join()).not.toContain(TOKEN);
    expect([...storage.data.values()]).toEqual([TOKEN]);
  });

  it('yenileme: /s/canli → sekmenin deposundan', () => {
    const storage = memStorage();
    consumeToken({ pathname: `/s/${TOKEN}` }, storage, spyHistory());
    const r = consumeToken({ pathname: STRIPPED_PATH }, storage, spyHistory());
    expect(r).toEqual({ token: TOKEN, hash: linkTokenHash(TOKEN), source: 'session' });
  });

  it('depo yok / hata atıyor: yine çalışır, yenilemede token yok', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(consumeToken({ pathname: `/s/${TOKEN}` }, throwing, null).token).toBe(TOKEN);
    expect(consumeToken({ pathname: STRIPPED_PATH }, throwing, null)).toEqual({ token: null, hash: null, source: 'none' });
    expect(consumeToken({ pathname: STRIPPED_PATH }, null, null).token).toBeNull();
  });

  it('bozuk depo değeri kabul edilmez; geçersiz yol adresi değiştirmez', () => {
    const storage = memStorage();
    storage.setItem('konum.link.token', 'bozuk');
    expect(consumeToken({ pathname: STRIPPED_PATH }, storage, null).token).toBeNull();
    const history = spyHistory();
    expect(consumeToken({ pathname: '/s/kisa' }, storage, history).token).toBeNull();
    expect(history.urls).toEqual([]);
  });

  it('yeni bağlantı eskisinin yerine geçer', () => {
    const storage = memStorage();
    const other = generateLinkToken((n) => new Uint8Array(randomBytes(n)));
    consumeToken({ pathname: `/s/${TOKEN}` }, storage, null);
    consumeToken({ pathname: `/s/${other}` }, storage, null);
    expect(consumeToken({ pathname: STRIPPED_PATH }, storage, null).token).toBe(other);
  });

  it('Uygulamada aç: konum://s/<token>', () => {
    expect(appLinkUrl(TOKEN)).toBe(`konum://s/${TOKEN}`);
  });
});
