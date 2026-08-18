'use strict';

/**
 * Server (community) schema helpers.
 *
 * A server is its own Firebase project, so these paths are relative to *that*
 * project, not the directory. The client connects to each server project as a
 * separate Firebase app at runtime.
 *
 * Note what is deliberately different from DMs: server messages are community
 * history, not in-flight transport. They have no `pendingFor`, are not deleted
 * on delivery, and have no sweep. A channel is meant to still be there when
 * someone scrolls up next year.
 */

/** The single document holding a server's name, description and icon. */
const SERVER_INFO_PATH = 'serverInfo/main';

const channelsPath = () => 'channels';
const channelMessagesPath = (channelId) => `channels/${channelId}/messages`;
const membersPath = () => 'members';

/** Channel ids and names, kept safe as document ids and readable as labels. */
const CHANNEL_NAME = /^[a-z0-9-]{1,24}$/;

function normalizeChannelName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24);
}

function isValidChannelName(raw) {
  return CHANNEL_NAME.test(normalizeChannelName(raw));
}

/** A server is identified by its Firebase project id — unique by construction. */
function serverIdFor(config) {
  if (!config?.projectId) throw new Error('a server config needs a projectId');
  return config.projectId;
}

/** Build a channel message document. */
function newChannelMessage({ senderUid, username, content, now = new Date() }) {
  return { senderUid, username, content, sentAt: now };
}

module.exports = {
  SERVER_INFO_PATH,
  CHANNEL_NAME,
  channelsPath,
  channelMessagesPath,
  membersPath,
  normalizeChannelName,
  isValidChannelName,
  serverIdFor,
  newChannelMessage,
};
