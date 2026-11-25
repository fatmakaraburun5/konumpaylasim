/**
 * Faz 6: uid'den çerçeveli avatar — arkadaş listesindeki kopyadan (`member_profiles`) fotoğraf (160 px) ve cinsiyet
 * rengi; kendi uid'im ise kendi profilim. Bilinmeyen kişi (bekleyen istek, silinmiş arkadaş) baş harfler + gri
 * çerçeve. Kartlar, şerit, alıcı seçici ve bildirim kartları bunu kullanır.
 */
import { avatarViewOf, type Freshness, type UserId } from '@konum/core';
import { useAuthStore } from '../../state/authStore';
import { avatarRecyclingKey, friendAvatarProps, useFriendsById } from '../../state/friendsStore';
import { Avatar, type AvatarProps } from '../../ui';

export interface FriendAvatarProps extends Omit<AvatarProps, 'name' | 'photoUrl' | 'gender' | 'recyclingKey'> {
  uid: UserId | null | undefined;
  /** Arkadaş listesinde yoksa gösterilecek ad. */
  fallbackName?: string;
  freshness?: Freshness | null;
  prefer?: 'thumb' | 'main';
}

export function FriendAvatar({ uid, fallbackName = 'Arkadaş', prefer = 'thumb', ...rest }: FriendAvatarProps) {
  const byId = useFriendsById();
  const myUid = useAuthStore((s) => s.uid);
  const profile = useAuthStore((s) => s.profile);
  if (uid && uid === myUid && profile) {
    const v = avatarViewOf(profile, prefer);
    return <Avatar {...rest} name={v.name || fallbackName} photoUrl={v.photo_url} gender={v.gender} recyclingKey={avatarRecyclingKey(v.photo_url)} />;
  }
  const f = uid ? byId[uid] : undefined;
  if (!f) return <Avatar {...rest} name={fallbackName} />;
  return <Avatar {...rest} {...friendAvatarProps(f, prefer)} />;
}
