// System <function> elements live beside <channel> in JSBSim XML. The signal
// canvas edits both forms, while the generator must keep their XML positions.
const TOP_LEVEL_CHANNEL = '__JSBSIM_SYSTEM_TOP_LEVEL_FUNCTIONS__';

export function systemCanvasChannels(channels: any[], topLevelItems: any[]): any[] {
  if (!topLevelItems.length) return channels;
  // Append to preserve existing channel node IDs and their saved positions.
  return [...channels, { name: TOP_LEVEL_CHANNEL, items: topLevelItems }];
}

export function splitSystemCanvasChannels(channels: any[]): {
  channels: any[];
  topLevelItems: any[];
} {
  const topLevelItems: any[] = [];
  const ordinary: any[] = [];
  for (const channel of channels) {
    if (channel.name === TOP_LEVEL_CHANNEL) {
      topLevelItems.push(...(channel.items || []));
    } else {
      ordinary.push(channel);
    }
  }
  return { channels: ordinary, topLevelItems };
}
