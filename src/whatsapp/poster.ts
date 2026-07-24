import type { ChannelRow, OfferRow } from '../types';
import { getEvolution } from './evolution';

/**
 * Monta a legenda final e posta a oferta no grupo de WhatsApp via Evolution.
 * Imagem + legenda; o link de afiliado entra no fim da legenda.
 */
export function buildCaption(offer: OfferRow): string {
  const copy = offer.rewritten_copy ?? offer.title ?? 'Oferta';
  const link = offer.affiliate_url ? `\n\n👉 ${offer.affiliate_url}` : '';
  return `${copy}${link}`;
}

export async function postOfferToGroup(
  channel: ChannelRow,
  offer: OfferRow,
): Promise<string | undefined> {
  if (!channel.target_ref) throw new Error(`canal ${channel.id} sem target_ref (id do grupo)`);
  const caption = buildCaption(offer);

  const evo = await getEvolution();
  if (!evo) throw new Error('Evolution API não configurada (configure na aba Config)');
  if (offer.image_url) {
    return evo.sendMedia(channel.instance_ref, channel.target_ref, offer.image_url, caption);
  }
  return evo.sendText(channel.instance_ref, channel.target_ref, caption);
}
