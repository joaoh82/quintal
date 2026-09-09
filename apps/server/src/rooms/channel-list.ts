import type { ChannelRef } from '@quintal/shared';

/**
 * A fingerprint of what one person sees of channels: the ones they are in,
 * and the ones they could join. Sent only when it changes.
 *
 * The two halves are kept apart. The first version joined them into one
 * string, and moving a channel from "could join" to "in" left that string
 * exactly as it was — so `/join` on the last channel in the list did its
 * work on the server and told nobody. The client sat showing the channel as
 * open, with no tab for it, until the next unrelated change.
 */
export function channelListSignature(
  channels: readonly ChannelRef[],
  available: readonly ChannelRef[],
): string {
  const part = (list: readonly ChannelRef[]) =>
    list.map((channel) => `${channel.id}:${channel.kind}:${channel.slug}:${channel.name}`).join(',');
  return `${part(channels)}|${part(available)}`;
}
