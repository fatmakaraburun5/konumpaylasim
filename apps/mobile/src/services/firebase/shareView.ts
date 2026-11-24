/** `location_shares` belgesi → sharingStore'un kullandığı görünüm (saf; native ve web demo ortak). */
import type { OutgoingShareView } from '@konum/core';
import type { ShareDoc } from '../../lib/schemas';

export const toOutgoingView = (s: ShareDoc): OutgoingShareView => ({
  share_id: s.share_id,
  session_id: s.session_id,
  receiver_id: s.receiver_id,
  status: s.status,
  share_mode: s.share_mode,
  started_at: s.started_at,
  expires_at: s.expires_at,
  end_reason: s.end_reason,
  version: s.version,
});
