/** Single source of truth for socket.io room names — shared by the gateway
 *  handlers and the API-side emitter so the contract can never drift. */
export const channelRoom = (channelId: string): string => `channel:${channelId}`;
export const dmRoom = (threadId: string): string => `dm:${threadId}`;
